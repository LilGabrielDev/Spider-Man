import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupDiskArtifacts,
  createBaileysCacheStore,
  createBoundedMap,
  createBoundedSet,
  getWorkerMemoryExecArgv,
  pruneAuthDirectory,
} from '../../spider/utils/resourceGuard.js';
import { createCommandRateLimiter } from '../../spider/utils/securityPolicy.js';

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
