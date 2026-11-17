import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MAX_BIO_LENGTH,
  MAX_SAVED_BIOS,
  PRESET_AUTOBIOS,
  applyProfileBio,
  buildDynamicBio,
  createAutobioManager,
  createAutobioStore,
  defaultAutobioManager,
  defaultAutobioStore,
  expandBioPlaceholders,
  parseAutobioInterval,
  sanitizeBioText,
} from '../../spider/utils/autobioStore.js';
import { reloadCommandsFromDisk } from '../../spider/utils/runtimeControl.js';
import { commands as userCommands } from '../commands/User.js';

function createTempDir(prefix = 'spider-autobio-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMockSock() {
  const statusUpdates = [];
  const messages = [];
  const queries = [];
  const sock = {
    user: { id: '254700000001@s.whatsapp.net' },
    ws: { isClosed: false, readyState: 1 },
    async updateProfileStatus(bio) {
      statusUpdates.push(bio);
      return undefined;
    },
    async query(stanza) {
      queries.push(stanza);
      return { attrs: { type: 'result' } };
    },
    async sendMessage(jid, content, opts) {
      messages.push({ jid, content, opts });
      return { key: { id: `msg-${messages.length}` } };
    },
  };
  return { sock, statusUpdates, messages, queries };
}

test('autobio helpers sanitize length (139 chars), parse intervals, and expand placeholders', () => {
  const longText = `${'A'.repeat(160)}\n\n   extra`;
  const clean = sanitizeBioText(longText);
  assert.equal(clean.truncated, true);
  assert.equal(clean.text.length, MAX_BIO_LENGTH);

  assert.equal(parseAutobioInterval('30s'), 30_000);
  assert.equal(parseAutobioInterval('5m'), 300_000);
  assert.equal(parseAutobioInterval('1h'), 3_600_000);
  assert.equal(parseAutobioInterval('5s'), 15_000); // clamped to min 15s
  assert.equal(parseAutobioInterval('60'), 60_000);
  assert.equal(parseAutobioInterval('abc'), null);

  const nowMs = Date.UTC(2026, 4, 10, 12, 30, 0);
  const startTimeMs = nowMs - 3_665_000; // 1h 1m 5s
  const expanded = expandBioPlaceholders('{bot} • Up {uptime} • {time} • {date}', {
    botName: 'Spider Test',
    tz: 'UTC',
    startTimeMs,
    nowMs,
  });
  assert.match(expanded, /^Spider Test • Up 1h 1m • 12:30 • /);

  const dynamic = buildDynamicBio({
    botName: 'Spider Test',
    tz: 'UTC',
    startTimeMs,
    nowMs,
    index: 0,
    externalFact: '',
  });
  assert.ok(dynamic.includes('Spider Test'));
  assert.ok(dynamic.length <= MAX_BIO_LENGTH);
});

test('autobioStore persists bios, rotation index, and env seeding while respecting manual disable', () => {
  const dir = createTempDir();
  const filePath = path.join(dir, 'autobio.json');
  try {
    const store1 = createAutobioStore(filePath, {
      env: {
        AUTO_BIO: 'on',
        AUTO_BIO_TEXT: 'Bio One | Bio Two',
        AUTO_BIO_INTERVAL_MS: '45000',
      },
    });
    const initial = store1.getState();
    assert.equal(initial.enabled, true);
    assert.deepEqual(initial.bios, ['Bio One', 'Bio Two']);
    assert.equal(initial.intervalMs, 45_000);

    store1.addBio('Bio Three');
    store1.setEnabled(false);

    // Reload from disk even with AUTO_BIO=on in env — persisted enabled=false wins
    const store2 = createAutobioStore(filePath, {
      env: { AUTO_BIO: 'on', AUTO_BIO_TEXT: 'Ignored Override' },
    });
    const reloaded = store2.getState();
    assert.equal(reloaded.enabled, false);
    assert.deepEqual(reloaded.bios, ['Bio One', 'Bio Two', 'Bio Three']);

    const rem = store2.removeBio(2);
    assert.equal(rem.ok, true);
    assert.equal(rem.removed, 'Bio Two');
    assert.deepEqual(store2.getState().bios, ['Bio One', 'Bio Three']);

    store2.clearBios();
    assert.deepEqual(store2.getState().bios, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autobioManager updates WhatsApp About immediately on enable/add/set, rotates on ticks, and follows socket reconnects', async () => {
  const dir = createTempDir();
  const filePath = path.join(dir, 'autobio.json');
  const store = createAutobioStore(filePath, { env: {} });

  const sock1Wrap = createMockSock();
  const sock2Wrap = createMockSock();
  let activeSock = sock1Wrap.sock;

  const manager = createAutobioManager({
    store,
    getSock: () => activeSock,
    getBotName: () => 'Spider Man',
    getTimezone: () => 'UTC',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });

  try {
    // Enabling with no custom bios falls back cleanly to dynamic bio even when external fetch fails
    const enableRes = await manager.enable();
    assert.equal(enableRes.ok, true);
    assert.equal(enableRes.updated, true);
    assert.equal(sock1Wrap.statusUpdates.length, 1);
    assert.ok(sock1Wrap.statusUpdates[0].includes('Spider Man'));

    // Adding a bio immediately sets WhatsApp About to that bio
    const add1 = await manager.addAndApply('Always Online ⚡');
    assert.equal(add1.ok, true);
    assert.equal(add1.updated, true);
    assert.equal(add1.bio, 'Always Online ⚡');
    assert.equal(sock1Wrap.statusUpdates.at(-1), 'Always Online ⚡');

    const add2 = await manager.addAndApply('Coding Mode 💻');
    assert.equal(add2.ok, true);
    assert.equal(add2.bio, 'Coding Mode 💻');
    assert.equal(sock1Wrap.statusUpdates.at(-1), 'Coding Mode 💻');

    // Simulate reconnect with a fresh socket
    activeSock = sock2Wrap.sock;
    const syncRes = await manager.syncOnConnect({ sock: sock2Wrap.sock, config: { BOT_NAME: 'Spider Man' } });
    assert.equal(syncRes.enabled, true);
    assert.equal(syncRes.updated, true);
    assert.equal(syncRes.bio, 'Always Online ⚡');

    // Subsequent tick rotates to the next saved bio on the new socket
    const tickRes = await manager.tick();
    assert.equal(tickRes.ok, true);
    assert.equal(tickRes.bio, 'Coding Mode 💻');
    assert.deepEqual(sock2Wrap.statusUpdates, ['Always Online ⚡', 'Coding Mode 💻']);

    // setAndApply replaces the list
    const setRes = await manager.setAndApply('Single Official About');
    assert.equal(setRes.ok, true);
    assert.equal(setRes.bio, 'Single Official About');
    assert.deepEqual(store.getState().bios, ['Single Official About']);
    assert.equal(sock2Wrap.statusUpdates.at(-1), 'Single Official About');

    manager.disable();
    assert.equal(manager.isRunning(), false);
    assert.equal(store.getState().enabled, false);
  } finally {
    manager.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyProfileBio supports legacy sock.query fallback when updateProfileStatus is absent', async () => {
  const queries = [];
  const legacySock = {
    async query(iq) {
      queries.push(iq);
      return { attrs: { type: 'result' } };
    },
  };
  const res = await applyProfileBio(legacySock, 'Legacy About Test');
  assert.equal(res.ok, true);
  assert.equal(res.bio, 'Legacy About Test');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].attrs.xmlns, 'status');
});

test('User.js autobio command adds bio, updates WhatsApp About immediately, lists, configures interval, deletes, and disables', async () => {
  const tmpDir = createTempDir('spider-autobio-cmd-');
  const origCwd = process.cwd();
  const origGlobalManager = globalThis.__spiderAutobioManager;
  const { sock, statusUpdates, messages } = createMockSock();
  const autobioCmd = userCommands.find((cmd) => cmd.name === 'autobio');
  assert.ok(autobioCmd, 'autobio command must exist in User.js');

  const testStore = createAutobioStore(path.join(tmpDir, 'data', 'autobio.json'), { env: {} });
  const testManager = createAutobioManager({
    store: testStore,
    getSock: () => sock,
    getBotName: () => 'Spider Man',
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });

  try {
    process.chdir(tmpDir);
    defaultAutobioStore.clearCache();
    globalThis.__spiderAutobioManager = testManager;

    const from = '254700000001@s.whatsapp.net';
    const fakeMsg = { key: { remoteJid: from, fromMe: true, id: 'm1' } };
    const cfg = { BOT_NAME: 'Spider Man', PREFIXES: ['.'] };

    // 1. Add bio explicitly
    await autobioCmd.execute({
      sock,
      from,
      text: 'add Available 24/7 ⚡',
      args: ['add', 'Available', '24/7', '⚡'],
      msg: fakeMsg,
      config: cfg,
    });
    assert.equal(statusUpdates.at(-1), 'Available 24/7 ⚡');
    assert.match(messages.at(-1).content.text, /BIO ADDED/);
    assert.match(messages.at(-1).content.text, /Available 24\/7 ⚡/);

    // 2. Direct text fallback (`.autobio <custom text>`)
    await autobioCmd.execute({
      sock,
      from,
      text: 'Spider Bot Live 🕷️',
      args: ['Spider', 'Bot', 'Live', '🕷️'],
      msg: fakeMsg,
      config: cfg,
    });
    assert.equal(statusUpdates.at(-1), 'Spider Bot Live 🕷️');

    // 3. List saved bios
    await autobioCmd.execute({
      sock,
      from,
      text: 'list',
      args: ['list'],
      msg: fakeMsg,
      config: cfg,
    });
    assert.match(messages.at(-1).content.text, /Available 24\/7 ⚡/);
    assert.match(messages.at(-1).content.text, /Spider Bot Live 🕷️/);

    // 4. Update interval
    await autobioCmd.execute({
      sock,
      from,
      text: 'interval 2m',
      args: ['interval', '2m'],
      msg: fakeMsg,
      config: cfg,
    });
    assert.equal(testManager.getState().intervalMs, 120_000);
    assert.match(messages.at(-1).content.text, /2m/);

    // 5. Delete bio #1
    await autobioCmd.execute({
      sock,
      from,
      text: 'del 1',
      args: ['del', '1'],
      msg: fakeMsg,
      config: cfg,
    });
    assert.match(messages.at(-1).content.text, /BIO REMOVED/);

    // 6. Set single bio
    await autobioCmd.execute({
      sock,
      from,
      text: 'set Only About Now',
      args: ['set', 'Only', 'About', 'Now'],
      msg: fakeMsg,
      config: cfg,
    });
    assert.equal(statusUpdates.at(-1), 'Only About Now');
    assert.match(messages.at(-1).content.text, /BIO SET/);

    // 7. Turn off
    await autobioCmd.execute({
      sock,
      from,
      text: 'off',
      args: ['off'],
      msg: fakeMsg,
      config: cfg,
    });
    assert.equal(testManager.getState().enabled, false);
    assert.equal(testManager.isRunning(), false);
  } finally {
    testManager.stop();
    defaultAutobioManager.stop();
    defaultAutobioStore.clearCache();
    globalThis.__spiderAutobioManager = origGlobalManager;
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('command loader registers autobio and aliases cleanly without collisions', async () => {
  const commandsMap = new Map();
  const aliasesMap = new Map();
  const commandsDir = path.resolve(process.cwd(), 'Spider', 'commands');

  await reloadCommandsFromDisk({
    commandsDir,
    commandsMap,
    aliasesMap,
    loadLegacyFn: () => 0,
    pathToFileUrlFn: pathToFileURL,
    fsImpl: fs,
    pathImpl: path,
  });

  assert.equal(commandsMap.get('autobio')?.name, 'autobio');
  for (const alias of ['bio', 'addbio', 'botbio', 'toggleautobio']) {
    assert.equal(aliasesMap.get(alias), 'autobio', `expected alias ${alias} -> autobio`);
  }
});

test('applyProfileBio falls back cleanly when GraphQL returns Bad Request on duration 0 and caches winning strategy per socket', async () => {
  const attempts = [];
  const sock = {
    async updateProfileStatus(arg) {
      attempts.push(arg);
      if (typeof arg === 'string') {
        const err = new Error('GraphQL server error: Bad Request');
        err.statusCode = 400;
        throw err;
      }
      if (arg && typeof arg === 'object' && arg.ephemeralDurationSec === 86400 && !arg.emoji) {
        return undefined;
      }
      throw new Error('Unexpected payload');
    },
  };

  const first = await applyProfileBio(sock, '⚡ Spider Man | Online & Ready');
  assert.equal(first.ok, true);
  assert.equal(first.strategy, 'ephemeral86400');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], '⚡ Spider Man | Online & Ready');
  assert.deepEqual(attempts[1], {
    text: '⚡ Spider Man | Online & Ready',
    ephemeralDurationSec: 86400,
  });

  // Second call on the same socket uses cached working strategy directly
  const second = await applyProfileBio(sock, 'Available 24/7 ⚡');
  assert.equal(second.ok, true);
  assert.equal(second.strategy, 'ephemeral86400');
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts[2], {
    text: 'Available 24/7 ⚡',
    ephemeralDurationSec: 86400,
  });
});

test('applyProfileBio falls through emoji+86400, raw w:mex text-only, and legacy status IQ when GraphQL rejects earlier variants', async () => {
  // Case 1: requires emoji + 86400
  const emojiCalls = [];
  const emojiSock = {
    async updateProfileStatus(arg) {
      emojiCalls.push(arg);
      if (typeof arg === 'object' && arg.emoji && arg.ephemeralDurationSec === 86400) {
        return undefined;
      }
      const err = new Error('GraphQL server error: Bad Request');
      err.statusCode = 400;
      throw err;
    },
  };
  const emojiRes = await applyProfileBio(emojiSock, '⚡ Spider Man | Online');
  assert.equal(emojiRes.ok, true);
  assert.equal(emojiRes.strategy, 'ephemeral86400Emoji');
  assert.deepEqual(emojiCalls.at(-1), {
    text: 'Spider Man | Online',
    emoji: '⚡',
    ephemeralDurationSec: 86400,
  });

  // Case 2: w:mex returns GraphQL errors inside <result>, falls back to legacy xmlns='status' IQ
  const iqCalls = [];
  const legacyFallbackSock = {
    async updateProfileStatus() {
      const err = new Error('GraphQL server error: Bad Request');
      err.statusCode = 400;
      throw err;
    },
    async query(iq) {
      iqCalls.push(iq);
      if (iq.attrs?.xmlns === 'w:mex') {
        return {
          tag: 'iq',
          attrs: { type: 'result' },
          content: [
            {
              tag: 'result',
              attrs: {},
              content: Buffer.from(JSON.stringify({ errors: [{ message: 'Bad Request' }] }), 'utf8'),
            },
          ],
        };
      }
      return { tag: 'iq', attrs: { type: 'result' } };
    },
  };
  const legacyRes = await applyProfileBio(legacyFallbackSock, 'Custom Bio');
  assert.equal(legacyRes.ok, true);
  assert.equal(legacyRes.strategy, 'legacyStatusIq');
  assert.equal(iqCalls.length, 2);
  assert.equal(iqCalls[0].attrs.xmlns, 'w:mex');
  assert.equal(iqCalls[1].attrs.xmlns, 'status');
});

test('applyProfileBio does not retry protocol fallbacks on non-schema socket errors', async () => {
  let count = 0;
  const deadSock = {
    async updateProfileStatus() {
      count += 1;
      throw new Error('Connection Closed');
    },
    async query() {
      count += 1;
      return { attrs: { type: 'result' } };
    },
  };
  await assert.rejects(() => applyProfileBio(deadSock, 'Hello'), /Connection Closed/);
  assert.equal(count, 1);
});

test('PRESET_AUTOBIOS contains 100 unique valid bios that rotate dynamically and load into store/commands', async () => {
  assert.equal(PRESET_AUTOBIOS.length, 100);
  assert.ok(MAX_SAVED_BIOS >= 100);

  const uniqueRaw = new Set(PRESET_AUTOBIOS.map((b) => b.trim()));
  assert.equal(uniqueRaw.size, 100, 'all 100 preset bios must be distinct');

  const nowMs = Date.UTC(2026, 10, 17, 13, 30, 0);
  const startTimeMs = nowMs - 7_260_000;
  const generated = new Set();
  for (let i = 0; i < 100; i += 1) {
    const bio = buildDynamicBio({
      botName: 'Spider Man',
      tz: 'UTC',
      startTimeMs,
      nowMs,
      index: i,
    });
    assert.ok(bio.length > 0 && bio.length <= MAX_BIO_LENGTH, `bio #${i + 1} invalid length: ${bio.length}`);
    generated.add(bio);
  }
  assert.equal(generated.size, 100, 'all 100 rotated bios must expand distinctly');

  const tmpDir = createTempDir('spider-autobio-100-');
  const origCwd = process.cwd();
  const origGlobalManager = globalThis.__spiderAutobioManager;
  const { sock, statusUpdates, messages } = createMockSock();
  const autobioCmd = userCommands.find((cmd) => cmd.name === 'autobio');

  const testStore = createAutobioStore(path.join(tmpDir, 'data', 'autobio.json'), { env: {} });
  const testManager = createAutobioManager({
    store: testStore,
    getSock: () => sock,
    getBotName: () => 'Spider Man',
  });

  try {
    process.chdir(tmpDir);
    defaultAutobioStore.clearCache();
    globalThis.__spiderAutobioManager = testManager;

    const from = '254700000001@s.whatsapp.net';
    const fakeMsg = { key: { remoteJid: from, fromMe: true, id: 'm100' } };
    const cfg = { BOT_NAME: 'Spider Man', PREFIXES: ['.'] };

    // Load all 100 presets via `.autobio presets`
    await autobioCmd.execute({
      sock,
      from,
      text: 'presets',
      args: ['presets'],
      msg: fakeMsg,
      config: cfg,
    });

    assert.equal(testStore.getState().bios.length, 100);
    assert.equal(testStore.getState().enabled, true);
    assert.equal(statusUpdates.length, 1);
    assert.match(messages.at(-1).content.text, /PRESET BIOS LOADED/);
    assert.match(messages.at(-1).content.text, /100/);

    // Pagination via `.autobio list 2`
    await autobioCmd.execute({
      sock,
      from,
      text: 'list 2',
      args: ['list', '2'],
      msg: fakeMsg,
      config: cfg,
    });
    const listText = messages.at(-1).content.text;
    assert.match(listText, /PAGE 2\/4/);
    assert.match(listText, /#26/);
    assert.match(listText, /#50/);
  } finally {
    testManager.stop();
    defaultAutobioManager.stop();
    defaultAutobioStore.clearCache();
    globalThis.__spiderAutobioManager = origGlobalManager;
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


