import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { spiderDivider, spiderFooter, spiderHeader, spiderRow } from '../Spider/utils/tableStyle.js';
import { cleanJid, extractPhoneDigits } from './utils/groupRoleResolver.js';

function resolveWritableAntivvPath(fileName = 'antivv.json') {
  const candidates = [
    path.join(process.cwd(), 'data', fileName),
    path.join(os.tmpdir(), 'spider-man-data', fileName),
  ];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.accessSync(path.dirname(candidate), fs.constants.W_OK);
      return candidate;
    } catch {}
  }
  return candidates[1];
}

export function createAntivvStore({ filePath = '' } = {}) {
  let state = null;

  function load() {
    if (state) return state;
    const target = filePath || resolveWritableAntivvPath();
    try {
      if (fs.existsSync(target)) {
        const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
        state = { enabled: Boolean(parsed?.enabled) };
        return state;
      }
    } catch {}
    state = { enabled: false };
    return state;
  }

  function save(next) {
    const target = filePath || resolveWritableAntivvPath();
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(next, null, 2));
    } catch {}
  }

  return {
    getState() {
      return { ...load() };
    },
    setEnabled(val) {
      const next = { enabled: Boolean(val) };
      state = next;
      save(next);
      return { ...next };
    },
    toggle() {
      const cur = load();
      return this.setEnabled(!cur.enabled);
    },
    reset() {
      state = { enabled: false };
      const target = filePath || resolveWritableAntivvPath();
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch {}
    },
  };
}

export const defaultAntivvStore = createAntivvStore();

const capturedViewOnceIds = new Map();
function markCapturedViewOnce(id) {
  if (!id) return;
  const now = Date.now();
  capturedViewOnceIds.set(id, now);
  if (capturedViewOnceIds.size > 500) {
    for (const [k, ts] of capturedViewOnceIds.entries()) {
      if (now - ts > 120000 || capturedViewOnceIds.size > 400) {
        capturedViewOnceIds.delete(k);
      } else {
        break;
      }
    }
  }
}

export function extractViewOnceMedia(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'object') return null;

  let layer = rawMessage;
  let explicitViewOnce = false;
  for (let depth = 0; depth < 6 && layer && typeof layer === 'object'; depth += 1) {
    if (layer.viewOnceMessageV2?.message) {
      explicitViewOnce = true;
      layer = layer.viewOnceMessageV2.message;
      continue;
    }
    if (layer.viewOnceMessageV2Extension?.message) {
      explicitViewOnce = true;
      layer = layer.viewOnceMessageV2Extension.message;
      continue;
    }
    if (layer.viewOnceMessage?.message) {
      explicitViewOnce = true;
      layer = layer.viewOnceMessage.message;
      continue;
    }
    if (layer.ephemeralMessage?.message) {
      layer = layer.ephemeralMessage.message;
      continue;
    }
    break;
  }

  const candidates = [
    ['image', 'image', layer.imageMessage],
    ['video', 'video', layer.videoMessage],
    ['video', 'video', layer.ptvMessage],
    ['audio', 'audio', layer.audioMessage],
  ];

  for (const [type, dlType, media] of candidates) {
    if (!media || typeof media !== 'object') continue;
    if (explicitViewOnce || media.viewOnce === true) {
      return {
        type,
        dlType,
        media,
        caption: String(media.caption || '').trim(),
      };
    }
  }

  return null;
}

async function downloadViewOnceBuffer(info) {
  if (!info?.media) return null;
  if (Buffer.isBuffer(info.media._buffer)) return info.media._buffer;
  if (Buffer.isBuffer(info.media.buffer)) return info.media.buffer;
  try {
    const stream = await downloadContentFromMessage(info.media, info.dlType);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return chunks.length > 0 ? Buffer.concat(chunks) : null;
  } catch {
    return null;
  }
}

export async function handleViewOnceAutoSave({
  sock,
  msg,
  from = '',
  sender = '',
  getOwnerJid = null,
  getPhoneFromJid = null,
  botName = 'Spider Man',
  store = defaultAntivvStore,
} = {}) {
  if (!sock || typeof sock.sendMessage !== 'function' || !msg?.message) {
    return { handled: false };
  }
  if (!store.getState().enabled) return { handled: false };

  const chatJid = String(from || msg?.key?.remoteJid || '');
  if (!chatJid || chatJid === 'status@broadcast') return { handled: false };

  const vo = extractViewOnceMedia(msg.message);
  if (!vo) return { handled: false };

  const msgId = msg?.key?.id || '';
  if (msgId && capturedViewOnceIds.has(msgId)) {
    return { handled: false, reason: 'duplicate' };
  }
  if (msgId) markCapturedViewOnce(msgId);

  const ownerJid = typeof getOwnerJid === 'function' ? getOwnerJid() : '';
  if (!ownerJid) return { handled: false, reason: 'no-owner' };

  const senderJid = sender || msg?.key?.participant || chatJid;
  const senderNum =
    extractPhoneDigits(senderJid, getPhoneFromJid) || cleanJid(senderJid).split('@')[0] || 'Unknown';
  const isGroup = chatJid.endsWith('@g.us');

  let chatLabel = `@${senderNum}`;
  if (isGroup) {
    try {
      const meta = await sock?.groupMetadata?.(chatJid);
      chatLabel = meta?.subject || chatJid;
    } catch {
      chatLabel = chatJid;
    }
  }

  const captionCard = [
    spiderHeader(botName, 'ANTI-VIEWONCE CAPTURE'),
    spiderRow('FROM', `@${senderNum}`, '👤'),
    spiderRow('CHAT', isGroup ? `${chatLabel} (Group)` : 'Private DM', '◈'),
    spiderRow('MEDIA', vo.type.toUpperCase(), '👁️'),
    ...(vo.caption ? [spiderDivider('ORIGINAL CAPTION'), `> ┃ ${vo.caption.slice(0, 1000)}`] : []),
    spiderFooter('ANTIVV // SPIDER-MAN'),
  ].join('\n');

  const mentionList = Array.from(
    new Set([cleanJid(senderJid)].filter((j) => j && !j.endsWith('@g.us'))),
  );

  const buffer = await downloadViewOnceBuffer(vo);
  try {
    if (buffer) {
      if (vo.type === 'image') {
        await sock.sendMessage(ownerJid, { image: buffer, caption: captionCard, mentions: mentionList });
      } else if (vo.type === 'video') {
        await sock.sendMessage(ownerJid, { video: buffer, caption: captionCard, mentions: mentionList });
      } else if (vo.type === 'audio') {
        await sock.sendMessage(ownerJid, { text: captionCard, mentions: mentionList });
        await sock.sendMessage(ownerJid, {
          audio: buffer,
          mimetype: vo.media?.mimetype || 'audio/mp4',
          ptt: Boolean(vo.media?.ptt),
        });
      }
      return { handled: true, ownerJid, type: vo.type, withMedia: true };
    }

    await sock.sendMessage(ownerJid, { text: captionCard, mentions: mentionList });
    return { handled: true, ownerJid, type: vo.type, withMedia: false };
  } catch {
    return { handled: false };
  }
}

export function installViewOnceAutoSave() {
  // Handled cleanly inline via handleViewOnceAutoSave in messages.upsert without polluting event listeners.
  return true;
}
