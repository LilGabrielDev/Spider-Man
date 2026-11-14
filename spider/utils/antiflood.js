import fs from 'node:fs';
import path from 'node:path';
import { spiderHeader, spiderRow, spiderFooter } from '../../Spider/utils/tableStyle.js';
import { cleanJid, extractPhone } from './antiscam.js';
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

export const ANTIFLOOD_ACTIONS = Object.freeze(['delete', 'warn', 'kick', 'warnkick', 'mute']);

export const ANTIFLOOD_MIN_LIMIT = 2;
export const ANTIFLOOD_MAX_LIMIT = 30;
export const ANTIFLOOD_DEFAULT_LIMIT = 5;

export const ANTIFLOOD_MIN_WINDOW_SEC = 3;
export const ANTIFLOOD_MAX_WINDOW_SEC = 120;
export const ANTIFLOOD_DEFAULT_WINDOW_SEC = 10;

const DEFAULT_MAX_WARNS = 3;
const MAX_WHITELIST_ENTRIES = 100;
const MAX_TRACKED_KEYS = 5000;
const CLEANUP_INTERVAL = 128;

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

function defaultGroupConfig() {
  return {
    enabled: false,
    action: 'delete',
    limit: ANTIFLOOD_DEFAULT_LIMIT,
    windowSec: ANTIFLOOD_DEFAULT_WINDOW_SEC,
    maxWarns: DEFAULT_MAX_WARNS,
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

  const action = ANTIFLOOD_ACTIONS.includes(String(raw.action || '').toLowerCase())
    ? String(raw.action).toLowerCase()
    : base.action;

  const limitNum = Number(raw.limit);
  const limit =
    Number.isInteger(limitNum) && limitNum >= ANTIFLOOD_MIN_LIMIT && limitNum <= ANTIFLOOD_MAX_LIMIT
      ? limitNum
      : base.limit;

  const windowNum = Number(raw.windowSec);
  const windowSec =
    Number.isInteger(windowNum) &&
    windowNum >= ANTIFLOOD_MIN_WINDOW_SEC &&
    windowNum <= ANTIFLOOD_MAX_WINDOW_SEC
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
    limit,
    windowSec,
    maxWarns,
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

export function createAntifloodStore(
  storePathOrResolver = () => path.join(process.cwd(), 'data', 'antiflood.json'),
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
    addWhitelist,
    removeWhitelist,
    recordAction,
    clearCache,
  };
}

export const defaultAntifloodStore = createAntifloodStore();

export function createFloodTracker({ now = Date.now, maxTrackedKeys = MAX_TRACKED_KEYS } = {}) {
  const buckets = new Map();
  let callsSinceCleanup = 0;
  let lastObservedTime = Number.NEGATIVE_INFINITY;

  function makeSenderKey(senderJid, getPhoneFn = null) {
    const cleaned = cleanJid(senderJid);
    const phone = (typeof getPhoneFn === 'function' ? getPhoneFn(cleaned) : null) || extractPhone(cleaned);
    return phone || cleaned || String(senderJid || 'unknown');
  }

  function makeBucketKey(groupJid, senderJid, getPhoneFn = null) {
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

  function pruneExpiredTimestamps(timestamps, windowStart) {
    let expiredCount = 0;
    while (expiredCount < timestamps.length && timestamps[expiredCount] <= windowStart) {
      expiredCount += 1;
    }
    if (expiredCount > 0) timestamps.splice(0, expiredCount);
  }

  function pruneStaleBuckets(nowMs, defaultWindowMs = ANTIFLOOD_MAX_WINDOW_SEC * 1000) {
    for (const [key, entry] of buckets.entries()) {
      const windowStart = nowMs - (entry.windowMs || defaultWindowMs);
      pruneExpiredTimestamps(entry.timestamps, windowStart);
      if (entry.timestamps.length === 0 && nowMs - entry.lastAlertAt > defaultWindowMs) {
        buckets.delete(key);
      }
    }
  }

  function recordMessage(
    groupJid,
    senderJid,
    { limit = ANTIFLOOD_DEFAULT_LIMIT, windowSec = ANTIFLOOD_DEFAULT_WINDOW_SEC, getPhoneFn = null } = {},
  ) {
    const nowMs = currentTimeMs();
    const windowMs = Math.max(1000, Number(windowSec || ANTIFLOOD_DEFAULT_WINDOW_SEC) * 1000);
    const windowStart = nowMs - windowMs;

    callsSinceCleanup += 1;
    if (callsSinceCleanup >= CLEANUP_INTERVAL) {
      pruneStaleBuckets(nowMs);
      callsSinceCleanup = 0;
    }

    const key = makeBucketKey(groupJid, senderJid, getPhoneFn);
    let entry = buckets.get(key);
    if (!entry) {
      entry = { timestamps: [], windowMs, lastAlertAt: Number.NEGATIVE_INFINITY };
    } else {
      buckets.delete(key);
      entry.windowMs = windowMs;
    }

    pruneExpiredTimestamps(entry.timestamps, windowStart);
    entry.timestamps.push(nowMs);
    buckets.set(key, entry);

    if (buckets.size > maxTrackedKeys) {
      pruneStaleBuckets(nowMs);
      while (buckets.size > maxTrackedKeys) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey === undefined) break;
        buckets.delete(oldestKey);
      }
    }

    const count = entry.timestamps.length;
    const isFlood = count > limit;
    const alertCooldownElapsed = nowMs - entry.lastAlertAt >= windowMs;

    return {
      isFlood,
      count,
      limit,
      windowSec,
      alertCooldownElapsed,
    };
  }

  function markAlertSent(groupJid, senderJid, getPhoneFn = null) {
    const key = makeBucketKey(groupJid, senderJid, getPhoneFn);
    const entry = buckets.get(key);
    if (entry) {
      entry.lastAlertAt = currentTimeMs();
    }
  }

  function resetSender(groupJid, senderJid, getPhoneFn = null) {
    const key = makeBucketKey(groupJid, senderJid, getPhoneFn);
    const entry = buckets.get(key);
    if (entry) {
      entry.timestamps = [];
    }
  }

  function resetGroup(groupJid) {
    const prefix = `${String(groupJid || '')}::`;
    for (const key of buckets.keys()) {
      if (key.startsWith(prefix)) {
        buckets.delete(key);
      }
    }
  }

  function clear() {
    buckets.clear();
    lastObservedTime = Number.NEGATIVE_INFINITY;
    callsSinceCleanup = 0;
  }

  return {
    recordMessage,
    markAlertSent,
    resetSender,
    resetGroup,
    clear,
  };
}

export const defaultFloodTracker = createFloodTracker();

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
  rateText,
  warnText = '',
  warningMessage = '',
}) {
  const lines = [
    spiderHeader(botName || 'Spider Man', 'ANTIFLOOD SHIELD'),
    spiderRow('USER', `@${targetUser}`, '⚠'),
    spiderRow('ACTION', actionLabel, '⛨'),
    spiderRow('BURST RATE', rateText, '⚡'),
  ];
  if (warnText) {
    lines.push(spiderRow('WARNINGS', warnText, '▣'));
  }
  if (warningMessage) {
    lines.push(spiderRow('WARNING', warningMessage, '⚠'));
  }
  lines.push(spiderFooter('GROUP FLOOD PROTECTION ACTIVE'));
  return lines.join('\n');
}

export async function handleAntiFloodMessage({
  sock,
  from,
  sender,
  msg,
  isOwner = false,
  groupMeta = null,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntifloodStore,
  tracker = defaultFloodTracker,
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

  const senderCandidates = collectSenderIdentities(msg, [sender]);
  const senderJid = senderCandidates[0] || sender || msg.key?.participant || '';
  if (senderCandidates.some((cand) => isSenderWhitelisted(cand, groupConfig.whitelist, getPhoneFromJid))) {
    return { handled: false, reason: 'whitelisted' };
  }

  const floodCheck = tracker.recordMessage(from, senderJid, {
    limit: groupConfig.limit,
    windowSec: groupConfig.windowSec,
    getPhoneFn: getPhoneFromJid,
  });

  if (!floodCheck.isFlood) {
    return {
      handled: false,
      reason: 'within-limit',
      count: floodCheck.count,
      limit: groupConfig.limit,
      windowSec: groupConfig.windowSec,
    };
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
    return {
      handled: false,
      reason: 'sender-is-admin',
      count: floodCheck.count,
      limit: groupConfig.limit,
      windowSec: groupConfig.windowSec,
    };
  }

  if (metadata && botCandidates.length > 0 && !botRole.isAdmin) {
    return {
      handled: false,
      reason: 'bot-not-admin',
      count: floodCheck.count,
      limit: groupConfig.limit,
      windowSec: groupConfig.windowSec,
    };
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
  let shouldAlert = floodCheck.alertCooldownElapsed;

  const mode = groupConfig.action;
  if (mode === 'warn') {
    const warnResult = store.addWarn(from, targetJid);
    warned = true;
    warnCount = warnResult.count;
    maxWarns = warnResult.maxWarns;
    actionLabel = deleted ? 'DELETED & WARNED' : 'WARNED (DELETE FAILED)';
    warnText = `${warnCount}/${maxWarns}`;
    tracker.resetSender(from, senderJid, getPhoneFromJid);
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
    tracker.resetSender(from, senderJid, getPhoneFromJid);
    shouldAlert = true;
  } else if (mode === 'warnkick') {
    const warnResult = store.addWarn(from, targetJid);
    warned = true;
    warnCount = warnResult.count;
    maxWarns = warnResult.maxWarns;
    warnText = `${warnCount}/${maxWarns}`;
    tracker.resetSender(from, senderJid, getPhoneFromJid);
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
    tracker.resetSender(from, senderJid, getPhoneFromJid);
    shouldAlert = true;
  } else if (mode === 'delete') {
    warningMessage = 'No flooding or spamming allowed in this group!';
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
          rateText: `${floodCheck.count} msgs / ${groupConfig.windowSec}s (limit ${groupConfig.limit})`,
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
    count: floodCheck.count,
    limit: groupConfig.limit,
    windowSec: groupConfig.windowSec,
    deleted,
    kicked,
    warned,
    muted,
    warnCount,
    maxWarns,
    targetJid,
    warningMessage,
  };
}
