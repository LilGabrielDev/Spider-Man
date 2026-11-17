import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spiderFooter, spiderHeader, spiderRow } from '../../Spider/utils/tableStyle.js';
import { cleanJid, extractMessageText, extractPhone } from './antiscam.js';
import {
  collectBotIdentities,
  collectSenderIdentities,
  resolveGroupRolesAsync,
} from './groupRoleResolver.js';
import {
  deleteMessageSafely,
  executeGroupSettingUpdate,
  executeParticipantsAction,
  resolveSenderDisplayAndMention,
  unwrapMessageContent,
} from './groupActionHelper.js';

export const ANTIDUPLICATE_ACTIONS = Object.freeze(['delete', 'warn', 'kick', 'warnkick', 'mute']);
export const ANTIDUPLICATE_SENSITIVITIES = Object.freeze(['normal', 'sensitive', 'strict']);
export const ANTIDUPLICATE_SCOPES = Object.freeze(['user', 'group']);

export const ANTIDUPLICATE_MIN_WINDOW_SEC = 10;
export const ANTIDUPLICATE_MAX_WINDOW_SEC = 86400;
export const ANTIDUPLICATE_DEFAULT_WINDOW_SEC = 86400;
export const ANTIDUPLICATE_MAX_MESSAGE_AGE_MS = 86400 * 1000;
export const ANTIDUPLICATE_DEFAULT_SENSITIVITY = 'sensitive';
export const ANTIDUPLICATE_DEFAULT_SCOPE = 'user';

const DEFAULT_MAX_WARNS = 3;
const MAX_WHITELIST_ENTRIES = 100;
const MAX_GROUPS_TRACKED = 2000;
const MAX_HISTORY_PER_BUCKET = 250;
const MAX_GROUP_HISTORY_PER_BUCKET = 500;
const ALERT_COOLDOWN_MS = 4000;
const CLEANUP_INTERVAL = 128;

const SENSITIVITY_THRESHOLDS = Object.freeze({
  normal: 0.95,
  sensitive: 0.80,
  strict: 0.72,
});

// Common Cyrillic, Greek, and stylised small-caps homoglyphs mapped to ASCII equivalents
const HOMOGLYPH_MAP = new Map([
  ['а', 'a'], ['à', 'a'], ['á', 'a'], ['â', 'a'], ['ã', 'a'], ['ä', 'a'], ['å', 'a'], ['ɑ', 'a'], ['α', 'a'], ['ᴀ', 'a'],
  ['в', 'b'], ['β', 'b'], ['ʙ', 'b'],
  ['с', 'c'], ['ç', 'c'], ['ϲ', 'c'], ['ᴄ', 'c'],
  ['ԁ', 'd'], ['ɗ', 'd'], ['ᴅ', 'd'],
  ['е', 'e'], ['ё', 'e'], ['è', 'e'], ['é', 'e'], ['ê', 'e'], ['ë', 'e'], ['є', 'e'], ['ε', 'e'], ['ᴇ', 'e'],
  ['ғ', 'f'], ['ꜰ', 'f'],
  ['ɡ', 'g'], ['ɢ', 'g'],
  ['н', 'h'], ['һ', 'h'], ['ʜ', 'h'],
  ['і', 'i'], ['ї', 'i'], ['ì', 'i'], ['í', 'i'], ['î', 'i'], ['ï', 'i'], ['ι', 'i'], ['ɪ', 'i'], ['ı', 'i'],
  ['ј', 'j'], ['ᴊ', 'j'],
  ['к', 'k'], ['κ', 'k'], ['ᴋ', 'k'],
  ['ӏ', 'l'], ['ʟ', 'l'],
  ['м', 'm'], ['μ', 'm'], ['ᴍ', 'm'],
  ['п', 'n'], ['ñ', 'n'], ['η', 'n'], ['ɴ', 'n'],
  ['о', 'o'], ['ө', 'o'], ['ò', 'o'], ['ó', 'o'], ['ô', 'o'], ['õ', 'o'], ['ö', 'o'], ['ø', 'o'], ['ο', 'o'], ['ᴏ', 'o'],
  ['р', 'p'], ['ρ', 'p'], ['ᴘ', 'p'],
  ['ԛ', 'q'],
  ['г', 'r'], ['ʀ', 'r'],
  ['ѕ', 's'], ['ś', 's'], ['š', 's'], ['ş', 's'], ['ꜱ', 's'],
  ['т', 't'], ['τ', 't'], ['ᴛ', 't'],
  ['υ', 'u'], ['ù', 'u'], ['ú', 'u'], ['û', 'u'], ['ü', 'u'], ['ᴜ', 'u'],
  ['ѵ', 'v'], ['ν', 'v'], ['ᴠ', 'v'],
  ['ԝ', 'w'], ['ᴡ', 'w'],
  ['х', 'x'], ['χ', 'x'],
  ['у', 'y'], ['ý', 'y'], ['ÿ', 'y'], ['γ', 'y'], ['ʏ', 'y'],
  ['ᴢ', 'z'], ['ž', 'z'], ['ź', 'z'],
]);

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeWhitelistEntry(raw) {
  const str = String(raw || '').trim();
  if (!str) return '';
  if (str.includes('@')) return cleanJid(str).toLowerCase();
  const digits = normalizeDigits(str);
  if (/^\+?\d{6,16}$/.test(str.replace(/[\s()-]/g, '')) && digits) {
    return digits;
  }
  return str.toLowerCase();
}

function isSenderWhitelisted(senderJid, whitelist = [], getPhoneFn = null) {
  if (!senderJid || !Array.isArray(whitelist) || !whitelist.length) return false;
  const cleaned = cleanJid(senderJid).toLowerCase();
  const digits = (typeof getPhoneFn === 'function' ? getPhoneFn(cleaned) : null) || extractPhone(cleaned);
  return whitelist.some((entry) => entry === cleaned || (digits && entry === digits));
}

export function normalizeSensitivity(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'high' || value === 'sensitive' || value === 'medium' || value === 'default') {
    return 'sensitive';
  }
  if (value === 'strict' || value === 'very' || value === 'ultra' || value === 'extreme' || value === 'max') {
    return 'strict';
  }
  if (value === 'normal' || value === 'low' || value === 'standard' || value === 'exact') {
    return 'normal';
  }
  return ANTIDUPLICATE_SENSITIVITIES.includes(value) ? value : null;
}

export function normalizeScope(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'user' || value === 'per-user' || value === 'peruser' || value === 'sender' || value === 'member') {
    return 'user';
  }
  if (value === 'group' || value === 'all' || value === 'chat' || value === 'global' || value === 'anyone') {
    return 'group';
  }
  return ANTIDUPLICATE_SCOPES.includes(value) ? value : null;
}

function defaultGroupConfig() {
  return {
    enabled: false,
    action: 'delete',
    sensitivity: ANTIDUPLICATE_DEFAULT_SENSITIVITY,
    scope: ANTIDUPLICATE_DEFAULT_SCOPE,
    windowSec: ANTIDUPLICATE_DEFAULT_WINDOW_SEC,
    maxWarns: DEFAULT_MAX_WARNS,
    includeMedia: true,
    notify: true,
    whitelist: [],
    warns: {},
    stats: {
      detected: 0,
      deleted: 0,
      kicked: 0,
      warned: 0,
      muted: 0,
    },
    updatedAt: null,
  };
}

function sanitizeGroupConfig(raw) {
  const base = defaultGroupConfig();
  if (!raw || typeof raw !== 'object') return base;

  const action = ANTIDUPLICATE_ACTIONS.includes(String(raw.action || '').toLowerCase())
    ? String(raw.action).toLowerCase()
    : base.action;

  const sensitivity = normalizeSensitivity(raw.sensitivity) || base.sensitivity;
  const scope = normalizeScope(raw.scope) || base.scope;

  const windowNum = Number(raw.windowSec);
  const windowSec =
    Number.isInteger(windowNum) &&
    windowNum >= ANTIDUPLICATE_MIN_WINDOW_SEC &&
    windowNum <= ANTIDUPLICATE_MAX_WINDOW_SEC
      ? windowNum
      : base.windowSec;

  const maxWarnsNum = Number(raw.maxWarns);
  const maxWarns =
    Number.isInteger(maxWarnsNum) && maxWarnsNum >= 1 && maxWarnsNum <= 10
      ? maxWarnsNum
      : base.maxWarns;

  const whitelist = Array.isArray(raw.whitelist)
    ? [...new Set(raw.whitelist.map((w) => normalizeWhitelistEntry(w)).filter(Boolean))].slice(
        0,
        MAX_WHITELIST_ENTRIES,
      )
    : [];

  const warns = {};
  if (raw.warns && typeof raw.warns === 'object') {
    for (const [k, v] of Object.entries(raw.warns)) {
      const count = Number(v);
      if (k && Number.isInteger(count) && count > 0) {
        warns[k] = count;
      }
    }
  }

  return {
    enabled: Boolean(raw.enabled),
    action,
    sensitivity,
    scope,
    windowSec,
    maxWarns,
    includeMedia: raw.includeMedia !== undefined ? Boolean(raw.includeMedia) : true,
    notify: raw.notify !== undefined ? Boolean(raw.notify) : true,
    whitelist,
    warns,
    stats: {
      detected: Math.max(0, Number(raw.stats?.detected || 0)),
      deleted: Math.max(0, Number(raw.stats?.deleted || 0)),
      kicked: Math.max(0, Number(raw.stats?.kicked || 0)),
      warned: Math.max(0, Number(raw.stats?.warned || 0)),
      muted: Math.max(0, Number(raw.stats?.muted || 0)),
    },
    updatedAt: raw.updatedAt || null,
  };
}

export function createAntiduplicateStore(storePathOrResolver = null) {
  const isDefault = storePathOrResolver === null || storePathOrResolver === undefined;
  let tmpFallbackPath = null;
  let cachedPath = null;
  let cachedGroups = null;

  function resolvePath() {
    if (!isDefault) {
      return typeof storePathOrResolver === 'function' ? storePathOrResolver() : storePathOrResolver;
    }
    return tmpFallbackPath || path.join(process.cwd(), 'data', 'antiduplicate.json');
  }

  function loadAll() {
    const filePath = resolvePath();
    if (cachedGroups && cachedPath === filePath) {
      return cachedGroups;
    }

    let parsed = {};
    let loadedFrom = filePath;
    const candidates =
      isDefault && !tmpFallbackPath
        ? [filePath, path.join(os.tmpdir(), 'spider-data', 'antiduplicate.json')]
        : [filePath];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          if (raw && typeof raw === 'object' && raw.groups && typeof raw.groups === 'object') {
            parsed = raw.groups;
            loadedFrom = candidate;
            if (candidate !== filePath) {
              tmpFallbackPath = candidate;
            }
            break;
          }
        }
      } catch {
        parsed = {};
      }
    }

    const next = new Map();
    for (const [groupId, cfg] of Object.entries(parsed)) {
      next.set(groupId, sanitizeGroupConfig(cfg));
    }

    cachedPath = loadedFrom;
    cachedGroups = next;
    return cachedGroups;
  }

  function writeTarget(filePath, serialized) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify({ groups: serialized }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {}
  }

  function saveAll(groupsMap) {
    const filePath = resolvePath();
    const serialized = {};
    for (const [groupId, cfg] of groupsMap.entries()) {
      serialized[groupId] = sanitizeGroupConfig(cfg);
    }

    try {
      writeTarget(filePath, serialized);
      cachedPath = filePath;
    } catch {
      if (isDefault) {
        const fallback = path.join(os.tmpdir(), 'spider-data', 'antiduplicate.json');
        try {
          writeTarget(fallback, serialized);
          tmpFallbackPath = fallback;
          cachedPath = fallback;
        } catch {
          cachedPath = filePath;
        }
      } else {
        cachedPath = filePath;
      }
    }
    cachedGroups = groupsMap;
  }

  function getGroupConfig(groupJid) {
    const groups = loadAll();
    const existing = groups.get(groupJid);
    return sanitizeGroupConfig(existing);
  }

  function setGroupConfig(groupJid, updater) {
    const groups = loadAll();
    const current = sanitizeGroupConfig(groups.get(groupJid));
    const patch = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
    const updated = sanitizeGroupConfig({
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    groups.set(groupJid, updated);
    saveAll(groups);
    return sanitizeGroupConfig(updated);
  }

  function addWarn(groupJid, senderJid) {
    const key = cleanJid(senderJid) || String(senderJid || 'unknown');
    let nextCount = 1;
    let maxWarns = DEFAULT_MAX_WARNS;
    setGroupConfig(groupJid, (cfg) => {
      maxWarns = cfg.maxWarns || DEFAULT_MAX_WARNS;
      const warns = { ...cfg.warns };
      nextCount = (Number(warns[key]) || 0) + 1;
      warns[key] = nextCount;
      return { ...cfg, warns };
    });
    return { count: nextCount, maxWarns };
  }

  function resetWarns(groupJid, senderJid = null) {
    return setGroupConfig(groupJid, (cfg) => {
      if (!senderJid) {
        return { ...cfg, warns: {} };
      }
      const key = cleanJid(senderJid);
      const warns = { ...cfg.warns };
      delete warns[key];
      const phone = extractPhone(key);
      if (phone) {
        for (const existingKey of Object.keys(warns)) {
          if (extractPhone(existingKey) === phone) {
            delete warns[existingKey];
          }
        }
      }
      return { ...cfg, warns };
    });
  }

  function addWhitelist(groupJid, entry) {
    const normalized = normalizeWhitelistEntry(entry);
    if (!normalized) return { added: false, entry: '', config: getGroupConfig(groupJid) };
    let added = false;
    const config = setGroupConfig(groupJid, (cfg) => {
      if (cfg.whitelist.includes(normalized)) return cfg;
      added = true;
      return {
        ...cfg,
        whitelist: [...cfg.whitelist, normalized].slice(-MAX_WHITELIST_ENTRIES),
      };
    });
    return { added, entry: normalized, config };
  }

  function removeWhitelist(groupJid, entry) {
    const normalized = normalizeWhitelistEntry(entry);
    let removed = false;
    const config = setGroupConfig(groupJid, (cfg) => {
      const next = cfg.whitelist.filter((item) => item !== normalized);
      removed = next.length !== cfg.whitelist.length;
      return { ...cfg, whitelist: next };
    });
    return { removed, entry: normalized, config };
  }

  function recordAction(
    groupJid,
    { detected = 1, deleted = 0, kicked = 0, warned = 0, muted = 0 } = {},
  ) {
    return setGroupConfig(groupJid, (cfg) => ({
      ...cfg,
      stats: {
        detected: cfg.stats.detected + detected,
        deleted: cfg.stats.deleted + deleted,
        kicked: cfg.stats.kicked + kicked,
        warned: cfg.stats.warned + warned,
        muted: cfg.stats.muted + muted,
      },
    }));
  }

  function flush() {
    if (cachedGroups) {
      saveAll(cachedGroups);
    }
  }

  function clearCache() {
    cachedPath = null;
    cachedGroups = null;
  }

  return {
    getGroupConfig,
    setGroupConfig,
    addWarn,
    resetWarns,
    addWhitelist,
    removeWhitelist,
    recordAction,
    flush,
    clearCache,
  };
}

export const defaultAntiduplicateStore = createAntiduplicateStore();

function stripInvisibleChars(str) {
  return String(str || '').replace(
    /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\u00AD\u034F\u180E]/g,
    '',
  );
}

function foldHomoglyphs(str) {
  const nfkd = stripInvisibleChars(String(str || '').normalize('NFKC'))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  let out = '';
  for (const ch of nfkd) {
    out += HOMOGLYPH_MAP.get(ch) || ch;
  }
  return out;
}

function squashStretch(str, minRun = 3) {
  const chars = Array.from(String(str || ''));
  if (!chars.length) return '';
  const out = [];
  let runChar = '';
  let runLen = 0;

  const flushRun = () => {
    if (!runChar) return;
    if (runLen >= minRun) {
      out.push(runChar);
    } else {
      for (let i = 0; i < runLen; i += 1) out.push(runChar);
    }
  };

  for (const ch of chars) {
    if (ch === runChar) {
      runLen += 1;
    } else {
      flushRun();
      runChar = ch;
      runLen = 1;
    }
  }
  flushRun();
  return out.join('');
}

export function normalizeDuplicateText(rawText) {
  const cleanedRaw = stripInvisibleChars(String(rawText || '').normalize('NFKC'))
    .replace(/\s+/g, ' ')
    .trim();
  const exactNormalized = cleanedRaw.toLowerCase();

  const folded = foldHomoglyphs(cleanedRaw)
    .replace(/\b([\p{L}\p{N}])(?:[._*\-]+([\p{L}\p{N}])){2,}\b/gu, (m) =>
      m.replace(/[._*\-]+/g, ''),
    )
    .replace(/(?<![\p{L}\p{N}])([\p{L}\p{N}])(?:\s+([\p{L}\p{N}])){2,}(?![\p{L}\p{N}])/gu, (m) =>
      m.replace(/\s+/g, ''),
    )
    .replace(/\s+/g, ' ')
    .trim();

  const alnumCompact = folded.replace(/[^\p{L}\p{N}]/gu, '');
  const visualCompact = stripInvisibleChars(cleanedRaw)
    .toLowerCase()
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/\s+/g, '');

  const stretch3 = squashStretch(alnumCompact, 3);
  const squashedAll = squashStretch(alnumCompact, 2);
  const squashedVisual = squashStretch(visualCompact, 2);

  return {
    raw: cleanedRaw,
    exactNormalized,
    folded,
    alnumCompact,
    visualCompact,
    stretch3,
    squashedAll,
    squashedVisual,
  };
}

function hashValue(val) {
  if (!val) return '';
  if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
    return crypto.createHash('sha1').update(Buffer.from(val)).digest('hex').slice(0, 20);
  }
  if (typeof val === 'string' && val.trim()) {
    return crypto.createHash('sha1').update(val.trim()).digest('hex').slice(0, 20);
  }
  if (Array.isArray(val) && val.length > 0) {
    return crypto.createHash('sha1').update(Buffer.from(val)).digest('hex').slice(0, 20);
  }
  return '';
}

function buildMediaContentKey(kind, mediaObj) {
  if (!mediaObj || typeof mediaObj !== 'object') return null;
  const sha = hashValue(mediaObj.fileSha256 || mediaObj.fileEncSha256);
  if (sha) return `${kind}:sha:${sha}`;

  const mediaKey = hashValue(mediaObj.mediaKey);
  if (mediaKey) return `${kind}:mk:${mediaKey}`;

  const pathHash = hashValue(mediaObj.directPath || mediaObj.url);
  if (pathHash) return `${kind}:url:${pathHash}`;

  const len = mediaObj.fileLength ? String(mediaObj.fileLength) : '';
  const mime = String(mediaObj.mimetype || '').toLowerCase();
  const extra = mediaObj.fileName || mediaObj.seconds || mediaObj.pageCount || '';
  if (len || extra) {
    return `${kind}:meta:${len}:${mime}:${String(extra).toLowerCase()}`;
  }
  if (kind === 'sticker') {
    return `sticker:bare:${mime || 'webp'}`;
  }
  return null;
}

export function extractMediaFingerprint(msg) {
  const unwrapped = unwrapMessageContent(msg?.message);
  if (!unwrapped || typeof unwrapped !== 'object') return null;

  if (unwrapped.protocolMessage || unwrapped.reactionMessage || unwrapped.senderKeyDistributionMessage) {
    // Ignore protocol / reaction / key distribution control frames unless wrapped around actual message
    if (!unwrapped.conversation && !unwrapped.extendedTextMessage) {
      return null;
    }
  }

  if (unwrapped.stickerMessage) {
    const key = buildMediaContentKey('sticker', unwrapped.stickerMessage);
    if (key) return { kind: 'sticker', key };
  }
  if (unwrapped.imageMessage) {
    const key = buildMediaContentKey('image', unwrapped.imageMessage);
    if (key) return { kind: 'image', key };
  }
  if (unwrapped.videoMessage) {
    const key = buildMediaContentKey('video', unwrapped.videoMessage);
    if (key) return { kind: 'video', key };
  }
  if (unwrapped.ptvMessage) {
    const key = buildMediaContentKey('video', unwrapped.ptvMessage);
    if (key) return { kind: 'video', key };
  }
  if (unwrapped.audioMessage) {
    const key = buildMediaContentKey('audio', unwrapped.audioMessage);
    if (key) return { kind: 'audio', key };
  }
  if (unwrapped.documentMessage) {
    const key = buildMediaContentKey('document', unwrapped.documentMessage);
    if (key) return { kind: 'document', key };
  }

  const loc = unwrapped.locationMessage || unwrapped.liveLocationMessage;
  if (loc && Number.isFinite(Number(loc.degreesLatitude)) && Number.isFinite(Number(loc.degreesLongitude))) {
    const lat = Number(loc.degreesLatitude).toFixed(4);
    const lng = Number(loc.degreesLongitude).toFixed(4);
    const label = String(loc.name || loc.address || '').trim().toLowerCase();
    return { kind: 'location', key: `loc:${lat},${lng}:${label}` };
  }

  const poll =
    unwrapped.pollCreationMessage ||
    unwrapped.pollCreationMessageV2 ||
    unwrapped.pollCreationMessageV3;
  if (poll?.name) {
    const opts = Array.isArray(poll.options)
      ? poll.options.map((o) => String(o?.optionName || '').trim().toLowerCase()).filter(Boolean).sort()
      : [];
    return {
      kind: 'poll',
      key: `poll:${foldHomoglyphs(poll.name)}::${opts.join('|')}`,
    };
  }

  if (unwrapped.contactMessage) {
    const name = foldHomoglyphs(unwrapped.contactMessage.displayName || '');
    const vcardDigits = normalizeDigits(unwrapped.contactMessage.vcard || '');
    if (vcardDigits || name) {
      return { kind: 'contact', key: `contact:${vcardDigits || name}` };
    }
  }

  return null;
}

export function buildMessageFingerprint(msg, fallbackText = '') {
  const unwrapped = unwrapMessageContent(msg?.message);
  if (
    unwrapped &&
    typeof unwrapped === 'object' &&
    (unwrapped.protocolMessage || unwrapped.reactionMessage || unwrapped.senderKeyDistributionMessage) &&
    !unwrapped.conversation &&
    !unwrapped.extendedTextMessage
  ) {
    return null;
  }

  const rawText = extractMessageText(msg, fallbackText);
  const textNorm = rawText ? normalizeDuplicateText(rawText) : null;
  const hasText = Boolean(textNorm && textNorm.visualCompact);
  const media = extractMediaFingerprint(msg);

  if (!hasText && !media) return null;

  return {
    hasText,
    text: hasText ? textNorm : null,
    media,
    kind: media?.kind || 'text',
  };
}

function diceBigramSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const mapA = new Map();
  for (let i = 0; i < a.length - 1; i += 1) {
    const bg = a.slice(i, i + 2);
    mapA.set(bg, (mapA.get(bg) || 0) + 1);
  }

  let shared = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const bg = b.slice(i, i + 2);
    const count = mapA.get(bg) || 0;
    if (count > 0) {
      shared += 1;
      mapA.set(bg, count - 1);
    }
  }

  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

function levenshteinSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const s1 = a.slice(0, 320);
  const s2 = b.slice(0, 320);
  const m = s1.length;
  const n = s2.length;
  const maxLen = Math.max(m, n);
  if (maxLen === 0) return 1;

  if (Math.abs(m - n) / maxLen > 0.45) {
    return 1 - Math.abs(m - n) / maxLen;
  }

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;

  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    const ch1 = s1.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      const cost = ch1 === s2.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return 1 - prev[n] / maxLen;
}

function tokenOverlapSimilarity(strA, strB) {
  const wordsA = strA.split(/\s+/).filter(Boolean);
  const wordsB = strB.split(/\s+/).filter(Boolean);
  if (wordsA.length < 2 || wordsB.length < 2) return 0;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection += 1;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

export function compareFingerprints(currentFp, previousFp, { sensitivity = ANTIDUPLICATE_DEFAULT_SENSITIVITY } = {}) {
  if (!currentFp || !previousFp) {
    return { isDuplicate: false, similarity: 0, matchType: null, reason: '' };
  }

  const level = normalizeSensitivity(sensitivity) || ANTIDUPLICATE_DEFAULT_SENSITIVITY;
  const threshold = SENSITIVITY_THRESHOLDS[level];

  if (currentFp.media && previousFp.media && currentFp.media.key === previousFp.media.key) {
    // If both are media with no differing text, or caption also matches (or sensitive/strict mode), mark duplicate
    if (!currentFp.hasText && !previousFp.hasText) {
      return {
        isDuplicate: true,
        similarity: 1,
        matchType: 'media',
        reason: `Duplicate ${currentFp.media.kind}`,
      };
    }
    if (level !== 'normal') {
      return {
        isDuplicate: true,
        similarity: 1,
        matchType: 'media',
        reason: `Duplicate ${currentFp.media.kind} attachment`,
      };
    }
  }

  if (!currentFp.hasText || !previousFp.hasText) {
    return { isDuplicate: false, similarity: 0, matchType: null, reason: '' };
  }

  const a = currentFp.text;
  const b = previousFp.text;

  if (a.exactNormalized === b.exactNormalized) {
    return { isDuplicate: true, similarity: 1, matchType: 'exact', reason: 'Exact duplicate message' };
  }

  if (a.visualCompact && a.visualCompact === b.visualCompact) {
    return {
      isDuplicate: true,
      similarity: 1,
      matchType: 'normalized',
      reason: 'Duplicate message (invisible/spacing variation)',
    };
  }

  if (a.alnumCompact && b.alnumCompact && a.alnumCompact === b.alnumCompact) {
    return {
      isDuplicate: true,
      similarity: 1,
      matchType: 'obfuscated',
      reason: 'Duplicate message (case/punctuation/font variation)',
    };
  }

  if (level !== 'normal') {
    // Repeated emoji strings like "🔥🔥" vs "🔥🔥🔥🔥"
    if (!a.alnumCompact && !b.alnumCompact && a.squashedVisual && a.squashedVisual === b.squashedVisual) {
      return {
        isDuplicate: true,
        similarity: 0.96,
        matchType: 'emoji',
        reason: 'Duplicate emoji spam',
      };
    }

    // Stretched 3+ repeated characters like "helloooo" vs "hello"
    if (a.stretch3 && a.stretch3 === b.stretch3 && a.stretch3.length >= 3) {
      return {
        isDuplicate: true,
        similarity: 0.95,
        matchType: 'stretched',
        reason: 'Duplicate message (stretched letters)',
      };
    }

    // All-squashed form (e.g. "hheelllloooo" vs "hello") guarded by >= 4 compacted length
    if (
      a.squashedAll &&
      a.squashedAll === b.squashedAll &&
      Math.min(a.alnumCompact.length, b.alnumCompact.length) >= 4
    ) {
      return {
        isDuplicate: true,
        similarity: 0.92,
        matchType: 'stretched',
        reason: 'Duplicate message (character-repeat bypass)',
      };
    }
  }

  // Fuzzy similarity on strings >= 5 alphanumeric chars (short words <= 4 chars must match exactly/compact/stretched)
  const strA = a.alnumCompact;
  const strB = b.alnumCompact;
  if (Math.min(strA.length, strB.length) >= 5) {
    const dice = diceBigramSimilarity(strA, strB);
    const editSim = strA.length <= 320 && strB.length <= 320 ? levenshteinSimilarity(strA, strB) : dice;
    const tokenSim = tokenOverlapSimilarity(a.folded, b.folded);
    const combined = Math.max(dice, editSim, tokenSim);

    if (combined >= threshold) {
      return {
        isDuplicate: true,
        similarity: Number(combined.toFixed(3)),
        matchType: 'fuzzy',
        reason: `Near-duplicate message (${Math.round(combined * 100)}% similar)`,
      };
    }
  }

  return { isDuplicate: false, similarity: 0, matchType: null, reason: '' };
}

export function extractMessageTimestampMs(msg) {
  const raw = msg?.messageTimestamp ?? msg?.timestamp;
  if (raw === null || raw === undefined) return null;
  let num = null;
  if (typeof raw === 'number') {
    num = raw;
  } else if (typeof raw === 'bigint') {
    num = Number(raw);
  } else if (typeof raw === 'string' && raw.trim()) {
    num = Number(raw.trim());
  } else if (typeof raw === 'object') {
    if (typeof raw.toNumber === 'function') {
      num = raw.toNumber();
    } else if (Number.isFinite(Number(raw.low))) {
      const high = Number(raw.high) || 0;
      num = high * 4294967296 + (Number(raw.low) >>> 0);
    }
  }
  if (!Number.isFinite(num) || num <= 0) return null;
  return num < 1e12 ? num * 1000 : num;
}

export function isMessageSentWithin24Hours(msg, nowMs = Date.now()) {
  const msgTsMs = extractMessageTimestampMs(msg);
  if (msgTsMs === null) return true;
  if (!Number.isFinite(nowMs)) return true;
  return nowMs - msgTsMs <= ANTIDUPLICATE_MAX_MESSAGE_AGE_MS;
}

export function createDuplicateTracker({ now = Date.now, maxGroups = MAX_GROUPS_TRACKED } = {}) {
  const buckets = new Map();
  const alertCooldowns = new Map();
  let callsSinceCleanup = 0;
  let lastObservedTime = Number.NEGATIVE_INFINITY;

  function makeSenderKey(senderJid, getPhoneFn = null) {
    const cleaned = cleanJid(senderJid);
    const phone = (typeof getPhoneFn === 'function' ? getPhoneFn(cleaned) : null) || extractPhone(cleaned);
    return phone || cleaned || String(senderJid || 'unknown');
  }

  function makeBucketKey(groupJid, senderJid, scope = ANTIDUPLICATE_DEFAULT_SCOPE, getPhoneFn = null) {
    if (scope === 'group') {
      return `${String(groupJid || '')}::__group__`;
    }
    return `${String(groupJid || '')}::${makeSenderKey(senderJid, getPhoneFn)}`;
  }

  function currentTimeMs() {
    const raw = now();
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new RangeError('now() must return a finite number.');
    }
    lastObservedTime = Math.max(raw, lastObservedTime);
    return lastObservedTime;
  }

  function isMessageWithin24h(msg) {
    return isMessageSentWithin24Hours(msg, currentTimeMs());
  }

  function pruneExpired(entries, cutoffMs) {
    let writeIdx = 0;
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i].ts >= cutoffMs) {
        if (writeIdx !== i) {
          entries[writeIdx] = entries[i];
        }
        writeIdx += 1;
      }
    }
    if (writeIdx < entries.length) {
      entries.length = writeIdx;
    }
  }

  function pruneStale(nowMs) {
    const maxAgeCutoff = nowMs - ANTIDUPLICATE_MAX_MESSAGE_AGE_MS;
    for (const [key, bucket] of buckets.entries()) {
      const effectiveWindowMs = Math.min(
        bucket.windowMs || ANTIDUPLICATE_DEFAULT_WINDOW_SEC * 1000,
        ANTIDUPLICATE_MAX_MESSAGE_AGE_MS,
      );
      const cutoffMs = Math.max(nowMs - effectiveWindowMs, maxAgeCutoff);
      pruneExpired(bucket.entries, cutoffMs);
      if (bucket.entries.length === 0) {
        buckets.delete(key);
      }
    }
    for (const [cdKey, lastAt] of alertCooldowns.entries()) {
      if (nowMs - lastAt > ALERT_COOLDOWN_MS * 4) {
        alertCooldowns.delete(cdKey);
      }
    }
  }

  function checkAndRecord(
    groupJid,
    senderJid,
    {
      msg = null,
      text = '',
      windowSec = ANTIDUPLICATE_DEFAULT_WINDOW_SEC,
      sensitivity = ANTIDUPLICATE_DEFAULT_SENSITIVITY,
      scope = ANTIDUPLICATE_DEFAULT_SCOPE,
      includeMedia = true,
      getPhoneFn = null,
    } = {},
  ) {
    const fp = buildMessageFingerprint(msg, text);
    if (!fp) {
      return { isDuplicate: false, skipped: 'empty-fingerprint' };
    }
    if (!includeMedia && !fp.hasText) {
      return { isDuplicate: false, skipped: 'media-disabled' };
    }

    const nowMs = currentTimeMs();
    const msgTsMs = extractMessageTimestampMs(msg);
    if (msgTsMs !== null && nowMs - msgTsMs > ANTIDUPLICATE_MAX_MESSAGE_AGE_MS) {
      return { isDuplicate: false, skipped: 'message-older-than-24h' };
    }

    const effectiveTs = msgTsMs !== null ? Math.min(msgTsMs, nowMs) : nowMs;
    const windowMs = Math.max(
      ANTIDUPLICATE_MIN_WINDOW_SEC * 1000,
      Math.min(
        ANTIDUPLICATE_MAX_WINDOW_SEC * 1000,
        ANTIDUPLICATE_MAX_MESSAGE_AGE_MS,
        Number(windowSec || ANTIDUPLICATE_DEFAULT_WINDOW_SEC) * 1000,
      ),
    );
    const cutoffMs = Math.max(nowMs - windowMs, nowMs - ANTIDUPLICATE_MAX_MESSAGE_AGE_MS);

    callsSinceCleanup += 1;
    if (callsSinceCleanup >= CLEANUP_INTERVAL) {
      pruneStale(nowMs);
      callsSinceCleanup = 0;
    }

    const resolvedScope = normalizeScope(scope) || ANTIDUPLICATE_DEFAULT_SCOPE;
    const key = makeBucketKey(groupJid, senderJid, resolvedScope, getPhoneFn);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { entries: [], windowMs };
    } else {
      buckets.delete(key);
      bucket.windowMs = windowMs;
    }

    pruneExpired(bucket.entries, cutoffMs);

    const effectiveFp = includeMedia ? fp : { ...fp, media: null };
    let match = null;
    for (let i = bucket.entries.length - 1; i >= 0; i -= 1) {
      const candidate = bucket.entries[i];
      if (
        nowMs - candidate.ts > ANTIDUPLICATE_MAX_MESSAGE_AGE_MS ||
        Math.abs(effectiveTs - candidate.ts) > windowMs
      ) {
        continue;
      }
      const res = compareFingerprints(effectiveFp, candidate.fp, { sensitivity });
      if (res.isDuplicate) {
        match = { ...res, repeatCount: candidate.repeatCount + 1, matchedTs: candidate.ts };
        candidate.repeatCount += 1;
        break;
      }
    }

    if (!match) {
      const historyCap = resolvedScope === 'group' ? MAX_GROUP_HISTORY_PER_BUCKET : MAX_HISTORY_PER_BUCKET;
      bucket.entries.push({ fp: effectiveFp, ts: effectiveTs, repeatCount: 1 });
      if (bucket.entries.length > historyCap) {
        bucket.entries.splice(0, bucket.entries.length - historyCap);
      }
    }

    buckets.set(key, bucket);

    if (buckets.size > maxGroups * 10) {
      pruneStale(nowMs);
      while (buckets.size > maxGroups * 10) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey === undefined) break;
        buckets.delete(oldestKey);
      }
    }

    const alertKey = `${String(groupJid || '')}::${makeSenderKey(senderJid, getPhoneFn)}`;
    const lastAlertAt = alertCooldowns.get(alertKey) ?? Number.NEGATIVE_INFINITY;
    const alertCooldownElapsed = nowMs - lastAlertAt >= ALERT_COOLDOWN_MS;

    return {
      isDuplicate: Boolean(match),
      similarity: match?.similarity || 0,
      matchType: match?.matchType || null,
      reason: match?.reason || '',
      repeatCount: match?.repeatCount || 1,
      alertCooldownElapsed,
    };
  }

  function markAlertSent(groupJid, senderJid, getPhoneFn = null) {
    const alertKey = `${String(groupJid || '')}::${makeSenderKey(senderJid, getPhoneFn)}`;
    alertCooldowns.set(alertKey, currentTimeMs());
  }

  function resetGroup(groupJid) {
    const prefix = `${String(groupJid || '')}::`;
    for (const key of buckets.keys()) {
      if (key.startsWith(prefix)) buckets.delete(key);
    }
    for (const key of alertCooldowns.keys()) {
      if (key.startsWith(prefix)) alertCooldowns.delete(key);
    }
  }

  function clear() {
    buckets.clear();
    alertCooldowns.clear();
    lastObservedTime = Number.NEGATIVE_INFINITY;
    callsSinceCleanup = 0;
  }

  return {
    checkAndRecord,
    isMessageWithin24h,
    markAlertSent,
    resetGroup,
    clear,
  };
}

export const defaultDuplicateTracker = createDuplicateTracker();

function formatAlertMessage({
  botName,
  actionLabel,
  targetUser,
  reason,
  warnText = '',
  warningMessage = '',
}) {
  const lines = [
    spiderHeader(botName || 'Spider Man', 'ANTIDUPLICATE SHIELD'),
    spiderRow('USER', `@${targetUser}`, '⚠'),
    spiderRow('ACTION', actionLabel, '⛨'),
    spiderRow('REASON', reason || 'Duplicate message detected', '◈'),
  ];
  if (warnText) {
    lines.push(spiderRow('WARNINGS', warnText, '▣'));
  }
  if (warningMessage) {
    lines.push(spiderRow('WARNING', warningMessage, '⚠'));
  }
  lines.push(spiderFooter('NO DUPLICATE MESSAGES ALLOWED'));
  return lines.join('\n');
}

export async function handleAntiDuplicateMessage({
  sock,
  from,
  sender,
  msg,
  text = '',
  isOwner = false,
  groupMeta = null,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntiduplicateStore,
  tracker = defaultDuplicateTracker,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !from || !String(from).endsWith('@g.us') || !msg || msg.key?.fromMe) {
    return { handled: false, reason: 'not-applicable' };
  }

  const groupConfig = store.getGroupConfig(from);
  if (!groupConfig.enabled) {
    return { handled: false, reason: 'disabled' };
  }

  if (typeof tracker?.isMessageWithin24h === 'function' && !tracker.isMessageWithin24h(msg)) {
    return { handled: false, reason: 'message-older-than-24h' };
  }

  if (isOwner) {
    return { handled: false, reason: 'owner-exempt' };
  }

  const senderCandidates = collectSenderIdentities(msg, [sender]);
  const senderJid = senderCandidates[0] || sender || msg.key?.participant || '';
  if (senderCandidates.some((cand) => isSenderWhitelisted(cand, groupConfig.whitelist, getPhoneFromJid))) {
    return { handled: false, reason: 'whitelisted' };
  }

  let metadata = groupMeta;
  if (!metadata) {
    try {
      metadata =
        typeof fetchGroupMetadata === 'function'
          ? await fetchGroupMetadata(from)
          : typeof sock.groupMetadata === 'function'
            ? await sock.groupMetadata(from)
            : null;
    } catch {
      metadata = null;
    }
  }

  const botCandidates = collectBotIdentities(sock);
  const { senderRole, botRole } = await resolveGroupRolesAsync({
    metadata,
    sock,
    senderJids: senderCandidates,
    getPhoneFn: getPhoneFromJid,
  });
  if (senderRole.isAdmin) {
    return { handled: false, reason: 'sender-is-admin' };
  }

  const dupResult = tracker.checkAndRecord(from, senderJid, {
    msg,
    text,
    windowSec: groupConfig.windowSec,
    sensitivity: groupConfig.sensitivity,
    scope: groupConfig.scope,
    includeMedia: groupConfig.includeMedia,
    getPhoneFn: getPhoneFromJid,
  });

  if (!dupResult.isDuplicate) {
    return { handled: false, reason: dupResult.skipped || 'unique' };
  }

  if (metadata && botCandidates.length > 0 && !botRole.isAdmin) {
    return { handled: false, reason: 'bot-not-admin', detection: dupResult };
  }

  const {
    targetJid,
    mentionJid,
    targetUser,
    candidates: resolvedCandidates,
  } = resolveSenderDisplayAndMention({
    senderRole,
    senderJid,
    senderCandidates,
    metadata,
    getPhoneFn: getPhoneFromJid,
  });

  const delRes = msg.key?.id
    ? await deleteMessageSafely({
        sock,
        from,
        msg,
        targetJid,
        senderCandidates: resolvedCandidates,
        metadata,
        getPhoneFn: getPhoneFromJid,
        broadcastAlternates: true,
      })
    : { ok: false };
  const deleted = delRes.ok;

  let kicked = false;
  let warned = false;
  let muted = false;
  let warnCount = 0;
  let maxWarns = groupConfig.maxWarns;
  let actionLabel = deleted ? 'DUPLICATE DELETED' : 'DELETE FAILED';
  let warnText = '';
  let warningMessage = '';
  let shouldAlert = dupResult.alertCooldownElapsed;

  const mode = groupConfig.action;
  if (mode === 'warn') {
    const warnResult = store.addWarn(from, targetJid);
    warned = true;
    warnCount = warnResult.count;
    maxWarns = warnResult.maxWarns;
    actionLabel = deleted ? 'DELETED & WARNED' : 'WARNED (DELETE FAILED)';
    warnText = `${warnCount}/${maxWarns}`;
    shouldAlert = true;
  } else if (mode === 'kick') {
    const kickRes = targetJid
      ? await executeParticipantsAction({
          sock,
          from,
          participants: [targetJid],
          action: 'remove',
          metadata,
        })
      : { ok: false };
    kicked = kickRes.ok;
    actionLabel = kicked
      ? deleted
        ? 'DELETED & KICKED'
        : 'KICKED (DELETE FAILED)'
      : deleted
        ? 'DELETED (KICK FAILED)'
        : 'KICK & DELETE FAILED';
    shouldAlert = true;
  } else if (mode === 'warnkick') {
    const warnResult = store.addWarn(from, targetJid);
    warned = true;
    warnCount = warnResult.count;
    maxWarns = warnResult.maxWarns;
    warnText = `${warnCount}/${maxWarns}`;
    shouldAlert = true;

    if (warnCount >= maxWarns) {
      const kickRes = targetJid
        ? await executeParticipantsAction({
            sock,
            from,
            participants: [targetJid],
            action: 'remove',
            metadata,
          })
        : { ok: false };
      kicked = kickRes.ok;
      if (kicked) {
        store.resetWarns(from, targetJid);
      }
      actionLabel = kicked
        ? deleted
          ? 'DELETED · MAX WARNS · KICKED'
          : 'MAX WARNS · KICKED (DELETE FAILED)'
        : deleted
          ? 'DELETED · MAX WARNS (KICK FAILED)'
          : 'MAX WARNS (KICK & DELETE FAILED)';
    } else {
      actionLabel = deleted ? 'DELETED & WARNED' : 'WARNED (DELETE FAILED)';
    }
  } else if (mode === 'mute') {
    const muteRes = await executeGroupSettingUpdate({
      sock,
      from,
      setting: 'announcement',
    });
    muted = muteRes.ok;
    actionLabel = muted
      ? deleted
        ? 'DELETED & GROUP MUTED'
        : 'GROUP MUTED (DELETE FAILED)'
      : deleted
        ? 'DELETED (MUTE FAILED)'
        : 'MUTE & DELETE FAILED';
    shouldAlert = true;
  } else if (mode === 'delete') {
    warningMessage = 'Do not send duplicate messages in this group!';
  }

  store.recordAction(from, {
    detected: 1,
    deleted: deleted ? 1 : 0,
    kicked: kicked ? 1 : 0,
    warned: warned ? 1 : 0,
    muted: muted ? 1 : 0,
  });

  if (groupConfig.notify && shouldAlert) {
    tracker.markAlertSent(from, senderJid, getPhoneFromJid);
    try {
      await sock.sendMessage(from, {
        text: formatAlertMessage({
          botName,
          actionLabel,
          targetUser,
          reason: dupResult.reason,
          warnText,
          warningMessage,
        }),
        mentions: mentionJid ? [mentionJid] : [],
      });
    } catch {}
  }

  return {
    handled: true,
    action: mode,
    deleted,
    kicked,
    warned,
    muted,
    warnCount,
    maxWarns,
    targetJid,
    warningMessage,
    detection: dupResult,
  };
}
