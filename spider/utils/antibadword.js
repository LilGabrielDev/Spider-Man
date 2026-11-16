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
  executeParticipantsAction,
  resolveSenderDisplayAndMention,
} from './groupActionHelper.js';

export const ANTIBADWORD_ACTIONS = ['delete', 'warn', 'kick', 'warnkick'];
export const ANTIBADWORD_DEFAULT_MAX_WARNS = 3;

export const DEFAULT_BADWORDS = [
  'fuck', 'fck', 'fckr', 'fcker', 'fuk', 'fukk', 'fcuk', 'f*ck', 'f@ck', 'f***er', 'motherfucker',
  'shit', 's***head', 'bitch', 'btch', 'b!tch', 'asshole', 'a**hole', 'assclown', 'bastard',
  'dick', 'd!ck', 'cock', 'pussy', 'cunt', 'twat', 'wanker', 'slut', 'slutty', 'whore', 'skank',
  'prick', 'douchebag', 'jackass', 'scumbag', 'retard', 'boobs', 'boobies', 'tits',
  'blowjob', 'handjob', 'cumshot', 'deepthroat', 'hentai', 'milf', 'orgasm', 'dildo', 'vibrator',
  'gangbang', 'threesome', 'porn', 'xxx',
  'nigga', 'n!gga', 'chink', 'gook', 'kike', 'paki', 'wetback', 'raghead', 'spic', 'towelhead',
  'faggot', 'dyke', 'tranny',
  'chut', 'lund', 'lodu', 'l0du', 'lund69', 'benchod', 'behen ke lode', 'madar', 'chodne',
  'chudai', 'chodu', 'harami', 'haramzada', 'randi', 'gaand mara', 'gandu', 'kameena', 'bsdk',
  'teri ma ki', 'teri maa ki',
  'heroin', 'meth', 'cocaine',
];

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
    action: 'warn',
    maxWarns: ANTIBADWORD_DEFAULT_MAX_WARNS,
    notify: true,
    customWords: [],
    warns: {},
    stats: {
      detected: 0,
      deleted: 0,
      kicked: 0,
      warned: 0,
    },
  };
}

function normalizeGroupConfig(raw) {
  const base = defaultGroupConfig();
  if (!raw || typeof raw !== 'object') return base;
  const maxWarnsNum = Number.parseInt(String(raw.maxWarns ?? base.maxWarns), 10);
  return {
    enabled: Boolean(raw.enabled),
    action: ANTIBADWORD_ACTIONS.includes(raw.action) ? raw.action : base.action,
    maxWarns: Number.isInteger(maxWarnsNum) && maxWarnsNum >= 1 && maxWarnsNum <= 10 ? maxWarnsNum : base.maxWarns,
    notify: raw.notify !== false,
    customWords: Array.isArray(raw.customWords)
      ? Array.from(new Set(raw.customWords.map((w) => String(w || '').trim().toLowerCase()).filter(Boolean)))
      : [],
    warns: raw.warns && typeof raw.warns === 'object' ? { ...raw.warns } : {},
    stats: {
      detected: Number(raw.stats?.detected || 0),
      deleted: Number(raw.stats?.deleted || 0),
      kicked: Number(raw.stats?.kicked || 0),
      warned: Number(raw.stats?.warned || 0),
    },
  };
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectBadword(text, groupConfig = null) {
  const raw = String(text || '').trim();
  if (!raw) return { matched: false, word: '', isCustom: false };

  const customWords = Array.isArray(groupConfig?.customWords) ? groupConfig.customWords : [];
  const lower = raw.toLowerCase();

  for (const cw of customWords) {
    if (!cw) continue;
    const escaped = escapeRegex(cw);
    const rx = new RegExp(`(?:^|\\b|\\s)${escaped}(?:$|\\b|\\s)`, 'i');
    if (rx.test(lower)) {
      return { matched: true, word: cw, isCustom: true };
    }
  }

  for (const bw of DEFAULT_BADWORDS) {
    const escaped = escapeRegex(bw);
    const rx = new RegExp(`(?:^|\\b|\\s)${escaped}(?:$|\\b|\\s)`, 'i');
    if (rx.test(lower)) {
      return { matched: true, word: bw, isCustom: false };
    }
  }

  return { matched: false, word: '', isCustom: false };
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
      for (const k of ['detected', 'deleted', 'kicked', 'warned']) {
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

  const messageText = extractMessageText(msg, text);
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

  const action = groupConfig.action || 'warn';
  let kicked = false;
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
      spiderRow('MESSAGE', deleted ? 'Deleted (Everyone)' : 'Flagged', '🗑'),
      spiderRow(
        'ENFORCEMENT',
        kicked
          ? 'Removed from Group'
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

  return { handled: true, deleted, kicked, warnedCount, word: detection.word };
}
