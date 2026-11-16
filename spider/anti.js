import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { downloadContentFromMessage, generateMessageIDV2 } from '@whiskeysockets/baileys';
import { spiderDivider, spiderFooter, spiderHeader, spiderRow } from '../Spider/utils/tableStyle.js';
import { cleanJid, extractPhoneDigits } from './utils/groupRoleResolver.js';
import { unwrapMessageContent } from './utils/groupActionHelper.js';
import { extractMessageText } from './utils/antiscam.js';
import config from './config.js';

const sendContextStorage = new AsyncLocalStorage();

export const messageStore = new Map();
const messagesByChatAndId = new Map();
const chatAliases = new Map();
const wrappedSockets = new WeakSet();
const DEFAULT_MAX_MESSAGES = 5000;
const MAX_CHAT_ALIASES = 4000;
const PERSIST_DEBOUNCE_MS = 1000;

let maxMessages = DEFAULT_MAX_MESSAGES;
let persistFilePath = '';
let persistTimer = null;
let aliasResolver = null;

function toPlainSerializable(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return value;
  }
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (typeof value?.constructor?.toObject === 'function') {
    try {
      return value.constructor.toObject(value, {
        longs: String,
        enums: Number,
        bytes: Buffer,
        defaults: false,
      });
    } catch {
      // Fallback to recursive copy below
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => toPlainSerializable(item, seen));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) {
      out[k] = toPlainSerializable(v, seen);
    }
  }
  return out;
}

function serializeValue(_key, value) {
  const raw = this && _key !== '' ? this[_key] : value;
  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
    return {
      __spiderBytes: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64'),
    };
  }
  if (
    value &&
    typeof value === 'object' &&
    value.type === 'Buffer' &&
    Array.isArray(value.data)
  ) {
    return {
      __spiderBytes: Buffer.from(value.data).toString('base64'),
    };
  }
  return value;
}

function deserializeValue(_key, value) {
  if (value && typeof value === 'object' && typeof value.__spiderBytes === 'string') {
    return Buffer.from(value.__spiderBytes, 'base64');
  }
  return value;
}

export function normalizeChatJid(jid) {
  const raw = String(jid || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase() === 'status@broadcast') return 'status@broadcast';
  const match = raw.match(
    /^([^:@]+)(?::\d+)?@(s\.whatsapp\.net|c\.us|lid|g\.us|broadcast|newsletter)$/i,
  );
  if (!match) return raw;
  const user = match[1];
  const domain = match[2].toLowerCase() === 'c.us' ? 's.whatsapp.net' : match[2].toLowerCase();
  return `${user}@${domain}`;
}

function isGroupOrBroadcastJid(jid) {
  const norm = normalizeChatJid(jid);
  return norm.endsWith('@g.us') || norm === 'status@broadcast' || norm.endsWith('@broadcast') || norm.endsWith('@newsletter');
}

function isDirectJid(jid) {
  const norm = normalizeChatJid(jid);
  return norm.endsWith('@s.whatsapp.net') || norm.endsWith('@lid');
}

function chatMessageKey(key, overrideJid = null) {
  const jid = overrideJid ?? key?.remoteJid;
  if (!jid || !key?.id) return '';
  return `${jid}\u0000${key.id}`;
}

function addAliasPair(a, b) {
  if (!a || !b || a === b) return;
  let set = chatAliases.get(a);
  if (!set) {
    set = new Set();
    chatAliases.set(a, set);
  }
  set.add(b);
  while (chatAliases.size > MAX_CHAT_ALIASES) {
    const oldest = chatAliases.keys().next().value;
    if (oldest === undefined) break;
    chatAliases.delete(oldest);
  }
}

export function registerChatAlias(jidA, jidB) {
  const a = normalizeChatJid(jidA);
  const b = normalizeChatJid(jidB);
  if (!a || !b || a === b) return false;
  if (!isDirectJid(a) || !isDirectJid(b)) return false;
  addAliasPair(a, b);
  addAliasPair(b, a);
  return true;
}

export function setChatAliasResolver(resolver) {
  aliasResolver = typeof resolver === 'function' ? resolver : null;
}

function collectKeyJids(key) {
  const jids = new Set();
  for (const raw of [key?.remoteJid, key?.remoteJidAlt]) {
    if (!raw) continue;
    const str = String(raw).trim();
    if (str) jids.add(str);
    const norm = normalizeChatJid(str);
    if (norm) jids.add(norm);
  }
  return Array.from(jids);
}

export function cleanMessageStore() {
  while (messageStore.size > maxMessages) {
    messageStore.delete(messageStore.keys().next().value);
  }
  const compositeCap = maxMessages * 3;
  while (messagesByChatAndId.size > compositeCap) {
    messagesByChatAndId.delete(messagesByChatAndId.keys().next().value);
  }
}

function persistNow() {
  if (!persistFilePath) return;
  try {
    fs.mkdirSync(path.dirname(persistFilePath), { recursive: true });
    const items = [];
    for (const entry of messageStore.values()) {
      if (entry?.key?.id && entry?.message) {
        items.push({
          key: entry.key,
          message: toPlainSerializable(entry.message),
          timestamp: entry.timestamp || Date.now(),
        });
      }
    }
    const payload = JSON.stringify(items.slice(-maxMessages), serializeValue);
    const tmpPath = `${persistFilePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, payload, { mode: 0o600 });
    fs.renameSync(tmpPath, persistFilePath);
  } catch {
    // Non-fatal: in-memory retry cache remains active
  }
}

function schedulePersist() {
  if (!persistFilePath) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

export function flushMessageRetryStore() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistNow();
}

export function resetMessageRetryStore() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  messageStore.clear();
  messagesByChatAndId.clear();
  chatAliases.clear();
  persistFilePath = '';
  maxMessages = DEFAULT_MAX_MESSAGES;
  aliasResolver = null;
}

function indexStoredMessage(stored) {
  const id = stored?.key?.id;
  if (!id || !stored?.message) return false;

  messageStore.delete(id);
  messageStore.set(id, stored);

  if (stored.key.remoteJid && stored.key.remoteJidAlt) {
    registerChatAlias(stored.key.remoteJid, stored.key.remoteJidAlt);
  }

  for (const jid of collectKeyJids(stored.key)) {
    const compositeKey = chatMessageKey(stored.key, jid);
    if (compositeKey) {
      messagesByChatAndId.delete(compositeKey);
      messagesByChatAndId.set(compositeKey, stored);
    }
  }

  cleanMessageStore();
  return true;
}

export function configureMessageRetryStore({
  persistPath = '',
  maxMessages: nextMaxMessages = DEFAULT_MAX_MESSAGES,
} = {}) {
  const parsedMax = Number(nextMaxMessages);
  if (Number.isFinite(parsedMax) && parsedMax > 0) {
    maxMessages = Math.floor(parsedMax);
  }
  persistFilePath = persistPath ? path.resolve(String(persistPath)) : '';
  if (!persistFilePath) return 0;

  let loaded = 0;
  try {
    if (fs.existsSync(persistFilePath)) {
      const raw = fs.readFileSync(persistFilePath, 'utf8');
      const items = JSON.parse(raw, deserializeValue);
      if (Array.isArray(items)) {
        for (const item of items.slice(-maxMessages)) {
          if (item?.key?.id && item?.message) {
            indexStoredMessage({
              key: item.key,
              message: item.message,
              timestamp: item.timestamp || Date.now(),
            });
            loaded += 1;
          }
        }
      }
    }
  } catch {
    // Ignore missing or unreadable retry store cache on startup
  }
  return loaded;
}

export function rememberMessage(message) {
  const id = message?.key?.id;
  if (!id || !message?.message) return false;

  const stored = { ...message, timestamp: Date.now() };
  const ok = indexStoredMessage(stored);
  if (ok) {
    schedulePersist();
  }
  return ok;
}

async function resolveCandidateJids(key) {
  const candidates = new Set();
  const seedJids = [key?.remoteJid, key?.remoteJidAlt].filter(Boolean);

  for (const raw of seedJids) {
    const str = String(raw).trim();
    if (str) candidates.add(str);
    const norm = normalizeChatJid(str);
    if (norm) {
      candidates.add(norm);
      const localAliases = chatAliases.get(norm);
      if (localAliases) {
        for (const alias of localAliases) {
          candidates.add(alias);
        }
      }
      if (aliasResolver) {
        try {
          const resolved = await aliasResolver(norm);
          if (Array.isArray(resolved)) {
            for (const alias of resolved) {
              const normAlias = normalizeChatJid(alias);
              if (normAlias) {
                candidates.add(normAlias);
                registerChatAlias(norm, normAlias);
              }
            }
          }
        } catch {
          // Non-fatal alias lookup failure
        }
      }
    }
  }

  return Array.from(candidates);
}

export async function getMessageForRetry(key) {
  if (!key?.id) return undefined;

  const hasRemoteJid = Boolean(key?.remoteJid || key?.remoteJidAlt);
  if (hasRemoteJid) {
    const candidates = await resolveCandidateJids(key);
    for (const jid of candidates) {
      const compositeKey = chatMessageKey(key, jid);
      if (compositeKey) {
        const hit = messagesByChatAndId.get(compositeKey);
        if (hit?.message) return hit.message;
      }
    }

    // Fallback for unresolved 1:1 LID <-> PN retry receipts when the stored message
    // is for the complementary direct JID type (never cross-match groups or different PNs).
    const requestedNorm = normalizeChatJid(key.remoteJid || key.remoteJidAlt);
    if (isDirectJid(requestedNorm)) {
      const byId = messageStore.get(key.id);
      const storedNorm = normalizeChatJid(byId?.key?.remoteJid);
      if (
        byId?.message &&
        isDirectJid(storedNorm) &&
        !isGroupOrBroadcastJid(requestedNorm) &&
        storedNorm.split('@')[1] !== requestedNorm.split('@')[1] &&
        (key.fromMe === undefined || byId.key?.fromMe === undefined || key.fromMe === byId.key.fromMe)
      ) {
        return byId.message;
      }
    }
    return undefined;
  }

  return messageStore.get(key.id)?.message;
}

export function createPreSendPatchCapture(basePatcher = null) {
  return async (message, recipientJids) => {
    const patched =
      typeof basePatcher === 'function' ? await basePatcher(message, recipientJids) : message;
    const ctx = sendContextStorage.getStore();
    if (ctx?.remoteJid && ctx?.messageId) {
      const msgToCache = Array.isArray(patched)
        ? patched[0]?.message || message
        : patched || message;
      if (msgToCache && typeof msgToCache === 'object') {
        rememberMessage({
          key: { remoteJid: ctx.remoteJid, id: ctx.messageId, fromMe: true },
          message: msgToCache,
        });
      }
    }
    return patched;
  };
}

export function installMessageRetryStore(sock) {
  if (!sock || typeof sock.sendMessage !== 'function') return false;
  if (wrappedSockets.has(sock)) return true;

  const originalSendMessage = sock.sendMessage.bind(sock);
  const sendQueues = new Map();
  const getCanonicalQueueKey = (jid) => {
    const norm = normalizeChatJid(jid) || String(jid || '');
    if (!norm) return '';
    const aliases = chatAliases.get(norm);
    if (!aliases || aliases.size === 0) return norm;
    const group = [norm, ...aliases];
    for (const candidate of group) {
      if (sendQueues.has(candidate)) return candidate;
    }
    group.sort((a, b) => {
      const aPn = a.endsWith('@s.whatsapp.net') ? 0 : 1;
      const bPn = b.endsWith('@s.whatsapp.net') ? 0 : 1;
      if (aPn !== bPn) return aPn - bPn;
      return a.localeCompare(b);
    });
    return group[0];
  };
  const enqueueMessage = (jid, operation) => {
    const chatId = getCanonicalQueueKey(jid);
    const previous = sendQueues.get(chatId) || Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    const tail = task.catch(() => {});
    sendQueues.set(chatId, tail);
    task.finally(() => {
      if (sendQueues.get(chatId) === tail) sendQueues.delete(chatId);
    }).catch(() => {});
    return task;
  };
  sock.sendMessage = (...args) => enqueueMessage(args[0], async () => {
    const targetJid = args[0];
    const content = args[1];
    const options = args[2];
    const isLiveSocket = Boolean(sock?.user?.id);
    const explicitMsgId = options && typeof options === 'object' ? options.messageId : undefined;
    const nextMsgId = explicitMsgId || (isLiveSocket ? generateMessageIDV2(sock.user.id) : undefined);

    const runSend = async () => {
      if (isLiveSocket && !explicitMsgId && nextMsgId) {
        const nextOptions =
          options && typeof options === 'object' && !Array.isArray(options)
            ? { ...options, messageId: nextMsgId }
            : { messageId: nextMsgId };
        return originalSendMessage(targetJid, content, nextOptions);
      }
      return originalSendMessage(...args);
    };

    const sentMessage = nextMsgId
      ? await sendContextStorage.run({ remoteJid: targetJid, messageId: nextMsgId }, runSend)
      : await runSend();

    if (sentMessage?.key?.remoteJid && targetJid) {
      registerChatAlias(targetJid, sentMessage.key.remoteJid);
    }
    if (sentMessage?.key?.remoteJid && sentMessage?.key?.remoteJidAlt) {
      registerChatAlias(sentMessage.key.remoteJid, sentMessage.key.remoteJidAlt);
    }
    rememberMessage(sentMessage);
    return sentMessage;
  });

  if (typeof sock.relayMessage === 'function') {
    const originalRelayMessage = sock.relayMessage.bind(sock);
    sock.relayMessage = (jid, message, options = {}) => enqueueMessage(jid, async () => {
      if (options?.messageId && message) {
        rememberMessage({ key: { remoteJid: jid, id: options.messageId, fromMe: true }, message });
      }
      const result = await originalRelayMessage(jid, message, options);
      const id =
        options?.messageId ||
        (typeof result === 'string' ? result : result?.key?.id);
      if (id && message) {
        rememberMessage({ key: { remoteJid: jid, id, fromMe: true }, message });
      }
      return result;
    });
  }

  wrappedSockets.add(sock);
  return true;
}

function resolveWritableAntiStorePath(fileName) {
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

const VALID_ANTIDELETE_MODES = ['indm', 'inchat', 'both'];

export function createAntideleteStore({ filePath = '' } = {}) {
  let state = null;

  function load() {
    if (state) return state;
    const targetPath = filePath || resolveWritableAntiStorePath('antidelete.json');
    try {
      if (fs.existsSync(targetPath)) {
        const parsed = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
        const mode = VALID_ANTIDELETE_MODES.includes(String(parsed?.mode || '').toLowerCase())
          ? String(parsed.mode).toLowerCase()
          : 'indm';
        state = {
          enabled: typeof parsed?.enabled === 'boolean' ? parsed.enabled : Boolean(config.ANTIDELETE ?? true),
          mode,
        };
        return state;
      }
    } catch {}
    state = {
      enabled: Boolean(config.ANTIDELETE ?? true),
      mode: 'indm',
    };
    return state;
  }

  function save(next) {
    const targetPath = filePath || resolveWritableAntiStorePath('antidelete.json');
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(next, null, 2));
    } catch {}
  }

  return {
    getConfig() {
      const cur = load();
      return { ...cur };
    },
    setConfig(patch = {}) {
      const cur = load();
      const nextMode = patch.mode !== undefined
        ? (VALID_ANTIDELETE_MODES.includes(String(patch.mode).toLowerCase()) ? String(patch.mode).toLowerCase() : cur.mode)
        : cur.mode;
      const next = {
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
        mode: nextMode,
      };
      state = next;
      save(next);
      return { ...next };
    },
    reset() {
      state = { enabled: Boolean(config.ANTIDELETE ?? true), mode: 'indm' };
      const targetPath = filePath || resolveWritableAntiStorePath('antidelete.json');
      try {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      } catch {}
    },
  };
}

export const defaultAntideleteStore = createAntideleteStore();

export function listRecentChatMessages(
  chatJid,
  { limit = 10, targetJid = '', alternateJids = [], getPhoneFn = null, includeFromMe = true } = {},
) {
  const normChat = normalizeChatJid(chatJid);
  if (!normChat) return [];

  const chatSet = new Set([normChat]);
  const aliases = chatAliases.get(normChat);
  if (aliases) {
    for (const a of aliases) chatSet.add(normalizeChatJid(a));
  }

  const targetPhones = new Set();
  const targetCleans = new Set();
  const allTargets = [targetJid, ...(Array.isArray(alternateJids) ? alternateJids : [])].filter(Boolean);
  for (const t of allTargets) {
    const c = cleanJid(t).toLowerCase();
    if (c) targetCleans.add(c);
    const p = extractPhoneDigits(t, getPhoneFn);
    if (p) targetPhones.add(p);
  }
  const hasTargetFilter = targetCleans.size > 0 || targetPhones.size > 0;

  const entries = Array.from(messageStore.values()).reverse();
  const out = [];
  const cap = Math.max(1, Math.min(Number(limit) || 10, 50));

  for (const item of entries) {
    if (!item?.key?.id || !item?.message) continue;
    if (item.message?.protocolMessage) continue;
    if (!includeFromMe && item.key.fromMe) continue;

    const itemChat = normalizeChatJid(item.key.remoteJid);
    const itemAltChat = normalizeChatJid(item.key.remoteJidAlt);
    if (!chatSet.has(itemChat) && (!itemAltChat || !chatSet.has(itemAltChat))) continue;

    if (hasTargetFilter) {
      const partJids = [
        item.key.participant,
        item.key.participantAlt,
        item.key.participantPn,
        item.key.senderPn,
        item.key.senderLid,
        !itemChat.endsWith('@g.us') ? itemChat : '',
      ].filter(Boolean);
      const matched = partJids.some((pj) => {
        const cl = cleanJid(pj).toLowerCase();
        if (cl && targetCleans.has(cl)) return true;
        const ph = extractPhoneDigits(pj, getPhoneFn);
        return Boolean(ph && targetPhones.has(ph));
      });
      if (!matched) continue;
    }

    out.push(item);
    if (out.length >= cap) break;
  }

  return out;
}

function isModeratedDeletedId(id) {
  if (!id) return false;
  const store = globalThis.__spiderModeratedDeletedIds;
  if (!(store instanceof Map)) return false;
  const ts = store.get(String(id));
  if (!ts) return false;
  if (Date.now() - ts > 120000) {
    store.delete(String(id));
    return false;
  }
  return true;
}

function findStoredMessageForProtocolKey(protocolKey, chatJid, lidToPhoneMap) {
  const id = protocolKey?.id;
  if (!id) return null;

  const tryChats = new Set();
  for (const raw of [protocolKey?.remoteJid, protocolKey?.remoteJidAlt, chatJid]) {
    if (!raw) continue;
    tryChats.add(String(raw));
    const norm = normalizeChatJid(raw);
    if (norm) {
      tryChats.add(norm);
      const aliases = chatAliases.get(norm);
      if (aliases) {
        for (const a of aliases) tryChats.add(a);
      }
      const userPart = norm.split('@')[0];
      if (lidToPhoneMap instanceof Map) {
        const mappedPn = lidToPhoneMap.get(userPart) || lidToPhoneMap.get(norm);
        if (mappedPn) {
          const pnStr = String(mappedPn).includes('@') ? String(mappedPn) : `${mappedPn}@s.whatsapp.net`;
          tryChats.add(pnStr);
        }
      }
    }
  }

  for (const cid of tryChats) {
    const composite = `${cid}\u0000${id}`;
    const hit = messagesByChatAndId.get(composite);
    if (hit?.message) return hit;
  }

  return messageStore.get(id) || null;
}

function resolveDisplayUser(jid, lidToPhoneMap) {
  const raw = String(jid || '').trim();
  if (!raw) return 'Unknown';
  const phone = extractPhoneDigits(raw, (j) => {
    if (!(lidToPhoneMap instanceof Map)) return null;
    const key = cleanJid(j);
    const bare = key.split('@')[0];
    return lidToPhoneMap.get(key) || lidToPhoneMap.get(bare) || null;
  });
  if (phone) return phone;
  return cleanJid(raw).split('@')[0] || 'Unknown';
}

function extractRecoveredMediaInfo(rawMsg) {
  const unwrapped = unwrapMessageContent(rawMsg);
  if (!unwrapped || typeof unwrapped !== 'object') return null;

  if (unwrapped.imageMessage) return { type: 'image', media: unwrapped.imageMessage, dlType: 'image' };
  if (unwrapped.videoMessage) return { type: 'video', media: unwrapped.videoMessage, dlType: 'video' };
  if (unwrapped.ptvMessage) return { type: 'video', media: unwrapped.ptvMessage, dlType: 'video' };
  if (unwrapped.stickerMessage) return { type: 'sticker', media: unwrapped.stickerMessage, dlType: 'sticker' };
  if (unwrapped.audioMessage) return { type: 'audio', media: unwrapped.audioMessage, dlType: 'audio' };
  if (unwrapped.documentMessage) return { type: 'document', media: unwrapped.documentMessage, dlType: 'document' };
  if (unwrapped.documentWithCaptionMessage?.message?.documentMessage) {
    return {
      type: 'document',
      media: unwrapped.documentWithCaptionMessage.message.documentMessage,
      dlType: 'document',
    };
  }
  return null;
}

async function downloadMediaBufferSafe(mediaInfo) {
  if (!mediaInfo?.media) return null;
  if (Buffer.isBuffer(mediaInfo.media._buffer)) return mediaInfo.media._buffer;
  if (Buffer.isBuffer(mediaInfo.media.buffer)) return mediaInfo.media.buffer;
  try {
    const stream = await downloadContentFromMessage(mediaInfo.media, mediaInfo.dlType);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return chunks.length > 0 ? Buffer.concat(chunks) : null;
  } catch {
    return null;
  }
}

async function resolveChatLabel(sock, chatJid, lidToPhoneMap) {
  if (!chatJid) return 'Unknown Chat';
  if (String(chatJid).endsWith('@g.us')) {
    try {
      const meta = await sock?.groupMetadata?.(chatJid);
      if (meta?.subject) return meta.subject;
    } catch {}
    return chatJid;
  }
  return resolveDisplayUser(chatJid, lidToPhoneMap);
}

function resolveAntiTargets({ mode, ownerJid, chatJid }) {
  const targets = [];
  if (mode === 'inchat') {
    if (chatJid) targets.push(chatJid);
  } else if (mode === 'both') {
    if (ownerJid) targets.push(ownerJid);
    if (chatJid && cleanJid(chatJid).toLowerCase() !== cleanJid(ownerJid).toLowerCase()) {
      targets.push(chatJid);
    }
  } else {
    if (ownerJid) targets.push(ownerJid);
  }
  return Array.from(new Set(targets.filter(Boolean)));
}

export async function handleDeletedMessage(
  revocationMsg,
  sock,
  getRealSenderJid,
  getOwnerJid,
  lidToPhoneMap = null,
) {
  if (!revocationMsg || !sock || typeof sock.sendMessage !== 'function') return { handled: false };

  const protocol = revocationMsg?.message?.protocolMessage;
  if (!protocol || (protocol.type !== 0 && protocol.type !== 'REVOKE')) {
    return { handled: false };
  }

  const targetKey = protocol.key;
  if (!targetKey?.id) return { handled: false };

  // Do not re-broadcast messages intentionally deleted by the bot's own moderation shields.
  if (isModeratedDeletedId(targetKey.id)) {
    return { handled: false, reason: 'bot-moderated' };
  }

  const chatJid = revocationMsg?.key?.remoteJid || targetKey?.remoteJid || '';
  if (chatJid === 'status@broadcast') return { handled: false };

  const stored = findStoredMessageForProtocolKey(targetKey, chatJid, lidToPhoneMap);
  if (!stored || !stored.message) return { handled: false, reason: 'not-found' };

  const storedSender =
    stored?.key?.participant ||
    stored?.key?.participantAlt ||
    stored?.key?.participantPn ||
    stored?.key?.senderPn ||
    (typeof getRealSenderJid === 'function' ? getRealSenderJid(stored) : '') ||
    stored?.key?.remoteJid ||
    '';
  const deletedBy =
    revocationMsg?.key?.participant ||
    revocationMsg?.key?.participantAlt ||
    (typeof getRealSenderJid === 'function' ? getRealSenderJid(revocationMsg) : '') ||
    revocationMsg?.key?.remoteJid ||
    storedSender;

  const fallbackPhoneCandidate = [
    stored?.key?.participantPn,
    stored?.key?.senderPn,
    stored?.key?.participantAlt,
  ]
    .map((cand) => resolveDisplayUser(cand, lidToPhoneMap))
    .find((label) => /^\d{5,16}$/.test(label));
  const resolvedSenderLabel = resolveDisplayUser(storedSender, lidToPhoneMap);
  const senderNum =
    (/^\d{5,16}$/.test(resolvedSenderLabel) ? resolvedSenderLabel : '') ||
    fallbackPhoneCandidate ||
    resolvedSenderLabel;
  const deletedByNum = resolveDisplayUser(deletedBy, lidToPhoneMap);
  const chatLabel = await resolveChatLabel(sock, chatJid, lidToPhoneMap);
  const isGroup = String(chatJid).endsWith('@g.us');

  const recoveredText = extractMessageText(stored, '');
  const mediaInfo = extractRecoveredMediaInfo(stored.message);
  const cfg = defaultAntideleteStore.getConfig();
  const ownerJid = typeof getOwnerJid === 'function' ? getOwnerJid() : '';
  const targets = resolveAntiTargets({ mode: cfg.mode || 'indm', ownerJid, chatJid });
  if (targets.length === 0) return { handled: false, reason: 'no-target' };

  const botName = config?.BOT_NAME || 'Spider Man';
  const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const mentionList = Array.from(
    new Set([cleanJid(storedSender), cleanJid(deletedBy)].filter((j) => j && !j.endsWith('@g.us'))),
  );

  const reportLines = [
    spiderHeader(botName, 'ANTIDELETE RECOVERY'),
    spiderRow('CHAT', isGroup ? `${chatLabel} (Group)` : `@${senderNum}`, '◈'),
    spiderRow('SENDER', `@${senderNum}`, '👤'),
    ...(cleanJid(deletedBy) && cleanJid(deletedBy) !== cleanJid(storedSender)
      ? [spiderRow('DELETED BY', `@${deletedByNum}`, '🗑')]
      : []),
    spiderRow('TYPE', mediaInfo ? mediaInfo.type.toUpperCase() : 'TEXT', '▣'),
    spiderRow('TIME', timeStr, '◷'),
    ...(recoveredText
      ? [spiderDivider('RECOVERED MESSAGE'), `> ┃ ${recoveredText.slice(0, 1500)}`]
      : []),
    spiderFooter('ANTIDELETE // SPIDER-MAN'),
  ].join('\n');

  let mediaBuffer = null;
  if (mediaInfo) {
    mediaBuffer = await downloadMediaBufferSafe(mediaInfo);
  }

  let sentCount = 0;
  for (const dest of targets) {
    try {
      if (mediaBuffer && mediaInfo) {
        if (mediaInfo.type === 'image') {
          await sock.sendMessage(dest, { image: mediaBuffer, caption: reportLines, mentions: mentionList });
          sentCount += 1;
          continue;
        }
        if (mediaInfo.type === 'video') {
          await sock.sendMessage(dest, { video: mediaBuffer, caption: reportLines, mentions: mentionList });
          sentCount += 1;
          continue;
        }
        if (mediaInfo.type === 'document') {
          await sock.sendMessage(dest, {
            document: mediaBuffer,
            fileName: mediaInfo.media?.fileName || 'recovered-file',
            mimetype: mediaInfo.media?.mimetype || 'application/octet-stream',
            caption: reportLines,
            mentions: mentionList,
          });
          sentCount += 1;
          continue;
        }
        if (mediaInfo.type === 'audio') {
          await sock.sendMessage(dest, { text: reportLines, mentions: mentionList });
          await sock.sendMessage(dest, {
            audio: mediaBuffer,
            mimetype: mediaInfo.media?.mimetype || 'audio/mp4',
            ptt: Boolean(mediaInfo.media?.ptt),
          });
          sentCount += 1;
          continue;
        }
        if (mediaInfo.type === 'sticker') {
          await sock.sendMessage(dest, { text: reportLines, mentions: mentionList });
          await sock.sendMessage(dest, { sticker: mediaBuffer });
          sentCount += 1;
          continue;
        }
      }

      await sock.sendMessage(dest, { text: reportLines, mentions: mentionList });
      sentCount += 1;
    } catch {}
  }

  messageStore.delete(targetKey.id);
  return { handled: sentCount > 0, sentCount, chatJid, messageId: targetKey.id };
}

export async function handleEditedMessage(
  editMsg,
  sock,
  getRealSenderJid,
  getOwnerJid,
  lidToPhoneMap = null,
) {
  if (!editMsg || !sock || typeof sock.sendMessage !== 'function') return { handled: false };

  const rawProtocol =
    editMsg?.message?.protocolMessage ||
    editMsg?.message?.editedMessage?.message?.protocolMessage ||
    null;
  if (!rawProtocol || (rawProtocol.type !== 14 && rawProtocol.type !== 'MESSAGE_EDIT')) {
    return { handled: false };
  }

  const targetKey = rawProtocol.key || editMsg.key;
  const chatJid = editMsg?.key?.remoteJid || targetKey?.remoteJid || '';
  if (!chatJid || chatJid === 'status@broadcast') return { handled: false };

  const editedInner = rawProtocol.editedMessage || editMsg?.message?.editedMessage?.message || null;
  const afterText = extractMessageText({ message: editedInner }, '');
  if (!afterText) return { handled: false };

  const stored = targetKey?.id
    ? findStoredMessageForProtocolKey(targetKey, chatJid, lidToPhoneMap)
    : null;
  const beforeText = stored ? extractMessageText(stored, '') : '';

  if (targetKey?.id && editedInner) {
    indexStoredMessage({
      key: stored?.key || { ...targetKey, remoteJid: chatJid },
      message: editedInner,
      timestamp: Date.now(),
    });
  }

  if (beforeText && beforeText === afterText) {
    return { handled: false, reason: 'unchanged' };
  }

  const sender =
    editMsg?.key?.participant ||
    (typeof getRealSenderJid === 'function' ? getRealSenderJid(editMsg) : '') ||
    stored?.key?.participant ||
    chatJid;
  const senderNum = resolveDisplayUser(sender, lidToPhoneMap);
  const chatLabel = await resolveChatLabel(sock, chatJid, lidToPhoneMap);
  const isGroup = String(chatJid).endsWith('@g.us');

  const cfg = defaultAntideleteStore.getConfig();
  const ownerJid = typeof getOwnerJid === 'function' ? getOwnerJid() : '';
  const targets = resolveAntiTargets({ mode: cfg.mode || 'indm', ownerJid, chatJid });
  if (targets.length === 0) return { handled: false, reason: 'no-target' };

  const botName = config?.BOT_NAME || 'Spider Man';
  const mentionList = Array.from(
    new Set([cleanJid(sender)].filter((j) => j && !j.endsWith('@g.us'))),
  );

  const reportLines = [
    spiderHeader(botName, 'ANTIEDIT MONITOR'),
    spiderRow('CHAT', isGroup ? `${chatLabel} (Group)` : `@${senderNum}`, '◈'),
    spiderRow('SENDER', `@${senderNum}`, '👤'),
    spiderDivider('BEFORE'),
    `> ┃ ${beforeText ? beforeText.slice(0, 1000) : '[Original message not cached]'}`,
    spiderDivider('AFTER (EDITED)'),
    `> ┃ ${afterText.slice(0, 1000)}`,
    spiderFooter('ANTIEDIT // SPIDER-MAN'),
  ].join('\n');

  let sentCount = 0;
  for (const dest of targets) {
    try {
      await sock.sendMessage(dest, { text: reportLines, mentions: mentionList });
      sentCount += 1;
    } catch {}
  }

  return { handled: sentCount > 0, sentCount, beforeText, afterText };
}

