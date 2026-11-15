import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

function runNodeSubprocess(script, extraEnv = {}, execArgs = []) {
  const cleanEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || os.tmpdir(),
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    NODE_NO_WARNINGS: '1',
    ...extraEnv,
  };
  return spawnSync(process.execPath, [...execArgs, '-e', script], {
    cwd: ROOT,
    env: cleanEnv,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('loadLegacyCommands loads >= 40 legacy commands cleanly with zero failures', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-legacy-load-'));
  const origDbPath = process.env.LIL_DB_PATH;
  process.env.LIL_DB_PATH = path.join(tmpDir, 'legacy.db');

  try {
    const { loadLegacyCommands } = await import('../utils/legacyPlugins.js');
    const cmds = await loadLegacyCommands();
    assert.ok(Array.isArray(cmds), 'loadLegacyCommands must return an array');
    assert.ok(cmds.length >= 40, `Expected >= 40 legacy commands, got ${cmds.length}`);
    for (const cmd of cmds) {
      assert.equal(typeof cmd.name, 'string');
      assert.ok(cmd.name.length > 0);
      assert.equal(typeof cmd.execute, 'function');
    }
  } finally {
    if (origDbPath === undefined) delete process.env.LIL_DB_PATH;
    else process.env.LIL_DB_PATH = origDbPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('LIL_DB_PATH isolated temp DB init/CRUD works across lil DB modules and sqliteCompat fallback', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-db-crud-'));
  try {
    const dbPath = path.join(tmpDir, 'isolated-lil.db');
    const cjsResult = runNodeSubprocess(
      `
      const assert = require('node:assert/strict');
      const path = require('node:path');
      const { initializeSettings, getSetting, setSetting } = require('./Spider/legacy/lil/database/settings.js');
      const { setCommitHash, getCommitHash } = require('./Spider/legacy/lil/database/autoUpdate.js');
      const { SQLiteStore } = require('./Spider/legacy/lil/database/messageStore.js');
      const { openSqliteCompat } = require('./Spider/legacy/lilgabriel/lib/sqliteCompat.js');

      (async () => {
        await initializeSettings();
        await setSetting('TEST_KEY', 'spider_ok');
        assert.equal(await getSetting('TEST_KEY'), 'spider_ok');

        await setCommitHash('abc1234');
        assert.equal(await getCommitHash(), 'abc1234');

        const store = new SQLiteStore(path.join(${JSON.stringify(tmpDir)}, 'msg-store.db'));
        store.saveMessage('12345@s.whatsapp.net', { key: { id: 'm1', remoteJid: '12345@s.whatsapp.net' }, message: { conversation: 'hi' } });
        const loaded = store.loadMessage('12345@s.whatsapp.net', 'm1');
        assert.equal(loaded?.message?.conversation, 'hi');
        store.destroy?.();

        const compat = openSqliteCompat(path.join(${JSON.stringify(tmpDir)}, 'compat.db'));
        compat.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
        compat.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('a', '1');
        const row = compat.prepare('SELECT v FROM kv WHERE k = ?').get('a');
        assert.equal(row?.v, '1');
        compat.close?.();
        process.exit(0);
      })().catch((err) => { console.error(err); process.exit(1); });
      `,
      { LIL_DB_PATH: dbPath },
    );
    assert.equal(
      cjsResult.status,
      0,
      `DB CRUD subprocess failed:\nSTDOUT:\n${cjsResult.stdout}\nSTDERR:\n${cjsResult.stderr}`,
    );

    // Verify JSON fallback in sqliteCompat when better-sqlite3 is blocked
    const fallbackResult = runNodeSubprocess(
      `
      const Module = require('node:module');
      const origLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === 'better-sqlite3' || request === 'sqlite3') {
          const err = new Error("Cannot find module '" + request + "'");
          err.code = 'MODULE_NOT_FOUND';
          throw err;
        }
        return origLoad.apply(this, arguments);
      };
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const { openSqliteCompat } = require('./Spider/legacy/lilgabriel/lib/sqliteCompat.js');
      const compatPath = path.join(${JSON.stringify(tmpDir)}, 'json-fallback.db');
      const db = openSqliteCompat(compatPath);
      db.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, val TEXT)');
      db.prepare('INSERT OR REPLACE INTO items (id, val) VALUES (?, ?)').run('x', '42');
      assert.equal(db.prepare('SELECT val FROM items WHERE id = ?').get('x')?.val, '42');
      assert.equal(fs.existsSync(compatPath + '.json'), true);
      `,
    );
    assert.equal(
      fallbackResult.status,
      0,
      `sqliteCompat JSON fallback failed:\nSTDOUT:\n${fallbackResult.stdout}\nSTDERR:\n${fallbackResult.stderr}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CJS and ESM modules load cleanly even when optional dependencies throw MODULE_NOT_FOUND', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-optdeps-'));
  try {
    const blocked = [
      'sharp',
      'fluent-ffmpeg',
      'ffmpeg-static',
      'google-tts-api',
      'wa-sticker-formatter',
      'better-sqlite3',
      'sqlite3',
      'jimp',
      'youtube-dl-exec',
      'acrcloud',
    ];

    const cjsProbe = runNodeSubprocess(
      `
      const Module = require('node:module');
      const blocked = new Set(${JSON.stringify(blocked)});
      const origLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        if (blocked.has(request)) {
          const err = new Error("Cannot find module '" + request + "'");
          err.code = 'MODULE_NOT_FOUND';
          throw err;
        }
        return origLoad.apply(this, arguments);
      };
      const assert = require('node:assert/strict');
      const cjsModules = [
        './Spider/legacy/lil/index.js',
        './Spider/legacy/lil/gmdFunctions.js',
        './Spider/legacy/lil/gmdFunctions2.js',
        './Spider/legacy/lil/handlers/connection.js',
        './Spider/legacy/lil/handlers/message.js',
        './Spider/legacy/lilgabriel/ai.js',
        './Spider/legacy/lilgabriel/converter.js',
      ];
      for (const modPath of cjsModules) {
        require(modPath);
      }

      const lilMod = require('./Spider/legacy/lil/index.js');
      const capturedCmds = [];
      lilMod.gmd = (meta, handler) => capturedCmds.push({ meta, handler });
      const aiResolved = require.resolve('./Spider/legacy/lilgabriel/ai.js');
      delete require.cache[aiResolved];
      require('./Spider/legacy/lilgabriel/ai.js');
      const ttsPlugin = capturedCmds.find((c) => c.meta?.pattern === 'tts');
      const explainPlugin = capturedCmds.find((c) => c.meta?.pattern === 'explain');
      assert.ok(ttsPlugin && explainPlugin);

      (async () => {
        const replies = [];
        await ttsPlugin.handler('123@s.whatsapp.net', { sendMessage: async () => {} }, {
          reply: async (t) => replies.push(t),
          react: async () => {},
          q: 'hello world',
          botName: 'Spider',
        });
        assert.match(replies[0], /unavailable on this deployment/i);

        // Mock axios.get so explain reaches googleTTS check deterministically
        const axios = require('axios');
        axios.get = async (url) => {
          if (String(url).includes('pollinations')) {
            return { data: 'This is a plain spoken summary of the sample webpage with more than twenty characters.' };
          }
          return { data: '<html><body><p>Sample webpage content with enough readable words for extraction test.</p></body></html>' };
        };
        await explainPlugin.handler('123@s.whatsapp.net', { sendMessage: async () => {} }, {
          reply: async (t) => replies.push(t),
          react: async () => {},
          q: 'https://example.com/article',
          botName: 'Spider',
        });
        assert.match(replies[1], /unavailable on this deployment/i);

        const gmd = require('./Spider/legacy/lil/gmdFunctions.js');
        await assert.rejects(() => gmd.stickerToImage(Buffer.from('webp')), /sharp is unavailable/i);
      })().catch((e) => { console.error(e); process.exit(1); });
      `,
      { LIL_DB_PATH: path.join(tmpDir, 'opt-cjs.db') },
    );
    assert.equal(
      cjsProbe.status,
      0,
      `CJS optional-dep guard check failed:\nSTDOUT:\n${cjsProbe.stdout}\nSTDERR:\n${cjsProbe.stderr}`,
    );

    const hookSource = `
      const blocked = new Set(${JSON.stringify(blocked)});
      export async function resolve(specifier, context, nextResolve) {
        if (blocked.has(specifier)) {
          const err = new Error("Cannot find package '" + specifier + "'");
          err.code = 'ERR_MODULE_NOT_FOUND';
          throw err;
        }
        return nextResolve(specifier, context);
      }
    `;
    const hookUrl = `data:text/javascript;base64,${Buffer.from(hookSource).toString('base64')}`;
    const registerSource = `
      import { register } from 'node:module';
      register(${JSON.stringify(hookUrl)});
    `;
    const registerUrl = `data:text/javascript;base64,${Buffer.from(registerSource).toString('base64')}`;

    const esmProbe = runNodeSubprocess(
      `
      import assert from 'node:assert/strict';
      const modules = [
        './Spider/commands/Convertor.js',
        './Spider/commands/Fun.js',
        './Spider/commands/Search.js',
        './Spider/commands/Download.js',
        './Spider/commands/Url.js',
        './Spider/legacy/lilgabriel/plugins/Editing/sticker.js',
      ];
      for (const m of modules) {
        await import(m);
      }
      assert.ok(true);
      `,
      { LIL_DB_PATH: path.join(tmpDir, 'opt-esm.db') },
      ['--input-type=module', '--import', registerUrl],
    );
    assert.equal(
      esmProbe.status,
      0,
      `ESM optional-dep guard check failed:\nSTDOUT:\n${esmProbe.stdout}\nSTDERR:\n${esmProbe.stderr}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadSession rejects cleanly when SESSION_ID is empty on non-TTY / cloud hosts without hanging', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-loadsession-'));
  try {
    const res = runNodeSubprocess(
      `
      const assert = require('node:assert/strict');
      const gmd = require('./Spider/legacy/lil/gmdFunctions.js');
      (async () => {
        await assert.rejects(() => gmd.loadSession(), /SESSION_ID is required/i);
      })().catch((e) => { console.error(e); process.exit(1); });
      `,
      { SESSION_ID: '', RAILWAY_PROJECT_ID: 'rail-test', SESSION_DIR: tmpDir },
    );
    assert.equal(
      res.status,
      0,
      `loadSession subprocess failed:\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createSecurityStore().audit handles read-only and unwritable directories without throwing', async () => {
  const { createSecurityStore } = await import('../../spider/utils/securityStore.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-sec-ro-'));
  const readOnlyDir = path.join(tmpDir, 'ro-parent');
  const blockerFile = path.join(tmpDir, 'not-a-directory');

  try {
    fs.mkdirSync(readOnlyDir, { recursive: true });
    fs.chmodSync(readOnlyDir, 0o555);
    fs.writeFileSync(blockerFile, 'file');

    const roStore = createSecurityStore(path.join(readOnlyDir, 'nested', 'state.json'));
    assert.doesNotThrow(() => {
      roStore.audit({ event: 'ro_test', actor: 'tester', detail: 'chmod 555 parent' });
    });

    // Even when running as root (where chmod 555 may still be writable), a file-as-parent guarantees ENOTDIR
    const enotdirStore = createSecurityStore(path.join(blockerFile, 'nested', 'state.json'));
    assert.doesNotThrow(() => {
      enotdirStore.audit({ event: 'enotdir_test', actor: 'tester', detail: 'file parent' });
    });
  } finally {
    try {
      fs.chmodSync(readOnlyDir, 0o755);
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('saveMediaToTemp falls back to os.tmpdir when cwd/temp cannot be written', async (t) => {
  const { saveMediaToTemp } = await import('../commands/Url.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-url-ro-'));
  const blockerFile = path.join(tmpDir, 'blocker');
  fs.writeFileSync(blockerFile, 'not a dir');
  t.mock.method(process, 'cwd', () => blockerFile);

  let savedPath = null;
  try {
    const mockDownload = async function* () {
      yield Buffer.from('hello-spider');
    };
    savedPath = await saveMediaToTemp({ fake: true }, 'image', mockDownload);
    assert.ok(savedPath.startsWith(path.join(os.tmpdir(), 'spider-temp')), `Expected fallback path in os.tmpdir, got ${savedPath}`);
    assert.equal(fs.readFileSync(savedPath, 'utf8'), 'hello-spider');
  } finally {
    if (savedPath && fs.existsSync(savedPath)) {
      fs.rmSync(savedPath, { force: true });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('@ffmpeg-installer/ffmpeg binary exists and runs -version cleanly', () => {
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  assert.equal(typeof ffmpegInstaller.path, 'string');
  assert.equal(fs.existsSync(ffmpegInstaller.path), true, `Missing ffmpeg binary at ${ffmpegInstaller.path}`);
  const out = execFileSync(ffmpegInstaller.path, ['-version'], { encoding: 'utf8', timeout: 10_000 });
  assert.match(out, /ffmpeg version/i);
});

test('Port precedence (PORT > SERVER_PORT > APP_PORT > 3000) works in both spider/config.js and legacy settings.js', () => {
  const cases = [
    { env: { PORT: '4101', SERVER_PORT: '4102', APP_PORT: '4103' }, expected: 4101 },
    { env: { SERVER_PORT: '4202', APP_PORT: '4203' }, expected: 4202 },
    { env: { APP_PORT: '4303' }, expected: 4303 },
    { env: {}, expected: 3000 },
  ];

  for (const tc of cases) {
    const res = runNodeSubprocess(
      `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const { default: spiderConfig } = await import('./spider/config.js');
      const legacyConfig = require('./Spider/legacy/lil/config/settings.js');
      assert.equal(spiderConfig.PORT, ${tc.expected});
      assert.equal(legacyConfig.PORT, ${tc.expected});
      `,
      tc.env,
      ['--input-type=module'],
    );
    assert.equal(
      res.status,
      0,
      `Port precedence failed for ${JSON.stringify(tc)}:\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`,
    );
  }
});

test('All hosting providers detect cleanly across hostDetector.js, legacy logger.js, and gmdFunctions.js', async () => {
  const { detectHostingProvider } = await import('../../spider/utils/hostDetector.js');

  const cases = [
    { env: { KATABUMP: '1' }, detector: 'Katabump', logger: 'Katabump', gmd: 'katabump' },
    { env: { KATABUMP_SERVER: '1' }, detector: 'Katabump', logger: 'Katabump', gmd: 'katabump' },
    { env: { BOT_HOSTING: '1' }, detector: 'Bot-Hosting', logger: 'Bot-Hosting', gmd: 'bot-hosting' },
    { env: { OPTIKLINK: '1' }, detector: 'Optiklink', logger: 'Optiklink', gmd: 'optiklink' },
    { env: { CYBRANCEE: '1' }, detector: 'Cybrancee', logger: 'Cybrancee', gmd: 'cybrancee' },
    { env: { PELLA: '1' }, detector: 'Pella', logger: 'Pella', gmd: 'pella' },
    { env: { SOLARHOSTING: '1' }, detector: 'SolarHosting', logger: 'SolarHosting', gmd: 'solarhosting' },
    { env: { WITHERHOSTING: '1' }, detector: 'WitherHosting', logger: 'WitherHosting', gmd: 'witherhosting' },
    { env: { BISECTHOSTING: '1' }, detector: 'BisectHosting', logger: 'BisectHosting', gmd: 'bisecthosting' },
    { env: { FALIXNODES: '1' }, detector: 'FalixNodes', logger: 'FalixNodes', gmd: 'falixnodes' },
    { env: { P_SERVER_UUID: 'srv-1' }, detector: 'Pterodactyl Panel', logger: 'Panel', gmd: 'pterodactyl' },
    { env: { DYNO: 'web.1' }, detector: 'Heroku', logger: 'Heroku', gmd: 'heroku' },
    { env: { RAILWAY_PROJECT_ID: 'proj-1' }, detector: 'Railway', logger: 'Railway', gmd: 'railway' },
    { env: { RENDER: 'true' }, detector: 'Render', logger: 'Render', gmd: 'render' },
    { env: { KOYEB_SERVICE_NAME: 'svc-1' }, detector: 'Koyeb', logger: 'Koyeb', gmd: 'koyeb' },
    { env: { FLY_APP_NAME: 'fly-1' }, detector: 'Fly', logger: 'Fly.io', gmd: 'fly' },
    { env: { REPL_ID: 'repl-1' }, detector: 'Replit', logger: 'Replit', gmd: 'replit' },
    { env: { PROJECT_DOMAIN: 'glitch-1' }, detector: 'Glitch', logger: 'Glitch', gmd: 'glitch' },
    { env: { VERCEL: '1' }, detector: 'Vercel', logger: 'Vercel', gmd: 'vercel' },
    { env: { AWS_LAMBDA_FUNCTION_NAME: 'fn-1' }, detector: 'AWS Lambda', logger: 'AWS', gmd: 'aws' },
    { env: { ECS_CONTAINER_METADATA_URI: 'http://169.254.170.2/v3' }, detector: 'AWS ECS', logger: 'AWS', gmd: 'aws' },
    { env: { K_SERVICE: 'svc-1' }, detector: 'Google Cloud Run', logger: 'Google Cloud', gmd: 'gcp' },
    { env: { WEBSITE_INSTANCE_ID: 'az-1' }, detector: 'Azure', logger: 'Azure', gmd: 'azure' },
    { env: { DIGITALOCEAN_APP_ID: 'do-1' }, detector: 'DigitalOcean', logger: 'DigitalOcean', gmd: 'digitalocean' },
    { env: { ORACLE_CLOUD_REGION: 'us-ashburn-1' }, detector: 'Oracle Cloud', logger: 'Oracle Cloud', gmd: 'oracle' },
    { env: { CODESPACES: 'true' }, detector: 'GitHub Codespaces', logger: 'GitHub Codespaces', gmd: 'codespaces' },
    { env: { GITHUB_ACTIONS: 'true' }, detector: 'GitHub Actions', logger: 'GitHub Actions', gmd: 'github-actions' },
    { env: { TERMUX_VERSION: '0.118.0' }, detector: 'Termux', logger: 'Termux', gmd: 'termux' },
  ];

  for (const tc of cases) {
    assert.equal(detectHostingProvider({ env: tc.env, probeSystem: false }), tc.detector);
  }

  // Docker probe in hostDetector
  assert.equal(
    detectHostingProvider({
      env: {},
      probeSystem: true,
      osImpl: { hostname: () => 'docker-node', platform: () => 'linux' },
      fsImpl: { existsSync: (p) => p === '/.dockerenv', readFileSync: () => '' },
      networkHint: null,
    }),
    'Docker',
  );

  // Batch-verify logger.js and gmdFunctions.js in subprocesses (so each test has a clean process.env)
  const batchScript = `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const loggerPath = require.resolve('./Spider/legacy/lil/utils/logger.js');
    const gmdPath = require.resolve('./Spider/legacy/lil/gmdFunctions.js');
    const cases = ${JSON.stringify(cases)};
    const managedKeys = Array.from(new Set(cases.flatMap((c) => Object.keys(c.env))));

    for (const tc of cases) {
      for (const k of managedKeys) delete process.env[k];
      delete process.env.HOST_PROVIDER;
      delete process.env.HOSTING_PROVIDER;
      delete process.env.SERVER_PORT;
      delete process.env.HOSTNAME;
      delete process.env.PANEL;
      delete process.env.ECS_CONTAINER_METADATA_URI_V4;
      Object.assign(process.env, tc.env);

      delete require.cache[loggerPath];
      const logger = require(loggerPath);
      assert.equal(logger.PLATFORM, tc.logger, 'logger PLATFORM mismatch for ' + JSON.stringify(tc.env));

      const gmd = require(gmdPath);
      assert.equal(gmd.detectHostEnvironment(), tc.gmd, 'gmdFunctions mismatch for ' + JSON.stringify(tc.env));
    }
  `;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-hosts-'));
  try {
    const res = runNodeSubprocess(batchScript, { LIL_DB_PATH: path.join(tmpDir, 'hosts.db') });
    assert.equal(
      res.status,
      0,
      `Host detection batch failed:\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
