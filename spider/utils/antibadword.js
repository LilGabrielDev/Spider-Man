import fs from 'fs';
import os from 'os';
import path from 'path';
import { spiderFooter, spiderHeader, spiderRow } from '../../Spider/utils/tableStyle.js';
import { extractMessageText } from './antiscam.js';
import {
  cleanJid,
  collectBotIdentities,
  collectSenderIdentities,
  extractPhoneDigits,
  resolveGroupRolesAsync,
} from './groupRoleResolver.js';
import {
  deleteMessageSafely,
  executeGroupSettingUpdate,
  executeParticipantsAction,
  resolveSenderDisplayAndMention,
  unwrapMessageContent,
} from './groupActionHelper.js';

export const ANTIBADWORD_ACTIONS = ['delete', 'warn', 'kick', 'warnkick', 'mute'];
export const ANTIBADWORD_DEFAULT_MAX_WARNS = 2;

export const DEFAULT_BADWORDS = [
  'fuck', 'fucker', 'fucking', 'fucked', 'fucks', 'fck', 'fckr', 'fcker', 'fuk', 'fukk', 'fcuk',
  'f*ck', 'f@ck', 'f***er', 'motherfucker', 'motherfucking', 'mofo',
  'shit', 'shitty', 'shitting', 'bullshit', 'shithead', 'dipshit', 's***head',
  'bitch', 'bitches', 'bitching', 'btch', 'b!tch',
  'asshole', 'assholes', 'a**hole', 'assclown', 'dumbass', 'jackass', 'fatass', 'smartass',
  'bastard', 'bastards', 'dick', 'dicks', 'dickhead', 'cock', 'cocks', 'cocksucker',
  'pussy', 'pussies', 'cunt', 'cunts', 'twat', 'wanker', 'slut', 'sluts', 'slutty',
  'whore', 'whores', 'skank', 'prick', 'douchebag', 'scumbag', 'retard', 'retarded',
  'boobs', 'boobies', 'tits', 'titties',
  'blowjob', 'handjob', 'cumshot', 'deepthroat', 'hentai', 'milf', 'orgasm', 'dildo', 'vibrator',
  'gangbang', 'threesome', 'porn', 'porno', 'pornography', 'xxx',
  'nigga', 'nigger', 'n!gga', 'chink', 'gook', 'kike', 'paki', 'wetback', 'raghead', 'spic', 'towelhead',
  'faggot', 'faggots', 'dyke', 'tranny',
  'chut', 'chutiya', 'lund', 'lodu', 'l0du', 'lund69', 'benchod', 'bhenchod', 'behen ke lode',
  'madar', 'madarchod', 'chodne', 'chudai', 'chodu', 'harami', 'haramzada', 'randi',
  'gaand mara', 'gandu', 'kameena', 'bsdk', 'bhosdike', 'teri ma ki', 'teri maa ki',
  'heroin', 'meth', 'cocaine',
];

const STRICT_COMPOUND_STEMS = [
  'fuck', 'shit', 'bitch', 'asshole', 'whore', 'nigger', 'nigga', 'faggot',
  'bastard', 'motherfucker', 'dickhead', 'cocksucker', 'porn', 'hentai',
  'blowjob', 'handjob', 'cumshot', 'deepthroat', 'gangbang', 'threesome',
  'dildo', 'vibrator', 'douchebag', 'jackass', 'scumbag', 'assclown',
  'benchod', 'bhenchod', 'madarchod', 'haramzada', 'bhosdike', 'chutiya',
  'bsdk', 'gandu', 'kameena',
];

const HOMOGLYPH_MAP = {
  '\u0430': 'a', '\u0410': 'a', '\u03b1': 'a', '\u00e0': 'a', '\u00e1': 'a', '\u00e2': 'a', '\u00e3': 'a', '\u00e4': 'a', '\u00e5': 'a',
  '\u0432': 'b', '\u0412': 'b', '\u03b2': 'b',
  '\u0441': 'c', '\u0421': 'c', '\u00e7': 'c',
  '\u0435': 'e', '\u0415': 'e', '\u0451': 'e', '\u03b5': 'e', '\u00e8': 'e', '\u00e9': 'e', '\u00ea': 'e', '\u00eb': 'e',
  '\u043d': 'h', '\u041d': 'h', '\u03b7': 'h',
  '\u0456': 'i', '\u0406': 'i', '\u0438': 'i', '\u03b9': 'i', '\u00ec': 'i', '\u00ed': 'i', '\u00ee': 'i', '\u00ef': 'i',
  '\u0458': 'j', '\u0408': 'j',
  '\u043a': 'k', '\u041a': 'k', '\u03ba': 'k',
  '\u043c': 'm', '\u041c': 'm', '\u03bc': 'm',
  '\u043e': 'o', '\u041e': 'o', '\u03bf': 'o', '\u00f2': 'o', '\u00f3': 'o', '\u00f4': 'o', '\u00f5': 'o', '\u00f6': 'o', '\u00f8': 'o',
  '\u0440': 'p', '\u0420': 'p', '\u03c1': 'p',
  '\u0455': 's', '\u0405': 's',
  '\u0442': 't', '\u0422': 't', '\u03c4': 't',
  '\u0443': 'y', '\u0423': 'y', '\u00fd': 'y', '\u00ff': 'y',
  '\u0445': 'x', '\u0425': 'x', '\u03c7': 'x',
  '\u00f9': 'u', '\u00fa': 'u', '\u00fb': 'u', '\u00fc': 'u',
  '\u00f1': 'n', '\u03bd': 'v', '\u0475': 'v',
};

const INVISIBLE_CHARS_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD\u034F\u061C\u180E]/g;
const COMBINING_MARKS_RE = /\p{Mn}+/gu;

const NORMALIZED_ASCII_BADWORDS = Array.from(
  new Set(
    DEFAULT_BADWORDS
      .map((w) => w.replace(/[^a-z0-9 ]/gi, '').trim().toLowerCase())
      .filter((w) => w.length >= 3),
  ),
);

const SQUEEZED_BADWORD_MAP = new Map();
for (const bw of NORMALIZED_ASCII_BADWORDS) {
  if (bw.includes(' ')) continue;
  const sq = bw.replace(/(.)\1+/g, '$1');
  if (sq.length >= 4 && !SQUEEZED_BADWORD_MAP.has(sq)) {
    SQUEEZED_BADWORD_MAP.set(sq, bw);
  }
}

function resolveWritableStorePath(fileName = 'antibadword.json') {
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

function defaultGroupConfig() {
  return {
    enabled: false,
    strict: true,
    action: 'warnkick',
    maxWarns: ANTIBADWORD_DEFAULT_MAX_WARNS,
    notify: true,
    customWords: [],
    whitelist: [],
    warns: {},
    stats: {
      detected: 0,
      deleted: 0,
      kicked: 0,
      warned: 0,
      muted: 0,
    },
  };
}

function normalizeGroupConfig(raw) {
  const base = defaultGroupConfig();
  if (!raw || typeof raw !== 'object') return base;
  const maxWarnsNum = Number.parseInt(String(raw.maxWarns ?? base.maxWarns), 10);
  return {
    enabled: Boolean(raw.enabled),
    strict: raw.strict !== undefined ? Boolean(raw.strict) : true,
    action: ANTIBADWORD_ACTIONS.includes(raw.action) ? raw.action : base.action,
    maxWarns: Number.isInteger(maxWarnsNum) && maxWarnsNum >= 1 && maxWarnsNum <= 10 ? maxWarnsNum : base.maxWarns,
    notify: raw.notify !== false,
    customWords: Array.isArray(raw.customWords)
      ? Array.from(new Set(raw.customWords.map((w) => String(w || '').trim().toLowerCase()).filter(Boolean)))
      : [],
    whitelist: Array.isArray(raw.whitelist)
      ? Array.from(new Set(raw.whitelist.map((w) => String(w || '').trim().toLowerCase()).filter(Boolean)))
      : [],
    warns: raw.warns && typeof raw.warns === 'object' ? { ...raw.warns } : {},
    stats: {
      detected: Number(raw.stats?.detected || 0),
      deleted: Number(raw.stats?.deleted || 0),
      kicked: Number(raw.stats?.kicked || 0),
      warned: Number(raw.stats?.warned || 0),
      muted: Number(raw.stats?.muted || 0),
    },
  };
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeUnicodeAndHomoglyphs(input) {
  const folded = String(input || '')
    .replace(INVISIBLE_CHARS_RE, '')
    .normalize('NFKD')
    .replace(COMBINING_MARKS_RE, '')
    .normalize('NFKC');

  let out = '';
  for (const ch of folded) {
    out += HOMOGLYPH_MAP[ch] || ch;
  }
  return out.toLowerCase();
}

function normalizeLeetToken(token) {
  if (!/[a-z]/i.test(token)) return token;
  return token
    .replace(/0/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[$5]/g, 's')
    .replace(/[7+]/g, 't')
    .replace(/8/g, 'b');
}

function collapseSpacedSingleChars(normalized) {
  const parts = normalized.split(/\s+/);
  const rebuilt = [];
  let buffer = '';

  const flush = () => {
    if (buffer) {
      rebuilt.push(buffer);
      buffer = '';
    }
  };

  for (const part of parts) {
    if (/^[a-z0-9@$!*#_]$/i.test(part)) {
      buffer += part;
    } else {
      if (buffer.length >= 3) {
        rebuilt.push(buffer);
        buffer = '';
      } else {
        flush();
      }
      rebuilt.push(part);
    }
  }
  flush();
  return rebuilt.join(' ');
}

function stripWhitelist(text, whitelist = []) {
  if (!Array.isArray(whitelist) || whitelist.length === 0) return text;
  let cleaned = text;
  for (const entry of whitelist) {
    const w = String(entry || '').trim().toLowerCase();
    if (!w) continue;
    const rx = new RegExp(`(?:^|\\b|\\s)${escapeRegex(w)}(?:$|\\b|\\s)`, 'gi');
    cleaned = cleaned.replace(rx, ' ');
  }
  return cleaned;
}

function matchesWildcardMask(token, word) {
  if (!/[*#_?.]/.test(token) || word.length < 4) return false;
  const cleaned = token.replace(/[^a-z0-9*#_?.]/gi, '');
  if (cleaned.length !== word.length) return false;
  if (cleaned[0] !== word[0] || cleaned[cleaned.length - 1] !== word[word.length - 1]) {
    return false;
  }
  let wildcards = 0;
  for (let i = 0; i < word.length; i += 1) {
    const ch = cleaned[i];
    if (ch === word[i]) continue;
    if ('*#_?.'.includes(ch)) {
      wildcards += 1;
      continue;
    }
    return false;
  }
  return wildcards > 0 && wildcards <= Math.max(2, Math.floor(word.length / 2));
}

function squeezeRepeats(token) {
  return String(token || '').replace(/(.)\1+/g, '$1');
}

export function detectBadword(text, groupConfig = null) {
  const raw = String(text || '').trim();
  if (!raw) return { matched: false, word: '', isCustom: false, reason: '' };

  const strict = groupConfig?.strict !== false;
  const customWords = Array.isArray(groupConfig?.customWords) ? groupConfig.customWords : [];
  const whitelist = Array.isArray(groupConfig?.whitelist) ? groupConfig.whitelist : [];

  const lower = stripWhitelist(normalizeUnicodeAndHomoglyphs(raw), whitelist).trim();
  if (!lower) return { matched: false, word: '', isCustom: false, reason: '' };

  // 1. Custom words (exact phrase/word + strict normalized/compound matching)
  for (const cw of customWords) {
    const normCw = normalizeUnicodeAndHomoglyphs(cw).trim();
    if (!normCw) continue;
    const escaped = escapeRegex(normCw);
    const rx = new RegExp(`(?:^|\\b|\\s)${escaped}(?:$|\\b|\\s)`, 'i');
    if (rx.test(lower)) {
      return { matched: true, word: cw, isCustom: true, reason: 'custom-word' };
    }
    if (strict && normCw.length >= 4 && !normCw.includes(' ')) {
      const compactLower = lower.replace(/[^a-z0-9\s]/g, '');
      if (new RegExp(`\\b[a-z0-9]*${escaped}[a-z0-9]*\\b`, 'i').test(compactLower)) {
        return { matched: true, word: cw, isCustom: true, reason: 'custom-compound' };
      }
    }
  }

  // 2. Standard boundary matches against default badwords (both standard & strict modes)
  for (const bw of DEFAULT_BADWORDS) {
    const escaped = escapeRegex(bw);
    const rx = new RegExp(`(?:^|\\b|\\s)${escaped}(?:$|\\b|\\s)`, 'i');
    if (rx.test(lower)) {
      return { matched: true, word: bw, isCustom: false, reason: 'exact' };
    }
  }

  if (!strict) {
    return { matched: false, word: '', isCustom: false, reason: '' };
  }

  // 3. Strict anti-evasion scans: spaced letters, inline punctuation, leetspeak, wildcards, elongation, compound stems
  const collapsedSpacing = collapseSpacedSingleChars(lower);
  const rawTokens = Array.from(
    new Set([
      ...lower.split(/\s+/),
      ...collapsedSpacing.split(/\s+/),
    ]),
  ).filter(Boolean);

  for (const rawTok of rawTokens) {
    const trimmedTok = rawTok.replace(/^[^a-z0-9@$!*#_]+|[^a-z0-9@$!*#_]+$/gi, '');
    if (!trimmedTok) continue;

    // 3a. Wildcard-masked tokens (e.g. f*ck, sh*t, b**ch, a$$hole)
    const leetMasked = trimmedTok
      .replace(/0/g, 'o')
      .replace(/[1!|]/g, 'i')
      .replace(/3/g, 'e')
      .replace(/[4@]/g, 'a')
      .replace(/[$5]/g, 's');
    for (const bw of NORMALIZED_ASCII_BADWORDS) {
      if (bw.includes(' ')) continue;
      if (matchesWildcardMask(trimmedTok, bw) || matchesWildcardMask(leetMasked, bw)) {
        return { matched: true, word: bw, isCustom: false, reason: 'masked-evasion' };
      }
    }

    // 3b. Strip internal separators (f.u.c.k, s-h-i-t, b_i_t_c_h) and normalize leetspeak
    const stripped = trimmedTok.replace(/[._\-/*|~`'"]+/g, '');
    const leetToken = normalizeLeetToken(stripped).replace(/[^a-z]/g, '');
    const alphaToken = stripped.replace(/[^a-z]/g, '');

    for (const candidate of new Set([alphaToken, leetToken].filter(Boolean))) {
      for (const cw of customWords) {
        const cleanCw = normalizeUnicodeAndHomoglyphs(cw).replace(/[^a-z]/g, '');
        if (cleanCw.length >= 3 && (candidate === cleanCw || (cleanCw.length >= 4 && candidate.includes(cleanCw)))) {
          return { matched: true, word: cw, isCustom: true, reason: 'custom-evasion' };
        }
      }

      if (NORMALIZED_ASCII_BADWORDS.includes(candidate)) {
        return { matched: true, word: candidate, isCustom: false, reason: 'obfuscated' };
      }

      // 3c. Strict compound profanity stems (e.g. bullshit, shithead, motherfucking, fuckface)
      for (const stem of STRICT_COMPOUND_STEMS) {
        if (candidate.includes(stem)) {
          return { matched: true, word: stem, isCustom: false, reason: 'strict-compound' };
        }
      }

      // 3d. Elongated / repeated character squeezing (e.g. fuuuuuck -> fuck, biiiitch -> bitch)
      const squeezed = squeezeRepeats(candidate);
      if (squeezed.length >= 4 && SQUEEZED_BADWORD_MAP.has(squeezed)) {
        return { matched: true, word: SQUEEZED_BADWORD_MAP.get(squeezed), isCustom: false, reason: 'elongated' };
      }
      for (const stem of STRICT_COMPOUND_STEMS) {
        const squeezedStem = squeezeRepeats(stem);
        if (squeezedStem.length >= 4 && squeezed.includes(squeezedStem)) {
          return { matched: true, word: stem, isCustom: false, reason: 'strict-elongated' };
        }
      }
    }
  }

  // 4. Multi-word collapsed text check (handles "f u c k" or "behen ke lode" with diacritics/zero-width)
  if (collapsedSpacing !== lower) {
    for (const bw of DEFAULT_BADWORDS) {
      const escaped = escapeRegex(bw);
      if (new RegExp(`(?:^|\\b|\\s)${escaped}(?:$|\\b|\\s)`, 'i').test(collapsedSpacing)) {
        return { matched: true, word: bw, isCustom: false, reason: 'spaced-evasion' };
      }
    }
    for (const cw of customWords) {
      const escaped = escapeRegex(normalizeUnicodeAndHomoglyphs(cw));
      if (escaped && new RegExp(`(?:^|\\b|\\s)${escaped}(?:$|\\b|\\s)`, 'i').test(collapsedSpacing)) {
        return { matched: true, word: cw, isCustom: true, reason: 'spaced-custom' };
      }
    }
  }

  return { matched: false, word: '', isCustom: false, reason: '' };
}

export function createAntibadwordStore({ filePath = '' } = {}) {
  let cache = null;

  function load() {
    if (cache) return cache;
    const target = filePath || resolveWritableStorePath();
    try {
      if (fs.existsSync(target)) {
        const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
        cache = parsed && typeof parsed === 'object' ? { groups: parsed.groups || {} } : { groups: {} };
        return cache;
      }
    } catch {}
    cache = { groups: {} };
    return cache;
  }

  function save() {
    const target = filePath || resolveWritableStorePath();
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(load(), null, 2));
    } catch {}
  }

  function resolveWarnKey(group, senderJid, alternates = []) {
    const candidates = [senderJid, ...alternates].filter(Boolean);
    for (const c of candidates) {
      const cleaned = cleanJid(c);
      if (cleaned && Object.prototype.hasOwnProperty.call(group.warns, cleaned)) return cleaned;
      const phone = extractPhoneDigits(c);
      if (phone) {
        const pnKey = `${phone}@s.whatsapp.net`;
        if (Object.prototype.hasOwnProperty.call(group.warns, pnKey)) return pnKey;
        const found = Object.keys(group.warns).find((k) => extractPhoneDigits(k) === phone);
        if (found) return found;
      }
    }
    const phone = extractPhoneDigits(senderJid) || alternates.map((a) => extractPhoneDigits(a)).find(Boolean);
    if (phone) return `${phone}@s.whatsapp.net`;
    return cleanJid(senderJid) || String(senderJid || 'unknown');
  }

  return {
    getGroupConfig(groupJid) {
      const data = load();
      return normalizeGroupConfig(data.groups[groupJid]);
    },
    setGroupConfig(groupJid, patch = {}) {
      const data = load();
      const merged = normalizeGroupConfig({ ...normalizeGroupConfig(data.groups[groupJid]), ...patch });
      data.groups[groupJid] = merged;
      save();
      return merged;
    },
    addCustomWord(groupJid, word) {
      const w = String(word || '').trim().toLowerCase();
      if (!w) return { added: false, config: this.getGroupConfig(groupJid) };
      const cur = this.getGroupConfig(groupJid);
      if (cur.customWords.includes(w)) return { added: false, config: cur };
      const updated = this.setGroupConfig(groupJid, { customWords: [...cur.customWords, w] });
      return { added: true, config: updated };
    },
    removeCustomWord(groupJid, word) {
      const w = String(word || '').trim().toLowerCase();
      const cur = this.getGroupConfig(groupJid);
      const next = cur.customWords.filter((item) => item !== w);
      const removed = next.length !== cur.customWords.length;
      const updated = removed ? this.setGroupConfig(groupJid, { customWords: next }) : cur;
      return { removed, config: updated };
    },
    addWhitelistWord(groupJid, word) {
      const w = String(word || '').trim().toLowerCase();
      if (!w) return { added: false, config: this.getGroupConfig(groupJid) };
      const cur = this.getGroupConfig(groupJid);
      if (cur.whitelist.includes(w)) return { added: false, config: cur };
      const updated = this.setGroupConfig(groupJid, { whitelist: [...cur.whitelist, w] });
      return { added: true, config: updated };
    },
    removeWhitelistWord(groupJid, word) {
      const w = String(word || '').trim().toLowerCase();
      const cur = this.getGroupConfig(groupJid);
      const next = cur.whitelist.filter((item) => item !== w);
      const removed = next.length !== cur.whitelist.length;
      const updated = removed ? this.setGroupConfig(groupJid, { whitelist: next }) : cur;
      return { removed, config: updated };
    },
    incrementWarn(groupJid, senderJid, alternates = []) {
      const data = load();
      const cur = normalizeGroupConfig(data.groups[groupJid]);
      const key = resolveWarnKey(cur, senderJid, alternates);
      const count = Number(cur.warns[key] || 0) + 1;
      cur.warns[key] = count;
      data.groups[groupJid] = cur;
      save();
      return { count, maxWarns: cur.maxWarns, key };
    },
    resetWarns(groupJid, senderJid = null, alternates = []) {
      const data = load();
      const cur = normalizeGroupConfig(data.groups[groupJid]);
      if (!senderJid) {
        cur.warns = {};
      } else {
        const key = resolveWarnKey(cur, senderJid, alternates);
        delete cur.warns[key];
      }
      data.groups[groupJid] = cur;
      save();
      return cur;
    },
    recordAction(groupJid, statsPatch = {}) {
      const data = load();
      const cur = normalizeGroupConfig(data.groups[groupJid]);
      for (const k of ['detected', 'deleted', 'kicked', 'warned', 'muted']) {
        if (typeof statsPatch[k] === 'number') cur.stats[k] += statsPatch[k];
      }
      data.groups[groupJid] = cur;
      save();
      return cur;
    },
    resetAll() {
      cache = { groups: {} };
      const target = filePath || resolveWritableStorePath();
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch {}
    },
  };
}

export const defaultAntibadwordStore = createAntibadwordStore();

function extractExtraMessageText(msg) {
  const unwrapped = unwrapMessageContent(msg?.message);
  if (!unwrapped || typeof unwrapped !== 'object') return '';
  const extras = [];
  if (typeof unwrapped.documentMessage?.fileName === 'string') {
    extras.push(unwrapped.documentMessage.fileName);
  }
  const pollOpts = unwrapped.pollCreationMessage?.options || unwrapped.pollCreationMessageV3?.options;
  if (Array.isArray(pollOpts)) {
    for (const opt of pollOpts) {
      if (typeof opt?.optionName === 'string') extras.push(opt.optionName);
    }
  }
  if (typeof unwrapped.pollCreationMessageV3?.name === 'string') {
    extras.push(unwrapped.pollCreationMessageV3.name);
  }
  return extras.filter(Boolean).join(' ');
}

export async function handleAntiBadwordMessage({
  sock,
  from,
  sender,
  msg,
  text = '',
  isOwner = false,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntibadwordStore,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !from || !String(from).endsWith('@g.us') || !msg || msg.key?.fromMe) {
    return { handled: false };
  }

  const groupConfig = store.getGroupConfig(from);
  if (!groupConfig.enabled) return { handled: false };

  const baseText = extractMessageText(msg, text);
  const extraText = extractExtraMessageText(msg);
  const messageText = [baseText, extraText].filter(Boolean).join(' ').trim();
  if (!messageText) return { handled: false };

  const detection = detectBadword(messageText, groupConfig);
  if (!detection.matched) return { handled: false };

  let metadata = null;
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

  const senderCandidates = collectSenderIdentities(msg, [sender]);
  const botCandidates = collectBotIdentities(sock);
  const { senderRole, botRole } = await resolveGroupRolesAsync({
    metadata,
    sock,
    senderJids: senderCandidates,
    getPhoneFn: getPhoneFromJid,
  });

  if (isOwner || senderRole.isAdmin || senderRole.isOwner) {
    return { handled: false, skipped: 'privileged' };
  }
  if (metadata && botCandidates.length > 0 && !botRole.isAdmin) {
    return { handled: false, skipped: 'bot-not-admin' };
  }

  const {
    targetJid,
    mentionJid,
    targetUser,
    candidates: resolvedCandidates,
  } = resolveSenderDisplayAndMention({
    senderRole,
    senderJid: sender || msg?.key?.participant || msg?.key?.participantAlt || '',
    senderCandidates,
    metadata,
    getPhoneFn: getPhoneFromJid,
  });

  const delRes = await deleteMessageSafely({
    sock,
    from,
    msg,
    targetJid,
    senderCandidates: resolvedCandidates,
    metadata,
    getPhoneFn: getPhoneFromJid,
    broadcastAlternates: true,
  });
  const deleted = delRes.ok;

  const action = groupConfig.action || 'warnkick';
  let kicked = false;
  let muted = false;
  let warnedCount = 0;

  if (action === 'kick') {
    const kickRes = await executeParticipantsAction({
      sock,
      from,
      participants: targetJid ? [targetJid, ...resolvedCandidates] : resolvedCandidates,
      action: 'remove',
      metadata,
    });
    kicked = kickRes.ok;
    store.resetWarns(from, targetJid, resolvedCandidates);
    store.recordAction(from, { detected: 1, deleted: deleted ? 1 : 0, kicked: kicked ? 1 : 0 });
  } else if (action === 'mute') {
    const muteRes = await executeGroupSettingUpdate({
      sock,
      from,
      setting: 'announcement',
      metadata,
    });
    muted = muteRes.ok;
    store.recordAction(from, { detected: 1, deleted: deleted ? 1 : 0, muted: muted ? 1 : 0 });
  } else if (action === 'warn' || action === 'warnkick') {
    const warnState = store.incrementWarn(from, targetJid, resolvedCandidates);
    warnedCount = warnState.count;
    if (warnState.count >= warnState.maxWarns) {
      const kickRes = await executeParticipantsAction({
        sock,
        from,
        participants: targetJid ? [targetJid, ...resolvedCandidates] : resolvedCandidates,
        action: 'remove',
        metadata,
      });
      kicked = kickRes.ok;
      store.resetWarns(from, targetJid, resolvedCandidates);
      store.recordAction(from, {
        detected: 1,
        deleted: deleted ? 1 : 0,
        warned: 1,
        kicked: kicked ? 1 : 0,
      });
    } else {
      store.recordAction(from, { detected: 1, deleted: deleted ? 1 : 0, warned: 1 });
    }
  } else {
    store.recordAction(from, { detected: 1, deleted: deleted ? 1 : 0 });
  }

  if (groupConfig.notify !== false) {
    const alertText = [
      spiderHeader(botName, 'ANTIBADWORD TRIGGERED'),
      spiderRow('USER', `@${targetUser}`, '👤'),
      spiderRow('MODE', groupConfig.strict !== false ? 'STRICT 🔥' : 'STANDARD', '☢'),
      spiderRow('MESSAGE', deleted ? 'Deleted (Everyone)' : 'Flagged', '🗑'),
      spiderRow(
        'ENFORCEMENT',
        kicked
          ? 'Removed from Group'
          : muted
            ? 'Group Muted (Admins Only)'
            : action === 'warn' || action === 'warnkick'
              ? `Warned (${warnedCount}/${groupConfig.maxWarns})`
              : 'Message Deleted',
        '⚡',
      ),
      spiderFooter('ANTIBADWORD // SPIDER-MAN'),
    ].join('\n');

    await sock.sendMessage(from, {
      text: alertText,
      ...(mentionJid ? { mentions: [mentionJid] } : {}),
    });
  }

  return {
    handled: true,
    deleted,
    kicked,
    muted,
    warnedCount,
    word: detection.word,
    reason: detection.reason || '',
  };
}

