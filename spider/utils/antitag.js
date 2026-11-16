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
  extractContextInfo,
  resolveSenderDisplayAndMention,
  unwrapMessageContent,
} from './groupActionHelper.js';

export const ANTITAG_ACTIONS = ['delete', 'warn', 'kick', 'warnkick'];
export const ANTITAG_DEFAULT_MAX_WARNS = 3;

function resolveWritableStorePath(fileName = 'antitag.json') {
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
    action: 'delete',
    maxWarns: ANTITAG_DEFAULT_MAX_WARNS,
    notify: true,
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
    action: ANTITAG_ACTIONS.includes(raw.action) ? raw.action : base.action,
    maxWarns: Number.isInteger(maxWarnsNum) && maxWarnsNum >= 1 && maxWarnsNum <= 10 ? maxWarnsNum : base.maxWarns,
    notify: raw.notify !== false,
    warns: raw.warns && typeof raw.warns === 'object' ? { ...raw.warns } : {},
    stats: {
      detected: Number(raw.stats?.detected || 0),
      deleted: Number(raw.stats?.deleted || 0),
      kicked: Number(raw.stats?.kicked || 0),
      warned: Number(raw.stats?.warned || 0),
    },
  };
}

function collectMentionedJids(msg) {
  const set = new Set();
  const addAll = (ctx) => {
    if (ctx && Array.isArray(ctx.mentionedJid)) {
      for (const j of ctx.mentionedJid) {
        const cleaned = cleanJid(j);
        if (cleaned) set.add(cleaned);
      }
    }
  };
  const { contextInfo } = extractContextInfo(msg);
  addAll(contextInfo);
  const unwrapped = unwrapMessageContent(msg?.message);
  for (const layer of [msg?.message, unwrapped]) {
    if (!layer || typeof layer !== 'object') continue;
    addAll(layer.contextInfo);
    for (const v of Object.values(layer)) {
      if (v && typeof v === 'object' && v.contextInfo) addAll(v.contextInfo);
    }
  }
  return Array.from(set);
}

export function detectMassTag({ msg, text = '', participantsCount = 0 } = {}) {
  const mentionedJids = collectMentionedJids(msg);
  const messageText = extractMessageText(msg, text);
  const numericMatches = messageText.match(/@\d{7,}/g) || [];
  const uniqueNumeric = new Set(numericMatches.map((m) => m.slice(1)));

  const mentionedCount = mentionedJids.length;
  const numericCount = uniqueNumeric.size;
  const totalMentions = Math.max(mentionedCount, numericCount);

  if (totalMentions < 3) {
    return { isMassTag: false, totalMentions, mentionedCount, numericCount };
  }

  const threshold = participantsCount > 0 ? Math.max(3, Math.ceil(participantsCount * 0.5)) : 10;
  const hasManyNumeric =
    numericCount >= 10 || (participantsCount > 0 && numericCount >= 5 && numericCount >= threshold);

  const isMassTag = totalMentions >= threshold || hasManyNumeric;
  return { isMassTag, totalMentions, mentionedCount, numericCount, threshold };
}

export function createAntitagStore({ filePath = '' } = {}) {
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
      }
    }
    const phone = extractPhoneDigits(senderJid) || alternates.map((a) => extractPhoneDigits(a)).find(Boolean);
    return phone ? `${phone}@s.whatsapp.net` : cleanJid(senderJid) || String(senderJid || 'unknown');
  }

  return {
    getGroupConfig(groupJid) {
      return normalizeGroupConfig(load().groups[groupJid]);
    },
    setGroupConfig(groupJid, patch = {}) {
      const data = load();
      const merged = normalizeGroupConfig({ ...normalizeGroupConfig(data.groups[groupJid]), ...patch });
      data.groups[groupJid] = merged;
      save();
      return merged;
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
      if (!senderJid) cur.warns = {};
      else delete cur.warns[resolveWarnKey(cur, senderJid, alternates)];
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

export const defaultAntitagStore = createAntitagStore();

export async function handleAntiTagMessage({
  sock,
  from,
  sender,
  msg,
  text = '',
  isOwner = false,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntitagStore,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !from || !String(from).endsWith('@g.us') || !msg || msg.key?.fromMe) {
    return { handled: false };
  }

  const groupConfig = store.getGroupConfig(from);
  if (!groupConfig.enabled) return { handled: false };

  let metadata = null;
  if (typeof fetchGroupMetadata === 'function') {
    try {
      metadata = await fetchGroupMetadata(from);
    } catch {}
  } else if (typeof sock.groupMetadata === 'function') {
    try {
      metadata = await sock.groupMetadata(from);
    } catch {}
  }

  const participantsCount = Array.isArray(metadata?.participants) ? metadata.participants.length : 0;
  const detection = detectMassTag({ msg, text, participantsCount });
  if (!detection.isMassTag) return { handled: false };

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

  const action = groupConfig.action || 'delete';
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
    if (action === 'warnkick' && warnState.count >= warnState.maxWarns) {
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
      spiderHeader(botName, 'ANTITAG // MASS MENTION BLOCKED'),
      spiderRow('USER', `@${targetUser}`, '👤'),
      spiderRow('MENTIONS DETECTED', String(detection.totalMentions), '📢'),
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
      spiderFooter('ANTITAG // SPIDER-MAN'),
    ].join('\n');

    await sock.sendMessage(from, {
      text: alertText,
      ...(mentionJid ? { mentions: [mentionJid] } : {}),
    });
  }

  return { handled: true, deleted, kicked, warnedCount, totalMentions: detection.totalMentions };
}
