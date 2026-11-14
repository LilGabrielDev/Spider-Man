import fs from 'node:fs';
import path from 'node:path';
import { spiderHeader, spiderRow, spiderFooter } from '../../Spider/utils/tableStyle.js';
import {
  cleanJid,
  deobfuscateTextForScan,
  extractMessageText,
  extractPhone,
  extractUrls,
  normalizeTextForScan,
} from './antiscam.js';
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
} from './groupActionHelper.js';

export const ANTIAD_ACTIONS = Object.freeze(['delete', 'warn', 'kick', 'warnkick', 'mute']);

const DEFAULT_MAX_WARNS = 3;
const MAX_CUSTOM_PATTERNS = 50;
const MAX_WHITELIST_ENTRIES = 100;
const STRICT_THRESHOLD = 3;
const STANDARD_THRESHOLD = 4;

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

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

  const action = ANTIAD_ACTIONS.includes(String(raw.action || '').toLowerCase())
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

export function createAntiadvertisementStore(
  storePathOrResolver = () => path.join(process.cwd(), 'data', 'antiadvertisement.json'),
) {
  let cachedPath = null;
  let cachedGroups = null;

  function resolvePath() {
    return typeof storePathOrResolver === 'function' ? storePathOrResolver() : storePathOrResolver;
  }

  function loadAll() {
    const filePath = resolvePath();
    if (cachedGroups && cachedPath === filePath) {
      return cachedGroups;
    }

    let parsed = {};
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (raw && typeof raw === 'object' && raw.groups && typeof raw.groups === 'object') {
          parsed = raw.groups;
        }
      }
    } catch {
      parsed = {};
    }

    const next = new Map();
    for (const [groupId, cfg] of Object.entries(parsed)) {
      next.set(groupId, sanitizeGroupConfig(cfg));
    }

    cachedPath = filePath;
    cachedGroups = next;
    return cachedGroups;
  }

  function saveAll(groupsMap) {
    const filePath = resolvePath();
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}

    const serialized = {};
    for (const [groupId, cfg] of groupsMap.entries()) {
      serialized[groupId] = sanitizeGroupConfig(cfg);
    }

    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify({ groups: serialized }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {}
    cachedPath = filePath;
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

export const defaultAntiadvertisementStore = createAntiadvertisementStore();

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

function isSenderOrCandidateWhitelisted(senderOrCandidates, whitelist = [], getPhoneFn = null) {
  if (!whitelist || !whitelist.length) return false;
  const list = Array.isArray(senderOrCandidates) ? senderOrCandidates : [senderOrCandidates];
  for (const candidate of list) {
    const cleaned = cleanJid(candidate).toLowerCase();
    if (!cleaned) continue;
    const digits = (typeof getPhoneFn === 'function' ? getPhoneFn(cleaned) : null) || extractPhone(cleaned);
    if (whitelist.some((entry) => entry === cleaned || (digits && entry === digits))) {
      return true;
    }
  }
  return false;
}

function stripMarkdownWrappers(text) {
  return String(text || '')
    .replace(/[*_~`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const AD_CATEGORIES = [
  {
    id: 'bundle-promo',
    category: 'Data / Airtime / Minutes / SMS Bundle Promo',
    score: 4,
    patterns: [
      /\b(?:data\s*deals?|sms\s*deals?|minutes?\s*deals?|airtime\s*deals?|data\s*bundles?|pata\s+minutes|bingwa\s+sokoni|tunukiwa)\b/i,
      /\b(?:valid\s+till\s+midnight|okoa\s+jahazi|buy\s+(?:once|many\s+times)|no\s+expiry|unlimited\s+data|cheap(?:est)?\s+(?:data|bundles?|airtime))\b/i,
      /\b(?:safaricom|airtel|telkom|mtn|glo|vodacom)\s+(?:data\s+)?(?:deals?|bundles?\s+(?:available|promo)|offers?)\b/i,
      /\b\d+(?:[.,]\d+)?\s*(?:gb|mbs?)\s*\+\s*\d+\s*(?:mins?|minutes?|sms)\b/i,
      /\bheist\s+heist\b/i,
    ],
  },
  {
    id: 'till-paybill',
    category: 'Mobile Money Till / Paybill Promotion',
    score: 4,
    patterns: [
      /\btill\s*(?:number|no\.?|=|:)?\s*\*?\s*\d{5,9}\b/i,
      /\b(?:paybill|buy\s*goods|lipa\s*na\s*mpesa)\b.{0,25}\b\d{5,9}\b/i,
    ],
  },
  {
    id: 'fuliza-utility-promo',
    category: 'Fuliza / Loan / Utility Token Promo',
    score: 4,
    patterns: [
      /\bfuliza\b.{0,30}\b\d+\s*k?\s*[@=]\s*\d+/i,
      /\b(?:increase|boost|unlock)\s+(?:your\s+)?fuliza\s+limit\b/i,
      /\b(?:cheap(?:est)?|discount(?:ed)?|sell(?:ing)?)\s+kplc\s+tokens?\b|\bbuy\s+kplc\s+tokens?\s+(?:from|via|here|now|cheap|at)\b|\bkplc\s+tokens?\s*(?:deals?|available|for\s+sale|promo|offers?|[@=])\b/i,
      /\b\d+\s*units?\s*[@=]\s*(?:ksh|kes)?\s*\d+\b/i,
    ],
  },
  {
    id: 'pharma-health-promo',
    category: 'Unsolicited Medication / Health / Adult Product Ad',
    score: 4,
    patterns: [
      /\b(?:abortion\s+pills?|reproductive\s+health\s+medication|sti\s+and\s+std\s+treatment)\b/i,
      /\b(?:titan\s*gel|butt\s*booster|hips?\s*(?:&|and)?\s*butt\s*booster|penis\s*enlargement|manhood\s+enlargement|enlargement\s+(?:cream|oil|pills?))\b/i,
      /\b(?:herbal\s+clinic|spell\s*caster|love\s*spell|bring\s+back\s+lost\s+lover|escort\s+services?|hookup\s+available|call\s+girls?)\b/i,
    ],
  },
  {
    id: 'health-cosmetic-catalog',
    category: 'Commercial Health / Cosmetic Catalog',
    score: 2,
    patterns: [
      /\b(?:weight\s+gain|weight\s+loss|flat\s+tummy|skin\s+whitening|acne\s+treatment|stretch\s+marks?\s+removal|bleaching\s+cream|slimming\s+(?:tea|pills)|detox\s+tea)\b/i,
    ],
    minMatchesForBoost: 2,
    boostScore: 2,
  },
  {
    id: 'digital-services-promo',
    category: 'Digital Services / Followers / Betting / Subscription Promo',
    score: 4,
    patterns: [
      /\b(?:buy|boost|sell(?:ing)?)\s+(?:real\s+)?(?:ig|instagram|tiktok|youtube|twitter|x|facebook|tg|telegram|whatsapp)?\s*(?:followers|likes|views|subscribers|members|accounts?)\b/i,
      /\b(?:fixed\s*match(?:es)?|sure\s+odds|correct\s+score\s+(?:fixed|vip)|aviator\s+predictor|vip\s+(?:betting|forex|crypto)\s+(?:signals?|tips?|group))\b/i,
      /\b(?:assignments?\s+done|essay\s+writing\s+service|academic\s+writing\s+service|cheap\s+(?:netflix|spotify|canva|iptv)\s+(?:accounts?|subscriptions?))\b/i,
      /\b(?:use\s+my\s+(?:referral|promo|invite)\s*(?:code|link)|register\s+(?:under|using|with)\s+my\s+link)\b/i,
    ],
  },
  {
    id: 'commercial-cta',
    category: 'Commercial Sales / Delivery CTA',
    score: 3,
    patterns: [
      /\b(?:payment\s+(?:can\s+be\s+done|is\s+done|on|upon)\s+after\s+delivery|pay\s+(?:on|after)\s+delivery|depending\s+on\s+(?:our\s+)?clients?\s+location)\b/i,
      /\b(?:dm\s+or\s+call\s+for\s+inquiries|dm\s+(?:me\s+)?for\s+(?:prices?|orders?|more\s+info)|inbox\s+(?:me\s+)?(?:for\s+)?(?:orders?|prices?)|call\s*(?:\/|or)\s*whatsapp)\b/i,
      /\b(?:countrywide\s+delivery|delivery\s+countrywide|nationwide\s+delivery|worldwide\s+shipping|available\s+in\s+stock|place\s+your\s+order|order\s+now|limited\s+stock|grab\s+yours|shop\s+with\s+us|visit\s+our\s+shop|wholesale\s+and\s+retail|price\s+list|flash\s+sale|mega\s+sale|selling\s+cheap)\b/i,
    ],
  },
];

const PRICE_ITEM_PATTERNS = [
  /\b(?:ksh|kes|ugx|tzs|ghs|ngn|zar|usd)\s*\.?\s*\d[\d,]*(?:\.\d+)?\s*(?:=|@|for)\s*[^\s,;]+/gi,
  /(?:[$₦€£])\s*\d[\d,]*(?:\.\d+)?\s*(?:=|@|for)\s*[^\s,;]+/gi,
  /\b\d+(?:[.,]\d+)?\s*(?:gb|mbs?|mins?|minutes?|sms|units?|k)\b[^@\n]{0,20}[@=]\s*(?:ksh|kes|rs|\$|₦)?\s*\d[\d,]*/gi,
  /@\s*(?:ksh|kes|ugx|tzs|ghs|ngn|usd|\$|₦)?\s*\d[\d,]*(?:\.\d+)?\b/gi,
];

function countPriceExpressions(text) {
  const matchedSpans = new Set();
  for (const regex of PRICE_ITEM_PATTERNS) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      matchedSpans.add(`${m.index}:${m[0].toLowerCase().trim()}`);
    }
  }
  return matchedSpans.size;
}

export function detectAdvertisementMessage(text, groupConfig = {}, senderOrCandidates = '') {
  const normalized = normalizeTextForScan(text);
  const whitelist = Array.isArray(groupConfig?.whitelist) ? groupConfig.whitelist : [];
  const strict = groupConfig?.strict !== undefined ? Boolean(groupConfig.strict) : true;
  const threshold = strict ? STRICT_THRESHOLD : STANDARD_THRESHOLD;

  if (!normalized) {
    return { isAd: false, score: 0, threshold, reason: '', categories: [], matches: [], urls: [] };
  }

  if (isSenderOrCandidateWhitelisted(senderOrCandidates, whitelist)) {
    return {
      isAd: false,
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
  const cleanText = stripMarkdownWrappers(textForRuleScan);
  const deobfuscatedText = deobfuscateTextForScan(cleanText);
  const scanVariants =
    deobfuscatedText && deobfuscatedText !== cleanText ? [cleanText, deobfuscatedText] : [cleanText];

  let score = 0;
  const categories = new Set();
  const matches = [];

  for (const custom of groupConfig?.customPatterns || []) {
    const rule = String(custom || '').trim().toLowerCase();
    if (!rule) continue;
    if (
      normalized.toLowerCase().includes(rule) ||
      cleanText.toLowerCase().includes(rule) ||
      deobfuscatedText.toLowerCase().includes(rule)
    ) {
      score += 6;
      categories.add('Custom Ad Rule Match');
      matches.push(`rule:${rule}`);
    }
  }

  for (const ruleGroup of AD_CATEGORIES) {
    let matchedInGroup = 0;
    for (const pattern of ruleGroup.patterns) {
      if (ruleGroup.minMatchesForBoost) {
        const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
        let bestMatches = [];
        for (const variant of scanVariants) {
          const found = variant.match(globalPattern) || [];
          if (found.length > bestMatches.length) bestMatches = found;
        }
        if (bestMatches.length > 0) {
          matchedInGroup += bestMatches.length;
          for (const item of bestMatches.slice(0, 3)) {
            matches.push(item.slice(0, 50));
          }
        }
      } else {
        let hit = null;
        for (const variant of scanVariants) {
          const m = variant.match(pattern);
          if (m) {
            hit = m;
            break;
          }
        }
        if (hit) {
          matchedInGroup += 1;
          matches.push(hit[0].slice(0, 60));
          break;
        }
      }
    }

    if (matchedInGroup > 0) {
      if (ruleGroup.minMatchesForBoost && matchedInGroup >= ruleGroup.minMatchesForBoost) {
        score += ruleGroup.score + (ruleGroup.boostScore || 0);
        categories.add(ruleGroup.category);
      } else if (!ruleGroup.minMatchesForBoost) {
        score += ruleGroup.score;
        categories.add(ruleGroup.category);
      } else {
        score += 1;
        categories.add(ruleGroup.category);
      }
    }
  }

  const priceCount = Math.max(...scanVariants.map((variant) => countPriceExpressions(variant)));
  if (priceCount >= 3) {
    score += 4;
    categories.add('Commercial Price List / Deals Menu');
    matches.push(`${priceCount} price items`);
  } else if (priceCount >= 1) {
    score += strict ? 3 : 2;
    categories.add('Promotional Pricing');
    matches.push(`${priceCount} price item(s)`);
  }

  if (nonWhitelistedUrls.length > 0) {
    let hasWaInviteOrChannel = false;
    let hasSocialPromoLink = false;
    for (const url of nonWhitelistedUrls) {
      const lowerUrl = url.toLowerCase();
      if (lowerUrl.includes('chat.whatsapp.com/') || lowerUrl.includes('whatsapp.com/channel/')) {
        hasWaInviteOrChannel = true;
        matches.push(getHostname(url));
      } else if (
        lowerUrl.includes('wa.me/') ||
        lowerUrl.includes('t.me/') ||
        lowerUrl.includes('telegram.me/') ||
        lowerUrl.includes('bit.ly/') ||
        lowerUrl.includes('tinyurl.com/') ||
        lowerUrl.includes('shorturl.at/') ||
        lowerUrl.includes('cutt.ly/') ||
        lowerUrl.includes('rb.gy/') ||
        lowerUrl.includes('is.gd/') ||
        lowerUrl.includes('instagram.com/') ||
        lowerUrl.includes('tiktok.com/@') ||
        lowerUrl.includes('youtube.com/@') ||
        lowerUrl.includes('youtu.be/') ||
        lowerUrl.includes('facebook.com/')
      ) {
        hasSocialPromoLink = true;
        matches.push(getHostname(url));
      }
    }

    if (hasWaInviteOrChannel) {
      score += 4;
      categories.add('WhatsApp Group / Channel Invite Ad');
    } else if (hasSocialPromoLink && (strict || score >= 2)) {
      score += strict ? 3 : 2;
      categories.add('Promotional Contact / Social Link');
    } else if (score >= (strict ? 1 : 2)) {
      score += strict ? 2 : 1;
      categories.add('Promotional Link');
      matches.push(getHostname(nonWhitelistedUrls[0]));
    }
  }

  const isAd = score >= threshold;
  const categoryList = [...categories];
  return {
    isAd,
    score,
    threshold,
    reason: categoryList[0] || '',
    categories: categoryList,
    matches: [...new Set(matches)],
    urls: nonWhitelistedUrls,
  };
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

function formatAlertMessage({ botName, actionLabel, targetUser, reason, warnText = '' }) {
  const lines = [
    spiderHeader(botName || 'Spider Man', 'ANTI-ADVERTISEMENT SHIELD'),
    spiderRow('USER', `@${targetUser}`, '⚠'),
    spiderRow('ACTION', actionLabel, '⛨'),
    spiderRow('REASON', reason || 'Unsolicited Advertisement / Promo', '◈'),
  ];
  if (warnText) {
    lines.push(spiderRow('WARNINGS', warnText, '▣'));
  }
  lines.push(spiderFooter('GROUP AD PROTECTION ACTIVE'));
  return lines.join('\n');
}

export async function handleAntiAdvertisementMessage({
  sock,
  from,
  sender,
  msg,
  text = '',
  isOwner = false,
  groupMeta = null,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntiadvertisementStore,
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
  if (isSenderOrCandidateWhitelisted(senderCandidates, groupConfig.whitelist, getPhoneFromJid)) {
    return { handled: false, reason: 'whitelisted' };
  }

  const detection = detectAdvertisementMessage(combinedText, groupConfig, senderCandidates);
  if (!detection.isAd) {
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
    detection,
  };
}
