import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { generateMessageIDV2 } from '@whiskeysockets/baileys';

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

export async function handleDeletedMessage() {}
export async function handleEditedMessage() {}
