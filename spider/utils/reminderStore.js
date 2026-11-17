import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spiderHeader, spiderRow, spiderFooter } from '../../Spider/utils/tableStyle.js';
import { cleanJid, extractLid, extractPhoneDigits } from './groupRoleResolver.js';

export const MIN_REMINDER_DURATION_MS = 5_000;
export const MAX_REMINDER_DURATION_MS = 365 * 86_400_000;
const MAX_ACTIVE_REMINDERS = 500;
const MAX_USER_REMINDERS = 25;
const MAX_REMINDER_TEXT_LENGTH = 500;
const SCHEDULER_MAX_SLEEP_MS = 30_000;

const UNIT_MS = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 7 * 86_400_000,
  wk: 7 * 86_400_000,
  wks: 7 * 86_400_000,
  week: 7 * 86_400_000,
  weeks: 7 * 86_400_000,
};

const DURATION_TOKEN_RE = /^(?:(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d|weeks?|wks?|wk|w))+$/i;
const SINGLE_SEGMENT_RE = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d|weeks?|wks?|wk|w)/gi;

export function parseReminderDuration(raw) {
  const input = String(raw || '').trim();
  if (!input) return null;
  if (!DURATION_TOKEN_RE.test(input)) return null;

  let totalMs = 0;
  let matched = false;
  SINGLE_SEGMENT_RE.lastIndex = 0;
  let match;
  while ((match = SINGLE_SEGMENT_RE.exec(input)) !== null) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const factor = UNIT_MS[unit];
    if (!Number.isFinite(amount) || amount <= 0 || !factor) return null;
    totalMs += Math.round(amount * factor);
  }

  if (!matched || !Number.isFinite(totalMs) || totalMs <= 0) return null;
  return totalMs;
}

export function extractDurationAndMessage(rawText = '') {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    return { ok: false, reason: 'empty', durationMs: 0, message: '' };
  }

  const tokens = trimmed.split(/\s+/);
  let consumedCount = 0;
  let totalMs = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const parsed = parseReminderDuration(token);
    if (parsed !== null) {
      totalMs += parsed;
      consumedCount += 1;
      continue;
    }

    // Handle spaced unit like "2 hours Check server"
    if (i + 1 < tokens.length && /^\d+(?:\.\d+)?$/.test(token)) {
      const combined = `${token}${tokens[i + 1]}`;
      const combinedParsed = parseReminderDuration(combined);
      if (combinedParsed !== null) {
        totalMs += combinedParsed;
        consumedCount += 2;
        i += 1;
        continue;
      }
    }
    break;
  }

  if (consumedCount === 0 || totalMs <= 0) {
    return { ok: false, reason: 'invalid-duration', durationMs: 0, message: '' };
  }

  if (totalMs < MIN_REMINDER_DURATION_MS) {
    return { ok: false, reason: 'too-short', durationMs: totalMs, message: '' };
  }

  if (totalMs > MAX_REMINDER_DURATION_MS) {
    return { ok: false, reason: 'too-long', durationMs: totalMs, message: '' };
  }

  const message = tokens.slice(consumedCount).join(' ').trim().slice(0, MAX_REMINDER_TEXT_LENGTH);
  return {
    ok: true,
    reason: null,
    durationMs: totalMs,
    message,
  };
}

export function formatDuration(ms) {
  const safeMs = Math.max(0, Math.round(Number(ms) || 0));
  if (safeMs < 1000) return 'now';
  const totalSec = Math.round(safeMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;

  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (secs > 0 && days === 0 && hours === 0) parts.push(`${secs}s`);
  return parts.slice(0, 3).join(' ') || '0s';
}

function generateReminderId(existingIds = new Set()) {
  for (let i = 0; i < 16; i += 1) {
    const candidate = `R${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `R${Date.now().toString(36).slice(-5).toUpperCase()}`;
}

function sanitizeReminder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().toUpperCase();
  const chatJid = cleanJid(raw.chatJid || '');
  const text = String(raw.text || '').trim().slice(0, MAX_REMINDER_TEXT_LENGTH);
  const dueAt = Number(raw.dueAt);
  if (!id || !chatJid || !text || !Number.isFinite(dueAt) || dueAt <= 0) return null;

  const creatorJid = cleanJid(raw.creatorJid || '');
  const creatorPhone = String(raw.creatorPhone || extractPhoneDigits(creatorJid) || '').replace(/\D/g, '');
  const createdAt = Number.isFinite(Number(raw.createdAt)) && Number(raw.createdAt) > 0
    ? Number(raw.createdAt)
    : dueAt;
  const durationMs = Number.isFinite(Number(raw.durationMs)) && Number(raw.durationMs) > 0
    ? Number(raw.durationMs)
    : Math.max(1000, dueAt - createdAt);
  const mentionJids = Array.isArray(raw.mentionJids)
    ? [...new Set(raw.mentionJids.map((j) => cleanJid(j)).filter(Boolean))]
    : creatorJid
      ? [creatorJid]
      : [];

  return {
    id,
    chatJid,
    isGroup: Boolean(raw.isGroup ?? chatJid.endsWith('@g.us')),
    creatorJid,
    creatorPhone,
    mentionJids,
    text,
    createdAt,
    dueAt,
    durationMs,
  };
}

export function createReminderStore(storePathOrResolver = null, { now = Date.now } = {}) {
  const isDefault = storePathOrResolver === null || storePathOrResolver === undefined;
  let tmpFallbackPath = null;
  let cachedPath = null;
  let cachedList = null;

  function resolvePath() {
    if (!isDefault) {
      return typeof storePathOrResolver === 'function' ? storePathOrResolver() : storePathOrResolver;
    }
    return tmpFallbackPath || path.join(process.cwd(), 'data', 'reminders.json');
  }

  function loadAll() {
    const filePath = resolvePath();
    if (cachedList && cachedPath === filePath) {
      return cachedList;
    }

    let rawReminders = [];
    let loadedFrom = filePath;
    const candidates =
      isDefault && !tmpFallbackPath
        ? [filePath, path.join(os.tmpdir(), 'spider-data', 'reminders.json')]
        : [filePath];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          if (raw && typeof raw === 'object' && Array.isArray(raw.reminders)) {
            rawReminders = raw.reminders;
            loadedFrom = candidate;
            if (candidate !== filePath) {
              tmpFallbackPath = candidate;
            }
            break;
          }
        }
      } catch {
        rawReminders = [];
      }
    }

    const clean = rawReminders
      .map(sanitizeReminder)
      .filter(Boolean)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, MAX_ACTIVE_REMINDERS);

    cachedPath = loadedFrom;
    cachedList = clean;
    return cachedList;
  }

  function writeTarget(filePath, serialized) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify({ reminders: serialized }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {}
  }

  function saveAll(list) {
    const sorted = [...list].sort((a, b) => a.dueAt - b.dueAt).slice(0, MAX_ACTIVE_REMINDERS);
    const filePath = resolvePath();
    try {
      writeTarget(filePath, sorted);
      cachedPath = filePath;
    } catch {
      if (isDefault) {
        const fallback = path.join(os.tmpdir(), 'spider-data', 'reminders.json');
        try {
          writeTarget(fallback, sorted);
          tmpFallbackPath = fallback;
          cachedPath = fallback;
        } catch {
          cachedPath = filePath;
        }
      } else {
        cachedPath = filePath;
      }
    }
    cachedList = sorted;
    return cachedList;
  }

  function matchesActor(reminder, { actorJid = '', actorPhone = '', lidToPhoneMap = null } = {}) {
    const cleanActor = cleanJid(actorJid).toLowerCase();
    const digitsActor = String(actorPhone || extractPhoneDigits(actorJid) || '').replace(/\D/g, '');
    const actorLid = extractLid(actorJid);

    if (reminder.creatorPhone && digitsActor && reminder.creatorPhone === digitsActor) {
      return true;
    }
    if (cleanActor && reminder.creatorJid && reminder.creatorJid.toLowerCase() === cleanActor) {
      return true;
    }
    if (actorLid && reminder.creatorJid && extractLid(reminder.creatorJid) === actorLid) {
      return true;
    }
    if (lidToPhoneMap && typeof lidToPhoneMap.get === 'function') {
      const remLid = extractLid(reminder.creatorJid);
      const mapped = remLid ? String(lidToPhoneMap.get(remLid) || '').replace(/\D/g, '') : '';
      if (mapped && digitsActor && mapped === digitsActor) return true;
    }
    return false;
  }

  function addReminder({
    chatJid,
    creatorJid = '',
    creatorPhone = '',
    mentionJids = null,
    text,
    durationMs,
  } = {}) {
    const list = loadAll();
    const currentNow = now();
    const cleanChat = cleanJid(chatJid);
    const cleanCreator = cleanJid(creatorJid || cleanChat);
    const phoneDigits = String(creatorPhone || extractPhoneDigits(cleanCreator) || '').replace(/\D/g, '');
    const cleanText = String(text || '').trim().slice(0, MAX_REMINDER_TEXT_LENGTH);
    const safeDuration = Math.max(1000, Math.round(Number(durationMs) || 0));

    if (!cleanChat || !cleanText || !Number.isFinite(safeDuration) || safeDuration <= 0) {
      return { ok: false, reason: 'invalid-arguments', reminder: null };
    }

    if (list.length >= MAX_ACTIVE_REMINDERS) {
      return { ok: false, reason: 'store-full', reminder: null };
    }

    const userActiveCount = list.filter((r) =>
      matchesActor(r, { actorJid: cleanCreator, actorPhone: phoneDigits }),
    ).length;
    if (userActiveCount >= MAX_USER_REMINDERS) {
      return { ok: false, reason: 'user-limit', limit: MAX_USER_REMINDERS, reminder: null };
    }

    const existingIds = new Set(list.map((r) => r.id));
    const reminder = sanitizeReminder({
      id: generateReminderId(existingIds),
      chatJid: cleanChat,
      isGroup: cleanChat.endsWith('@g.us'),
      creatorJid: cleanCreator,
      creatorPhone: phoneDigits,
      mentionJids: Array.isArray(mentionJids) ? mentionJids : [cleanCreator],
      text: cleanText,
      createdAt: currentNow,
      dueAt: currentNow + safeDuration,
      durationMs: safeDuration,
    });

    list.push(reminder);
    saveAll(list);
    return { ok: true, reason: null, reminder };
  }

  function listReminders({
    chatJid = '',
    actorJid = '',
    actorPhone = '',
    scope = 'user',
    lidToPhoneMap = null,
  } = {}) {
    const list = loadAll();
    const cleanChat = cleanJid(chatJid).toLowerCase();

    if (scope === 'all') {
      return [...list];
    }
    if (scope === 'chat' && cleanChat) {
      return list.filter((r) => r.chatJid.toLowerCase() === cleanChat);
    }
    return list.filter((r) => {
      if (cleanChat && r.chatJid.toLowerCase() !== cleanChat) return false;
      return matchesActor(r, { actorJid, actorPhone, lidToPhoneMap });
    });
  }

  function getReminder(id) {
    const cleanId = String(id || '').trim().toUpperCase();
    if (!cleanId) return null;
    return loadAll().find((r) => r.id === cleanId) || null;
  }

  function deleteReminder(
    id,
    { chatJid = '', actorJid = '', actorPhone = '', isOwner = false, isGroupAdmin = false, lidToPhoneMap = null } = {},
  ) {
    const cleanId = String(id || '').trim().toUpperCase();
    if (!cleanId) return { ok: false, reason: 'missing-id', reminder: null };
    const list = loadAll();
    const index = list.findIndex((r) => r.id === cleanId);
    if (index === -1) return { ok: false, reason: 'not-found', reminder: null };

    const target = list[index];
    const sameChat = !chatJid || target.chatJid.toLowerCase() === cleanJid(chatJid).toLowerCase();
    const ownsReminder = matchesActor(target, { actorJid, actorPhone, lidToPhoneMap });
    const canDelete = isOwner || (isGroupAdmin && sameChat && target.isGroup) || (ownsReminder && sameChat);

    if (!canDelete) {
      return { ok: false, reason: 'forbidden', reminder: null };
    }

    const [removed] = list.splice(index, 1);
    saveAll(list);
    return { ok: true, reason: null, reminder: removed };
  }

  function clearReminders({
    chatJid = '',
    actorJid = '',
    actorPhone = '',
    isOwner = false,
    isGroupAdmin = false,
    allChat = false,
    lidToPhoneMap = null,
  } = {}) {
    const list = loadAll();
    const cleanChat = cleanJid(chatJid).toLowerCase();
    const kept = [];
    const removed = [];

    for (const r of list) {
      const sameChat = !cleanChat || r.chatJid.toLowerCase() === cleanChat;
      const ownsReminder = matchesActor(r, { actorJid, actorPhone, lidToPhoneMap });
      const shouldRemove =
        sameChat &&
        ((allChat && (isOwner || (isGroupAdmin && r.isGroup))) || ownsReminder);
      if (shouldRemove) {
        removed.push(r);
      } else {
        kept.push(r);
      }
    }

    if (removed.length > 0) {
      saveAll(kept);
    }
    return { removedCount: removed.length, removed };
  }

  function getDueReminders(nowMs = now()) {
    return loadAll().filter((r) => r.dueAt <= nowMs);
  }

  function removeDueReminders(ids = []) {
    const idSet = new Set(ids.map((id) => String(id || '').trim().toUpperCase()).filter(Boolean));
    if (idSet.size === 0) return 0;
    const list = loadAll();
    const next = list.filter((r) => !idSet.has(r.id));
    const removedCount = list.length - next.length;
    if (removedCount > 0) {
      saveAll(next);
    }
    return removedCount;
  }

  function getNextDueAt() {
    const list = loadAll();
    return list.length > 0 ? list[0].dueAt : null;
  }

  function flush() {
    if (cachedList) {
      saveAll(cachedList);
    }
  }

  function clearCache() {
    cachedPath = null;
    cachedList = null;
  }

  return {
    addReminder,
    listReminders,
    getReminder,
    deleteReminder,
    clearReminders,
    getDueReminders,
    removeDueReminders,
    getNextDueAt,
    flush,
    clearCache,
  };
}

export const defaultReminderStore = createReminderStore();

export function formatDueReminderPayload(reminder, { botName = 'Spider Man', nowMs = Date.now() } = {}) {
  const displayUser =
    reminder.creatorPhone ||
    (reminder.creatorJid ? reminder.creatorJid.split('@')[0] : 'user');
  const setAgo = formatDuration(Math.max(1000, nowMs - (reminder.createdAt || nowMs)));
  const lines = [
    spiderHeader(botName || 'Spider Man', 'REMINDER'),
    spiderRow('ID', reminder.id, '🆔'),
    ...(reminder.isGroup ? [spiderRow('FOR', `@${displayUser}`, '👤')] : []),
    spiderRow('MESSAGE', reminder.text, '⏰'),
    spiderRow('SET', `${setAgo} ago`, '🕒'),
    spiderFooter('SCHEDULED REMINDER'),
  ];

  const mentions = reminder.isGroup
    ? [...new Set((reminder.mentionJids || []).filter(Boolean))]
    : [];

  return {
    text: lines.join('\n'),
    ...(mentions.length > 0 ? { mentions } : {}),
  };
}

export function createReminderScheduler({
  store = defaultReminderStore,
  getSock = () => null,
  botName = 'Spider Man',
  getBotName = null,
  logError = null,
  now = Date.now,
} = {}) {
  let timer = null;
  let running = false;
  let processing = false;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNextTick() {
    clearTimer();
    if (!running) return;
    const nextDueAt = store.getNextDueAt();
    if (nextDueAt === null) return;
    const delayMs = Math.min(SCHEDULER_MAX_SLEEP_MS, Math.max(250, nextDueAt - now()));
    timer = setTimeout(() => {
      timer = null;
      void triggerCheck();
    }, delayMs);
    timer?.unref?.();
  }

  async function triggerCheck() {
    if (processing) return { delivered: 0, skipped: true };
    processing = true;
    let delivered = 0;

    try {
      const currentNow = now();
      const due = store.getDueReminders(currentNow);
      if (due.length === 0) {
        return { delivered: 0, skipped: false };
      }

      const sock = typeof getSock === 'function' ? getSock() : null;
      const isSocketConnected = Boolean(sock && typeof sock.sendMessage === 'function' && sock.user?.id);
      if (!isSocketConnected) {
        return { delivered: 0, deferred: due.length };
      }

      const activeBotName = (typeof getBotName === 'function' ? getBotName() : botName) || 'Spider Man';
      const deliveredIds = [];

      for (const reminder of due) {
        try {
          const payload = formatDueReminderPayload(reminder, {
            botName: activeBotName,
            nowMs: currentNow,
          });
          await sock.sendMessage(reminder.chatJid, payload);
          deliveredIds.push(reminder.id);
          delivered += 1;
        } catch (err) {
          if (typeof logError === 'function') {
            try {
              logError('Reminder Delivery', reminder.id, reminder.chatJid, err?.message || String(err));
            } catch {}
          }
        }
      }

      if (deliveredIds.length > 0) {
        store.removeDueReminders(deliveredIds);
      }

      return { delivered, deferred: due.length - delivered };
    } finally {
      processing = false;
      if (running) {
        scheduleNextTick();
      }
    }
  }

  function start() {
    if (running) {
      scheduleNextTick();
      return;
    }
    running = true;
    void triggerCheck();
  }

  function nudge() {
    if (!running) return;
    scheduleNextTick();
  }

  function stop() {
    running = false;
    clearTimer();
  }

  return {
    start,
    stop,
    nudge,
    triggerCheck,
    isRunning: () => running,
  };
}
