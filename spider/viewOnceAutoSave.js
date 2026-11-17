import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadContentFromMessage, downloadMediaMessage } from '@whiskeysockets/baileys';
import { spiderDivider, spiderFooter, spiderHeader, spiderRow } from '../Spider/utils/tableStyle.js';
import { cleanJid, extractPhoneDigits } from './utils/groupRoleResolver.js';
import { SILENT_LOGGER } from './utils/privacyLogger.js';

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

const VIEW_ONCE_CACHE_LIMIT = 250;
export const viewOnceCache =
  globalThis.__spiderViewOnceCache || (globalThis.__spiderViewOnceCache = new Map());

export function getCachedViewOnce(id) {
  if (!id) return null;
  return viewOnceCache.get(id) || null;
}

export function setCachedViewOnce(id, entry) {
  if (!id || !entry || !Buffer.isBuffer(entry.buffer) || entry.buffer.length === 0) {
    return false;
  }
  if (viewOnceCache.has(id)) {
    viewOnceCache.delete(id);
  }
  viewOnceCache.set(id, entry);
  while (viewOnceCache.size > VIEW_ONCE_CACHE_LIMIT) {
    const oldestKey = viewOnceCache.keys().next().value;
    if (oldestKey === undefined) break;
    viewOnceCache.delete(oldestKey);
  }
  return true;
}

export function clearViewOnceCache() {
  viewOnceCache.clear();
}

export function normalizeMediaKey(mediaKey) {
  if (!mediaKey) return null;
  if (Buffer.isBuffer(mediaKey)) return mediaKey;
  if (typeof mediaKey === 'string') return mediaKey.trim() ? mediaKey : null;
  if (mediaKey instanceof Uint8Array || Array.isArray(mediaKey)) {
    return Buffer.from(mediaKey);
  }
  if (typeof mediaKey === 'object') {
    if (mediaKey.type === 'Buffer' && Array.isArray(mediaKey.data)) {
      return Buffer.from(mediaKey.data);
    }
    const numericKeys = Object.keys(mediaKey)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    if (numericKeys.length > 0) {
      return Buffer.from(numericKeys.map((k) => Number(mediaKey[k]) & 0xff));
    }
  }
  return null;
}

export function hasValidMediaKey(mediaKey) {
  const normalized = normalizeMediaKey(mediaKey);
  if (!normalized) return false;
  if (Buffer.isBuffer(normalized) || normalized instanceof Uint8Array) {
    return normalized.length > 0;
  }
  if (typeof normalized === 'string') {
    return normalized.trim().length > 0;
  }
  return false;
}

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
  let explicitViewOnce = Boolean(rawMessage.viewOnce === true);
  for (let depth = 0; depth < 8 && layer && typeof layer === 'object'; depth += 1) {
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
    if (layer.documentWithCaptionMessage?.message) {
      layer = layer.documentWithCaptionMessage.message;
      continue;
    }
    if (layer.editedMessage?.message) {
      layer =
        layer.editedMessage.message?.protocolMessage?.editedMessage ||
        layer.editedMessage.message;
      continue;
    }
    if (layer.groupStatusMessageV2?.message) {
      layer = layer.groupStatusMessageV2.message;
      continue;
    }
    if (layer.associatedChildMessage?.message) {
      layer = layer.associatedChildMessage.message;
      continue;
    }
    if (layer.botInvokeMessage?.message) {
      layer = layer.botInvokeMessage.message;
      continue;
    }
    break;
  }

  if (!layer || typeof layer !== 'object') return null;
  if (layer.viewOnce === true) explicitViewOnce = true;

  const candidates = [
    ['image', 'image', layer.imageMessage, false],
    ['video', 'video', layer.videoMessage, false],
    ['video', 'video', layer.ptvMessage, true],
    ['audio', 'audio', layer.audioMessage, false],
  ];

  for (const [type, dlType, media, isPtv] of candidates) {
    if (!media || typeof media !== 'object') continue;
    if (explicitViewOnce || media.viewOnce === true) {
      return {
        type,
        dlType,
        isPtv,
        media,
        caption: String(media.caption || '').trim(),
      };
    }
  }

  return null;
}

async function downloadViewOnceBuffer(info, { downloader = null, sock = null, msg = null } = {}) {
  if (!info?.media) return null;
  if (Buffer.isBuffer(info.media._buffer)) return info.media._buffer;
  if (Buffer.isBuffer(info.media.buffer)) return info.media.buffer;

  const normalizedKey = normalizeMediaKey(info.media.mediaKey);
  if (!hasValidMediaKey(normalizedKey)) return null;

  const normalizedMedia = {
    ...info.media,
    mediaKey: normalizedKey,
  };

  if (typeof downloader === 'function') {
    const out = await downloader(normalizedMedia, info.dlType);
    return Buffer.isBuffer(out) && out.length > 0 ? out : null;
  }

  const hasValidUrl =
    typeof normalizedMedia.url === 'string' && normalizedMedia.url.trim().startsWith('https://');
  const hasDirectPath =
    typeof normalizedMedia.directPath === 'string' && normalizedMedia.directPath.trim().length > 0;
  if (!hasValidUrl && !hasDirectPath) return null;

  try {
    const stream = await downloadContentFromMessage(normalizedMedia, info.dlType);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buf = chunks.length > 0 ? Buffer.concat(chunks) : null;
    if (buf && buf.length > 0) return buf;
  } catch (err) {
    const status = err?.status || err?.output?.statusCode;
    if (
      msg &&
      sock &&
      typeof sock.updateMediaMessage === 'function' &&
      (status === 401 ||
        status === 403 ||
        status === 404 ||
        status === 410 ||
        /\b(401|403|404|410)\b/.test(String(err?.message || '')))
    ) {
      try {
        const mediaKey = info.isPtv
          ? 'ptvMessage'
          : info.type === 'image'
            ? 'imageMessage'
            : info.type === 'video'
              ? 'videoMessage'
              : 'audioMessage';
        const fullMsg = { key: msg.key, message: { [mediaKey]: normalizedMedia } };
        const buf = await downloadMediaMessage(
          fullMsg,
          'buffer',
          {},
          {
            logger: SILENT_LOGGER,
            reuploadRequest: sock.updateMediaMessage.bind(sock),
          },
        );
        return Buffer.isBuffer(buf) && buf.length > 0 ? buf : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Downloads and caches view-once media bytes on arrival while the mediaKey
 * and CDN URL are still fresh, so manual .vv / .vv2 works even after
 * WhatsApp strips mediaKey/viewOnce from quoted replies or expires the media.
 */
export async function cacheViewOnce(msg, { downloader = null, sock = null } = {}) {
  try {
    const raw = msg?.message;
    const msgId = msg?.key?.id;
    if (!raw || !msgId) return { cached: false, reason: 'missing-message' };

    const chatJid = String(msg?.key?.remoteJid || '');
    if (chatJid === 'status@broadcast') return { cached: false, reason: 'status-broadcast' };

    const vo = extractViewOnceMedia(raw);
    if (!vo) return { cached: false, reason: 'not-viewonce' };

    if (viewOnceCache.has(msgId)) {
      return { cached: true, alreadyCached: true, id: msgId, type: vo.type };
    }

    const hasInlineBuf = Buffer.isBuffer(vo.media._buffer) || Buffer.isBuffer(vo.media.buffer);
    if (!hasInlineBuf && !hasValidMediaKey(vo.media.mediaKey)) {
      return { cached: false, reason: 'missing-mediakey' };
    }

    const buffer = await downloadViewOnceBuffer(vo, { downloader, sock, msg });
    if (!buffer || buffer.length === 0) {
      return { cached: false, reason: 'download-failed' };
    }

    setCachedViewOnce(msgId, {
      type: vo.type,
      dlType: vo.dlType,
      isPtv: Boolean(vo.isPtv),
      buffer,
      mimetype: vo.media.mimetype || '',
      caption: vo.caption || '',
      ptt: Boolean(vo.media.ptt),
      timestamp: Date.now(),
    });

    return { cached: true, id: msgId, type: vo.type };
  } catch {
    return { cached: false, reason: 'error' };
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

  const cached = msgId ? getCachedViewOnce(msgId) : null;
  const buffer = cached?.buffer || (await downloadViewOnceBuffer(vo, { sock, msg }));
  if (msgId && buffer && !cached) {
    setCachedViewOnce(msgId, {
      type: vo.type,
      dlType: vo.dlType,
      isPtv: Boolean(vo.isPtv),
      buffer,
      mimetype: vo.media?.mimetype || '',
      caption: vo.caption || '',
      ptt: Boolean(vo.media?.ptt),
      timestamp: Date.now(),
    });
  }

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
