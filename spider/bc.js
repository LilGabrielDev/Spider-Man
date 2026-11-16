import fs from 'fs';
import path from 'path';
import os from 'os';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { chooseStatusReactionEmoji } from './statusReactions.js';
import { SILENT_LOGGER, sanitizeConsoleText, logStatusUpdate } from './utils/privacyLogger.js';
import CONFIG from './config.js';
import { cleanUserJid, getLidFromJid, getPhoneFromJid as getPhoneFromJidHelper } from './utils/userJid.js';

export const seenStatusIds = new Set();

const STATUS_VIEW_MAX_RETRIES = 3;
const STATUS_VIEW_RETRY_BASE_MS = 1000;
const STATUS_LIKE_TIMEOUT_MS = 25000;
const STATUS_LIKE_QUEUE_LIMIT = 10;
const STATUS_MAX_AGE_SECONDS = 86400;

const statusLikeQueue = [];
let statusLikeBusy = false;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout(fn, timeoutMs, timeoutMsg) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(fn),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(timeoutMsg)), timeoutMs);
                timer?.unref?.();
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function isNonUserJid(jid) {
    const lower = String(jid || '').trim().toLowerCase();
    return (
        !lower ||
        lower === 'status@broadcast' ||
        lower.endsWith('@g.us') ||
        lower.endsWith('@broadcast') ||
        lower.endsWith('@newsletter')
    );
}

function isOwnAccountJid(jid, sock) {
    const cleaned = cleanUserJid(jid);
    if (!cleaned || isNonUserJid(cleaned)) return false;
    const targetUser = cleaned.split('@')[0];
    const meCandidates = [
        sock?.authState?.creds?.me?.id,
        sock?.authState?.creds?.me?.lid,
        sock?.user?.id,
        sock?.user?.lid
    ];
    for (const raw of meCandidates) {
        const cleanMe = cleanUserJid(raw);
        if (!cleanMe || isNonUserJid(cleanMe)) continue;
        if (cleanMe.toLowerCase() === cleaned.toLowerCase()) return true;
        if (targetUser && cleanMe.split('@')[0] === targetUser) return true;
    }
    return false;
}

function unwrapStatusContent(message) {
    let content = message;
    for (let i = 0; i < 5 && content && typeof content === 'object'; i++) {
        const inner =
            content.ephemeralMessage?.message ||
            content.viewOnceMessage?.message ||
            content.viewOnceMessageV2?.message ||
            content.viewOnceMessageV2Extension?.message ||
            content.documentWithCaptionMessage?.message;
        if (!inner || typeof inner !== 'object') break;
        content = inner;
    }
    return content;
}

async function resolveStatusAuthor(msg, sock) {
    const rawCandidates = [
        msg?.key?.participant,
        msg?.participant,
        msg?.key?.participantAlt,
        msg?.key?.participantPn,
        msg?.key?.remoteJidAlt
    ];

    const cleanedCandidates = [];
    for (const candidate of rawCandidates) {
        if (typeof candidate !== 'string' || !candidate) continue;
        const cleaned = cleanUserJid(candidate);
        if (!cleaned || isNonUserJid(cleaned) || !cleaned.includes('@')) continue;
        if (!cleanedCandidates.includes(cleaned)) {
            cleanedCandidates.push(cleaned);
        }
    }

    if (cleanedCandidates.length === 0) {
        return { canonicalJid: null, displayJid: 'Unknown' };
    }

    const lidCandidate = cleanedCandidates.find((c) => Boolean(getLidFromJid(c)));
    const pnCandidate = cleanedCandidates.find((c) => Boolean(getPhoneFromJidHelper(c)));

    let canonicalJid = lidCandidate || cleanedCandidates[0];
    if (!lidCandidate && canonicalJid) {
        const lidMapping = sock?.signalRepository?.lidMapping;
        if (lidMapping && typeof lidMapping.getLIDForPN === 'function') {
            try {
                const mappedLid = cleanUserJid(await lidMapping.getLIDForPN(canonicalJid));
                if (mappedLid && getLidFromJid(mappedLid)) {
                    canonicalJid = mappedLid;
                }
            } catch {
                // Keep cleaned candidate
            }
        }
    }

    return {
        canonicalJid,
        displayJid: pnCandidate || canonicalJid || 'Unknown'
    };
}

async function pumpStatusLikeQueue() {
    if (statusLikeBusy) return;
    statusLikeBusy = true;
    try {
        while (statusLikeQueue.length) {
            const item = statusLikeQueue.shift();
            try {
                if (CONFIG.AUTO_VIEW === true && typeof item.sock?.readMessages === 'function') {
                    await item.sock.readMessages([item.key]).catch(() => {});
                }
                await withTimeout(
                    () =>
                        item.sock.sendMessage(
                            'status@broadcast',
                            { react: { text: item.emoji, key: item.key } },
                            { statusJidList: [item.participant] }
                        ),
                    STATUS_LIKE_TIMEOUT_MS,
                    'status like timed out'
                );
            } catch (err) {
                console.warn('⚠️ Status like skipped: ' + sanitizeConsoleText(err?.message || err));
            }
        }
    } finally {
        statusLikeBusy = false;
    }
}

function enqueueStatusLike(sock, key, participant) {
    if (!participant || participant === 'Unknown' || isNonUserJid(participant)) return;
    if (statusLikeQueue.length >= STATUS_LIKE_QUEUE_LIMIT) {
        console.warn('⚠️ Status like queue full; skipping reaction');
        return;
    }
    const emoji = chooseStatusReactionEmoji(CONFIG.STATUS_LIKE_EMOJI);
    statusLikeQueue.push({ sock, key, participant, emoji });
    void pumpStatusLikeQueue();
}

export function logStatus(_jid, _id, _name, _type = 'unknown', _caption = '') {
    return logStatusUpdate();
}

export function getStatusUserPhone(jid) {
    if (!jid) return 'Unknown';
    return getPhoneFromJidHelper(jid) || cleanUserJid(jid) || 'Unknown';
}

export async function processStatusMessage(msg, sock) {
    if (
        !msg?.key ||
        !msg.message ||
        (msg.key.remoteJid !== 'status@broadcast' && msg.key.remoteJidAlt !== 'status@broadcast')
    ) {
        return;
    }
    if (!msg.key.id || msg.message?.protocolMessage) return;
    if (msg.key.fromMe === true) return;

    const statusId = msg.key.id;
    if (seenStatusIds.has(statusId)) return;

    const tsRaw = msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0;
    const statusTs = Number(tsRaw);
    if (Number.isFinite(statusTs) && statusTs > 0) {
        const ageSeconds = Math.floor(Date.now() / 1000) - statusTs;
        if (ageSeconds > STATUS_MAX_AGE_SECONDS) {
            seenStatusIds.add(statusId);
            return;
        }
    }

    const { canonicalJid, displayJid } = await resolveStatusAuthor(msg, sock);
    if (canonicalJid && isOwnAccountJid(canonicalJid, sock)) {
        seenStatusIds.add(statusId);
        return;
    }

    const statusKey = {
        remoteJid: 'status@broadcast',
        fromMe: false,
        id: statusId,
        ...(canonicalJid ? { participant: canonicalJid } : {}),
        ...(msg.key.isGroupStatus ? { isGroupStatus: true } : {})
    };

    const innerContent = unwrapStatusContent(msg.message);
    let mediaType = 'unknown';
    let caption = '';
    try {
        if (innerContent?.imageMessage) {
            mediaType = 'image';
            caption = innerContent.imageMessage.caption || '';
        } else if (innerContent?.videoMessage) {
            mediaType = 'video';
            caption = innerContent.videoMessage.caption || '';
        } else if (innerContent?.conversation) {
            mediaType = 'text';
            caption = innerContent.conversation;
        } else if (innerContent?.extendedTextMessage) {
            mediaType = 'text';
            caption = innerContent.extendedTextMessage.text || '';
        } else if (innerContent?.audioMessage) {
            mediaType = 'audio';
        } else if (innerContent?.documentMessage) {
            mediaType = 'document';
        } else if (innerContent?.stickerMessage) {
            mediaType = 'sticker';
        }

        if (mediaType === 'unknown') {
            seenStatusIds.add(statusId);
            return;
        }

        if (CONFIG.AUTO_VIEW === true && !canonicalJid) {
            console.warn('[AUTO-VIEW] Skipping unauthenticated status');
        } else if (CONFIG.AUTO_VIEW === true && !(CONFIG.AUTO_LIKE === true && canonicalJid)) {
            let lastErr;
            for (let attempt = 1; attempt <= STATUS_VIEW_MAX_RETRIES; attempt++) {
                try {
                    await sock.readMessages([statusKey]);
                    lastErr = null;
                    break;
                } catch (err) {
                    lastErr = err;
                    if (attempt < STATUS_VIEW_MAX_RETRIES) {
                        console.warn(
                            '⚠️ Status view attempt ' +
                                attempt +
                                ' failed; retrying: ' +
                                sanitizeConsoleText(err?.message || err)
                        );
                        await wait(STATUS_VIEW_RETRY_BASE_MS * attempt);
                    }
                }
            }
            if (lastErr) {
                console.error(
                    '❌ Failed to view status after ' +
                        STATUS_VIEW_MAX_RETRIES +
                        ' attempts: ' +
                        sanitizeConsoleText(lastErr?.message || lastErr)
                );
            }
        }

        if (CONFIG.AUTO_LIKE === true && canonicalJid) {
            const likeTimer = setTimeout(() => enqueueStatusLike(sock, statusKey, canonicalJid), 2000);
            likeTimer?.unref?.();
        }

        seenStatusIds.add(statusId);
        if (seenStatusIds.size > 1000) {
            const oldest = seenStatusIds.values().next().value;
            seenStatusIds.delete(oldest);
        }

        let pushName = msg.pushName || 'Unknown';
        if (
            displayJid !== 'Unknown' &&
            getPhoneFromJidHelper(displayJid) &&
            typeof sock?.onWhatsApp === 'function'
        ) {
            try {
                const res = await sock.onWhatsApp(displayJid);
                if (res && res[0]) {
                    pushName = res[0].notify || pushName;
                }
            } catch {
                // Ignore onWhatsApp lookup errors
            }
        }

        logStatus(displayJid, statusId, pushName, mediaType, caption);
    } catch (err) {
        console.error('[AUTO-VIEW] Error viewing status:', sanitizeConsoleText(err?.message || err));
    }
}

export async function handleStatusReply(msg, sock, from) {
    const tempDir = path.join(os.tmpdir(), 'ultra-lil-temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    try {
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quoted = contextInfo?.quotedMessage;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const normalized = text.toLowerCase().trim();
        const triggers = ['share', 'send', 'tuma', 'nitumie'];
        const hasQuotedFromSender = contextInfo?.participant && quoted;
        if (triggers.includes(normalized) && hasQuotedFromSender) {
            let replyPayload;
            let tempFile = null;
            const mediaTarget = { message: quoted };
            try {
                if (quoted.imageMessage) {
                    const buf = await downloadMediaMessage(mediaTarget, 'buffer', {}, { logger: SILENT_LOGGER });
                    const filePath = path.join(tempDir, Date.now() + '-status-image.jpg');
                    fs.writeFileSync(filePath, buf);
                    tempFile = filePath;
                    replyPayload = { image: { url: filePath }, caption: '📸 Sent by *Spider Man* !' };
                } else if (quoted.videoMessage) {
                    const buf = await downloadMediaMessage(mediaTarget, 'buffer', {}, { logger: SILENT_LOGGER });
                    const filePath = path.join(tempDir, Date.now() + '-status-video.mp4');
                    fs.writeFileSync(filePath, buf);
                    tempFile = filePath;
                    replyPayload = { video: { url: filePath }, caption: '🎥 Sent by *Spider Man* !' };
                } else if (quoted.stickerMessage) {
                    const buf = await downloadMediaMessage(mediaTarget, 'buffer', {}, { logger: SILENT_LOGGER });
                    const filePath = path.join(tempDir, Date.now() + '-status-sticker.webp');
                    fs.writeFileSync(filePath, buf);
                    tempFile = filePath;
                    replyPayload = { sticker: { url: filePath } };
                } else {
                    return false;
                }
                await sock.sendMessage(from, replyPayload, { quoted: msg });
                return true;
            } finally {
                if (tempFile) {
                    try {
                        await fs.promises.unlink(tempFile);
                    } catch {
                        // Ignore cleanup error
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error in status reply: ' + sanitizeConsoleText(err?.message || err));
    }
    return false;
}