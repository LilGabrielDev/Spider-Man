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
  extractContextInfo,
  resolveSenderDisplayAndMention,
  unwrapMessageContent,
} from './groupActionHelper.js';

export const ANTIMENTION_ACTIONS = ['delete', 'warn', 'warnkick', 'kick'];
export const ANTIMENTION_DEFAULT_MAX_WARNS = 3;

function resolveWritableStorePath(fileName = 'antimention.json') {
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
    maxWarns: ANTIMENTION_DEFAULT_MAX_WARNS,
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
    action: ANTIMENTION_ACTIONS.includes(raw.action) ? raw.action : base.action,
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

export function detectGroupMention(msg) {
  if (!msg || typeof msg !== 'object') {
    return { isGroupMention: false, reason: '' };
  }

  const layers = [msg.message, unwrapMessageContent(msg.message)].filter((l) => l && typeof l === 'object');
  for (const layer of layers) {
    if (
      layer.groupMentionedMessage ||
      layer.extendedTextMessage?.groupMentionedMessage ||
      layer.groupMentionMessage ||
      layer.statusMentionMessage
    ) {
      return { isGroupMention: true, reason: 'Group / Status Mention Message' };
    }
  }

  const contexts = [];
  const { contextInfo } = extractContextInfo(msg);
  if (contextInfo) contexts.push(contextInfo);
  for (const layer of layers) {
    if (layer.contextInfo && typeof layer.contextInfo === 'object') contexts.push(layer.contextInfo);
    for (const v of Object.values(layer)) {
      if (v && typeof v === 'object' && v.contextInfo && typeof v.contextInfo === 'object') {
        contexts.push(v.contextInfo);
      }
    }
  }

  const mentionedSet = new Set();
  for (const ctx of contexts) {
    if (Array.isArray(ctx.groupMentions) && ctx.groupMentions.length > 0) {
      return { isGroupMention: true, reason: 'Group Mention Tag' };
    }
    if (Array.isArray(ctx.mentionedJid)) {
      for (const j of ctx.mentionedJid) {
        const cl = cleanJid(j);
        if (cl) mentionedSet.add(cl);
      }
    }
  }

  if (mentionedSet.size >= 10) {
    return { isGroupMention: true, reason: `Mass Mention (${mentionedSet.size} users)` };
  }

  return { isGroupMention: false, reason: '' };
}

export function createAntimentionStore({ filePath = '' } = {}) {
  let cache = null;

  function load() {
    if (cache) return cache;
    const target = filePath || resolveWritableStorePath();
    try {
      if (fs.existsSync(target)) {
        const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
        cache = {
          groups: parsed?.groups || {},
          global: {
            enabled: Boolean(parsed?.global?.enabled),
            action: ANTIMENTION_ACTIONS.includes(parsed?.global?.action) ? parsed.global.action : 'delete',
          },
        };
        return cache;
      }
    } catch {}
    cache = { groups: {}, global: { enabled: false, action: 'delete' } };
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
    getGlobalConfig() {
      const data = load();
      return {
        enabled: Boolean(data.global?.enabled),
        action: ANTIMENTION_ACTIONS.includes(data.global?.action) ? data.global.action : 'delete',
      };
    },
    setGlobalConfig(patch = {}) {
      const data = load();
      const cur = this.getGlobalConfig();
      const next = {
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
        action: ANTIMENTION_ACTIONS.includes(patch.action) ? patch.action : cur.action,
      };
      data.global = next;
      save();
      return next;
    },
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
      cache = { groups: {}, global: { enabled: false, action: 'delete' } };
      const target = filePath || resolveWritableStorePath();
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch {}
    },
  };
}

export const defaultAntimentionStore = createAntimentionStore();

export async function handleAntiMentionMessage({
  sock,
  from,
  sender,
  msg,
  isOwner = false,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntimentionStore,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !from || !String(from).endsWith('@g.us') || !msg || msg.key?.fromMe) {
    return { handled: false };
  }

  const groupConfig = store.getGroupConfig(from);
  const globalConfig = typeof store.getGlobalConfig === 'function' ? store.getGlobalConfig() : { enabled: false };
  if (!groupConfig.enabled && !globalConfig.enabled) return { handled: false };

  const detection = detectGroupMention(msg);
  if (!detection.isGroupMention) return { handled: false };

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

  const effectiveAction = groupConfig.enabled
    ? groupConfig.action
    : globalConfig.action || 'delete';

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

  let kicked = false;
  let warnedCount = 0;

  if (effectiveAction === 'kick') {
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
  } else if (effectiveAction === 'warn' || effectiveAction === 'warnkick') {
    const warnState = store.incrementWarn(from, targetJid, resolvedCandidates);
    warnedCount = warnState.count;
    if (effectiveAction === 'warnkick' && warnState.count >= warnState.maxWarns) {
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
      spiderHeader(botName, 'ANTIMENTION SHIELD'),
      spiderRow('USER', `@${targetUser}`, '👤'),
      spiderRow('REASON', detection.reason || 'Group Mention', '📢'),
      spiderRow('MESSAGE', deleted ? 'Deleted (Everyone)' : 'Flagged', '🗑'),
      spiderRow(
        'ENFORCEMENT',
        kicked
          ? 'Removed from Group'
          : effectiveAction === 'warn' || effectiveAction === 'warnkick'
            ? `Warned (${warnedCount}/${groupConfig.maxWarns})`
            : 'Message Deleted',
        '⚡',
      ),
      spiderFooter('ANTIMENTION // SPIDER-MAN'),
    ].join('\n');

    await sock.sendMessage(from, {
      text: alertText,
      ...(mentionJid ? { mentions: [mentionJid] } : {}),
    });
  }

  return { handled: true, deleted, kicked, warnedCount, reason: detection.reason };
}
