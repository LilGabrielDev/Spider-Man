import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spiderHeader, spiderRow, spiderDivider, spiderFooter } from '../../Spider/utils/tableStyle.js';
import {
  collectBotIdentities,
  collectSenderIdentities,
  resolveParticipantRole as resolveParticipantRoleUnified,
  resolveGroupRolesAsync,
} from './groupRoleResolver.js';
import {
  deleteMessageSafely,
  executeGroupSettingUpdate,
  executeParticipantsAction,
  resolveSenderDisplayAndMention,
} from './groupActionHelper.js';

export const ANTISCAM_ACTIONS = Object.freeze(['delete', 'warn', 'kick', 'warnkick', 'mute']);

const DEFAULT_MAX_WARNS = 3;
const MAX_CUSTOM_PATTERNS = 50;
const MAX_WHITELIST_ENTRIES = 100;
const STRICT_THRESHOLD = 3;
const STANDARD_THRESHOLD = 4;

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function cleanJid(jid) {
  const raw = String(jid || '').trim();
  if (!raw) return '';
  if (raw.includes(':')) {
    const [user, rest] = raw.split(':');
    const domain = rest?.split('@')?.[1];
    if (user && domain) return `${user}@${domain}`;
  }
  return raw;
}

export function extractPhone(jid) {
  const cleaned = cleanJid(jid);
  const match = cleaned.match(/^(\d+)@/);
  return match ? match[1] : '';
}

function defaultGroupConfig() {
  return {
    enabled: false,
    strict: true,
    action: 'delete',
    maxWarns: DEFAULT_MAX_WARNS,
    notify: true,
    customPatterns: [],
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

  const action = ANTISCAM_ACTIONS.includes(String(raw.action || '').toLowerCase())
    ? String(raw.action).toLowerCase()
    : base.action;

  const maxWarnsNum = Number(raw.maxWarns);
  const maxWarns =
    Number.isInteger(maxWarnsNum) && maxWarnsNum >= 1 && maxWarnsNum <= 10
      ? maxWarnsNum
      : base.maxWarns;

  const customPatterns = Array.isArray(raw.customPatterns)
    ? [...new Set(raw.customPatterns.map((p) => String(p || '').trim().toLowerCase()).filter(Boolean))].slice(
        0,
        MAX_CUSTOM_PATTERNS,
      )
    : [];

  const whitelist = Array.isArray(raw.whitelist)
    ? [...new Set(raw.whitelist.map((w) => String(w || '').trim().toLowerCase()).filter(Boolean))].slice(
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
    strict: raw.strict !== undefined ? Boolean(raw.strict) : true,
    action,
    maxWarns,
    notify: raw.notify !== undefined ? Boolean(raw.notify) : true,
    customPatterns,
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

export function createAntiscamStore(storePathOrResolver = null) {
  const isDefault = storePathOrResolver === null || storePathOrResolver === undefined;
  let tmpFallbackPath = null;
  let cachedPath = null;
  let cachedGroups = null;

  function resolvePath() {
    if (!isDefault) {
      return typeof storePathOrResolver === 'function' ? storePathOrResolver() : storePathOrResolver;
    }
    return tmpFallbackPath || path.join(process.cwd(), 'data', 'antiscam.json');
  }

  function loadAll() {
    const filePath = resolvePath();
    if (cachedGroups && cachedPath === filePath) {
      return cachedGroups;
    }

    let parsed = {};
    let loadedFrom = filePath;
    const candidates = isDefault && !tmpFallbackPath
      ? [filePath, path.join(os.tmpdir(), 'spider-data', 'antiscam.json')]
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
        const fallback = path.join(os.tmpdir(), 'spider-data', 'antiscam.json');
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

  function addCustomPattern(groupJid, phrase) {
    const normalized = String(phrase || '').trim().toLowerCase();
    if (!normalized) return { added: false, config: getGroupConfig(groupJid) };
    let added = false;
    const config = setGroupConfig(groupJid, (cfg) => {
      if (cfg.customPatterns.includes(normalized)) return cfg;
      added = true;
      return {
        ...cfg,
        customPatterns: [...cfg.customPatterns, normalized].slice(-MAX_CUSTOM_PATTERNS),
      };
    });
    return { added, config };
  }

  function removeCustomPattern(groupJid, phrase) {
    const normalized = String(phrase || '').trim().toLowerCase();
    let removed = false;
    const config = setGroupConfig(groupJid, (cfg) => {
      const next = cfg.customPatterns.filter((item) => item !== normalized);
      removed = next.length !== cfg.customPatterns.length;
      return { ...cfg, customPatterns: next };
    });
    return { removed, config };
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

  function clearCache() {
    cachedPath = null;
    cachedGroups = null;
  }

  return {
    getGroupConfig,
    setGroupConfig,
    addWarn,
    resetWarns,
    addCustomPattern,
    removeCustomPattern,
    addWhitelist,
    removeWhitelist,
    recordAction,
    clearCache,
  };
}

export const defaultAntiscamStore = createAntiscamStore();

function normalizeWhitelistEntry(raw) {
  const str = String(raw || '').trim();
  if (!str) return '';
  if (str.includes('@')) return cleanJid(str).toLowerCase();
  const strippedUrl = str.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  if (/^\+?\d{6,16}$/.test(str.replace(/[\s()-]/g, ''))) {
    return normalizeDigits(str);
  }
  return strippedUrl;
}

export function normalizeTextForScan(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapMessageContent(message) {
  let current = message;
  const visited = new Set();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }
    if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
      continue;
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }
    if (current.editedMessage?.message) {
      current = current.editedMessage.message;
      continue;
    }
    break;
  }
  return current || {};
}

export function extractMessageText(msg, fallbackText = '') {
  const parts = [];
  if (fallbackText) parts.push(String(fallbackText));

  const unwrapped = unwrapMessageContent(msg?.message);
  if (unwrapped && typeof unwrapped === 'object') {
    const candidates = [
      unwrapped.conversation,
      unwrapped.extendedTextMessage?.text,
      unwrapped.extendedTextMessage?.matchedText,
      unwrapped.extendedTextMessage?.title,
      unwrapped.extendedTextMessage?.description,
      unwrapped.imageMessage?.caption,
      unwrapped.videoMessage?.caption,
      unwrapped.documentMessage?.caption,
      unwrapped.documentMessage?.title,
      unwrapped.buttonsMessage?.contentText,
      unwrapped.buttonsMessage?.text,
      unwrapped.buttonsResponseMessage?.selectedDisplayText,
      unwrapped.listResponseMessage?.title,
      unwrapped.listResponseMessage?.description,
      unwrapped.templateButtonReplyMessage?.selectedDisplayText,
      unwrapped.interactiveMessage?.header?.title,
      unwrapped.interactiveMessage?.body?.text,
      unwrapped.interactiveMessage?.footer?.text,
      unwrapped.templateMessage?.hydratedTemplate?.hydratedTitleText,
      unwrapped.templateMessage?.hydratedTemplate?.hydratedContentText,
      unwrapped.pollCreationMessage?.name,
      unwrapped.contactMessage?.displayName,
      unwrapped.contactMessage?.vcard,
    ];
    for (const item of candidates) {
      if (typeof item === 'string' && item.trim()) {
        parts.push(item.trim());
      }
    }
  }

  return normalizeTextForScan([...new Set(parts)].join(' '));
}

export function extractUrls(text) {
  const cleaned = normalizeTextForScan(text);
  const matches = new Set();
  const fullUrlRegex = /(?:https?:\/\/|www\.)[^\s<>()]+/gi;
  for (const m of cleaned.match(fullUrlRegex) || []) {
    matches.add(m.replace(/[),.;!?]+$/, ''));
  }

  const shortOrDomainRegex =
    /\b(?:wa\.me|t\.me|telegram\.me|bit\.ly|tinyurl\.com|cutt\.ly|shorturl\.at|rb\.gy|t\.co|chat\.whatsapp\.com)\/[^\s<>()]+/gi;
  for (const m of cleaned.match(shortOrDomainRegex) || []) {
    matches.add(m.replace(/[),.;!?]+$/, ''));
  }

  const bareSuspiciousDomainRegex =
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:tk|ml|ga|cf|gq|top|xyz|click|icu|buzz|work|claim|gift|vip)\b(?:\/[^\s<>()]*)?/gi;
  for (const m of cleaned.match(bareSuspiciousDomainRegex) || []) {
    matches.add(m.replace(/[),.;!?]+$/, ''));
  }

  return [...matches];
}

function getHostname(rawUrl) {
  try {
    const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    return new URL(withScheme).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return String(rawUrl || '')
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .toLowerCase();
  }
}

function isDomainWhitelisted(hostname, whitelist = []) {
  if (!hostname) return false;
  for (const entry of whitelist) {
    if (!entry || /^\d+$/.test(entry) || entry.includes('@')) continue;
    if (hostname === entry || hostname.endsWith(`.${entry}`)) return true;
  }
  return false;
}

function isSenderWhitelisted(senderOrCandidates, whitelist = [], getPhoneFn = null) {
  if (!senderOrCandidates || !whitelist.length) return false;
  const list = Array.isArray(senderOrCandidates) ? senderOrCandidates : [senderOrCandidates];
  for (const senderJid of list) {
    const cleaned = cleanJid(senderJid).toLowerCase();
    if (!cleaned) continue;
    const digits = (typeof getPhoneFn === 'function' ? getPhoneFn(cleaned) : null) || extractPhone(cleaned);
    if (whitelist.some((entry) => entry === cleaned || (digits && entry === digits))) {
      return true;
    }
  }
  return false;
}

const LEET_CHAR_MAP = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  '$': 's',
};

export function deobfuscateTextForScan(text) {
  const collapsedPunctuation = String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b([a-z0-9])(?:[._*\-]+([a-z0-9])){2,}\b/gi, (m) => m.replace(/[._*\-]+/g, ''))
    .replace(/(?<![a-z0-9])([a-z])(?:\s+([a-z])){2,}(?![a-z0-9])/gi, (m) => m.replace(/\s+/g, ''))
    .replace(/[*_~`]+/g, ' ');

  return collapsedPunctuation
    .split(/\s+/)
    .map((token) => {
      if (/[a-z].*[a-z]/i.test(token) && /[013457@$]/.test(token) && !/^https?:/i.test(token)) {
        return token.replace(/[013457@$]/g, (ch) => LEET_CHAR_MAP[ch] || ch);
      }
      return token;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HIGH_CONFIDENCE_RULES = [
  {
    id: 'otp-takeover',
    category: 'Account Takeover / OTP Phishing',
    score: 5,
    patterns: [
      /\b(?:send|forward|share|give|tell|type|enter|confirm)\b.{0,35}\b(?:6[\s-]?digit|six[\s-]?digit|verification|otp|security|pin|2fa|login|reset)\s*code\b/i,
      /\b(?:otp\s*(?:bot|grabber|bypass|spoof)|sim\s*swap|send\s+(?:me\s+)?your\s+otp)\b/i,
      /\bsent\s+(?:you\s+)?(?:a\s+)?(?:6[\s-]?digit\s+)?code\s+by\s+mistake\b/i,
      /\b(?:whatsapp|meta|account|bank|paypal|binance|telegram|apple|google)\b.{0,30}\b(?:will\s+be|has\s+been|is)\s+(?:suspended|banned|deactivated|terminated|locked|restricted|flagged)\b.{0,45}\b(?:verify|confirm|click|tap|code|link|reactivate|appeal)\b/i,
      /\b(?:whatsapp|meta)\s+(?:support|security|verification)\s+team\b/i,
      /\b(?:verify|re-verify|reactivate|validate|update)\s+(?:your\s+)?(?:kyc|account|bvn|nin|ssn|pan|bank\s+details|card\s+details)\s+(?:now|here|immediately|urgently|link)\b/i,
      /\b(?:hack\s+(?:any\s+)?(?:whatsapp|instagram|ig|facebook|fb|tiktok|snapchat|telegram|phone|account|bank|mpesa|momo)|spy\s+on\s+(?:any\s+)?(?:whatsapp|partner|spouse|phone)|hire\s+(?:a\s+)?hacker|ethical\s+hacker\s+for\s+hire|clone\s+(?:any\s+)?phone|account\s+recovery\s+(?:service|agent|expert)|unban\s+(?:banned\s+)?accounts?|unlock\s+icloud)\b/i,
    ],
  },
  {
    id: 'wallet-drainer',
    category: 'Crypto Wallet / Seed-Phrase / Investment Scam',
    score: 5,
    patterns: [
      /\b(?:seed|recovery|mnemonic|secret|backup)\s*phrase\b/i,
      /\b(?:12|24)[\s-]word\s+(?:phrase|seed|recovery|key)\b/i,
      /\b(?:enter|paste|submit|verify|share|send|import)\b.{0,25}\bprivate\s*key\b/i,
      /\b(?:connect|validate|rectify|synchronize|sync|restore|claim)\s+(?:your\s+)?(?:wallet|dapp|trust\s*wallet|metamask|phantom|coinbase\s*wallet)\b/i,
      /\b(?:wallet\s*drainer|drainer\s*script|dapp\s*sync|wallet\s*rectify)\b/i,
      /\b(?:flash\s+(?:usdt|btc|bitcoin|eth|trc20|erc20|coins?)|(?:usdt|btc|bitcoin|eth)\s+flash(?:ing)?|spendable\s+flash)\b/i,
      /\bdouble\s+(?:your|any)\s+(?:btc|bitcoin|eth|ethereum|usdt|crypto|money|cash|funds?)\b/i,
      /\bsend\s+\d+(?:[.,]\d+)?\s*(?:btc|eth|usdt|sol|bnb|trx)\b.{0,35}\b(?:receive|get\s+back|return|double)\b/i,
      /\b(?:ponzi|pyramid\s*scheme|hyip|pig\s*butchering|crypto\s*flip|btc\s*flip|eth\s*flip|usdt\s*flip|ai\s+trading\s+bot|cloud\s+mining\s+(?:profit|returns?)|bitcoin\s+mining\s+pool|guaranteed\s+(?:daily\s+)?(?:profit|returns?|roi|income)|risk[\s-]?free\s+(?:profit|returns?|trading)|forex\s+account\s+management|pump\s+and\s+dump\s+(?:vip|signal|group)|recover\s+(?:stolen|lost|scammed)\s+(?:crypto|btc|usdt|funds|money)|crypto\s+recovery\s+(?:expert|agent))\b/i,
    ],
  },
  {
    id: 'phishing-spoof-url',
    category: 'Phishing / Spoofed Domain / Malware',
    score: 5,
    patterns: [
      /\b(?:wa-verify|whatsapp-verify|whatsapp-support|support-whatsapp|meta-verify|paypal-secure|binance-claim|coinbase-support|metamask-sync|claim-airdrop|claim-reward|free-nitro|discord-nitro-free|gift-nitro|free-robux|free-uc|free-diamonds|airdrop-claim|wallet-rectify|dapp-sync|kyc-update|bank-verify|login-verify|secure-claim)\b/i,
      /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\//i,
      /\b(?:phishing\s+(?:link|page|kit|script)|scampage|rat\s+(?:malware|trojan|tool|builder)|infostealer|keylogger\s+(?:apk|tool)|mod\s+apk\s+crack|free\s+(?:robux|nitro|v-?bucks|diamonds?|uc)\s+(?:generator|claim|link)|gift\s*card\s+generator)\b/i,
    ],
  },
  {
    id: 'advance-fee-prize',
    category: 'Advance-Fee / Prize / Inheritance / Grant Scam',
    score: 5,
    patterns: [
      /\bcongratulations\b.{0,40}\b(?:won|winner|selected|chosen)\b.{0,50}\b(?:claim|prize|cash|reward|iphone|lottery|usdt|btc|grant)\b/i,
      /\b(?:pay|send|deposit|transfer)\b.{0,30}\b(?:registration|activation|clearance|processing|withdrawal|delivery|unlock|customs|stamp\s*duty|upgrade|verification)\s*fee\b/i,
      /\b(?:cash\s*flip|money\s*flip|flip\s+(?:your\s+)?cash|money\s*doubling|cash\s*doubling)\b/i,
      /\b(?:inheritance\s+fund|unclaimed\s+funds|abandoned\s+fund|next\s+of\s+kin\s+(?:fund|claim)|diplomatic\s+box|consignment\s+box|trunk\s+box|world\s+bank\s+grant|empowerment\s+grant|charity\s+grant|lottery\s+(?:winner|winning|claim))\b/i,
    ],
  },
  {
    id: 'carding-fraud',
    category: 'Carding / Financial / Mobile-Money Fraud',
    score: 5,
    patterns: [
      /\b(?:bank\s*logs?|cvv\s*dumps?|cc\s*dumps?|dumps?\s+with\s+pin|cloned\s*cards?|clone\s*cards?|fullz|ssn\s+fullz|carding\s*(?:method|tutorial|shop|tools?)|stealer\s*logs|combo\s*list|fresh\s*logs)\b/i,
      /\b(?:paypal\s*logs|cashapp\s*logs|chase\s*logs|chime\s*logs|venmo\s*logs|zelle\s*logs|wells\s*fargo\s*logs)\b/i,
      /\b(?:cashapp\s*glitch|paypal\s*flip|venmo\s*flip|zelle\s*flip|western\s*union\s*(?:bug|glitch)|moneygram\s*glitch|binance\s*p2p\s*glitch|wire\s*transfer\s*glitch)\b/i,
      /\b(?:mpesa\s*(?:reversal|hack|glitch)|momo\s*(?:hack|glitch)|airtel\s*money\s*(?:hack|glitch)|fuliza\s*(?:hack|bypass|limit\s*boost)|okoa\s*jahazi\s*hack|fake\s*(?:bank\s*)?alert(?:\s*app)?|fake\s+(?:mpesa|receipt)\s*(?:generator|sms)|counterfeit\s*(?:notes?|money|cash|bills?)|wash\s+black\s+money|ssd\s+chemical)\b/i,
      /\b(?:steam|apple|itunes|razer\s*gold|google\s*play)\s*(?:gift\s*)?cards?\b.{0,30}\b(?:available|rate|swap|cashout|sell|fee|unlock|payment)\b/i,
    ],
  },
  {
    id: 'task-loan-betting-extortion',
    category: 'Task / Loan / Fixed-Match / Occult / Extortion Scam',
    score: 5,
    patterns: [
      /\b(?:prepaid\s+task|telegram\s+task|merchant\s+task|recharge\s+to\s+withdraw|complete\s+task\s+to\s+(?:earn|withdraw)|like\s+(?:youtube|tiktok)\s+videos\s+(?:and|to)\s+earn|rate\s+hotels\s+(?:and|to)\s+earn|work\s+from\s+home\s+earn\s+\$?\d+|online\s+data\s+entry\s+earn)\b/i,
      /\b(?:instant\s+loan\s+(?:with\s+)?no\s+collateral|quick\s+loan\s+pay\s+fee|loan\s+(?:approval|processing)\s+fee|crb\s+clearance\s+(?:fee|agent))\b/i,
      /\b(?:fixed\s*match(?:es)?|sure\s+fixed\s+odds|correct\s+score\s+fixed|100%\s+sure\s+odds|aviator\s+(?:predictor|hack)|crash\s+predictor|betting\s+hack)\b/i,
      /\b(?:money\s+ritual|blood\s+money|illuminati\s+(?:membership|brotherhood)|join\s+illuminati|magic\s+wallet|riches\s+spell|sugar\s*(?:mummy|mommy|daddy)\b.{0,30}\b(?:pay|allowance|cash|dm|hookup|weekly))\b/i,
      /\b(?:leak\s+your\s+nudes|recorded\s+your\s+screen|hacked\s+your\s+webcam|send\s+money\s+or\s+i\s+(?:post|leak)|sextortion)\b/i,
    ],
  },
];

const SIGNAL_GROUPS = [
  {
    id: 'urgency',
    label: 'Urgency / Pressure',
    score: 2,
    regex: /\b(?:urgent|act\s+now|limited\s+time|expires?\s+(?:in|today|soon)|last\s+chance|final\s+warning|within\s+\d+\s*(?:min|mins|minutes|hours?|hrs?)|immediately|account\s+suspended)\b/i,
  },
  {
    id: 'financial-lure',
    label: 'Financial / Crypto Lure',
    score: 2,
    regex: /\b(?:usdt|bitcoin|btc|eth|crypto|airdrop|giveaway|free\s*(?:money|cash|data|airtime|coins|crypto|gift\s*cards?)|guaranteed|roi|investment|bonus|reward|jackpot|earn\s+\$?\d+\s*(?:daily|per\s*day|weekly|hourly)|passive\s+income|instant\s+loan|cashapp|paypal|western\s*union|moneygram|wire\s+transfer|trust\s*wallet|metamask|binance|coinbase|gift\s*card)\b/i,
  },
  {
    id: 'cta',
    label: 'Direct Solicitation CTA',
    score: 2,
    regex: /\b(?:dm\s+me|inbox\s+me|message\s+me|pm\s+me|click\s+(?:the\s+)?link|tap\s+(?:the\s+)?link|tap\s+here|claim\s+now|register\s+now|sign\s*up\s+now|join\s+(?:my\s+)?telegram|message\s+on\s+telegram|whatsapp\s+me|contact\s+admin)\b/i,
  },
];

const SHORTENER_HOSTS = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'shorturl.at',
  'cutt.ly',
  'rb.gy',
  'is.gd',
  'tiny.cc',
  't.me',
  'telegram.me',
  'wa.me',
]);

const RISKY_TLDS = /\.(?:tk|ml|ga|cf|gq|top|xyz|click|icu|buzz|work|claim|gift|vip|pw|cc)$/i;

export function detectScamMessage(text, groupConfig = {}, senderOrCandidates = '') {
  const normalized = normalizeTextForScan(text);
  const whitelist = Array.isArray(groupConfig?.whitelist) ? groupConfig.whitelist : [];
  const strict = groupConfig?.strict !== undefined ? Boolean(groupConfig.strict) : true;
  const threshold = strict ? STRICT_THRESHOLD : STANDARD_THRESHOLD;

  if (!normalized) {
    return { isScam: false, score: 0, threshold, reason: '', categories: [], matches: [], urls: [] };
  }

  if (isSenderWhitelisted(senderOrCandidates, whitelist)) {
    return {
      isScam: false,
      score: 0,
      threshold,
      reason: 'Sender is whitelisted',
      categories: [],
      matches: [],
      urls: [],
      whitelisted: true,
    };
  }

  const urls = extractUrls(normalized);
  const nonWhitelistedUrls = urls.filter((u) => !isDomainWhitelisted(getHostname(u), whitelist));

  let textForRuleScan = normalized;
  for (const url of urls) {
    if (!nonWhitelistedUrls.includes(url)) {
      textForRuleScan = textForRuleScan.replaceAll(url, ' ');
    }
  }
  const deobfuscatedScan = deobfuscateTextForScan(textForRuleScan);
  const scanVariants =
    deobfuscatedScan && deobfuscatedScan !== textForRuleScan
      ? [textForRuleScan, deobfuscatedScan]
      : [textForRuleScan];

  let score = 0;
  const categories = new Set();
  const matches = [];

  for (const custom of groupConfig?.customPatterns || []) {
    const rule = String(custom || '').trim().toLowerCase();
    if (!rule) continue;
    if (
      normalized.toLowerCase().includes(rule) ||
      deobfuscatedScan.toLowerCase().includes(rule)
    ) {
      score += 6;
      categories.add('Custom Rule Match');
      matches.push(`rule:${rule}`);
    }
  }

  for (const ruleGroup of HIGH_CONFIDENCE_RULES) {
    let matchedRule = false;
    for (const pattern of ruleGroup.patterns) {
      for (const variant of scanVariants) {
        const m = variant.match(pattern);
        if (m) {
          score += ruleGroup.score;
          categories.add(ruleGroup.category);
          matches.push(m[0].slice(0, 60));
          matchedRule = true;
          break;
        }
      }
      if (matchedRule) break;
    }
  }

  for (const signal of SIGNAL_GROUPS) {
    for (const variant of scanVariants) {
      const m = variant.match(signal.regex);
      if (m) {
        score += signal.score;
        categories.add(signal.label);
        matches.push(m[0].slice(0, 40));
        break;
      }
    }
  }

  if (nonWhitelistedUrls.length > 0) {
    let urlRiskAdded = false;
    for (const url of nonWhitelistedUrls) {
      const host = getHostname(url);
      if (SHORTENER_HOSTS.has(host) || RISKY_TLDS.test(host)) {
        score += strict ? 3 : 2;
        categories.add('Suspicious / Shortened Link');
        matches.push(host);
        urlRiskAdded = true;
        break;
      }
    }
    if (!urlRiskAdded && score >= 2) {
      score += 1;
      categories.add('External Link');
      matches.push(getHostname(nonWhitelistedUrls[0]));
    }
  }

  const isScam = score >= threshold;
  const categoryList = [...categories];
  return {
    isScam,
    score,
    threshold,
    reason: categoryList[0] || '',
    categories: categoryList,
    matches: [...new Set(matches)],
    urls: nonWhitelistedUrls,
  };
}

export function resolveParticipantRole(metadata, targetJid, optionsOrFn = null) {
  return resolveParticipantRoleUnified(metadata, targetJid, optionsOrFn);
}

function buildDeleteKey(from, msg, sender) {
  const key = {
    remoteJid: from,
    fromMe: Boolean(msg?.key?.fromMe),
    id: msg?.key?.id,
  };
  const participant = msg?.key?.participant || sender;
  if (participant) key.participant = participant;
  return key;
}

function formatAlertMessage({
  botName,
  actionLabel,
  targetUser,
  reason,
  warnText = '',
  warningMessage = '',
}) {
  const lines = [
    spiderHeader(botName || 'Spider Man', 'ANTISCAM SHIELD'),
    spiderRow('USER', `@${targetUser}`, '⚠'),
    spiderRow('ACTION', actionLabel, '⛨'),
    spiderRow('REASON', reason || 'Suspicious Scam Content', '◈'),
  ];
  if (warnText) {
    lines.push(spiderRow('WARNINGS', warnText, '▣'));
  }
  if (warningMessage) {
    lines.push(spiderRow('WARNING', warningMessage, '⚠'));
  }
  lines.push(spiderFooter('GROUP PROTECTION ACTIVE'));
  return lines.join('\n');
}

export async function handleAntiScamMessage({
  sock,
  from,
  sender,
  msg,
  text = '',
  isOwner = false,
  groupMeta = null,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntiscamStore,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !from || !String(from).endsWith('@g.us') || !msg || msg.key?.fromMe) {
    return { handled: false, reason: 'not-applicable' };
  }

  const groupConfig = store.getGroupConfig(from);
  if (!groupConfig.enabled) {
    return { handled: false, reason: 'disabled' };
  }

  if (isOwner) {
    return { handled: false, reason: 'owner-exempt' };
  }

  const combinedText = extractMessageText(msg, text);
  if (!combinedText) {
    return { handled: false, reason: 'empty-text' };
  }

  const senderJid = sender || msg.key?.participant || msg.key?.participantAlt || '';
  const senderCandidates = collectSenderIdentities(msg, [sender]);
  if (isSenderWhitelisted(senderCandidates, groupConfig.whitelist, getPhoneFromJid)) {
    return { handled: false, reason: 'whitelisted' };
  }

  const detection = detectScamMessage(combinedText, groupConfig, senderCandidates);
  if (!detection.isScam) {
    return { handled: false, reason: 'clean', detection };
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
    return { handled: false, reason: 'sender-is-admin', detection };
  }

  if (metadata && botCandidates.length > 0 && !botRole.isAdmin) {
    return { handled: false, reason: 'bot-not-admin', detection };
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
  let actionLabel = deleted ? 'MESSAGE DELETED' : 'DELETE FAILED';
  let warnText = '';
  let warningMessage = '';

  const mode = groupConfig.action;
  if (mode === 'warn') {
    const warnResult = store.addWarn(from, targetJid);
    warned = true;
    warnCount = warnResult.count;
    maxWarns = warnResult.maxWarns;
    actionLabel = deleted ? 'DELETED & WARNED' : 'WARNED (DELETE FAILED)';
    warnText = `${warnCount}/${maxWarns}`;
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
  } else if (mode === 'warnkick') {
    const warnResult = store.addWarn(from, targetJid);
    warned = true;
    warnCount = warnResult.count;
    maxWarns = warnResult.maxWarns;
    warnText = `${warnCount}/${maxWarns}`;

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
  } else if (mode === 'delete') {
    warningMessage = 'No scam or phishing messages allowed in this group!';
  }

  store.recordAction(from, {
    detected: 1,
    deleted: deleted ? 1 : 0,
    kicked: kicked ? 1 : 0,
    warned: warned ? 1 : 0,
    muted: muted ? 1 : 0,
  });

  if (groupConfig.notify) {
    try {
      await sock.sendMessage(from, {
        text: formatAlertMessage({
          botName,
          actionLabel,
          targetUser,
          reason: detection.reason,
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
    detection,
  };
}
