import fs from 'fs';
import os from 'os';
import path from 'path';
import { spiderFooter, spiderHeader, spiderRow } from '../../Spider/utils/tableStyle.js';
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

export const ANTIBOT_ACTIONS = ['delete', 'warn', 'kick'];
export const ANTIBOT_DEFAULT_MAX_WARNS = 3;

function resolveWritableStorePath(fileName = 'antibot.json') {
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
    action: 'kick',
    maxWarns: ANTIBOT_DEFAULT_MAX_WARNS,
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
  const maxW = Number.parseInt(String(raw.maxWarns ?? base.maxWarns), 10);
  return {
    enabled: Boolean(raw.enabled),
    action: ANTIBOT_ACTIONS.includes(raw.action) ? raw.action : base.action,
    maxWarns: Number.isInteger(maxW) && maxW >= 1 && maxW <= 10 ? maxW : base.maxWarns,
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

export function createAntibotStore({ filePath = '' } = {}) {
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

export const defaultAntibotStore = createAntibotStore();

export function detectBotActivity({ msg, text = '', isCommand = false } = {}) {
  if (isCommand) {
    return { isBot: true, reason: 'Unauthorized Bot Command' };
  }
  const m = msg?.message || {};
  if (m.botInvokeMessage || m.bcallMessage) {
    return { isBot: true, reason: 'Bot Invoke Payload' };
  }
  const id = String(msg?.key?.id || '');
  if (/^BAE5[0-9A-F]{8,}$/i.test(id)) {
    return { isBot: true, reason: 'Automated Bot Client Signature' };
  }
  const cleanText = String(text || '').trim();
  if (/^❯❯|^⛨\s*SPIDER\s*MAN\b/i.test(cleanText)) {
    return { isBot: true, reason: 'External Bot Output' };
  }
  return { isBot: false, reason: '' };
}

export async function handleAntiBotMessage({
  sock,
  from,
  sender,
  msg,
  text = '',
  isCommand = false,
  isOwner = false,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntibotStore,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !from || !String(from).endsWith('@g.us') || !msg || msg.key?.fromMe) {
    return { handled: false };
  }

  const groupConfig = store.getGroupConfig(from);
  if (!groupConfig.enabled) return { handled: false };

  const detection = detectBotActivity({ msg, text, isCommand });
  if (!detection.isBot) return { handled: false };

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

  const action = groupConfig.action || 'kick';
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
  } else if (action === 'warn') {
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
      spiderHeader(botName, 'ANTIBOT SHIELD'),
      spiderRow('USER', `@${targetUser}`, '🤖'),
      spiderRow('REASON', detection.reason, '⚠'),
      spiderRow('MESSAGE', deleted ? 'Deleted (Everyone)' : 'Flagged', '🗑'),
      spiderRow(
        'ENFORCEMENT',
        kicked ? 'Removed from Group' : action === 'warn' ? `Warned (${warnedCount}/${groupConfig.maxWarns})` : 'Blocked',
        '⚡',
      ),
      spiderFooter('ANTIBOT // SPIDER-MAN'),
    ].join('\n');

    await sock.sendMessage(from, {
      text: alertText,
      ...(mentionJid ? { mentions: [mentionJid] } : {}),
    });
  }

  return { handled: true, deleted, kicked, warnedCount, reason: detection.reason };
}
