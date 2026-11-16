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

export const ANTISPAM_ACTIONS = ['delete', 'warn', 'kick', 'warnkick', 'mute'];
export const ANTISPAM_DEFAULT_REPEAT_LIMIT = 3;
export const ANTISPAM_DEFAULT_WINDOW_SEC = 12;
export const ANTISPAM_DEFAULT_MAX_WARNS = 3;

function resolveWritableStorePath(fileName = 'antispam.json') {
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
    repeatLimit: ANTISPAM_DEFAULT_REPEAT_LIMIT,
    windowSec: ANTISPAM_DEFAULT_WINDOW_SEC,
    maxWarns: ANTISPAM_DEFAULT_MAX_WARNS,
    notify: true,
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
  const rep = Number.parseInt(String(raw.repeatLimit ?? base.repeatLimit), 10);
  const win = Number.parseInt(String(raw.windowSec ?? base.windowSec), 10);
  const maxW = Number.parseInt(String(raw.maxWarns ?? base.maxWarns), 10);
  return {
    enabled: Boolean(raw.enabled),
    action: ANTISPAM_ACTIONS.includes(raw.action) ? raw.action : base.action,
    repeatLimit: Number.isInteger(rep) && rep >= 2 && rep <= 20 ? rep : base.repeatLimit,
    windowSec: Number.isInteger(win) && win >= 3 && win <= 120 ? win : base.windowSec,
    maxWarns: Number.isInteger(maxW) && maxW >= 1 && maxW <= 10 ? maxW : base.maxWarns,
    notify: raw.notify !== false,
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

export function buildSpamSignature(msg, text = '') {
  const normalizedText = String(extractMessageText(msg, text) || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (normalizedText) {
    return { kind: 'text', sig: `txt:${normalizedText.slice(0, 180)}` };
  }
  const unwrapped = unwrapMessageContent(msg?.message);
  if (unwrapped?.stickerMessage) {
    const sha = unwrapped.stickerMessage.fileSha256
      ? Buffer.from(unwrapped.stickerMessage.fileSha256).toString('hex').slice(0, 16)
      : 'sticker';
    return { kind: 'sticker', sig: `stk:${sha}` };
  }
  if (unwrapped?.imageMessage) return { kind: 'media', sig: 'img' };
  if (unwrapped?.videoMessage) return { kind: 'media', sig: 'vid' };
  if (unwrapped?.audioMessage) return { kind: 'media', sig: 'aud' };
  if (unwrapped?.documentMessage) return { kind: 'media', sig: 'doc' };
  return null;
}

export function createSpamTracker() {
  const map = new Map();

  return {
    record(groupJid, senderKey, { msg, text = '', repeatLimit = 3, windowSec = 12 } = {}, now = Date.now()) {
      const signature = buildSpamSignature(msg, text);
      if (!signature) return { isSpam: false, count: 0 };

      const key = `${groupJid}::${senderKey}`;
      const windowMs = Math.max(3, Number(windowSec) || 12) * 1000;
      const cutoff = now - windowMs;
      const existing = (map.get(key) || []).filter((item) => item.ts >= cutoff);
      existing.push({ sig: signature.sig, kind: signature.kind, ts: now, msg });
      map.set(key, existing.slice(-30));

      const matching = existing.filter((item) => item.sig === signature.sig);
      const effectiveThreshold =
        signature.kind === 'text' || signature.kind === 'sticker'
          ? Math.max(2, Number(repeatLimit) || 3)
          : Math.max(3, (Number(repeatLimit) || 3) + 1);

      if (matching.length >= effectiveThreshold) {
        return {
          isSpam: true,
          count: matching.length,
          threshold: effectiveThreshold,
          kind: signature.kind,
          recentMsgs: matching.map((m) => m.msg).filter(Boolean),
        };
      }

      return { isSpam: false, count: matching.length, threshold: effectiveThreshold };
    },
    resetSender(groupJid, senderKey) {
      map.delete(`${groupJid}::${senderKey}`);
    },
    resetGroup(groupJid) {
      const prefix = `${groupJid}::`;
      for (const k of map.keys()) {
        if (k.startsWith(prefix)) map.delete(k);
      }
    },
    clearAll() {
      map.clear();
    },
  };
}

export const defaultSpamTracker = createSpamTracker();

export function createAntispamStore({ filePath = '' } = {}) {
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
      for (const k of ['detected', 'deleted', 'kicked', 'warned', 'muted']) {
        if (typeof statsPatch[k] === 'number') cur.stats[k] += statsPatch[k];
      }
      data.groups[groupJid] = cur;
      save();
      return cur;
    },
    resetAll() {
      cache = { groups: {} };
      defaultSpamTracker.clearAll();
      const target = filePath || resolveWritableStorePath();
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch {}
    },
  };
}

export const defaultAntispamStore = createAntispamStore();

export async function handleAntiSpamMessage({
  sock,
  from,
  sender,
  msg,
  text = '',
  isOwner = false,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntispamStore,
  tracker = defaultSpamTracker,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !from || !String(from).endsWith('@g.us') || !msg || msg.key?.fromMe) {
    return { handled: false };
  }

  const groupConfig = store.getGroupConfig(from);
  if (!groupConfig.enabled) return { handled: false };

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

  const primarySender = senderRole.targetJid || senderCandidates[0] || sender || msg?.key?.participant;
  const senderKey = extractPhoneDigits(primarySender, getPhoneFromJid) || cleanJid(primarySender) || 'unknown';
  const hit = tracker.record(from, senderKey, {
    msg,
    text,
    repeatLimit: groupConfig.repeatLimit,
    windowSec: groupConfig.windowSec,
  });

  if (!hit.isSpam) return { handled: false };
  if (metadata && botCandidates.length > 0 && !botRole.isAdmin) {
    return { handled: false, skipped: 'bot-not-admin' };
  }

  tracker.resetSender(from, senderKey);

  const {
    targetJid,
    mentionJid,
    targetUser,
    candidates: resolvedCandidates,
  } = resolveSenderDisplayAndMention({
    senderRole,
    senderJid: primarySender,
    senderCandidates,
    metadata,
    getPhoneFn: getPhoneFromJid,
  });

  let deletedCount = 0;
  const uniqueMsgs = Array.from(new Map((hit.recentMsgs || [msg]).map((m) => [m?.key?.id, m])).values());
  for (const spamMsg of uniqueMsgs) {
    if (!spamMsg?.key?.id) continue;
    const delRes = await deleteMessageSafely({
      sock,
      from,
      msg: spamMsg,
      targetJid,
      senderCandidates: resolvedCandidates,
      metadata,
      getPhoneFn: getPhoneFromJid,
      broadcastAlternates: true,
    });
    if (delRes.ok) deletedCount += 1;
  }

  const action = groupConfig.action || 'delete';
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
    store.recordAction(from, { detected: 1, deleted: deletedCount, kicked: kicked ? 1 : 0 });
  } else if (action === 'mute') {
    const muteRes = await executeGroupSettingUpdate({ sock, from, setting: 'announcement' });
    muted = muteRes.ok;
    store.recordAction(from, { detected: 1, deleted: deletedCount, muted: muted ? 1 : 0 });
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
        deleted: deletedCount,
        warned: 1,
        kicked: kicked ? 1 : 0,
      });
    } else {
      store.recordAction(from, { detected: 1, deleted: deletedCount, warned: 1 });
    }
  } else {
    store.recordAction(from, { detected: 1, deleted: deletedCount });
  }

  if (groupConfig.notify !== false) {
    const alertText = [
      spiderHeader(botName, 'ANTISPAM SHIELD'),
      spiderRow('USER', `@${targetUser}`, '👤'),
      spiderRow('REPEATED SPAM', `${hit.count}x within ${groupConfig.windowSec}s`, '◷'),
      spiderRow('DELETED', `${deletedCount} message(s) (Everyone)`, '🗑'),
      spiderRow(
        'ENFORCEMENT',
        kicked
          ? 'Removed from Group'
          : muted
            ? 'Group Muted (Admins Only)'
            : action === 'warn' || action === 'warnkick'
              ? `Warned (${warnedCount}/${groupConfig.maxWarns})`
              : 'Spam Cleared',
        '⚡',
      ),
      spiderFooter('ANTISPAM // SPIDER-MAN'),
    ].join('\n');

    await sock.sendMessage(from, {
      text: alertText,
      ...(mentionJid ? { mentions: [mentionJid] } : {}),
    });
  }

  return { handled: true, deleted: deletedCount > 0, deletedCount, kicked, muted, warnedCount };
}
