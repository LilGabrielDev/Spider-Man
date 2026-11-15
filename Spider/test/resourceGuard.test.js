import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupDiskArtifacts,
  clearTemporarySessionsAndCache,
  createBaileysCacheStore,
  createBoundedMap,
  createBoundedSet,
  getWorkerMemoryExecArgv,
  pruneAuthDirectory,
  startSessionAndCacheCleaner,
} from '../../spider/utils/resourceGuard.js';
import { createCommandRateLimiter } from '../../spider/utils/securityPolicy.js';
import { commands as adminCommands } from '../commands/Admin.js';

function withTempWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-rg-test-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function setFileAge(filePath, ageMs, nowMs) {
  const targetTime = new Date(nowMs - ageMs);
  fs.utimesSync(filePath, targetTime, targetTime);
}

test('createBoundedMap enforces LRU eviction and refreshes order on get()', () => {
  const map = createBoundedMap({ maxEntries: 3 });
  map.set('a', 1);
  map.set('b', 2);
  map.set('c', 3);

  // Touch 'a' so 'b' becomes least-recently used
  assert.equal(map.get('a'), 1);

  map.set('d', 4);
  assert.equal(map.size, 3);
  assert.equal(map.has('b'), false);
  assert.equal(map.get('a'), 1);
  assert.equal(map.get('c'), 3);
  assert.equal(map.get('d'), 4);
});

test('createBoundedMap expires entries by TTL and prunes expired items', () => {
  let currentTime = 1_000;
  const map = createBoundedMap({
    maxEntries: 5,
    ttlMs: 500,
    now: () => currentTime,
  });

  map.set('short', 'val1');
  currentTime = 1_200;
  map.set('longer', 'val2');

  currentTime = 1_500;
  assert.equal(map.has('short'), false);
  assert.equal(map.get('short'), undefined);
  assert.equal(map.get('longer'), 'val2');

  currentTime = 1_700;
  assert.equal(map.prune(), 1);
  assert.equal(map.size, 0);
});

test('createBoundedSet enforces capacity and TTL expiration', () => {
  let currentTime = 10_000;
  const set = createBoundedSet({
    maxEntries: 2,
    ttlMs: 1_000,
    now: () => currentTime,
  });

  set.add('m1');
  set.add('m2');
  set.add('m3');
  assert.equal(set.size, 2);
  assert.equal(set.has('m1'), false);
  assert.equal(set.has('m2'), true);
  assert.equal(set.has('m3'), true);

  currentTime = 11_000;
  assert.equal(set.has('m2'), false);
  assert.equal(set.prune(), 1);
  assert.equal(set.size, 0);
});

test('createBaileysCacheStore supports batch ops, flushAll, and bounded capacity', () => {
  let currentTime = 5_000;
  const store = createBaileysCacheStore({
    maxEntries: 3,
    ttlMs: 2_000,
    now: () => currentTime,
  });

  store.mset([
    { key: 'k1', value: 'v1' },
    { key: 'k2', value: 'v2' },
    { key: 'k3', value: 'v3' },
  ]);
  assert.deepEqual(store.mget(['k1', 'k2', 'missing']), {
    k1: 'v1',
    k2: 'v2',
    missing: undefined,
  });

  store.set('k4', 'v4');
  assert.equal(store.size, 3);
  assert.equal(store.get('k3'), undefined); // 'k3' was LRU after mget(['k1','k2'])

  store.mdel(['k1']);
  assert.equal(store.get('k1'), undefined);

  store.flushAll();
  assert.equal(store.size, 0);
});

test('getWorkerMemoryExecArgv computes container-aware heap limits and respects overrides', () => {
  const MB = 1024 * 1024;
  const makeMockFs = (cgroupMap = {}) => ({
    existsSync: (p) => Object.prototype.hasOwnProperty.call(cgroupMap, p),
    readFileSync: (p) => cgroupMap[p],
  });

  // Katabump 256MB container even on large host
  assert.deepEqual(
    getWorkerMemoryExecArgv({
      totalMemBytes: 16_384 * MB,
      env: {},
      existingExecArgv: [],
      fsImpl: makeMockFs({ '/sys/fs/cgroup/memory.max': String(256 * MB) }),
    }),
    ['--max-old-space-size=166'],
  );

  // Katabump 512MB container via cgroup v1
  assert.deepEqual(
    getWorkerMemoryExecArgv({
      totalMemBytes: 8_192 * MB,
      env: {},
      existingExecArgv: [],
      fsImpl: makeMockFs({
        '/sys/fs/cgroup/memory.max': 'max',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(512 * MB),
      }),
    }),
    ['--max-old-space-size=320'],
  );

  // Large host/container capped at 512MB
  assert.deepEqual(
    getWorkerMemoryExecArgv({
      totalMemBytes: 4_096 * MB,
      env: {},
      existingExecArgv: [],
      fsImpl: makeMockFs({}),
    }),
    ['--max-old-space-size=512'],
  );

  // Explicit SPIDER_MAX_OLD_SPACE_MB override
  assert.deepEqual(
    getWorkerMemoryExecArgv({
      totalMemBytes: 512 * MB,
      env: { SPIDER_MAX_OLD_SPACE_MB: '220' },
      existingExecArgv: [],
      fsImpl: makeMockFs({}),
    }),
    ['--max-old-space-size=220'],
  );

  // Passthrough when already configured in NODE_OPTIONS or execArgv
  assert.deepEqual(
    getWorkerMemoryExecArgv({
      totalMemBytes: 512 * MB,
      env: { NODE_OPTIONS: '--max-old-space-size=256' },
      existingExecArgv: [],
      fsImpl: makeMockFs({}),
    }),
    [],
  );
  assert.deepEqual(
    getWorkerMemoryExecArgv({
      totalMemBytes: 512 * MB,
      env: {},
      existingExecArgv: ['--max_old_space_size=300'],
      fsImpl: makeMockFs({}),
    }),
    [],
  );
});

test('cleanupDiskArtifacts removes expired temp and crash files while keeping fresh/app files', () => {
  withTempWorkspace((root) => {
    const cwd = path.join(root, 'app');
    const tmpDir = path.join(root, 'sys-tmp');
    const tempDir = path.join(cwd, 'temp');
    const tmpSubDir = path.join(cwd, 'tmp');
    const dataDir = path.join(cwd, 'data');
    const customTempDir = path.join(cwd, 'custom-tmp');

    for (const dir of [cwd, tmpDir, tempDir, tmpSubDir, dataDir, customTempDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const nowMs = Date.now();
    const expiredAge = 20 * 60 * 1000;
    const freshAge = 30 * 1000;

    // Files that MUST be removed (expired)
    const expiredFiles = [
      path.join(tempDir, 'old-download.mp3'),
      path.join(tmpSubDir, 'old-frame.png'),
      path.join(customTempDir, 'stale.webp'),
      path.join(tmpDir, 'ultra-lil-play-123.m4a'),
      path.join(tmpDir, 'ultra-lil-compress-123.jpg'),
      path.join(tmpDir, 'sticker_123_0.webp'),
      path.join(cwd, 'temp_999'),
      path.join(cwd, 'video_999.mp4'),
      path.join(cwd, 'audio_999.mp3'),
      path.join(cwd, 'sticker_999.webp'),
      path.join(cwd, 'Spider-Backup-2026-01-01T00-00-00.zip'),
      path.join(dataDir, 'sudo.json.tmp'),
    ];
    for (const file of expiredFiles) {
      fs.writeFileSync(file, 'x'.repeat(64));
      setFileAge(file, expiredAge, nowMs);
    }

    const expiredDir = path.join(tmpDir, 'ultra-lil-temp-dir');
    fs.mkdirSync(expiredDir, { recursive: true });
    fs.writeFileSync(path.join(expiredDir, 'nested.bin'), 'abc');
    setFileAge(expiredDir, expiredAge, nowMs);

    // Files that MUST be preserved (fresh or non-temp app files)
    const preservedFiles = [
      path.join(tempDir, 'active-download.mp3'),
      path.join(tmpDir, 'ultra-lil-play-fresh.m4a'),
      path.join(tmpDir, 'unrelated-system-socket.sock'),
      path.join(cwd, 'package.json'),
      path.join(cwd, 'creds.json'),
      path.join(dataDir, 'settings.json'),
    ];
    for (const file of preservedFiles) {
      fs.writeFileSync(file, 'keep');
    }
    setFileAge(path.join(tempDir, 'active-download.mp3'), freshAge, nowMs);
    setFileAge(path.join(tmpDir, 'ultra-lil-play-fresh.m4a'), freshAge, nowMs);
    setFileAge(path.join(tmpDir, 'unrelated-system-socket.sock'), expiredAge, nowMs);
    setFileAge(path.join(cwd, 'package.json'), expiredAge, nowMs);
    setFileAge(path.join(cwd, 'creds.json'), expiredAge, nowMs);
    setFileAge(path.join(dataDir, 'settings.json'), expiredAge, nowMs);

    const summary = cleanupDiskArtifacts({
      cwd,
      tmpDir,
      tempDirs: [customTempDir],
      maxAgeMs: 15 * 60 * 1000,
      nowMs,
    });

    assert.equal(summary.removedFiles, expiredFiles.length);
    assert.equal(summary.removedDirs, 1);
    assert.ok(summary.freedBytes > 0);

    for (const file of expiredFiles) {
      assert.equal(fs.existsSync(file), false, `expected removed: ${file}`);
    }
    assert.equal(fs.existsSync(expiredDir), false);

    for (const file of preservedFiles) {
      assert.equal(fs.existsSync(file), true, `expected preserved: ${file}`);
    }
  });
});

test('pruneAuthDirectory protects credentials and prunes oldest excess session/prekey/sender-key files', () => {
  withTempWorkspace((root) => {
    const authDir = path.join(root, 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    const nowMs = Date.now();

    const protectedFiles = [
      'creds.json',
      'app-state-sync-key-123.json',
      'app-state-sync-version-regular.json',
      'lid-mapping-100.json',
      'device-list-254700000000.json',
    ];
    for (const name of protectedFiles) {
      const p = path.join(authDir, name);
      fs.writeFileSync(p, '{}');
      setFileAge(p, 60 * 60 * 1000, nowMs);
    }

    const oldTmp = path.join(authDir, 'creds.json.tmp');
    const freshTmp = path.join(authDir, 'session-1.tmp');
    fs.writeFileSync(oldTmp, '{}');
    fs.writeFileSync(freshTmp, '{}');
    setFileAge(oldTmp, 20 * 60 * 1000, nowMs);
    setFileAge(freshTmp, 30 * 1000, nowMs);

    // Create 5 sender keys, 4 sessions, 4 pre-keys with staggered ages (0 is oldest)
    for (let i = 0; i < 5; i += 1) {
      const p = path.join(authDir, `sender-key-${i}.json`);
      fs.writeFileSync(p, '{}');
      setFileAge(p, (5 - i) * 60 * 1000, nowMs);
    }
    for (let i = 0; i < 4; i += 1) {
      const p = path.join(authDir, `session-${i}.json`);
      fs.writeFileSync(p, '{}');
      setFileAge(p, (4 - i) * 60 * 1000, nowMs);
    }
    for (let i = 0; i < 4; i += 1) {
      const p = path.join(authDir, `pre-key-${i}.json`);
      fs.writeFileSync(p, '{}');
      setFileAge(p, (4 - i) * 60 * 1000, nowMs);
    }

    const result = pruneAuthDirectory({
      authDir,
      maxSenderKeys: 2,
      maxSessionFiles: 2,
      maxPreKeys: 2,
      tempMaxAgeMs: 10 * 60 * 1000,
      nowMs,
    });

    // Removed: 1 oldTmp + 3 sender-keys + 2 sessions + 2 pre-keys = 8
    assert.equal(result.removedFiles, 8);
    assert.equal(fs.existsSync(oldTmp), false);
    assert.equal(fs.existsSync(freshTmp), true);

    for (const name of protectedFiles) {
      assert.equal(fs.existsSync(path.join(authDir, name)), true);
    }

    // Oldest deleted, newest kept
    assert.equal(fs.existsSync(path.join(authDir, 'sender-key-0.json')), false);
    assert.equal(fs.existsSync(path.join(authDir, 'sender-key-2.json')), false);
    assert.equal(fs.existsSync(path.join(authDir, 'sender-key-3.json')), true);
    assert.equal(fs.existsSync(path.join(authDir, 'sender-key-4.json')), true);

    assert.equal(fs.existsSync(path.join(authDir, 'session-0.json')), false);
    assert.equal(fs.existsSync(path.join(authDir, 'session-3.json')), true);

    assert.equal(fs.existsSync(path.join(authDir, 'pre-key-0.json')), false);
    assert.equal(fs.existsSync(path.join(authDir, 'pre-key-3.json')), true);
  });
});

test('pruneAuthDirectory preserves sender-key-memory files and keeps highest pre-key IDs on equal mtime', () => {
  withTempWorkspace((root) => {
    const authDir = path.join(root, 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    const nowMs = Date.now();

    const memoryKey = path.join(authDir, 'sender-key-memory-120363000000000001@g.us.json');
    fs.writeFileSync(memoryKey, '{}');
    setFileAge(memoryKey, 60 * 60 * 1000, nowMs);

    for (let i = 1; i <= 5; i += 1) {
      const sk = path.join(authDir, `sender-key-${i}.json`);
      const pk = path.join(authDir, `pre-key-${i}.json`);
      fs.writeFileSync(sk, '{}');
      fs.writeFileSync(pk, '{}');
      setFileAge(sk, 5 * 60 * 1000, nowMs);
      setFileAge(pk, 5 * 60 * 1000, nowMs);
    }

    pruneAuthDirectory({
      authDir,
      maxSenderKeys: 2,
      maxPreKeys: 2,
      nowMs,
    });

    assert.equal(fs.existsSync(memoryKey), true);
    assert.equal(fs.existsSync(path.join(authDir, 'pre-key-1.json')), false);
    assert.equal(fs.existsSync(path.join(authDir, 'pre-key-2.json')), false);
    assert.equal(fs.existsSync(path.join(authDir, 'pre-key-3.json')), false);
    assert.equal(fs.existsSync(path.join(authDir, 'pre-key-4.json')), true);
    assert.equal(fs.existsSync(path.join(authDir, 'pre-key-5.json')), true);
  });
});

test('createCommandRateLimiter bounds tracked senders under high unique-sender churn', () => {
  const limiter = createCommandRateLimiter({
    limit: 1,
    windowMs: 60_000,
    now: () => 1_000,
  });

  for (let i = 0; i < 2_050; i += 1) {
    assert.equal(limiter.allow(`sender-${i}`), true);
  }

  // Newest sender is still tracked and rate-limited
  assert.equal(limiter.allow('sender-2049'), false);
  // Earliest sender was evicted due to the 2000-entry memory cap
  assert.equal(limiter.allow('sender-0'), true);
});

test('clearTemporarySessionsAndCache clears caches, pairing sessions, and temp session files across dirs', () => {
  withTempWorkspace((root) => {
    const cwd = path.join(root, 'bot');
    const tmpDir = path.join(root, 'os-tmp');
    const authDir = path.join(cwd, 'spider', 'auth');
    const sessionsDir = path.join(cwd, 'sessions');
    const cacheDir = path.join(cwd, '.cache', 'nested');
    const nmCacheDir = path.join(cwd, 'node_modules', '.cache', 'sharp');
    const pairSessionDir = path.join(
      cwd,
      'Spider',
      'legacy',
      'lilgabriel',
      'features',
      'spidersession',
      'temp',
      'pair123',
    );
    const tmpPairDir = path.join(tmpDir, 'spider-pair-abc');

    for (const dir of [
      cwd,
      tmpDir,
      authDir,
      sessionsDir,
      cacheDir,
      nmCacheDir,
      pairSessionDir,
      tmpPairDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const nowMs = Date.now();
    const expiredAge = 20 * 60 * 1000;

    // Protected credentials that must survive
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{"me":"ok"}');
    setFileAge(path.join(authDir, 'creds.json'), expiredAge, nowMs);

    // Temp session artifacts in both authDir and sessionsDir
    const staleFiles = [
      path.join(authDir, 'session-123.tmp-99'),
      path.join(authDir, 'creds.json.bak'),
      path.join(sessionsDir, 'session-abc.lock'),
      path.join(cwd, '.spider-update.json.tmp-42'),
      path.join(cacheDir, 'img-thumb.bin'),
      path.join(nmCacheDir, 'prebuild.cache'),
      path.join(pairSessionDir, 'creds.json'),
      path.join(tmpPairDir, 'creds.json'),
    ];
    for (const file of staleFiles) {
      fs.writeFileSync(file, 'stale-data');
      setFileAge(file, expiredAge, nowMs);
    }
    setFileAge(pairSessionDir, expiredAge, nowMs);
    setFileAge(tmpPairDir, expiredAge, nowMs);

    // Non-expired parent dirs to ensure recursive cleanup inside cache dirs works
    setFileAge(path.join(cwd, '.cache'), 1_000, nowMs);
    setFileAge(cacheDir, 1_000, nowMs);

    // Excess tctoken files in authDir
    for (let i = 0; i < 4; i += 1) {
      const p = path.join(authDir, `tctoken-${i}.json`);
      fs.writeFileSync(p, '{}');
      setFileAge(p, (4 - i) * 60 * 1000, nowMs);
    }

    let currentTime = 1_000;
    const boundedCache = createBoundedMap({ maxEntries: 10, ttlMs: 500, now: () => currentTime });
    boundedCache.set('old-key', 'value');
    currentTime = nowMs;

    const summary = clearTemporarySessionsAndCache({
      authDir,
      cwd,
      tmpDir,
      caches: [boundedCache],
      maxAgeMs: 15 * 60 * 1000,
      tempMaxAgeMs: 10 * 60 * 1000,
      maxTcTokens: 2,
      nowMs,
    });

    assert.equal(boundedCache.size, 0);
    assert.equal(fs.existsSync(path.join(authDir, 'creds.json')), true);
    assert.equal(fs.existsSync(path.join(authDir, 'session-123.tmp-99')), false);
    assert.equal(fs.existsSync(path.join(authDir, 'creds.json.bak')), false);
    assert.equal(fs.existsSync(path.join(sessionsDir, 'session-abc.lock')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.spider-update.json.tmp-42')), false);
    assert.equal(fs.existsSync(path.join(cacheDir, 'img-thumb.bin')), false);
    assert.equal(fs.existsSync(path.join(nmCacheDir, 'prebuild.cache')), false);
    assert.equal(fs.existsSync(pairSessionDir), false);
    assert.equal(fs.existsSync(tmpPairDir), false);
    assert.equal(fs.existsSync(path.join(authDir, 'tctoken-0.json')), false);
    assert.equal(fs.existsSync(path.join(authDir, 'tctoken-3.json')), true);
    assert.ok(summary.totalRemovedFiles >= 6);
    assert.ok(summary.totalRemovedDirs >= 2);
    assert.ok(summary.totalFreedBytes > 0);
  });
});

test('startSessionAndCacheCleaner runs periodic background sweeps and stops cleanly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-rg-async-'));
  let cleaner;
  let watchdog;

  try {
    const cwd = path.join(root, 'bot');
    const tmpDir = path.join(root, 'tmp');
    const authDir = path.join(cwd, 'auth');
    const tempDir = path.join(cwd, 'temp');
    fs.mkdirSync(authDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    await new Promise((resolve, reject) => {
      watchdog = setTimeout(() => {
        reject(new Error('Timed out waiting for periodic background cleanup run'));
      }, 2000);

      const cleanupRuns = [];
      cleaner = startSessionAndCacheCleaner({
        authDir,
        cwd,
        tmpDir,
        intervalMs: 40,
        maxAgeMs: 10,
        tempMaxAgeMs: 10,
        quiet: true,
        onCleanup(summary) {
          cleanupRuns.push(summary);
          if (cleanupRuns.length === 1) {
            const staleSession = path.join(authDir, 'session-99.tmp');
            const staleCache = path.join(tempDir, 'cached.dat');
            fs.writeFileSync(staleSession, '12345');
            fs.writeFileSync(staleCache, '123456789');
            const old = new Date(Date.now() - 5_000);
            fs.utimesSync(staleSession, old, old);
            fs.utimesSync(staleCache, old, old);
          } else if (cleanupRuns.length >= 2) {
            cleaner.stop();
            try {
              const stats = cleaner.getStats();
              assert.ok(stats.runs >= 2);
              assert.ok(stats.totalRemovedFiles >= 2);
              assert.equal(fs.existsSync(path.join(authDir, 'session-99.tmp')), false);
              assert.equal(fs.existsSync(path.join(tempDir, 'cached.dat')), false);
              resolve();
            } catch (err) {
              reject(err);
            }
          }
        },
      });
    });
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (cleaner) cleaner.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Admin clearcache command is owner-only and reports cleaned artifacts', async () => {
  const clearCmd = adminCommands.find((cmd) => cmd.name === 'clearcache');
  assert.ok(clearCmd);
  assert.equal(clearCmd.ownerOnly, true);

  const sent = [];
  const fakeSock = {
    async sendMessage(to, payload) {
      sent.push({ to, payload });
    },
  };

  await clearCmd.execute({
    sock: fakeSock,
    from: '123@s.whatsapp.net',
    msg: { key: { id: 'm1' } },
    isOwner: false,
  });
  assert.match(sent[0].payload.text, /restricted to the bot owner/i);

  await clearCmd.execute({
    sock: fakeSock,
    from: '123@s.whatsapp.net',
    msg: { key: { id: 'm2' } },
    isOwner: true,
  });
  assert.match(sent[1].payload.text, /DISK & CACHE CLEANER/);
  assert.match(sent[1].payload.text, /SESSION TEMP FILES/);
});

test('pruneAuthDirectory and clearTemporarySessionsAndCache preserve Signal keys and backups when preserveSignalKeys=true', () => {
  withTempWorkspace((root) => {
    const authDir = path.join(root, 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    const nowMs = Date.now();
    const oldAge = 60 * 60 * 1000;

    const signalFiles = [
      'creds.json',
      'creds.json.bak',
      'sender-key-1.json',
      'sender-key-2.json',
      'session-1.json',
      'session-2.json',
      'pre-key-1.json',
      'pre-key-2.json',
      'tctoken-1.json',
      'tctoken-2.json',
    ];
    for (const file of signalFiles) {
      const p = path.join(authDir, file);
      fs.writeFileSync(p, '{}');
      setFileAge(p, oldAge, nowMs);
    }

    const orphanTmp = path.join(authDir, 'creds.json.tmp-123');
    fs.writeFileSync(orphanTmp, '{');
    setFileAge(orphanTmp, oldAge, nowMs);

    const summary = clearTemporarySessionsAndCache({
      authDir,
      cwd: root,
      maxSenderKeys: 1,
      maxSessionFiles: 1,
      maxPreKeys: 1,
      maxTcTokens: 1,
      tempMaxAgeMs: 10 * 60 * 1000,
      preserveSignalKeys: true,
      nowMs,
    });

    assert.equal(summary.auth.removedFiles, 1);
    assert.equal(fs.existsSync(orphanTmp), false);
    for (const file of signalFiles) {
      assert.equal(fs.existsSync(path.join(authDir, file)), true, `${file} must survive when preserveSignalKeys=true`);
    }
  });
});
