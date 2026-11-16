import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  installSocketResilience,
  countLocalPreKeyFiles,
} from '../../spider/utils/socketResilience.js';
import {
  detectHostingProvider,
  detectHostingProviderAsync,
  resetHostDetectorCache,
} from '../../spider/utils/hostDetector.js';
import { getWorkerMemoryExecArgv } from '../../spider/utils/resourceGuard.js';
import { reloadCommandsFromDisk } from '../../spider/utils/runtimeControl.js';
import { loadLegacyCommands } from '../utils/legacyPlugins.js';

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

function createEmitter() {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    emit(event, payload) {
      for (const fn of listeners.get(event) || []) {
        fn(payload);
      }
    },
    removeAllListeners(event) {
      if (event) listeners.delete(event);
      else listeners.clear();
    },
  };
}

test('Katabump panel supervisor/worker boots on SERVER_PORT, hydrates SESSION creds.json, serves HTTP endpoints, and exits cleanly on SIGTERM', async () => {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-katabump-boot-'));
  const authDir = path.join(tmpDir, 'auth');
  const dbPath = path.join(tmpDir, 'lil.db');

  // Deliberately omit creds.me.name and pre-key files to mimic a fresh Katabump SESSION env var deploy
  const sampleCreds = {
    noiseKey: { private: { type: 'Buffer', data: [1, 2, 3] }, public: { type: 'Buffer', data: [4, 5, 6] } },
    signedIdentityKey: { private: { type: 'Buffer', data: [7, 8, 9] }, public: { type: 'Buffer', data: [10, 11, 12] } },
    signedPreKey: { keyPair: { private: { type: 'Buffer', data: [13] }, public: { type: 'Buffer', data: [14] } }, signature: { type: 'Buffer', data: [15] }, keyId: 1 },
    registrationId: 12345,
    advSecretKey: 'dGVzdA==',
    nextPreKeyId: 50,
    firstUnuploadedPreKeyId: 1,
    me: { id: '254700000001:5@s.whatsapp.net', lid: '998877665544@lid' },
    registered: true,
  };
  const base64Session = Buffer.from(JSON.stringify(sampleCreds), 'utf8').toString('base64');

  const childEnv = {
    ...process.env,
    PORT: '',
    APP_PORT: '',
    SERVER_PORT: String(port),
    SERVER_MEMORY: '512',
    P_SERVER_UUID: 'kata-panel-uuid-01',
    P_SERVER_LOCATION: 'eu-katabump-1',
    KATABUMP: '1',
    USER: 'container',
    HOME: tmpDir,
    AUTH_DIR: authDir,
    LIL_DB_PATH: dbPath,
    SESSION: base64Session,
    SESSION_ID: '',
    MODE: 'private',
    AUTO_READ: 'off',
  };

  const child = spawn(process.execPath, ['index.js'], {
    cwd: process.cwd(),
    env: childEnv,
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

    assert.ok(rootRes, `Katabump worker HTTP server did not become ready on SERVER_PORT=${port}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.text, /Spider Man is Running/i);

    assert.ok(healthRes, 'Expected /health response');
    assert.ok([200, 503].includes(healthRes.status), `Unexpected /health status: ${healthRes.status}`);
    assert.equal(healthRes.json.bot, 'Spider Man');
    assert.equal(healthRes.json.whatsapp, healthRes.status === 200 ? 'connected' : 'disconnected');

    const credsPath = path.join(authDir, 'creds.json');
    assert.equal(fs.existsSync(credsPath), true, 'Expected SESSION env var to hydrate AUTH_DIR/creds.json');
    const persistedCreds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    assert.equal(persistedCreds.registrationId, 12345);
    assert.equal(persistedCreds.me.id, '254700000001:5@s.whatsapp.net');
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

test('Katabump panel host detection, container memory sizing, and .host command report Katabump cleanly', async () => {
  resetHostDetectorCache();

  assert.equal(
    detectHostingProvider({
      env: { P_SERVER_UUID: 'kata-1', KATABUMP: '1', USER: 'container', HOME: '/home/container' },
      probeSystem: false,
    }),
    'Katabump',
  );

  const detectedViaPtr = await detectHostingProviderAsync({
    env: { P_SERVER_UUID: 'kata-2', SERVER_PORT: '25565', USER: 'container', HOME: '/home/container' },
    probeSystem: true,
    probeNetwork: true,
    osImpl: { hostname: () => 'container-node', platform: () => 'linux' },
    fsImpl: {
      existsSync: (p) => p === '/home/container',
      readFileSync: () => '',
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        success: true,
        ip: '198.51.100.42',
        connection: { org: 'OVH SAS', isp: 'OVHcloud', domain: 'ovh.net' },
      }),
    }),
    dnsImpl: { reverse: async () => ['node4.katabump.com'] },
  });
  assert.equal(detectedViaPtr, 'Katabump');

  // Katabump 256MB & 512MB container memory flags
  const MB = 1024 * 1024;
  assert.deepEqual(
    getWorkerMemoryExecArgv({
      totalMemBytes: 16_384 * MB,
      env: {},
      existingExecArgv: [],
      fsImpl: {
        existsSync: (p) => p === '/sys/fs/cgroup/memory.max',
        readFileSync: () => String(256 * MB),
      },
    }),
    ['--max-old-space-size=166'],
  );

  // Execute .host command under simulated Katabump container env
  const origKatabump = process.env.KATABUMP;
  process.env.KATABUMP = '1';
  try {
    const { commands: hostCmds } = await import('../commands/Host.js');
    const hostCmd = hostCmds.find((c) => c.name === 'host');
    assert.ok(hostCmd);

    const sent = [];
    await hostCmd.execute({
      sock: {
        sendMessage: async (jid, payload) => {
          sent.push({ jid, payload });
          return { key: { id: 'host-1', remoteJid: jid, fromMe: true } };
        },
      },
      from: '254700000001@s.whatsapp.net',
      text: '',
      msg: { key: { id: 'in-host', remoteJid: '254700000001@s.whatsapp.net', fromMe: true } },
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].payload.text, /Katabump/);
  } finally {
    if (origKatabump === undefined) delete process.env.KATABUMP;
    else process.env.KATABUMP = origKatabump;
    resetHostDetectorCache();
  }
});

test('Katabump fresh SESSION container replenishes pre-keys past MIN_UPLOAD_INTERVAL, sends active online presence (2nd tick), and executes ". Menu" with local image fallback', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-katabump-flow-'));
  const origBotPic = (await import('../../spider/config.js')).default.BOT_PIC;
  const origAutoRead = (await import('../../spider/config.js')).default.AUTO_READ;
  const { default: config } = await import('../../spider/config.js');

  try {
    // 1. Fresh Katabump auth dir right after Baileys CB:success uploaded initial 5 pre-keys
    for (let i = 50; i <= 54; i += 1) {
      fs.writeFileSync(path.join(tmpDir, `pre-key-${i}.json`), '{}');
    }

    const ev = createEmitter();
    const presenceLog = [];
    const uploadedCounts = [];
    let withinMinUploadInterval = true;

    const sock = {
      ev,
      user: { id: '254700000001:5@s.whatsapp.net', lid: '998877665544@lid' },
      authState: {
        creds: {
          nextPreKeyId: 55,
          me: { id: '254700000001:5@s.whatsapp.net', lid: '998877665544@lid', name: '' },
        },
        keys: {
          get: async (_type, ids) => Object.fromEntries(ids.map((id) => [id, id === '54' ? {} : null])),
          set: async (data) => {
            if (data?.['pre-key']) {
              for (const [id, val] of Object.entries(data['pre-key'])) {
                fs.writeFileSync(path.join(tmpDir, `pre-key-${id}.json`), JSON.stringify(val));
              }
            }
          },
        },
      },
      uploadPreKeys: async (count) => {
        uploadedCounts.push({ count, throttled: withinMinUploadInterval });
        if (withinMinUploadInterval) return;
        const batch = {};
        const start = sock.authState.creds.nextPreKeyId;
        for (let i = 0; i < count; i += 1) {
          batch[String(start + i)] = { keyPair: {} };
        }
        await sock.authState.keys.set({ 'pre-key': batch });
        sock.authState.creds.nextPreKeyId = start + count;
      },
      sendPresenceUpdate: async (type, toJid) => {
        if ((type === 'available' || type === 'unavailable') && !sock.authState.creds.me?.name) {
          return;
        }
        presenceLog.push({ type, toJid, meName: sock.authState.creds.me?.name });
      },
      signalRepository: {
        lidMapping: { getLIDsForPNs: async () => [] },
      },
      query: async () => ({ tag: 'iq', attrs: { type: 'result' }, content: [] }),
      sendMessage: async (jid, payload) => {
        if (payload?.image?.url) {
          throw new Error('Remote BOT_PIC unreachable on Katabump egress');
        }
        sentMenuPayloads.push({ jid, payload });
        return { key: { id: `menu-${sentMenuPayloads.length}`, remoteJid: jid, fromMe: true } };
      },
    };

    const sentMenuPayloads = [];
    installSocketResilience(sock, {
      authDir: tmpDir,
      defaultPushName: 'Spider Man',
      preKeyRetryDelayMs: 30,
      logInfo: () => {},
    });

    // Simulate connection opening right inside Baileys' 5000ms uploadPreKeys cooldown
    ev.emit('connection.update', { connection: 'open' });
    await new Promise((r) => setTimeout(r, 15));

    // Presence resilience ensured creds.me.name + unavailable presence by default (bot stays offline unless ALWAYS_ONLINE=on)
    assert.equal(sock.authState.creds.me.name, 'Spider Man');
    assert.equal(presenceLog.some((p) => p.type === 'unavailable' && p.meName === 'Spider Man'), true);
    assert.equal(presenceLog.some((p) => p.type === 'available'), false);
    assert.equal(config.AUTO_READ, false);
    assert.equal(config.ALWAYS_ONLINE, false);

    // Cooldown clears; retry replenishes 50 pre-keys
    withinMinUploadInterval = false;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(uploadedCounts.length, 2);
    assert.equal(countLocalPreKeyFiles(tmpDir), 55);
    assert.equal(sock.authState.creds.nextPreKeyId, 105);

    // Load commands and execute ". Menu" (with space + uppercase M)
    const commandsMap = new Map();
    const aliasesMap = new Map();
    await reloadCommandsFromDisk({
      commandsDir: path.join(process.cwd(), 'Spider', 'commands'),
      commandsMap,
      aliasesMap,
      loadLegacyFn: loadLegacyCommands,
      pathToFileUrlFn: pathToFileURL,
      cacheBust: 999123,
    });

    const trimmed = ' . Menu'.trimStart();
    const prefix = config.PREFIXES.find((p) => trimmed.startsWith(p));
    assert.equal(prefix, '.');
    const [rawCmd, ...args] = trimmed.slice(prefix.length).trim().split(/\s+/);
    const resolvedName = aliasesMap.get(rawCmd.toLowerCase()) || rawCmd.toLowerCase();
    assert.equal(resolvedName, 'menu');

    const menuCmd = commandsMap.get(resolvedName);
    await menuCmd.execute({
      sock,
      from: '254700000001@s.whatsapp.net',
      sender: '254700000001@s.whatsapp.net',
      senderNumber: '254700000001',
      args,
      text: args.join(' '),
      commands: commandsMap,
      commandAliases: aliasesMap,
      config,
      global,
      isOwner: true,
      msg: {
        key: { id: 'kata-in-1', remoteJid: '254700000001@s.whatsapp.net', fromMe: true },
        pushName: 'Owner',
        message: { conversation: '. Menu' },
      },
    });

    assert.ok(sentMenuPayloads.length >= 1, 'Expected . Menu to reply on Katabump');
    assert.equal(Buffer.isBuffer(sentMenuPayloads[0].payload.image), true, 'Expected fallback to local spider-man.jpg buffer when remote BOT_PIC fails');
    const fullText = sentMenuPayloads.map((m) => m.payload.caption || m.payload.text || '').join('\n');
    assert.match(fullText, /SYSTEM MENU/);

    ev.emit('connection.update', { connection: 'close' });
  } finally {
    config.BOT_PIC = origBotPic;
    config.AUTO_READ = origAutoRead;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
