import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  detectHostingProvider,
  detectHostingProviderAsync,
  normalizeExplicitHostProvider,
  resetHostDetectorCache,
} from '../../spider/utils/hostDetector.js';
import {
  createBaileysCacheStore,
  getWorkerMemoryExecArgv,
  isKoyebEnvironment,
  isKoyebFreePlan,
  isLowMemoryEnvironment,
  startSessionAndCacheCleaner,
} from '../../spider/utils/resourceGuard.js';
import {
  detectHostingEnvironment,
  getCurrentCommitSha,
  runBotUpdate,
} from '../../spider/utils/selfUpdater.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

function makeMockFs(cgroupMap = {}) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(cgroupMap, p),
    readFileSync: (p) => cgroupMap[p],
  };
}

test('Koyeb deployment manifests, Dockerfile, .npmrc, Procfile, .env-sample, and README are properly configured', () => {
  const koyebYaml = fs.readFileSync(path.join(ROOT, 'koyeb.yaml'), 'utf8');
  assert.match(koyebYaml, /^name:\s*spider-man-md/m);
  assert.match(koyebYaml, /^type:\s*web/m);
  assert.match(koyebYaml, /repository:\s*github\.com\/LilGabrielDev\/Spider-Man/);
  assert.match(koyebYaml, /branch:\s*main/);
  assert.match(koyebYaml, /build_command:.*--legacy-peer-deps/);
  assert.match(koyebYaml, /run_command:\s*npm start/);
  assert.match(koyebYaml, /port:\s*3000/);
  assert.match(koyebYaml, /path:\s*\//);
  assert.doesNotMatch(koyebYaml, /path:\s*\/health\b/);
  assert.match(koyebYaml, /instance_types:\s*\n\s*-\s*free/);
  assert.doesNotMatch(koyebYaml, /\bUSER_LID\b/);
  assert.doesNotMatch(koyebYaml, /\bOWNER_NUMBER\b/);

  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /if \[ -f package-lock\.json \]; then npm ci .* else npm install --omit=dev --legacy-peer-deps/);
  assert.match(dockerfile, /EXPOSE 3000 8000/);
  assert.match(dockerfile, /CMD \["node", "index\.js"\]/);

  const npmrc = fs.readFileSync(path.join(ROOT, '.npmrc'), 'utf8');
  assert.match(npmrc, /^legacy-peer-deps=true$/m);

  const procfile = fs.readFileSync(path.join(ROOT, 'Procfile'), 'utf8');
  assert.match(procfile, /^web:\s*node index\.js$/m);

  const envSample = fs.readFileSync(path.join(ROOT, '.env-sample'), 'utf8');
  assert.match(envSample, /Koyeb/);
  assert.equal(/^\s*PORT\s*=/m.test(envSample), false, '.env-sample must keep PORT commented for Koyeb');
  assert.doesNotMatch(envSample, /\bUSER_LID\b/);
  assert.doesNotMatch(envSample, /\bOWNER_NUMBER\b/);

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /app\.koyeb\.com\/deploy/);
  assert.match(readme, /## Koyeb Deployment/);
  assert.doesNotMatch(readme, /\bUSER_LID\b/);
  assert.doesNotMatch(readme, /\bOWNER_NUMBER\b/);
});

test('Koyeb runtime environment variables and DNS hints are detected across modern and legacy detectors', async () => {
  assert.equal(normalizeExplicitHostProvider('koyeb'), 'Koyeb');

  const koyebEnvVariants = [
    { KOYEB: 'true' },
    { KOYEB_ENV: 'prod' },
    { KOYEB_APP_NAME: 'spider-man-md' },
    { KOYEB_SERVICE_ID: 'svc-123' },
    { KOYEB_SERVICE_NAME: 'spider-man-md' },
    { KOYEB_INSTANCE_ID: 'inst-123' },
    { KOYEB_DEPLOYMENT_ID: 'dep-123' },
    { KOYEB_REGIONAL_DEPLOYMENT_ID: 'rdep-123' },
    { KOYEB_INSTANCE_TYPE: 'free' },
    { KOYEB_REGION: 'fra' },
    { KOYEB_DC: 'fra1' },
    { KOYEB_HYPERVISOR_ID: 'hv-123' },
    { KOYEB_ORGANIZATION_ID: 'org-123' },
    { KOYEB_PUBLIC_DOMAIN: 'spider-man.koyeb.app' },
    { KOYEB_GIT_SHA: 'abcdef1234567890' },
    { KOYEB_GIT_BRANCH: 'main' },
    { KOYEB_GIT_REPOSITORY: 'github.com/LilGabrielDev/Spider-Man' },
  ];

  for (const env of koyebEnvVariants) {
    assert.equal(
      detectHostingProvider({ env, probeSystem: false }),
      'Koyeb',
      `Expected Koyeb detection for ${JSON.stringify(env)}`,
    );
  }

  resetHostDetectorCache();
  try {
    const viaNetwork = await detectHostingProviderAsync({
      env: {},
      probeSystem: true,
      probeNetwork: true,
      osImpl: { hostname: () => 'app-1', platform: () => 'linux' },
      fsImpl: makeMockFs({}),
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          success: true,
          ip: '198.51.100.77',
          connection: { org: 'Koyeb SAS', isp: 'Koyeb', domain: 'koyeb.app' },
        }),
      }),
      dnsImpl: { reverse: async () => ['edge-1.koyeb.app'] },
    });
    assert.equal(viaNetwork, 'Koyeb');
  } finally {
    resetHostDetectorCache();
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-koyeb-legacy-'));
  try {
    const script = `
      const assert = require('node:assert/strict');
      const loggerPath = require.resolve('./Spider/legacy/lil/utils/logger.js');
      const gmdPath = require.resolve('./Spider/legacy/lil/gmdFunctions.js');
      const cases = ${JSON.stringify([
        { KOYEB_INSTANCE_ID: 'inst-1' },
        { KOYEB_DEPLOYMENT_ID: 'dep-1' },
        { KOYEB_REGIONAL_DEPLOYMENT_ID: 'rdep-1' },
        { KOYEB_PUBLIC_DOMAIN: 'bot.koyeb.app' },
        { KOYEB_INSTANCE_TYPE: 'free' },
        { KOYEB_REGION: 'was' },
        { KOYEB_GIT_SHA: 'deadbeef' },
      ])};
      const allKeys = Array.from(new Set(cases.flatMap((c) => Object.keys(c))));
      for (const envCase of cases) {
        for (const key of allKeys) delete process.env[key];
        delete process.env.KOYEB;
        delete process.env.KOYEB_ENV;
        delete process.env.KOYEB_SERVICE_NAME;
        delete process.env.KOYEB_SERVICE_ID;
        delete process.env.KOYEB_APP_NAME;
        Object.assign(process.env, envCase);
        delete require.cache[loggerPath];
        const logger = require(loggerPath);
        assert.equal(logger.PLATFORM, 'Koyeb', 'logger mismatch for ' + JSON.stringify(envCase));
        const gmd = require(gmdPath);
        assert.equal(gmd.detectHostEnvironment(), 'koyeb', 'gmd mismatch for ' + JSON.stringify(envCase));
      }
    `;
    const res = spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME || os.tmpdir(),
        TMPDIR: process.env.TMPDIR || os.tmpdir(),
        LIL_DB_PATH: path.join(tmpDir, 'legacy.db'),
        NODE_NO_WARNINGS: '1',
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(
      res.status,
      0,
      `Legacy Koyeb detection failed:\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resourceGuard scopes Koyeb Free (512MB) and Nano (256MB) heap tuning without throttling paid Koyeb instances', () => {
  const MB = 1024 * 1024;

  assert.equal(isKoyebEnvironment({ KOYEB_INSTANCE_ID: 'inst-1' }), true);
  assert.equal(isKoyebEnvironment({ KOYEB_PUBLIC_DOMAIN: 'bot.koyeb.app' }), true);
  assert.equal(isKoyebEnvironment({}), false);

  assert.equal(
    isKoyebFreePlan({
      totalMemBytes: 16_384 * MB,
      env: { KOYEB_INSTANCE_TYPE: 'free', KOYEB_SERVICE_ID: 'svc-1' },
      fsImpl: makeMockFs({}),
    }),
    true,
  );
  assert.equal(
    isKoyebFreePlan({
      totalMemBytes: 16_384 * MB,
      env: { KOYEB_INSTANCE_TYPE: 'nano', KOYEB_SERVICE_ID: 'svc-1' },
      fsImpl: makeMockFs({}),
    }),
    true,
  );
  assert.equal(
    isKoyebFreePlan({
      totalMemBytes: 16_384 * MB,
      env: { KOYEB_SERVICE_ID: 'svc-1' },
      fsImpl: makeMockFs({ '/sys/fs/cgroup/memory.max': String(512 * MB) }),
    }),
    true,
  );
  assert.equal(
    isKoyebFreePlan({
      totalMemBytes: 16_384 * MB,
      env: { KOYEB_INSTANCE_TYPE: 'medium', KOYEB_SERVICE_ID: 'svc-1' },
      fsImpl: makeMockFs({ '/sys/fs/cgroup/memory.max': String(2_048 * MB) }),
    }),
    false,
  );
  assert.equal(
    isKoyebFreePlan({
      totalMemBytes: 512 * MB,
      env: {},
      fsImpl: makeMockFs({ '/sys/fs/cgroup/memory.max': String(512 * MB) }),
    }),
    false,
  );
  assert.equal(
    isKoyebFreePlan({
      totalMemBytes: 4_096 * MB,
      env: { SPIDER_KOYEB_FREE: '1' },
      fsImpl: makeMockFs({}),
    }),
    true,
  );
  assert.equal(
    isKoyebFreePlan({
      totalMemBytes: 512 * MB,
      env: { KOYEB_INSTANCE_TYPE: 'free', SPIDER_KOYEB_FREE: '0' },
      fsImpl: makeMockFs({}),
    }),
    false,
  );

  assert.equal(
    isLowMemoryEnvironment({
      totalMemBytes: 16_384 * MB,
      env: { KOYEB_INSTANCE_TYPE: 'free', KOYEB_SERVICE_ID: 'svc-1' },
      fsImpl: makeMockFs({}),
    }),
    true,
  );
  assert.equal(
    isLowMemoryEnvironment({
      totalMemBytes: 16_384 * MB,
      env: { KOYEB_INSTANCE_TYPE: 'medium', KOYEB_SERVICE_ID: 'svc-1' },
      fsImpl: makeMockFs({ '/sys/fs/cgroup/memory.max': String(2_048 * MB) }),
    }),
    false,
  );

  assert.deepEqual(
    getWorkerMemoryExecArgv({
      totalMemBytes: 16_384 * MB,
      env: { KOYEB_INSTANCE_TYPE: 'nano', KOYEB_SERVICE_ID: 'svc-1' },
      existingExecArgv: [],
      fsImpl: makeMockFs({ '/sys/fs/cgroup/memory.max': String(256 * MB) }),
    }),
    ['--max-old-space-size=144', '--max-semi-space-size=4', '--expose-gc'],
  );
  assert.deepEqual(
    getWorkerMemoryExecArgv({
      totalMemBytes: 16_384 * MB,
      env: { KOYEB_INSTANCE_TYPE: 'free', KOYEB_SERVICE_ID: 'svc-1' },
      existingExecArgv: [],
      fsImpl: makeMockFs({ '/sys/fs/cgroup/memory.max': String(512 * MB) }),
    }),
    ['--max-old-space-size=200', '--max-semi-space-size=4', '--expose-gc'],
  );
  assert.deepEqual(
    getWorkerMemoryExecArgv({
      totalMemBytes: 16_384 * MB,
      env: { KOYEB_INSTANCE_TYPE: 'medium', KOYEB_SERVICE_ID: 'svc-1' },
      existingExecArgv: [],
      fsImpl: makeMockFs({ '/sys/fs/cgroup/memory.max': String(2_048 * MB) }),
    }),
    ['--max-old-space-size=512'],
  );

  const ephemeral = createBaileysCacheStore({ maxEntries: 10, ttlMs: 60_000 });
  const protectedCache = createBaileysCacheStore({ maxEntries: 10, ttlMs: 60_000 });
  ephemeral.set('k1', 'v1');
  protectedCache.set('p1', 'keep');

  let pressureLimitBytes = 0;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-koyeb-cleaner-'));
  const maint = startSessionAndCacheCleaner({
    cwd: tmpDir,
    authDir: path.join(tmpDir, 'auth'),
    caches: [ephemeral],
    protectedCaches: [protectedCache],
    quiet: true,
    intervalMs: 60_000,
    memoryWatchIntervalMs: 0,
    env: { KOYEB_SERVICE_ID: 'svc-1', KOYEB_INSTANCE_TYPE: 'nano', SPIDER_KOYEB_FREE: '1' },
    onMemoryPressure: ({ limitBytes }) => {
      pressureLimitBytes = limitBytes;
    },
  });

  try {
    const res = maint.checkMemoryNow({ force: true });
    assert.equal(res.memoryTrimmed, true);
    assert.ok(pressureLimitBytes > 0 && pressureLimitBytes <= 256 * MB);
    assert.equal(ephemeral.get('k1'), undefined);
    assert.equal(protectedCache.get('p1'), 'keep');
  } finally {
    maint.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('selfUpdater supports KOYEB_GIT_SHA and KOYEB_DEPLOY_HOOK_URL', async () => {
  const sha = 'c'.repeat(40);
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-koyeb-sha-'));
  try {
    assert.equal(
      getCurrentCommitSha({
        rootDir: emptyDir,
        env: { KOYEB_GIT_SHA: sha },
      }),
      sha,
    );
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }

  assert.deepEqual(
    detectHostingEnvironment({ KOYEB_APP_NAME: 'spider-man-md', KOYEB_INSTANCE_ID: 'inst-1' }),
    { mode: 'self', label: 'Koyeb' },
  );

  assert.deepEqual(
    detectHostingEnvironment({
      KOYEB_DEPLOY_HOOK_URL: 'https://app.koyeb.com/v1/services/svc-1/redeploy',
    }),
    {
      mode: 'deploy_hook',
      label: 'Koyeb',
      deployHookUrl: 'https://app.koyeb.com/v1/services/svc-1/redeploy',
    },
  );

  const hookCalls = [];
  const fetchMock = async (url, opts) => {
    if (url.endsWith('/commits/main')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ sha: 'd'.repeat(40), commit: { message: 'Koyeb deploy test' } }),
      };
    }
    if (url.includes('/git/trees/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tree: [
            { path: 'package.json' },
            { path: 'spider/index.js' },
            { path: 'spider/config.js' },
            { path: 'Spider/commands/Admin.js' },
          ],
        }),
      };
    }
    if (url.includes('app.koyeb.com/v1/services/')) {
      hookCalls.push({ url, method: opts?.method });
      return { ok: true, status: 200 };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await runBotUpdate({
    force: true,
    env: {
      KOYEB_SERVICE_ID: 'svc-1',
      KOYEB_DEPLOY_HOOK_URL: 'https://app.koyeb.com/v1/services/svc-1/redeploy',
    },
    fetchImpl: fetchMock,
  });
  assert.equal(result.status, 'deploy_hook_triggered');
  assert.equal(result.host.label, 'Koyeb');
  assert.deepEqual(hookCalls, [
    { url: 'https://app.koyeb.com/v1/services/svc-1/redeploy', method: 'POST' },
  ]);
});

test('Koyeb supervisor/worker boots on PORT, serves / and /health, hydrates SESSION, and .host reports Koyeb', async () => {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-koyeb-boot-'));
  const authDir = path.join(tmpDir, 'auth');
  const dbPath = path.join(tmpDir, 'lil.db');

  const sampleCreds = {
    noiseKey: { private: { type: 'Buffer', data: [1, 2, 3] }, public: { type: 'Buffer', data: [4, 5, 6] } },
    signedIdentityKey: { private: { type: 'Buffer', data: [7, 8, 9] }, public: { type: 'Buffer', data: [10, 11, 12] } },
    signedPreKey: { keyPair: { private: { type: 'Buffer', data: [13] }, public: { type: 'Buffer', data: [14] } }, signature: { type: 'Buffer', data: [15] }, keyId: 1 },
    registrationId: 24680,
    advSecretKey: 'dGVzdA==',
    me: { id: '254700000001:5@s.whatsapp.net', lid: '998877665544@lid' },
    registered: true,
  };
  const base64Session = Buffer.from(JSON.stringify(sampleCreds), 'utf8').toString('base64');

  const child = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SERVER_PORT: '',
      APP_PORT: '',
      KOYEB_APP_NAME: 'spider-man-md',
      KOYEB_SERVICE_ID: 'koyeb-svc-01',
      KOYEB_INSTANCE_ID: 'koyeb-inst-01',
      KOYEB_INSTANCE_TYPE: 'free',
      KOYEB_PUBLIC_DOMAIN: 'spider-man.koyeb.app',
      HOME: tmpDir,
      AUTH_DIR: authDir,
      LIL_DB_PATH: dbPath,
      SESSION: base64Session,
      SESSION_ID: '',
      MODE: 'private',
      AUTO_READ: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    let rootRes = null;
    let healthRes = null;
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        if (res.ok) {
          rootRes = { status: res.status, text: await res.text() };
          const hRes = await fetch(`http://127.0.0.1:${port}/health`);
          healthRes = { status: hRes.status, json: await hRes.json() };
          break;
        }
      } catch {
        // Server still starting
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    assert.ok(rootRes, `Koyeb worker HTTP server did not become ready on PORT=${port}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.text, /Spider Man is Running/i);

    assert.ok(healthRes, 'Expected /health response');
    assert.ok([200, 503].includes(healthRes.status), `Unexpected /health status: ${healthRes.status}`);
    assert.equal(healthRes.json.bot, 'Spider Man');
    assert.equal(healthRes.json.whatsapp, healthRes.status === 200 ? 'connected' : 'disconnected');

    const credsPath = path.join(authDir, 'creds.json');
    assert.equal(fs.existsSync(credsPath), true, 'Expected SESSION env var to hydrate AUTH_DIR/creds.json');
    const persistedCreds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    assert.equal(persistedCreds.registrationId, 24680);

    // Verify .host command reports Koyeb under simulated Koyeb env vars
    const origKoyebSvc = process.env.KOYEB_SERVICE_ID;
    const origKoyebType = process.env.KOYEB_INSTANCE_TYPE;
    process.env.KOYEB_SERVICE_ID = 'koyeb-svc-01';
    process.env.KOYEB_INSTANCE_TYPE = 'free';
    resetHostDetectorCache();
    try {
      const { commands: hostCmds } = await import('../commands/Host.js');
      const hostCmd = hostCmds.find((c) => c.name === 'host');
      assert.ok(hostCmd);
      const sent = [];
      await hostCmd.execute({
        sock: {
          sendMessage: async (jid, payload) => {
            sent.push({ jid, payload });
            return { key: { id: 'koyeb-host-1', remoteJid: jid, fromMe: true } };
          },
        },
        from: '254700000001@s.whatsapp.net',
        text: '',
        msg: { key: { id: 'in-koyeb-host', remoteJid: '254700000001@s.whatsapp.net', fromMe: true } },
      });
      assert.equal(sent.length, 1);
      assert.match(sent[0].payload.text, /Koyeb/);
    } finally {
      if (origKoyebSvc === undefined) delete process.env.KOYEB_SERVICE_ID;
      else process.env.KOYEB_SERVICE_ID = origKoyebSvc;
      if (origKoyebType === undefined) delete process.env.KOYEB_INSTANCE_TYPE;
      else process.env.KOYEB_INSTANCE_TYPE = origKoyebType;
      resetHostDetectorCache();
    }
  } finally {
    child.kill('SIGTERM');
    const exitResult = await new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        resolve({ timeout: true });
      }, 6000);
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    assert.equal(exitResult.code, 0, `Expected clean SIGTERM exit code 0, got ${JSON.stringify(exitResult)}\nSTDERR:\n${stderr}`);
  }
});
