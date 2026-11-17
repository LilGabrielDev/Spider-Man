import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { S_WHATSAPP_NET, getBinaryNodeChild } from '@whiskeysockets/baileys';
import { isSendMessageFailure } from './groupActionHelper.js';
import { CORE_AUTOBIOS, EXTRA_BIO_TARGET, TOTAL_BUILTIN_BIOS, getBuiltinAutobios } from './bioCatalog.js';

export const MAX_BIO_LENGTH = 139;
export const DEFAULT_AUTOBIO_INTERVAL_MS = 60_000;
export const MIN_AUTOBIO_INTERVAL_MS = 15_000;
export const MAX_AUTOBIO_INTERVAL_MS = 86_400_000;
export const MAX_SAVED_BIOS = 10_250;

export { CORE_AUTOBIOS, EXTRA_BIO_TARGET, TOTAL_BUILTIN_BIOS };
export const PRESET_AUTOBIOS = getBuiltinAutobios();

export function sanitizeBioText(raw, maxLength = MAX_BIO_LENGTH) {
  const collapsed = String(raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) {
    return { text: '', truncated: false, originalLength: 0 };
  }
  const chars = Array.from(collapsed);
  if (chars.length <= maxLength) {
    return { text: collapsed, truncated: false, originalLength: chars.length };
  }
  return {
    text: chars.slice(0, maxLength).join('').trimEnd(),
    truncated: true,
    originalLength: chars.length,
  };
}

export function formatAutobioUptime(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function parseAutobioInterval(raw) {
  const input = String(raw ?? '').trim().toLowerCase();
  if (!input) return null;

  const plainNum = Number(input);
  if (/^\d+$/.test(input) && Number.isFinite(plainNum) && plainNum > 0) {
    const ms = plainNum * 1000;
    return clampIntervalMs(ms);
  }

  const match = input.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) return null;

  let factor = 1000;
  if (unit.startsWith('m')) factor = 60_000;
  else if (unit.startsWith('h')) factor = 3_600_000;

  return clampIntervalMs(Math.round(amount * factor));
}

export function clampIntervalMs(rawMs, { min = MIN_AUTOBIO_INTERVAL_MS, max = MAX_AUTOBIO_INTERVAL_MS } = {}) {
  const num = Number(rawMs);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_AUTOBIO_INTERVAL_MS;
  return Math.min(max, Math.max(min, Math.round(num)));
}

export function formatAutobioInterval(ms) {
  const safeMs = Math.max(1000, Math.round(Number(ms) || DEFAULT_AUTOBIO_INTERVAL_MS));
  const totalSec = Math.round(safeMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (secs > 0 && hours === 0) parts.push(`${secs}s`);
  return parts.join(' ') || '60s';
}

function formatClock(nowMs, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz || 'Africa/Nairobi',
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(11, 16);
  }
}

function formatDate(nowMs, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      timeZone: tz || 'Africa/Nairobi',
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

export function expandBioPlaceholders(
  template,
  {
    botName = 'Spider Man',
    tz = 'Africa/Nairobi',
    startTimeMs = Date.now(),
    nowMs = Date.now(),
  } = {},
) {
  const raw = String(template ?? '');
  if (!raw) return '';
  const uptime = formatAutobioUptime(Math.max(0, nowMs - startTimeMs));
  const timeStr = formatClock(nowMs, tz);
  const dateStr = formatDate(nowMs, tz);
  const safeBotName = String(botName || 'Spider Man').trim() || 'Spider Man';

  const replaced = raw
    .replace(/\{bot(?:Name)?\}/gi, safeBotName)
    .replace(/\{uptime\}/gi, uptime)
    .replace(/\{time\}/gi, timeStr)
    .replace(/\{date\}/gi, dateStr);

  return sanitizeBioText(replaced).text;
}

export function buildDynamicBio({
  botName = 'Spider Man',
  tz = 'Africa/Nairobi',
  startTimeMs = Date.now(),
  nowMs = Date.now(),
  index = 0,
  externalFact = '',
} = {}) {
  const safeBotName = String(botName || 'Spider Man').trim() || 'Spider Man';
  const cleanFact = sanitizeBioText(externalFact).text;
  if (cleanFact) {
    const prefixed = sanitizeBioText(`${safeBotName}: ${cleanFact}`).text;
    if (prefixed.length > safeBotName.length + 4) {
      return prefixed;
    }
  }

  const template = PRESET_AUTOBIOS[Math.abs(Number(index) || 0) % PRESET_AUTOBIOS.length];
  return expandBioPlaceholders(template, {
    botName: safeBotName,
    tz,
    startTimeMs,
    nowMs,
  });
}

function parseSeedBios(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => sanitizeBioText(item).text).filter(Boolean).slice(0, MAX_SAVED_BIOS);
  }
  const str = String(raw ?? '').trim();
  if (!str) return [];
  const parts = str.includes('|') ? str.split('|') : [str];
  return parts.map((item) => sanitizeBioText(item).text).filter(Boolean).slice(0, MAX_SAVED_BIOS);
}

function parseBooleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return ['on', 'true', '1', 'yes'].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

export function createAutobioStore(
  storePathOrResolver = null,
  { now = Date.now, env = process.env, getConfig = null } = {},
) {
  const isDefault = storePathOrResolver === null || storePathOrResolver === undefined;
  let tmpFallbackPath = null;
  let cachedPath = null;
  let cachedResolvedTarget = null;
  let cachedState = null;

  function resolvePath() {
    if (!isDefault) {
      return typeof storePathOrResolver === 'function' ? storePathOrResolver() : storePathOrResolver;
    }
    return tmpFallbackPath || path.join(process.cwd(), 'data', 'autobio.json');
  }

  function defaultState() {
    const cfg = typeof getConfig === 'function' ? getConfig() : null;
    const seedEnabled = parseBooleanValue(cfg?.AUTO_BIO ?? env?.AUTO_BIO ?? false);
    const seedBios = parseSeedBios(cfg?.AUTO_BIO_TEXT ?? env?.AUTO_BIO_TEXT ?? '');
    const seedInterval = clampIntervalMs(
      cfg?.AUTO_BIO_INTERVAL_MS ?? env?.AUTO_BIO_INTERVAL_MS ?? DEFAULT_AUTOBIO_INTERVAL_MS,
    );
    return {
      enabled: seedEnabled,
      bios: seedBios,
      intervalMs: seedInterval,
      currentIndex: 0,
      lastBio: '',
      lastUpdatedAt: 0,
    };
  }

  function normalizeState(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== 'object') return base;
    const bios = Array.isArray(raw.bios)
      ? Array.from(new Set(raw.bios.map((item) => sanitizeBioText(item).text).filter(Boolean))).slice(
          0,
          MAX_SAVED_BIOS,
        )
      : base.bios;
    const rawIndex = Number.parseInt(raw.currentIndex, 10);
    const currentIndex = Number.isFinite(rawIndex) && rawIndex >= 0 ? rawIndex : 0;
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
      bios,
      intervalMs: clampIntervalMs(raw.intervalMs ?? base.intervalMs),
      currentIndex: bios.length > 0 ? currentIndex % bios.length : currentIndex,
      lastBio: sanitizeBioText(raw.lastBio || '').text,
      lastUpdatedAt: Number.isFinite(Number(raw.lastUpdatedAt)) ? Number(raw.lastUpdatedAt) : 0,
    };
  }

  function loadState() {
    const filePath = resolvePath();
    if (cachedState && cachedResolvedTarget === filePath) {
      return cachedState;
    }
    if (cachedResolvedTarget && cachedResolvedTarget !== filePath) {
      tmpFallbackPath = null;
      cachedPath = null;
      cachedState = null;
    }

    const candidates =
      isDefault && !tmpFallbackPath
        ? [filePath, path.join(os.tmpdir(), 'spider-data', 'autobio.json')]
        : [filePath];

    let parsed = null;
    let loadedFrom = filePath;
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          if (data && typeof data === 'object') {
            parsed = data;
            loadedFrom = candidate;
            if (candidate !== filePath) {
              tmpFallbackPath = candidate;
            }
            break;
          }
        }
      } catch {
        parsed = null;
      }
    }

    cachedResolvedTarget = filePath;
    cachedPath = loadedFrom;
    cachedState = normalizeState(parsed);
    return cachedState;
  }

  function writeTarget(filePath, stateObj) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(stateObj, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  }

  function saveState(nextState) {
    const normalized = normalizeState(nextState);
    const filePath = resolvePath();
    try {
      writeTarget(filePath, normalized);
      cachedPath = filePath;
      cachedResolvedTarget = filePath;
    } catch {
      if (isDefault) {
        const fallback = path.join(os.tmpdir(), 'spider-data', 'autobio.json');
        try {
          writeTarget(fallback, normalized);
          tmpFallbackPath = fallback;
          cachedPath = fallback;
          cachedResolvedTarget = fallback;
        } catch {
          cachedPath = filePath;
        }
      } else {
        cachedPath = filePath;
      }
    }
    cachedState = normalized;
    return cachedState;
  }

  function getState() {
    const state = loadState();
    return {
      ...state,
      bios: [...state.bios],
    };
  }

  function setEnabled(enabled) {
    const current = loadState();
    const saved = saveState({ ...current, enabled: Boolean(enabled) });
    return { ...saved, bios: [...saved.bios] };
  }

  function addBio(rawText) {
    const { text: clean, truncated, originalLength } = sanitizeBioText(rawText);
    if (!clean) {
      return { ok: false, reason: 'empty', bio: '', truncated: false, added: false };
    }
    const current = loadState();
    const existingIdx = current.bios.findIndex((b) => b === clean);
    let nextBios;
    let targetIdx;
    let added = false;

    if (existingIdx !== -1) {
      nextBios = [...current.bios];
      targetIdx = existingIdx;
    } else if (current.bios.length >= MAX_SAVED_BIOS) {
      nextBios = [...current.bios.slice(1), clean];
      targetIdx = nextBios.length - 1;
      added = true;
    } else {
      nextBios = [...current.bios, clean];
      targetIdx = nextBios.length - 1;
      added = true;
    }

    const saved = saveState({
      ...current,
      bios: nextBios,
      currentIndex: targetIdx,
    });

    return {
      ok: true,
      bio: clean,
      truncated,
      originalLength,
      added,
      index: targetIdx,
      total: saved.bios.length,
      state: { ...saved, bios: [...saved.bios] },
    };
  }

  function setBio(rawText) {
    const { text: clean, truncated, originalLength } = sanitizeBioText(rawText);
    if (!clean) {
      return { ok: false, reason: 'empty', bio: '', truncated: false };
    }
    const current = loadState();
    const saved = saveState({
      ...current,
      bios: [clean],
      currentIndex: 0,
    });
    return {
      ok: true,
      bio: clean,
      truncated,
      originalLength,
      index: 0,
      total: saved.bios.length,
      state: { ...saved, bios: [...saved.bios] },
    };
  }

  function removeBio(oneBasedIndex) {
    const idx = Number.parseInt(oneBasedIndex, 10) - 1;
    const current = loadState();
    if (!Number.isFinite(idx) || idx < 0 || idx >= current.bios.length) {
      return { ok: false, reason: 'not-found', removed: '' };
    }
    const nextBios = current.bios.filter((_, i) => i !== idx);
    const removed = current.bios[idx];
    const nextIndex = nextBios.length > 0 ? current.currentIndex % nextBios.length : 0;
    const saved = saveState({
      ...current,
      bios: nextBios,
      currentIndex: nextIndex,
    });
    return {
      ok: true,
      removed,
      total: saved.bios.length,
      state: { ...saved, bios: [...saved.bios] },
    };
  }

  function clearBios() {
    const current = loadState();
    const removedCount = current.bios.length;
    const saved = saveState({
      ...current,
      bios: [],
      currentIndex: 0,
    });
    return {
      ok: true,
      removedCount,
      state: { ...saved, bios: [] },
    };
  }

  function loadPresetBios({ replace = false, limit = null } = {}) {
    const current = loadState();
    const targetLimit =
      Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Math.min(MAX_SAVED_BIOS, Math.floor(Number(limit)))
        : MAX_SAVED_BIOS;
    const cleanPresets = PRESET_AUTOBIOS.slice(0, targetLimit);
    let nextBios;
    let addedCount;

    if (replace) {
      nextBios = [...cleanPresets];
      addedCount = nextBios.length;
    } else {
      const merged = [...current.bios];
      const existingSet = new Set(merged);
      addedCount = 0;
      for (const preset of cleanPresets) {
        if (!existingSet.has(preset) && merged.length < MAX_SAVED_BIOS) {
          merged.push(preset);
          existingSet.add(preset);
          addedCount += 1;
        }
      }
      nextBios = merged;
    }

    const saved = saveState({
      ...current,
      bios: nextBios,
      currentIndex: replace ? 0 : current.currentIndex < nextBios.length ? current.currentIndex : 0,
    });

    return {
      ok: true,
      addedCount,
      presetCount: cleanPresets.length,
      total: saved.bios.length,
      state: { ...saved, bios: [...saved.bios] },
    };
  }

  function setIntervalMs(ms) {
    const current = loadState();
    const clamped = clampIntervalMs(ms);
    const saved = saveState({
      ...current,
      intervalMs: clamped,
    });
    return { ...saved, bios: [...saved.bios] };
  }

  function getNextBioCandidate({
    preferredBio = '',
    botName = 'Spider Man',
    tz = 'Africa/Nairobi',
    startTimeMs = now(),
    nowMs = now(),
    externalFact = '',
  } = {}) {
    const current = loadState();
    const cleanPreferred = sanitizeBioText(preferredBio).text;
    if (cleanPreferred) {
      const expanded = expandBioPlaceholders(cleanPreferred, { botName, tz, startTimeMs, nowMs });
      return {
        bio: expanded || cleanPreferred,
        source: 'preferred',
        nextIndex:
          current.bios.length > 0
            ? (current.currentIndex + 1) % current.bios.length
            : current.currentIndex + 1,
      };
    }

    if (current.bios.length > 0) {
      const idx = current.currentIndex % current.bios.length;
      const rawTemplate = current.bios[idx];
      const expanded = expandBioPlaceholders(rawTemplate, { botName, tz, startTimeMs, nowMs });
      return {
        bio: expanded || rawTemplate,
        source: 'custom',
        nextIndex: (idx + 1) % current.bios.length,
      };
    }

    const dynamic = buildDynamicBio({
      botName,
      tz,
      startTimeMs,
      nowMs,
      index: current.currentIndex,
      externalFact,
    });
    return {
      bio: dynamic,
      source: externalFact ? 'external' : 'dynamic',
      nextIndex: current.currentIndex + 1,
    };
  }

  function recordAppliedBio(bioText, nextIndex = null, timestampMs = now()) {
    const current = loadState();
    const clean = sanitizeBioText(bioText).text;
    const saved = saveState({
      ...current,
      lastBio: clean || current.lastBio,
      lastUpdatedAt: timestampMs,
      currentIndex:
        nextIndex !== null && nextIndex !== undefined
          ? nextIndex
          : current.bios.length > 0
            ? (current.currentIndex + 1) % current.bios.length
            : current.currentIndex + 1,
    });
    return { ...saved, bios: [...saved.bios] };
  }

  function flush() {
    if (cachedState) {
      saveState(cachedState);
    }
  }

  function clearCache() {
    tmpFallbackPath = null;
    cachedPath = null;
    cachedResolvedTarget = null;
    cachedState = null;
  }

  return {
    getState,
    setEnabled,
    addBio,
    setBio,
    removeBio,
    clearBios,
    loadPresetBios,
    setIntervalMs,
    getNextBioCandidate,
    recordAppliedBio,
    flush,
    clearCache,
  };
}

export const defaultAutobioStore = createAutobioStore();

const workingBioStrategyBySock = new WeakMap();

export function splitLeadingEmoji(text) {
  const str = String(text || '').trim();
  if (!str) return { emoji: '', text: '' };
  const match = str.match(/^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s+(.*)$/u);
  if (match && match[2]?.trim()) {
    return { emoji: match[1], text: match[2].trim() };
  }
  return { emoji: '', text: str };
}

function isRetryableStatusProtocolError(err) {
  const statusCode = Number(err?.output?.statusCode ?? err?.statusCode ?? err?.data?.statusCode);
  if ([400, 404, 405, 422, 501].includes(statusCode)) return true;
  const msg = String(err?.message || err || '');
  return /bad[\s_-]?request|graphql|unexpected response|not[- ]implemented|xmlns|validation/i.test(msg);
}

function assertMexResultOk(result) {
  if (!result || typeof result !== 'object') return;
  if (result.attrs?.type === 'error' || isSendMessageFailure(result)) {
    throw new Error('WhatsApp rejected the About update.');
  }
  const child = getBinaryNodeChild(result, 'result');
  if (child?.content) {
    const rawStr = Buffer.isBuffer(child.content)
      ? child.content.toString('utf8')
      : child.content instanceof Uint8Array
        ? Buffer.from(child.content).toString('utf8')
        : String(child.content);
    let parsed = null;
    try {
      parsed = JSON.parse(rawStr);
    } catch {
      parsed = null;
    }
    if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
      const errorMessages = parsed.errors.map((e) => e?.message || 'Unknown error').join(', ');
      const err = new Error(`GraphQL server error: ${errorMessages}`);
      err.statusCode = parsed.errors[0]?.extensions?.error_code || 400;
      throw err;
    }
  }
}

export async function applyProfileBio(sock, bioText) {
  if (!sock || (typeof sock.updateProfileStatus !== 'function' && typeof sock.query !== 'function')) {
    throw new Error('WhatsApp socket is not connected.');
  }
  const { text: cleanBio } = sanitizeBioText(bioText);
  if (!cleanBio) {
    throw new Error('Bio text cannot be empty.');
  }

  const split = splitLeadingEmoji(cleanBio);
  const strategies = [];

  if (typeof sock.updateProfileStatus === 'function') {
    strategies.push(
      {
        id: 'string',
        run: async () => {
          const res = await sock.updateProfileStatus(cleanBio);
          if (isSendMessageFailure(res)) {
            throw new Error('WhatsApp rejected the About update.');
          }
        },
      },
      {
        id: 'ephemeral86400',
        run: async () => {
          const res = await sock.updateProfileStatus({
            text: cleanBio,
            ephemeralDurationSec: 86400,
          });
          if (isSendMessageFailure(res)) {
            throw new Error('WhatsApp rejected the About update.');
          }
        },
      },
      {
        id: 'ephemeral86400Emoji',
        run: async () => {
          const res = await sock.updateProfileStatus({
            text: split.text || cleanBio,
            emoji: split.emoji || '💬',
            ephemeralDurationSec: 86400,
          });
          if (isSendMessageFailure(res)) {
            throw new Error('WhatsApp rejected the About update.');
          }
        },
      },
      {
        id: 'ephemeralNeg1',
        run: async () => {
          const res = await sock.updateProfileStatus({
            text: cleanBio,
            ephemeralDurationSec: -1,
          });
          if (isSendMessageFailure(res)) {
            throw new Error('WhatsApp rejected the About update.');
          }
        },
      },
      {
        id: 'ephemeral604800',
        run: async () => {
          const res = await sock.updateProfileStatus({
            text: cleanBio,
            ephemeralDurationSec: 604800,
          });
          if (isSendMessageFailure(res)) {
            throw new Error('WhatsApp rejected the About update.');
          }
        },
      },
    );
  }

  if (typeof sock.query === 'function') {
    const mexTextOnlyStrategy = {
      id: 'mexTextOnly',
      run: async () => {
        const tag =
          typeof sock.generateMessageTag === 'function'
            ? sock.generateMessageTag()
            : `autobio-${Date.now()}`;
        const res = await sock.query({
          tag: 'iq',
          attrs: {
            id: tag,
            type: 'get',
            to: S_WHATSAPP_NET,
            xmlns: 'w:mex',
          },
          content: [
            {
              tag: 'query',
              attrs: { query_id: '9152604461510864' },
              content: Buffer.from(
                JSON.stringify({ variables: { input: { text: cleanBio } } }),
                'utf-8',
              ),
            },
          ],
        });
        assertMexResultOk(res);
      },
    };
    const legacyStatusIqStrategy = {
      id: 'legacyStatusIq',
      run: async () => {
        const res = await sock.query({
          tag: 'iq',
          attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'status' },
          content: [{ tag: 'status', attrs: {}, content: Buffer.from(cleanBio, 'utf-8') }],
        });
        if (res?.attrs?.type === 'error' || isSendMessageFailure(res)) {
          throw new Error('WhatsApp rejected the About update.');
        }
      },
    };

    if (typeof sock.updateProfileStatus === 'function') {
      strategies.push(mexTextOnlyStrategy, legacyStatusIqStrategy);
    } else {
      strategies.push(legacyStatusIqStrategy, mexTextOnlyStrategy);
    }
  }

  const preferredId = workingBioStrategyBySock.get(sock);
  const ordered = preferredId
    ? [
        ...strategies.filter((s) => s.id === preferredId),
        ...strategies.filter((s) => s.id !== preferredId),
      ]
    : strategies;

  let firstErr = null;
  for (let i = 0; i < ordered.length; i += 1) {
    const strategy = ordered[i];
    try {
      await strategy.run();
      workingBioStrategyBySock.set(sock, strategy.id);
      return { ok: true, bio: cleanBio, strategy: strategy.id };
    } catch (err) {
      if (!firstErr) firstErr = err;
      if (!isRetryableStatusProtocolError(err)) {
        workingBioStrategyBySock.delete(sock);
        throw err;
      }
    }
  }

  workingBioStrategyBySock.delete(sock);
  throw firstErr || new Error('WhatsApp rejected the About update.');
}

export async function fetchExternalBioFact({
  fetchImpl = globalThis.fetch,
  timeoutMs = 2500,
} = {}) {
  if (typeof fetchImpl !== 'function') return '';
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  timer?.unref?.();

  try {
    const resp = await fetchImpl('https://nekos.life/api/v2/fact', {
      signal: controller?.signal,
    });
    if (!resp || resp.ok === false) return '';
    const data = await resp.json().catch(() => null);
    const fact = String(data?.fact || data?.quote || '').trim();
    return fact;
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createAutobioManager({
  store = defaultAutobioStore,
  getSock = () => null,
  getBotName = () => 'Spider Man',
  getTimezone = () => 'Africa/Nairobi',
  startTimeMs = Date.now(),
  fetchImpl = null,
  logError = null,
  now = Date.now,
} = {}) {
  let intervalHandle = null;
  let updating = false;
  let sockResolver = typeof getSock === 'function' ? getSock : () => null;
  let botNameResolver = typeof getBotName === 'function' ? getBotName : () => 'Spider Man';
  let tzResolver = typeof getTimezone === 'function' ? getTimezone : () => 'Africa/Nairobi';
  let errorLogger = typeof logError === 'function' ? logError : null;
  let fallbackSock = null;

  function configure({
    getSock: nextGetSock,
    getBotName: nextGetBotName,
    getTimezone: nextGetTimezone,
    logError: nextLogError,
  } = {}) {
    if (typeof nextGetSock === 'function') sockResolver = nextGetSock;
    if (typeof nextGetBotName === 'function') botNameResolver = nextGetBotName;
    if (typeof nextGetTimezone === 'function') tzResolver = nextGetTimezone;
    if (typeof nextLogError === 'function') errorLogger = nextLogError;
  }

  function resolveActiveSock(explicitSock = null) {
    if (explicitSock) {
      fallbackSock = explicitSock;
      return explicitSock;
    }
    const fromResolver = sockResolver?.();
    return fromResolver || fallbackSock || null;
  }

  function isSocketReadyForBackground(sock) {
    if (!sock) return false;
    if (typeof sock.updateProfileStatus !== 'function' && typeof sock.query !== 'function') {
      return false;
    }
    if (sock.ws && (sock.ws.isClosed || sock.ws.readyState === 2 || sock.ws.readyState === 3)) {
      return false;
    }
    return true;
  }

  function clearTimer() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  function startTimer(intervalMs) {
    clearTimer();
    const delay = clampIntervalMs(intervalMs);
    intervalHandle = setInterval(() => {
      void tick();
    }, delay);
    intervalHandle?.unref?.();
  }

  async function updateNow({
    sock = null,
    preferredBio = '',
    allowExternalFetch = true,
    isBackground = false,
  } = {}) {
    if (updating) {
      return { ok: false, skipped: true, reason: 'busy', bio: '' };
    }

    const activeSock = resolveActiveSock(sock);
    if (!activeSock || (isBackground && !isSocketReadyForBackground(activeSock))) {
      return {
        ok: false,
        skipped: true,
        reason: 'socket-unavailable',
        bio: '',
        error: 'WhatsApp socket is not ready.',
      };
    }

    updating = true;
    try {
      const botName = botNameResolver?.() || 'Spider Man';
      const tz = tzResolver?.() || 'Africa/Nairobi';

      const candidate = store.getNextBioCandidate({
        preferredBio,
        botName,
        tz,
        startTimeMs,
        nowMs: now(),
      });

      const applied = await applyProfileBio(activeSock, candidate.bio);
      store.recordAppliedBio(applied.bio, candidate.nextIndex, now());
      return {
        ok: true,
        bio: applied.bio,
        source: candidate.source,
      };
    } catch (err) {
      const errMsg = err?.message || String(err || 'Failed to update About');
      if (typeof errorLogger === 'function') {
        try {
          errorLogger('AutoBio', null, null, errMsg);
        } catch {}
      }
      return {
        ok: false,
        bio: '',
        error: errMsg,
      };
    } finally {
      updating = false;
    }
  }

  async function tick() {
    const state = store.getState();
    if (!state.enabled) {
      clearTimer();
      return { ok: false, skipped: true, reason: 'disabled' };
    }
    return updateNow({ isBackground: true });
  }

  async function enable({ sock = null, bioText = '', intervalMs = null } = {}) {
    let addRes = null;
    if (String(bioText || '').trim()) {
      addRes = store.addBio(bioText);
      if (!addRes.ok) {
        return { ok: false, reason: addRes.reason, error: 'Bio text cannot be empty.' };
      }
    }
    if (intervalMs !== null && intervalMs !== undefined) {
      store.setIntervalMs(intervalMs);
    }
    const nextState = store.setEnabled(true);
    startTimer(nextState.intervalMs);

    const updateRes = await updateNow({
      sock,
      preferredBio: addRes?.bio || '',
    });

    return {
      ok: true,
      updated: Boolean(updateRes.ok),
      bio: updateRes.bio || addRes?.bio || '',
      truncated: Boolean(addRes?.truncated),
      error: updateRes.ok ? null : updateRes.error || null,
      state: store.getState(),
    };
  }

  function disable() {
    clearTimer();
    const state = store.setEnabled(false);
    return { ok: true, state };
  }

  async function addAndApply(rawBio, { sock = null, enableAuto = true } = {}) {
    const addRes = store.addBio(rawBio);
    if (!addRes.ok) {
      return { ok: false, reason: addRes.reason, error: 'Provide bio text to add.' };
    }
    if (enableAuto) {
      const nextState = store.setEnabled(true);
      startTimer(nextState.intervalMs);
    }
    const updateRes = await updateNow({
      sock,
      preferredBio: addRes.bio,
      allowExternalFetch: false,
    });
    return {
      ok: true,
      added: addRes.added,
      index: addRes.index,
      total: addRes.total,
      truncated: addRes.truncated,
      bio: updateRes.bio || addRes.bio,
      updated: Boolean(updateRes.ok),
      error: updateRes.ok ? null : updateRes.error || null,
      state: store.getState(),
    };
  }

  async function setAndApply(rawBio, { sock = null, enableAuto = true } = {}) {
    const setRes = store.setBio(rawBio);
    if (!setRes.ok) {
      return { ok: false, reason: setRes.reason, error: 'Provide bio text to set.' };
    }
    if (enableAuto) {
      const nextState = store.setEnabled(true);
      startTimer(nextState.intervalMs);
    }
    const updateRes = await updateNow({
      sock,
      preferredBio: setRes.bio,
      allowExternalFetch: false,
    });
    return {
      ok: true,
      index: 0,
      total: setRes.total,
      truncated: setRes.truncated,
      bio: updateRes.bio || setRes.bio,
      updated: Boolean(updateRes.ok),
      error: updateRes.ok ? null : updateRes.error || null,
      state: store.getState(),
    };
  }

  function setIntervalMs(ms) {
    const state = store.setIntervalMs(ms);
    if (state.enabled) {
      startTimer(state.intervalMs);
    }
    return state;
  }

  async function syncOnConnect({ sock = null, config = null } = {}) {
    if (sock) fallbackSock = sock;
    if (config?.BOT_NAME) botNameResolver = () => config.BOT_NAME || 'Spider Man';
    if (config?.TZ) tzResolver = () => config.TZ || 'Africa/Nairobi';

    const state = store.getState();
    if (!state.enabled) {
      clearTimer();
      return { enabled: false, updated: false };
    }

    startTimer(state.intervalMs);
    const res = await updateNow({ sock, isBackground: true });
    return {
      enabled: true,
      updated: Boolean(res.ok),
      bio: res.bio || '',
      error: res.error || null,
    };
  }

  function stop() {
    clearTimer();
  }

  async function loadPresets({ sock = null, replace = false, limit = null, enableAuto = true } = {}) {
    const res = store.loadPresetBios({ replace, limit });
    if (enableAuto) {
      const nextState = store.setEnabled(true);
      startTimer(nextState.intervalMs);
    }
    const updateRes = await updateNow({ sock });
    return {
      ok: true,
      addedCount: res.addedCount,
      presetCount: res.presetCount,
      total: store.getState().bios.length,
      bio: updateRes.bio || '',
      updated: Boolean(updateRes.ok),
      error: updateRes.ok ? null : updateRes.error || null,
      state: store.getState(),
    };
  }

  return {
    store,
    configure,
    updateNow,
    tick,
    enable,
    disable,
    addAndApply,
    setAndApply,
    loadPresets,
    setIntervalMs,
    syncOnConnect,
    stop,
    getState: () => store.getState(),
    isRunning: () => Boolean(intervalHandle),
  };
}

export const defaultAutobioManager = createAutobioManager({
  store: defaultAutobioStore,
});
