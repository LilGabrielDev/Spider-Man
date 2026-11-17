import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  downloadContentFromMessage,
  downloadEncryptedContent,
  downloadMediaMessage,
  getMediaKeys,
} from '@whiskeysockets/baileys';
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

function resolveViewOnceCacheDir() {
  const envDir = String(process.env.SPIDER_VIEWONCE_CACHE_DIR || '').trim();
  const candidates = [
    ...(envDir ? [envDir] : []),
    path.join(process.cwd(), 'data', 'viewonce-cache'),
    path.join(os.tmpdir(), 'spider-man-data', 'viewonce-cache'),
  ];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch {}
  }
  return candidates[candidates.length - 1];
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
const VIEW_ONCE_DISK_CACHE_LIMIT = 120;
const MAX_DISK_ENTRY_BYTES = 25 * 1024 * 1024;

export const viewOnceCache =
  globalThis.__spiderViewOnceCache || (globalThis.__spiderViewOnceCache = new Map());
export const pendingViewOnceCache =
  globalThis.__spiderPendingViewOnceCache || (globalThis.__spiderPendingViewOnceCache = new Map());

function cacheDiskFileForId(id, dir = resolveViewOnceCacheDir()) {
  const hash = crypto.createHash('sha256').update(String(id)).digest('hex');
  return path.join(dir, `${hash}.json`);
}

function pruneDiskCache(dir) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const full = path.join(dir, name);
        try {
          return { full, mtimeMs: fs.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = files.length - VIEW_ONCE_DISK_CACHE_LIMIT;
    for (let i = 0; i < excess; i += 1) {
      try {
        fs.unlinkSync(files[i].full);
      } catch {}
    }
  } catch {}
}

function writeDiskCacheEntry(id, entry) {
  try {
    if (!id || !Buffer.isBuffer(entry?.buffer) || entry.buffer.length === 0) return false;
    if (entry.buffer.length > MAX_DISK_ENTRY_BYTES) return false;
    const dir = resolveViewOnceCacheDir();
    const target = cacheDiskFileForId(id, dir);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    const payload = JSON.stringify({
      v: 1,
      id: String(id),
      type: entry.type || 'image',
      dlType: entry.dlType || entry.type || 'image',
      isPtv: Boolean(entry.isPtv),
      mimetype: entry.mimetype || '',
      caption: entry.caption || '',
      ptt: Boolean(entry.ptt),
      fileName: entry.fileName || '',
      timestamp: entry.timestamp || Date.now(),
      bufferBase64: entry.buffer.toString('base64'),
    });
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, target);
    pruneDiskCache(dir);
    return true;
  } catch {
    return false;
  }
}

function readDiskCacheEntry(id) {
  try {
    if (!id) return null;
    const target = cacheDiskFileForId(id);
    if (!fs.existsSync(target)) return null;
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!parsed || parsed.id !== String(id) || typeof parsed.bufferBase64 !== 'string') {
      return null;
    }
    const buffer = Buffer.from(parsed.bufferBase64, 'base64');
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    return {
      type: parsed.type || 'image',
      dlType: parsed.dlType || parsed.type || 'image',
      isPtv: Boolean(parsed.isPtv),
      buffer,
      mimetype: parsed.mimetype || '',
      caption: parsed.caption || '',
      ptt: Boolean(parsed.ptt),
      fileName: parsed.fileName || '',
      timestamp: parsed.timestamp || Date.now(),
    };
  } catch {
    return null;
  }
}

export function getCachedViewOnce(id) {
  if (!id) return null;
  const mem = viewOnceCache.get(id);
  if (mem) return mem;
  const disk = readDiskCacheEntry(id);
  if (disk) {
    viewOnceCache.set(id, disk);
    while (viewOnceCache.size > VIEW_ONCE_CACHE_LIMIT) {
      const oldestKey = viewOnceCache.keys().next().value;
      if (oldestKey === undefined) break;
      viewOnceCache.delete(oldestKey);
    }
    return disk;
  }
  return null;
}

export function setCachedViewOnce(id, entry, { persist = true } = {}) {
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
  if (persist) {
    writeDiskCacheEntry(id, entry);
  }
  return true;
}

export function clearViewOnceCache({ keepDisk = false } = {}) {
  viewOnceCache.clear();
  pendingViewOnceCache.clear();
  if (!keepDisk) {
    try {
      const dir = resolveViewOnceCacheDir();
      if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) {
          if (name.endsWith('.json')) {
            try {
              fs.unlinkSync(path.join(dir, name));
            } catch {}
          }
        }
      }
    } catch {}
  }
}

export async function waitForPendingViewOnceCache(id, timeoutMs = 8000) {
  if (!id) return null;
  const pending = pendingViewOnceCache.get(id);
  if (!pending) return null;
  try {
    let timer = null;
    return await Promise.race([
      pending.catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(50, Number(timeoutMs) || 8000));
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch {
    return null;
  }
}

export function normalizeMediaKey(mediaKey) {
  if (!mediaKey) return null;
  if (Buffer.isBuffer(mediaKey)) return mediaKey.length > 0 ? mediaKey : null;
  if (typeof mediaKey === 'string') return mediaKey.trim() ? mediaKey.trim() : null;
  if (mediaKey instanceof ArrayBuffer) {
    const buf = Buffer.from(mediaKey);
    return buf.length > 0 ? buf : null;
  }
  if (mediaKey instanceof Uint8Array || ArrayBuffer.isView(mediaKey)) {
    const buf = Buffer.from(mediaKey.buffer, mediaKey.byteOffset, mediaKey.byteLength);
    return buf.length > 0 ? buf : null;
  }
  if (Array.isArray(mediaKey)) {
    const buf = Buffer.from(mediaKey);
    return buf.length > 0 ? buf : null;
  }
  if (typeof mediaKey === 'object') {
    if (typeof mediaKey.__spiderBytes === 'string') {
      const buf = Buffer.from(mediaKey.__spiderBytes, 'base64');
      return buf.length > 0 ? buf : null;
    }
    if (mediaKey.type === 'Buffer' && Array.isArray(mediaKey.data)) {
      const buf = Buffer.from(mediaKey.data);
      return buf.length > 0 ? buf : null;
    }
    const numericKeys = Object.keys(mediaKey)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    if (numericKeys.length > 0) {
      const buf = Buffer.from(numericKeys.map((k) => Number(mediaKey[k]) & 0xff));
      return buf.length > 0 ? buf : null;
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
    if (layer.deviceSentMessage?.message) {
      layer = layer.deviceSentMessage.message;
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
    if (layer.groupMentionedMessage?.message) {
      layer = layer.groupMentionedMessage.message;
      continue;
    }
    if (layer.limitSharingMessage?.message) {
      layer = layer.limitSharingMessage.message;
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
    if (layer.futureProofMessage?.message) {
      layer = layer.futureProofMessage.message;
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
    ['document', 'document', layer.documentMessage, false],
    ['sticker', 'sticker', layer.stickerMessage, false],
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

function isReuploadStatusError(err) {
  if (!err) return false;
  const status = err?.status || err?.output?.statusCode || err?.response?.status;
  if (status === 401 || status === 403 || status === 404 || status === 410) {
    return true;
  }
  const msg = String(err?.message || err || '');
  return /\b(401|403|404|410)\b|empty media stream|unexpected server response|bad status|expired|unauthorized|forbidden/i.test(
    msg,
  );
}

function toMediaKeyBuffer(mediaKey) {
  const normalized = normalizeMediaKey(mediaKey);
  if (!normalized) return null;
  if (Buffer.isBuffer(normalized)) return normalized;
  if (normalized instanceof Uint8Array) return Buffer.from(normalized);
  if (typeof normalized === 'string') {
    const trimmed = normalized.trim();
    if (!trimmed) return null;
    try {
      const decoded = Buffer.from(trimmed, 'base64');
      if (decoded.length >= 16) return decoded;
    } catch {}
    return Buffer.from(trimmed);
  }
  return null;
}

async function streamMediaToBuffer(targetMedia, dlType) {
  const trimmedUrl = typeof targetMedia?.url === 'string' ? targetMedia.url.trim() : '';
  const hasUrl = trimmedUrl.startsWith('https://');
  const isMmgUrl = trimmedUrl.startsWith('https://mmg.whatsapp.net/');
  const hasDirectPath =
    typeof targetMedia?.directPath === 'string' && targetMedia.directPath.trim().length > 0;

  const readStream = async (s) => {
    const chunks = [];
    for await (const chunk of s) {
      chunks.push(chunk);
    }
    const buf = chunks.length > 0 ? Buffer.concat(chunks) : null;
    return buf && buf.length > 0 ? buf : null;
  };

  if (hasUrl && !isMmgUrl && !hasDirectPath) {
    const keys = await getMediaKeys(toMediaKeyBuffer(targetMedia.mediaKey) || targetMedia.mediaKey, dlType);
    return readStream(await downloadEncryptedContent(trimmedUrl, keys));
  }

  try {
    const stream = await downloadContentFromMessage(targetMedia, dlType);
    const buf = await readStream(stream);
    if (buf) return buf;
  } catch (err) {
    if (hasUrl && !isMmgUrl) {
      const keys = await getMediaKeys(toMediaKeyBuffer(targetMedia.mediaKey) || targetMedia.mediaKey, dlType);
      return readStream(await downloadEncryptedContent(trimmedUrl, keys));
    }
    throw err;
  }

  if (hasUrl && !isMmgUrl) {
    const keys = await getMediaKeys(toMediaKeyBuffer(targetMedia.mediaKey) || targetMedia.mediaKey, dlType);
    return readStream(await downloadEncryptedContent(trimmedUrl, keys));
  }
  return null;
}

function unwrapMediaNodeFromMessage(rawMsg, preferredKeys = []) {
  let layer = rawMsg;
  for (let depth = 0; depth < 6 && layer && typeof layer === 'object'; depth += 1) {
    const next =
      layer.viewOnceMessageV2?.message ||
      layer.viewOnceMessageV2Extension?.message ||
      layer.viewOnceMessage?.message ||
      layer.deviceSentMessage?.message ||
      layer.ephemeralMessage?.message ||
      layer.documentWithCaptionMessage?.message ||
      layer.groupMentionedMessage?.message ||
      layer.limitSharingMessage?.message ||
      layer.futureProofMessage?.message;
    if (!next || typeof next !== 'object') break;
    layer = next;
  }
  if (!layer || typeof layer !== 'object') return null;
  for (const key of preferredKeys) {
    if (layer[key] && typeof layer[key] === 'object') return layer[key];
  }
  return null;
}

async function buildGroupReuploadKeys(baseKey, sock) {
  if (!baseKey || typeof baseKey !== 'object') return [];
  const keys = [baseKey];
  const remoteJid = String(baseKey.remoteJid || '');
  if (!remoteJid.endsWith('@g.us')) {
    return keys;
  }

  const seenParticipants = new Set(
    [baseKey.participant].filter(Boolean).map((p) => String(p).trim().toLowerCase()),
  );
  const addParticipantVariant = (candidate) => {
    const val = String(candidate || '').trim();
    if (!val) return;
    const lower = val.toLowerCase();
    if (seenParticipants.has(lower)) return;
    seenParticipants.add(lower);
    keys.push({ ...baseKey, participant: val });
  };

  for (const rawAlt of [baseKey.participantAlt, baseKey.participantPn]) {
    addParticipantVariant(rawAlt);
    addParticipantVariant(cleanJid(rawAlt));
  }
  if (baseKey.participant) {
    addParticipantVariant(cleanJid(baseKey.participant));
  }

  const lidMapping = sock?.signalRepository?.lidMapping;
  if (lidMapping && baseKey.participant) {
    const cleaned = cleanJid(baseKey.participant);
    try {
      if (cleaned.endsWith('@lid') && typeof lidMapping.getPNForLID === 'function') {
        const pn = await lidMapping.getPNForLID(cleaned);
        if (pn) addParticipantVariant(cleanJid(pn));
      } else if (cleaned.endsWith('@s.whatsapp.net') && typeof lidMapping.getLIDForPN === 'function') {
        const lid = await lidMapping.getLIDForPN(cleaned);
        if (lid) addParticipantVariant(cleanJid(lid));
      }
    } catch {}
  }

  return keys;
}

export async function downloadMediaWithRecovery({
  media,
  dlType,
  mediaTypeKey = '',
  isPtv = false,
  downloader = null,
  sock = null,
  msg = null,
} = {}) {
  if (!media || typeof media !== 'object') return null;
  if (Buffer.isBuffer(media._buffer) && media._buffer.length > 0) return media._buffer;
  if (Buffer.isBuffer(media.buffer) && media.buffer.length > 0) return media.buffer;

  const normalizedKey = normalizeMediaKey(media.mediaKey);
  if (!hasValidMediaKey(normalizedKey)) return null;

  const keyBuffer = toMediaKeyBuffer(normalizedKey) || normalizedKey;
  const normalizedMedia = {
    ...media,
    mediaKey: keyBuffer,
  };

  if (typeof downloader === 'function') {
    try {
      const out = await downloader(normalizedMedia, dlType);
      if (Buffer.isBuffer(out) && out.length > 0) return out;
    } catch {}
    return null;
  }

  const hasValidUrl =
    typeof normalizedMedia.url === 'string' && normalizedMedia.url.trim().startsWith('https://');
  const hasDirectPath =
    typeof normalizedMedia.directPath === 'string' && normalizedMedia.directPath.trim().length > 0;

  let lastErr = null;

  // 1) Primary attempt with provided url/directPath (only when at least one location field exists)
  if (hasValidUrl || hasDirectPath) {
    try {
      const buf = await streamMediaToBuffer(normalizedMedia, dlType);
      if (buf) return buf;
    } catch (err) {
      lastErr = err;
    }
  }

  // 2) Fallback to directPath only when url was stale/non-mmg or failed
  if (hasValidUrl && hasDirectPath) {
    try {
      const directOnly = { ...normalizedMedia };
      delete directOnly.url;
      const buf = await streamMediaToBuffer(directOnly, dlType);
      if (buf) return buf;
    } catch (err) {
      lastErr = err;
    }
  }

  const resolvedMediaKey = isPtv
    ? 'ptvMessage'
    : mediaTypeKey ||
      (dlType === 'image'
        ? 'imageMessage'
        : dlType === 'audio'
          ? 'audioMessage'
          : dlType === 'document'
            ? 'documentMessage'
            : dlType === 'sticker'
              ? 'stickerMessage'
              : 'videoMessage');

  // 3) Direct re-upload request + retry (handles 401/403 too, and retries alternate group participant PN/LID keys)
  if (msg?.key && sock) {
    // Baileys assertMediaContent doesn't recognize ptvMessage directly; map to videoMessage for updateMediaMessage
    const reuploadMediaField = resolvedMediaKey === 'ptvMessage' ? 'videoMessage' : resolvedMediaKey;
    const candidateKeys = await buildGroupReuploadKeys(msg.key, sock);

    if (typeof sock.updateMediaMessage === 'function') {
      for (const candidateKey of candidateKeys) {
        const reuploadMsg = {
          key: candidateKey,
          message: { [reuploadMediaField]: normalizedMedia },
        };

        let updateSucceeded = false;
        try {
          const updatedMsg = await sock.updateMediaMessage(reuploadMsg);
          updateSucceeded = true;
          const updatedNode = unwrapMediaNodeFromMessage(updatedMsg?.message, [
            reuploadMediaField,
            resolvedMediaKey,
            'videoMessage',
            'imageMessage',
            'audioMessage',
            'documentMessage',
            'stickerMessage',
          ]);
          const refreshedMedia = updatedNode
            ? {
                ...normalizedMedia,
                ...updatedNode,
                mediaKey: toMediaKeyBuffer(updatedNode.mediaKey) || keyBuffer,
              }
            : normalizedMedia;
          if (Buffer.isBuffer(refreshedMedia._buffer) && refreshedMedia._buffer.length > 0) {
            return refreshedMedia._buffer;
          }
          if (Buffer.isBuffer(refreshedMedia.buffer) && refreshedMedia.buffer.length > 0) {
            return refreshedMedia.buffer;
          }
          const refreshedBuf = await streamMediaToBuffer(refreshedMedia, dlType).catch(() => null);
          if (refreshedBuf) return refreshedBuf;
        } catch {
          // continue to next candidate key / fallback
        }

        if (updateSucceeded || hasValidUrl || hasDirectPath) {
          try {
            const buf = await downloadMediaMessage(
              reuploadMsg,
              'buffer',
              {},
              {
                logger: SILENT_LOGGER,
                reuploadRequest: sock.updateMediaMessage.bind(sock),
              },
            );
            if (Buffer.isBuffer(buf) && buf.length > 0) return buf;
          } catch {}
        }
      }
    }

    if (typeof sock.downloadMediaMessage === 'function') {
      for (const candidateKey of candidateKeys) {
        try {
          const customBuf = await sock.downloadMediaMessage({
            key: candidateKey,
            message: { [resolvedMediaKey]: normalizedMedia },
          });
          if (Buffer.isBuffer(customBuf) && customBuf.length > 0) return customBuf;
        } catch {}
      }
    }
  }

  // 4) Single transient retry in case CDN dropped the connection
  if (lastErr && !isReuploadStatusError(lastErr)) {
    try {
      const retryBuf = await streamMediaToBuffer(normalizedMedia, dlType);
      if (retryBuf) return retryBuf;
    } catch {}
  }

  return null;
}

async function downloadViewOnceBuffer(info, { downloader = null, sock = null, msg = null } = {}) {
  if (!info?.media) return null;
  return downloadMediaWithRecovery({
    media: info.media,
    dlType: info.dlType,
    isPtv: Boolean(info.isPtv),
    downloader,
    sock,
    msg,
  });
}

/**
 * Downloads and caches view-once media bytes on arrival while the mediaKey
 * and CDN URL are still fresh, so manual .vv / .vv2 works even after
 * WhatsApp strips mediaKey/viewOnce from quoted replies or expires the media.
 */
async function cacheViewOnceInternal(msg, { downloader = null, sock = null } = {}) {
  try {
    const raw = msg?.message;
    const msgId = msg?.key?.id;
    if (!raw || !msgId) return { cached: false, reason: 'missing-message' };

    const chatJid = String(msg?.key?.remoteJid || '');
    if (chatJid === 'status@broadcast') return { cached: false, reason: 'status-broadcast' };

    const vo = extractViewOnceMedia(raw);
    if (!vo) return { cached: false, reason: 'not-viewonce' };

    if (getCachedViewOnce(msgId)) {
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
      fileName: vo.media.fileName || '',
      timestamp: Date.now(),
    });

    return { cached: true, id: msgId, type: vo.type };
  } catch {
    return { cached: false, reason: 'error' };
  }
}

export async function cacheViewOnce(msg, opts = {}) {
  const msgId = msg?.key?.id;
  if (!msg?.message || !msgId) return { cached: false, reason: 'missing-message' };

  const existingPending = pendingViewOnceCache.get(msgId);
  if (existingPending) {
    return existingPending;
  }

  const promise = cacheViewOnceInternal(msg, opts).finally(() => {
    if (pendingViewOnceCache.get(msgId) === promise) {
      pendingViewOnceCache.delete(msgId);
    }
  });
  pendingViewOnceCache.set(msgId, promise);
  return promise;
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
