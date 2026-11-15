import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MAX_TEMP_AGE_MS = 15 * 60 * 1000;
export const DEFAULT_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

export function createBoundedMap({
  maxEntries = 500,
  ttlMs = 0,
  now = Date.now,
} = {}) {
  const limit = Number.isFinite(Number(maxEntries)) && Number(maxEntries) > 0
    ? Math.floor(Number(maxEntries))
    : 500;
  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
    ? Number(ttlMs)
    : 0;
  const store = new Map();

  function isExpired(entry, currentTime) {
    return ttl > 0 && entry && currentTime >= entry.expiresAt;
  }

  function evictOverflow() {
    while (store.size > limit) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      store.delete(oldestKey);
    }
  }

  function prune(currentTime = now()) {
    let removed = 0;
    if (ttl > 0) {
      for (const [key, entry] of store.entries()) {
        if (isExpired(entry, currentTime)) {
          store.delete(key);
          removed += 1;
        }
      }
    }
    while (store.size > limit) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      store.delete(oldestKey);
      removed += 1;
    }
    return removed;
  }

  return {
    get size() {
      if (ttl > 0) prune();
      return store.size;
    },
    has(key) {
      const entry = store.get(key);
      if (!entry) return false;
      if (isExpired(entry, now())) {
        store.delete(key);
        return false;
      }
      return true;
    },
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (isExpired(entry, now())) {
        store.delete(key);
        return undefined;
      }
      // Refresh LRU position
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    set(key, value, customTtlMs) {
      const effectiveTtl =
        Number.isFinite(Number(customTtlMs)) && Number(customTtlMs) > 0
          ? Number(customTtlMs)
          : ttl;
      const currentTime = now();
      if (store.has(key)) store.delete(key);
      store.set(key, {
        value,
        expiresAt: effectiveTtl > 0 ? currentTime + effectiveTtl : Infinity,
      });
      if (store.size > limit) {
        if (ttl > 0) prune(currentTime);
        evictOverflow();
      }
      return this;
    },
    delete(key) {
      return store.delete(key);
    },
    clear() {
      store.clear();
    },
    prune,
    keys() {
      if (ttl > 0) prune();
      return store.keys();
    },
    *values() {
      if (ttl > 0) prune();
      for (const entry of store.values()) {
        yield entry.value;
      }
    },
    *entries() {
      if (ttl > 0) prune();
      for (const [key, entry] of store.entries()) {
        yield [key, entry.value];
      }
    },
    [Symbol.iterator]() {
      return this.entries();
    },
  };
}

export function createBoundedSet({
  maxEntries = 1000,
  ttlMs = 0,
  now = Date.now,
} = {}) {
  const map = createBoundedMap({ maxEntries, ttlMs, now });

  return {
    get size() {
      return map.size;
    },
    has(value) {
      return map.has(value);
    },
    add(value) {
      map.set(value, true);
      return this;
    },
    delete(value) {
      return map.delete(value);
    },
    clear() {
      map.clear();
    },
    prune(currentTime) {
      return map.prune(currentTime);
    },
    values() {
      return map.keys();
    },
    keys() {
      return map.keys();
    },
    [Symbol.iterator]() {
      return map.keys();
    },
  };
}

export function createBaileysCacheStore({
  maxEntries = 400,
  ttlMs = 10 * 60 * 1000,
  now = Date.now,
} = {}) {
  const cache = createBoundedMap({ maxEntries, ttlMs, now });
  return {
    get size() {
      return cache.size;
    },
    get(key) {
      return cache.get(key);
    },
    set(key, value) {
      cache.set(key, value);
    },
    del(key) {
      return cache.delete(key);
    },
    mget(keys = []) {
      const out = {};
      for (const key of keys) {
        out[key] = cache.get(key);
      }
      return out;
    },
    mset(entries = []) {
      for (const item of entries) {
        if (item && item.key !== undefined) {
          cache.set(item.key, item.value);
        }
      }
    },
    mdel(keys = []) {
      for (const key of keys) {
        cache.delete(key);
      }
    },
    flushAll() {
      cache.clear();
    },
    prune(currentTime) {
      return cache.prune(currentTime);
    },
  };
}

export function readCgroupMemoryLimitBytes(fsImpl = fs) {
  const candidates = [
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ];
  for (const filePath of candidates) {
    try {
      if (!fsImpl.existsSync(filePath)) continue;
      const raw = String(fsImpl.readFileSync(filePath, 'utf8')).trim();
      if (!raw || raw === 'max') continue;
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0 && parsed < 1e15) {
        return parsed;
      }
    } catch {
      // Ignore environments without readable cgroup files
    }
  }
  return null;
}

export function getWorkerMemoryExecArgv({
  totalMemBytes,
  env = process.env,
  existingExecArgv = process.execArgv,
  fsImpl = fs,
} = {}) {
  const nodeOptions = String(env?.NODE_OPTIONS || '');
  const hasExplicitFlag =
    /--max[-_]old[-_]space[-_]size(?:=|\s|$)/i.test(nodeOptions) ||
    (Array.isArray(existingExecArgv) &&
      existingExecArgv.some((arg) => /--max[-_]old[-_]space[-_]size/i.test(String(arg))));

  if (hasExplicitFlag) {
    return [];
  }

  const envOverrideMb = Number(env?.SPIDER_MAX_OLD_SPACE_MB);
  if (Number.isFinite(envOverrideMb) && envOverrideMb >= 96) {
    return [`--max-old-space-size=${Math.floor(envOverrideMb)}`];
  }

  const cgroupLimit = readCgroupMemoryLimitBytes(fsImpl);
  const hostTotal = Number.isFinite(Number(totalMemBytes)) && Number(totalMemBytes) > 0
    ? Number(totalMemBytes)
    : os.totalmem();
  const effectiveBytes = cgroupLimit ? Math.min(cgroupLimit, hostTotal) : hostTotal;
  const totalMb = Math.floor(effectiveBytes / (1024 * 1024));

  let targetMb;
  if (totalMb <= 0) {
    targetMb = 320;
  } else if (totalMb <= 512) {
    targetMb = Math.max(160, Math.min(320, Math.floor(totalMb * 0.65)));
  } else if (totalMb <= 1024) {
    targetMb = Math.max(256, Math.min(512, Math.floor(totalMb * 0.65)));
  } else {
    targetMb = 512;
  }

  return [`--max-old-space-size=${targetMb}`];
}

function safeStat(fsImpl, targetPath) {
  try {
    return fsImpl.lstatSync(targetPath);
  } catch {
    return null;
  }
}

function measurePathBytes(fsImpl, targetPath) {
  const stat = safeStat(fsImpl, targetPath);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size || 0;
  let total = 0;
  try {
    for (const entry of fsImpl.readdirSync(targetPath)) {
      total += measurePathBytes(fsImpl, path.join(targetPath, entry));
    }
  } catch {
    // Best effort
  }
  return total;
}

function removeEntry(fsImpl, targetPath, stats, result) {
  const isDir = stats.isDirectory();
  const byteSize = isDir ? measurePathBytes(fsImpl, targetPath) : stats.size || 0;
  try {
    if (isDir) {
      fsImpl.rmSync(targetPath, { recursive: true, force: true });
      result.removedDirs += 1;
    } else {
      fsImpl.unlinkSync(targetPath);
      result.removedFiles += 1;
    }
    result.freedBytes += byteSize;
  } catch {
    // Ignore files actively locked or concurrently deleted
  }
}

export const DEFAULT_CLEANUP_INTERVAL_MS = DEFAULT_MAINTENANCE_INTERVAL_MS;
export const DEFAULT_SESSION_TEMP_AGE_MS = 10 * 60 * 1000;

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function sweepDirectory(
  fsImpl,
  dirPath,
  { maxAgeMs, nowMs, nameMatcher, recursiveSubdirs = false },
  result,
) {
  if (!dirPath) return;
  let entries;
  try {
    if (!fsImpl.existsSync(dirPath)) return;
    entries = fsImpl.readdirSync(dirPath);
  } catch {
    return;
  }

  for (const name of entries) {
    if (typeof nameMatcher === 'function' && !nameMatcher(name)) continue;
    const fullPath = path.join(dirPath, name);
    const st = safeStat(fsImpl, fullPath);
    if (!st) continue;
    const ageMs = nowMs - (st.mtimeMs || st.ctimeMs || 0);
    if (maxAgeMs <= 0 || ageMs >= maxAgeMs) {
      removeEntry(fsImpl, fullPath, st, result);
    } else if (recursiveSubdirs && st.isDirectory()) {
      sweepDirectory(
        fsImpl,
        fullPath,
        { maxAgeMs, nowMs, recursiveSubdirs: true },
        result,
      );
      try {
        if (fsImpl.readdirSync(fullPath).length === 0) {
          fsImpl.rmSync(fullPath, { recursive: true, force: true });
          result.removedDirs += 1;
        }
      } catch {}
    }
  }
}

const CWD_ARTIFACT_PATTERN =
  /^(?:temp_\d+|video_\d+\.mp4|audio_\d+\.mp3|sticker_\d+\.webp|.*-Backup-[\dT-]+\.zip|\.spider-update\.json\.tmp-.*)$/i;
const TMPDIR_PREFIX_PATTERN =
  /^(?:ultra-lil-play-|ultra-lil-compress-|ultra-lil-temp|spider-pair-|yt-dlp-|jimp-|sticker_\d+_\d+\.(?:webm|webp)$)/i;

export function cleanupDiskArtifacts({
  cwd = process.cwd(),
  tmpDir = os.tmpdir(),
  tempDirs = [],
  cacheDirs = [],
  maxAgeMs = DEFAULT_MAX_TEMP_AGE_MS,
  nowMs = Date.now(),
  fsImpl = fs,
} = {}) {
  const result = { removedFiles: 0, removedDirs: 0, freedBytes: 0 };
  const visitedDirs = new Set();

  const dedicatedTempDirs = [
    '/tmp/ultra-lil-temp',
    tmpDir ? path.join(tmpDir, 'ultra-lil-temp') : null,
    cwd ? path.join(cwd, 'temp') : null,
    cwd ? path.join(cwd, 'tmp') : null,
    cwd ? path.join(cwd, 'spider', 'temp') : null,
    cwd ? path.join(cwd, 'spider', 'tmp') : null,
    cwd ? path.join(cwd, 'cache') : null,
    cwd ? path.join(cwd, '.cache') : null,
    cwd ? path.join(cwd, 'spider', 'cache') : null,
    cwd ? path.join(cwd, 'spider', '.cache') : null,
    cwd ? path.join(cwd, 'node_modules', '.cache') : null,
    cwd ? path.join(cwd, '.npm', '_cacache') : null,
    cwd ? path.join(cwd, '.npm', '_logs') : null,
    cwd
      ? path.join(cwd, 'Spider', 'legacy', 'lilgabriel', 'features', 'spidersession', 'temp')
      : null,
    ...tempDirs,
    ...cacheDirs,
  ].filter(Boolean);

  for (const dir of dedicatedTempDirs) {
    const resolved = path.resolve(dir);
    if (visitedDirs.has(resolved)) continue;
    visitedDirs.add(resolved);
    sweepDirectory(
      fsImpl,
      resolved,
      { maxAgeMs, nowMs, recursiveSubdirs: true },
      result,
    );
  }

  if (tmpDir) {
    sweepDirectory(
      fsImpl,
      path.resolve(tmpDir),
      {
        maxAgeMs,
        nowMs,
        nameMatcher: (name) => TMPDIR_PREFIX_PATTERN.test(name),
      },
      result,
    );
  }

  if (cwd) {
    const resolvedCwd = path.resolve(cwd);
    sweepDirectory(
      fsImpl,
      resolvedCwd,
      {
        maxAgeMs,
        nowMs,
        nameMatcher: (name) => CWD_ARTIFACT_PATTERN.test(name),
      },
      result,
    );

    const dataDir = path.join(resolvedCwd, 'data');
    sweepDirectory(
      fsImpl,
      dataDir,
      {
        maxAgeMs: Math.min(maxAgeMs, 5 * 60 * 1000),
        nowMs,
        nameMatcher: (name) => name.endsWith('.tmp'),
      },
      result,
    );
  }

  return result;
}

const PROTECTED_AUTH_PREFIXES = [
  'creds.json',
  'app-state-sync-key-',
  'app-state-sync-version-',
  'lid-mapping-',
  'device-list-',
  'sender-key-memory-',
  'retry-message-store.json',
  '.spider-retry-store.json',
];

const TEMP_SESSION_FILE_PATTERN =
  /(?:\.tmp(?:-[^\s]*)?|\.bak|\.lock|-lock|\.partial|\.swp)$/i;

function isProtectedAuthFile(fileName) {
  return PROTECTED_AUTH_PREFIXES.some(
    (prefix) => fileName === prefix || fileName.startsWith(prefix),
  );
}

function isTempSessionFile(fileName, { preserveBackups = false } = {}) {
  if (fileName === 'creds.json') return false;
  if (preserveBackups && fileName === 'creds.json.bak') return false;
  return TEMP_SESSION_FILE_PATTERN.test(fileName);
}

export function pruneAuthDirectory({
  authDir,
  maxSenderKeys = 400,
  maxSessionFiles = 500,
  maxPreKeys = 900,
  maxTcTokens = 200,
  tempMaxAgeMs = DEFAULT_SESSION_TEMP_AGE_MS,
  preserveSignalKeys = false,
  nowMs = Date.now(),
  fsImpl = fs,
} = {}) {
  const result = { removedFiles: 0, freedBytes: 0, remainingFiles: 0 };
  if (!authDir) return result;

  let entries;
  try {
    if (!fsImpl.existsSync(authDir)) return result;
    entries = fsImpl.readdirSync(authDir);
  } catch {
    return result;
  }

  const senderKeys = [];
  const sessions = [];
  const preKeys = [];
  const tcTokens = [];
  let protectedCount = 0;
  let otherCount = 0;

  for (const name of entries) {
    const fullPath = path.join(authDir, name);
    const st = safeStat(fsImpl, fullPath);
    if (!st || st.isDirectory()) continue;

    if (isTempSessionFile(name, { preserveBackups: preserveSignalKeys })) {
      const ageMs = nowMs - (st.mtimeMs || st.ctimeMs || 0);
      if (tempMaxAgeMs <= 0 || ageMs >= tempMaxAgeMs) {
        try {
          fsImpl.unlinkSync(fullPath);
          result.removedFiles += 1;
          result.freedBytes += st.size || 0;
        } catch {
          otherCount += 1;
        }
      } else {
        otherCount += 1;
      }
      continue;
    }

    if (preserveSignalKeys && name === 'creds.json.bak') {
      protectedCount += 1;
      continue;
    }

    if (isProtectedAuthFile(name)) {
      protectedCount += 1;
      continue;
    }

    const item = { name, fullPath, mtimeMs: st.mtimeMs || st.ctimeMs || 0, size: st.size || 0 };
    if (name.startsWith('sender-key-')) {
      senderKeys.push(item);
    } else if (name.startsWith('session-')) {
      sessions.push(item);
    } else if (name.startsWith('pre-key-')) {
      preKeys.push(item);
    } else if (name.startsWith('tctoken-')) {
      tcTokens.push(item);
    } else {
      otherCount += 1;
    }
  }

  function extractNumericSuffix(fileName) {
    const match = String(fileName || '').match(/(\d+)(?:\.[^.]+)?$/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }

  function pruneOldest(list, cap) {
    if (preserveSignalKeys || !Number.isFinite(cap) || cap < 0 || list.length <= cap) {
      return list.length;
    }
    list.sort((a, b) => {
      const timeDiff = a.mtimeMs - b.mtimeMs;
      if (timeDiff !== 0) return timeDiff;
      return extractNumericSuffix(a.name) - extractNumericSuffix(b.name);
    });
    const excess = list.length - cap;
    let remaining = list.length;
    for (let i = 0; i < excess; i += 1) {
      const target = list[i];
      try {
        fsImpl.unlinkSync(target.fullPath);
        result.removedFiles += 1;
        result.freedBytes += target.size;
        remaining -= 1;
      } catch {
        // Ignore locked files
      }
    }
    return remaining;
  }

  const keptSenderKeys = pruneOldest(senderKeys, maxSenderKeys);
  const keptSessions = pruneOldest(sessions, maxSessionFiles);
  const keptPreKeys = pruneOldest(preKeys, maxPreKeys);
  const keptTcTokens = pruneOldest(tcTokens, maxTcTokens);
  result.remainingFiles =
    protectedCount + otherCount + keptSenderKeys + keptSessions + keptPreKeys + keptTcTokens;
  return result;
}

export function discoverSessionDirectories({
  authDir,
  sessionDirs = [],
  cwd = process.cwd(),
  fsImpl = fs,
} = {}) {
  const candidates = [
    authDir,
    ...sessionDirs,
    cwd ? path.join(cwd, 'auth') : null,
    cwd ? path.join(cwd, 'spider', 'auth') : null,
    cwd ? path.join(cwd, 'auth_info_baileys') : null,
    cwd ? path.join(cwd, 'sessions') : null,
    cwd ? path.join(cwd, 'session') : null,
  ].filter(Boolean);

  const unique = [];
  const seen = new Set();
  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      if (fsImpl.existsSync(resolved)) {
        unique.push(resolved);
      }
    } catch {}
  }
  return unique;
}

export function clearTemporarySessionsAndCache({
  authDir,
  sessionDirs = [],
  cacheDirs = [],
  cwd = process.cwd(),
  tmpDir = os.tmpdir(),
  tempDirs = [],
  caches = [],
  maxAgeMs = DEFAULT_MAX_TEMP_AGE_MS,
  tempMaxAgeMs = DEFAULT_SESSION_TEMP_AGE_MS,
  maxSenderKeys = 400,
  maxSessionFiles = 500,
  maxPreKeys = 900,
  maxTcTokens = 200,
  preserveSignalKeys = false,
  nowMs = Date.now(),
  fsImpl = fs,
} = {}) {
  for (const cache of caches) {
    try {
      cache?.prune?.(nowMs);
    } catch {}
  }

  const disk = cleanupDiskArtifacts({
    cwd,
    tmpDir,
    tempDirs,
    cacheDirs,
    maxAgeMs,
    nowMs,
    fsImpl,
  });

  const resolvedSessionDirs = discoverSessionDirectories({
    authDir,
    sessionDirs,
    cwd,
    fsImpl,
  });

  const auth = { removedFiles: 0, freedBytes: 0, remainingFiles: 0 };
  const sessionResults = [];

  for (const dir of resolvedSessionDirs) {
    const stats = pruneAuthDirectory({
      authDir: dir,
      maxSenderKeys,
      maxSessionFiles,
      maxPreKeys,
      maxTcTokens,
      tempMaxAgeMs,
      preserveSignalKeys,
      nowMs,
      fsImpl,
    });
    auth.removedFiles += stats.removedFiles;
    auth.freedBytes += stats.freedBytes;
    auth.remainingFiles += stats.remainingFiles;
    sessionResults.push({ dir, ...stats });
  }

  return {
    disk,
    auth,
    sessionResults,
    totalRemovedFiles: disk.removedFiles + auth.removedFiles,
    totalRemovedDirs: disk.removedDirs,
    totalFreedBytes: disk.freedBytes + auth.freedBytes,
    ranAt: nowMs,
  };
}

function readDurationEnv(env, key, fallback) {
  const raw = Number(env?.[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function startResourceMaintenance({
  authDir,
  sessionDirs = [],
  cacheDirs = [],
  cwd = process.cwd(),
  tmpDir = os.tmpdir(),
  tempDirs = [],
  caches = [],
  protectedCaches = [],
  intervalMs,
  maxAgeMs,
  tempMaxAgeMs,
  maxSenderKeys = 400,
  maxSessionFiles = 500,
  maxPreKeys = 900,
  maxTcTokens = 200,
  preserveSignalKeys = false,
  memoryHighWaterRatio = 0.85,
  quiet = false,
  env = process.env,
  onCleanup,
} = {}) {
  const effectiveIntervalMs =
    Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0
      ? Number(intervalMs)
      : readDurationEnv(env, 'SPIDER_CLEANUP_INTERVAL_MS', DEFAULT_CLEANUP_INTERVAL_MS);
  const defaultMaxAgeMs =
    Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) >= 0
      ? Number(maxAgeMs)
      : readDurationEnv(env, 'SPIDER_CLEANUP_MAX_AGE_MS', DEFAULT_MAX_TEMP_AGE_MS);
  const defaultTempMaxAgeMs =
    Number.isFinite(Number(tempMaxAgeMs)) && Number(tempMaxAgeMs) >= 0
      ? Number(tempMaxAgeMs)
      : readDurationEnv(env, 'SPIDER_SESSION_TEMP_MAX_AGE_MS', DEFAULT_SESSION_TEMP_AGE_MS);

  let isRunning = false;
  const stats = {
    runs: 0,
    totalRemovedFiles: 0,
    totalRemovedDirs: 0,
    totalFreedBytes: 0,
    lastRunAt: null,
    lastSummary: null,
  };

  function runNow({ forceMemoryTrim = false, aggressive = false } = {}) {
    if (isRunning) {
      return stats.lastSummary;
    }
    isRunning = true;
    try {
      const nowMs = Date.now();
      const passMaxAgeMs = aggressive ? Math.min(defaultMaxAgeMs, 5_000) : defaultMaxAgeMs;
      const passTempAgeMs = aggressive ? Math.min(defaultTempMaxAgeMs, 5_000) : defaultTempMaxAgeMs;

      const cleanupSummary = clearTemporarySessionsAndCache({
        authDir,
        sessionDirs,
        cacheDirs,
        cwd,
        tmpDir,
        tempDirs,
        caches: [...caches, ...protectedCaches],
        maxAgeMs: passMaxAgeMs,
        tempMaxAgeMs: passTempAgeMs,
        maxSenderKeys,
        maxSessionFiles,
        maxPreKeys,
        maxTcTokens,
        preserveSignalKeys,
        nowMs,
      });

      const mem = process.memoryUsage();
      const heapLimitBytes =
        readCgroupMemoryLimitBytes() || Math.max(mem.heapTotal * 1.5, 256 * 1024 * 1024);
      const rssRatio = heapLimitBytes > 0 ? mem.rss / heapLimitBytes : 0;

      let memoryTrimmed = false;
      if (forceMemoryTrim || aggressive || rssRatio >= memoryHighWaterRatio) {
        memoryTrimmed = true;
        for (const cache of caches) {
          try {
            if (typeof cache?.flushAll === 'function') cache.flushAll();
            else if (typeof cache?.clear === 'function') cache.clear();
          } catch {}
        }
        for (const cache of protectedCaches) {
          try {
            cache?.prune?.(nowMs);
          } catch {}
        }
        try {
          if (typeof globalThis.gc === 'function') globalThis.gc();
        } catch {}
      }

      const summary = {
        ...cleanupSummary,
        memoryTrimmed,
        rssBytes: mem.rss,
      };

      stats.runs += 1;
      stats.totalRemovedFiles += summary.totalRemovedFiles;
      stats.totalRemovedDirs += summary.totalRemovedDirs;
      stats.totalFreedBytes += summary.totalFreedBytes;
      stats.lastRunAt = nowMs;
      stats.lastSummary = summary;

      if (
        !quiet &&
        (summary.totalRemovedFiles > 0 || summary.totalRemovedDirs > 0 || memoryTrimmed)
      ) {
        console.log(
          `🧹 [CLEANER] Cleared ${summary.totalRemovedFiles} file(s), ${summary.totalRemovedDirs} dir(s) (${formatBytes(summary.totalFreedBytes)} freed).`,
        );
      }

      if (typeof onCleanup === 'function') {
        try {
          onCleanup(summary);
        } catch {}
      }
      return summary;
    } finally {
      isRunning = false;
    }
  }

  runNow();

  const timer = setInterval(() => {
    runNow();
  }, effectiveIntervalMs);
  timer.unref?.();

  return {
    runNow,
    getStats() {
      return { ...stats };
    },
    stop() {
      clearInterval(timer);
    },
  };
}

export const startSessionAndCacheCleaner = startResourceMaintenance;
