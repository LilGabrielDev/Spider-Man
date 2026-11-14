import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let reloadCommandsFromDisk;
let loadLegacyCommands;
let config;
let antifloodUtils;

const commandsMap = new Map();
const aliasesMap = new Map();
const origFetch = globalThis.fetch;

before(async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/json']]),
    json: async () => ({}),
    text: async () => '',
    arrayBuffer: async () => Buffer.from(''),
  });

  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const handle = origSetInterval(...args);
    handle?.unref?.();
    return handle;
  };

  try {
    ({ reloadCommandsFromDisk } = await import('../../spider/utils/runtimeControl.js'));
    ({ loadLegacyCommands } = await import('../utils/legacyPlugins.js'));
    config = (await import('../../spider/config.js')).default;
    antifloodUtils = await import('../../spider/utils/antiflood.js');

    await reloadCommandsFromDisk({
      commandsDir: path.join(process.cwd(), 'Spider', 'commands'),
      commandsMap,
      aliasesMap,
      loadLegacyFn: loadLegacyCommands,
      pathToFileUrlFn: pathToFileURL,
      cacheBust: 999202,
    });
  } finally {
    globalThis.setInterval = origSetInterval;
  }
});

after(() => {
  globalThis.fetch = origFetch;
});

function createGroupMockSock({ botId = '254700000099@s.whatsapp.net', botIsAdmin = true } = {}) {
  const sent = [];
  const kicked = [];
  const settingsUpdates = [];
  const metadata = {
    id: '120363000000008888@g.us',
    subject: 'Flood Test Group',
    owner: '254700000001@s.whatsapp.net',
    participants: [
      { id: '254700000001@s.whatsapp.net', admin: 'superadmin' },
      { id: '254700000002@s.whatsapp.net', admin: 'admin' },
      { id: '254700000003@s.whatsapp.net', admin: null },
      { id: '254700000004@s.whatsapp.net', admin: null },
      { id: botId, admin: botIsAdmin ? 'admin' : null },
    ],
  };

  return {
    sent,
    kicked,
    settingsUpdates,
    metadata,
    sock: {
      user: { id: `${botId.split('@')[0]}:1@s.whatsapp.net` },
      sendMessage: async (jid, payload, options = {}) => {
        const record = { id: `msg-${sent.length + 1}`, jid, payload, options };
        sent.push(record);
        return { key: { id: record.id, remoteJid: jid, fromMe: true } };
      },
      groupParticipantsUpdate: async (jid, participants, action) => {
        kicked.push({ jid, participants, action });
        return participants.map((p) => ({ status: '200', jid: p }));
      },
      groupSettingUpdate: async (jid, setting) => {
        settingsUpdates.push({ jid, setting });
        return {};
      },
      groupMetadata: async () => metadata,
    },
  };
}

test('antiflood command is registered with group/admin/botAdmin guards and appears in Group category', async () => {
  const cmd = commandsMap.get('antiflood');
  assert.ok(cmd, 'antiflood command must be registered');
  assert.equal(cmd.category, 'Group');
  assert.equal(cmd.groupOnly, true);
  assert.equal(cmd.adminOnly, true);
  assert.equal(cmd.botAdminOnly, true);
  assert.equal(aliasesMap.get('noflood'), 'antiflood');
  assert.equal(aliasesMap.get('floodguard'), 'antiflood');
  assert.equal(aliasesMap.get('floodprotect'), 'antiflood');

  const { sock, sent } = createGroupMockSock();
  await commandsMap.get('category').execute({
    sock,
    from: '120363000000008888@g.us',
    text: 'group',
    args: ['group'],
    commands: commandsMap,
    commandAliases: aliasesMap,
    config,
    msg: { key: { id: 'cat-af-1' } },
  });
  assert.match(sent[0].payload.text, /ᴀɴᴛɪғʟᴏᴏᴅ|antiflood/i);
});

test('createFloodTracker enforces sliding window thresholds, expires cleanly, and resists clock rollback', () => {
  let nowMs = 10_000;
  const tracker = antifloodUtils.createFloodTracker({ now: () => nowMs });
  const groupJid = '120363000000008888@g.us';
  const senderA = '254700000003@s.whatsapp.net';
  const senderB = '254700000004@s.whatsapp.net';

  for (let i = 1; i <= 3; i += 1) {
    const res = tracker.recordMessage(groupJid, senderA, { limit: 3, windowSec: 10 });
    assert.equal(res.isFlood, false);
    assert.equal(res.count, i);
  }

  // 4th message in 10s triggers flood
  const trigger = tracker.recordMessage(groupJid, senderA, { limit: 3, windowSec: 10 });
  assert.equal(trigger.isFlood, true);
  assert.equal(trigger.count, 4);

  // Separate sender has independent budget
  const otherSender = tracker.recordMessage(groupJid, senderB, { limit: 3, windowSec: 10 });
  assert.equal(otherSender.isFlood, false);
  assert.equal(otherSender.count, 1);

  // Clock rollback does not bypass tracker
  nowMs = 5_000;
  const rollback = tracker.recordMessage(groupJid, senderA, { limit: 3, windowSec: 10 });
  assert.equal(rollback.isFlood, true);

  // Advancing past window expires prior timestamps
  nowMs = 25_000;
  const recovered = tracker.recordMessage(groupJid, senderA, { limit: 3, windowSec: 10 });
  assert.equal(recovered.isFlood, false);
  assert.equal(recovered.count, 1);
});

test('antiflood command manages on/off, actions, limit/window/set, warnlimit, notify, and whitelist', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antiflood-cmd-'));
  t.mock.method(process, 'cwd', () => tmpDir);
  antifloodUtils.defaultAntifloodStore.clearCache();
  antifloodUtils.defaultFloodTracker.clear();

  try {
    const groupJid = '120363000000008888@g.us';
    const { sock, sent } = createGroupMockSock();
    const cmd = commandsMap.get('antiflood');
    const makeCmdCtx = (text, extra = {}) => ({
      sock,
      from: groupJid,
      text,
      args: text ? text.split(/\s+/) : [],
      config,
      isOwner: true,
      isGroupAdmin: true,
      isBotGroupAdmin: true,
      msg: {
        key: { id: `cmd-${sent.length + 1}`, remoteJid: groupJid, fromMe: false, participant: '254700000001@s.whatsapp.net' },
        message: { conversation: `.antiflood ${text}` },
      },
      ...extra,
    });

    // Guards
    await cmd.execute(makeCmdCtx('', { from: '254700000001@s.whatsapp.net' }));
    assert.match(sent.at(-1).payload.text, /only be used in a group/i);

    await cmd.execute(makeCmdCtx('on', { isGroupAdmin: false, isOwner: false }));
    assert.match(sent.at(-1).payload.text, /Only a group admin/i);

    await cmd.execute(makeCmdCtx('on', { isBotGroupAdmin: false }));
    assert.match(sent.at(-1).payload.text, /needs group admin/i);

    // Status card
    await cmd.execute(makeCmdCtx(''));
    assert.match(sent.at(-1).payload.text, /ANTIFLOOD SHIELD/);
    assert.match(sent.at(-1).payload.text, /OFF ❌/);

    // Enable with warnkick
    await cmd.execute(makeCmdCtx('on warnkick'));
    assert.match(sent.at(-1).payload.text, /ANTIFLOOD ENABLED/);
    assert.match(sent.at(-1).payload.text, /DELETE · WARN TO KICK/);
    assert.equal(antifloodUtils.defaultAntifloodStore.getGroupConfig(groupJid).enabled, true);
    assert.equal(antifloodUtils.defaultAntifloodStore.getGroupConfig(groupJid).action, 'warnkick');

    // Rate controls: limit, window, set
    await cmd.execute(makeCmdCtx('limit 4'));
    assert.equal(antifloodUtils.defaultAntifloodStore.getGroupConfig(groupJid).limit, 4);
    await cmd.execute(makeCmdCtx('window 15'));
    assert.equal(antifloodUtils.defaultAntifloodStore.getGroupConfig(groupJid).windowSec, 15);
    await cmd.execute(makeCmdCtx('set 6 12'));
    assert.equal(antifloodUtils.defaultAntifloodStore.getGroupConfig(groupJid).limit, 6);
    assert.equal(antifloodUtils.defaultAntifloodStore.getGroupConfig(groupJid).windowSec, 12);

    // Invalid bounds rejected
    await cmd.execute(makeCmdCtx('limit 1'));
    assert.match(sent.at(-1).payload.text, /between 2 and 30/i);
    await cmd.execute(makeCmdCtx('window 1'));
    assert.match(sent.at(-1).payload.text, /between 3 and 120/i);

    // Warnlimit, mute action, notify, whitelist
    await cmd.execute(makeCmdCtx('warnlimit 2'));
    assert.equal(antifloodUtils.defaultAntifloodStore.getGroupConfig(groupJid).maxWarns, 2);

    await cmd.execute(makeCmdCtx('mute'));
    assert.equal(antifloodUtils.defaultAntifloodStore.getGroupConfig(groupJid).action, 'mute');

    await cmd.execute(makeCmdCtx('notify off'));
    assert.equal(antifloodUtils.defaultAntifloodStore.getGroupConfig(groupJid).notify, false);
    await cmd.execute(makeCmdCtx('notify on'));
    assert.equal(antifloodUtils.defaultAntifloodStore.getGroupConfig(groupJid).notify, true);

    await cmd.execute(makeCmdCtx('whitelist add 254700000004'));
    assert.match(sent.at(-1).payload.text, /Added \*254700000004\*/);
    await cmd.execute(makeCmdCtx('whitelist list'));
    assert.match(sent.at(-1).payload.text, /254700000004/);
    await cmd.execute(makeCmdCtx('whitelist remove 254700000004'));
    assert.match(sent.at(-1).payload.text, /Removed \*254700000004\*/);

    await cmd.execute(makeCmdCtx('off'));
    assert.equal(antifloodUtils.defaultAntifloodStore.getGroupConfig(groupJid).enabled, false);
    assert.ok(fs.existsSync(path.join(tmpDir, 'data', 'antiflood.json')));
  } finally {
    antifloodUtils.defaultAntifloodStore.clearCache();
    antifloodUtils.defaultFloodTracker.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('handleAntiFloodMessage enforces delete, warnkick, kick, mute, and respects admin/whitelist/botAdmin guards', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antiflood-enforce-'));
  const store = antifloodUtils.createAntifloodStore(path.join(tmpDir, 'antiflood.json'));
  let nowMs = 1_000;
  const tracker = antifloodUtils.createFloodTracker({ now: () => nowMs });

  try {
    const groupJid = '120363000000008888@g.us';
    const flooder = '254700000003@s.whatsapp.net';
    const whitelistedUser = '254700000004@s.whatsapp.net';
    const adminUser = '254700000002@s.whatsapp.net';

    const buildMsg = (id, sender) => ({
      key: { id, remoteJid: groupJid, fromMe: false, participant: sender },
      message: { conversation: `msg ${id}` },
    });

    // 1. Delete mode: allows limit (3), deletes 4th & 5th, throttles duplicate alert card within window
    store.setGroupConfig(groupJid, { enabled: true, action: 'delete', limit: 3, windowSec: 10, notify: true });
    let env = createGroupMockSock();
    for (let i = 1; i <= 3; i += 1) {
      const okRes = await antifloodUtils.handleAntiFloodMessage({
        sock: env.sock,
        from: groupJid,
        sender: flooder,
        msg: buildMsg(`m-${i}`, flooder),
        store,
        tracker,
      });
      assert.equal(okRes.handled, false);
    }
    assert.equal(env.sent.length, 0);

    const del1 = await antifloodUtils.handleAntiFloodMessage({
      sock: env.sock,
      from: groupJid,
      sender: flooder,
      msg: buildMsg('m-4', flooder),
      store,
      tracker,
    });
    assert.equal(del1.handled, true);
    assert.equal(del1.deleted, true);
    assert.equal(del1.warningMessage, 'No flooding or spamming allowed in this group!');
    assert.equal(env.sent.length, 2); // delete + 1 alert card
    assert.match(env.sent[1].payload.text, /MESSAGE DELETED/);
    assert.match(env.sent[1].payload.text, /\*WARNING\*\s*›\s*No flooding or spamming allowed in this group!/);

    const del2 = await antifloodUtils.handleAntiFloodMessage({
      sock: env.sock,
      from: groupJid,
      sender: flooder,
      msg: buildMsg('m-5', flooder),
      store,
      tracker,
    });
    assert.equal(del2.handled, true);
    assert.equal(del2.deleted, true);
    assert.equal(env.sent.length, 3); // delete only, alert throttled!

    // 2. Warnkick mode: 2 bursts kick flooder and reset warns
    nowMs += 20_000;
    tracker.clear();
    store.setGroupConfig(groupJid, {
      enabled: true,
      action: 'warnkick',
      limit: 2,
      windowSec: 10,
      maxWarns: 2,
      notify: true,
    });
    env = createGroupMockSock();

    // Burst 1 (3 messages -> 1st warn)
    for (let i = 1; i <= 2; i += 1) {
      await antifloodUtils.handleAntiFloodMessage({
        sock: env.sock,
        from: groupJid,
        sender: flooder,
        msg: buildMsg(`wk-a-${i}`, flooder),
        store,
        tracker,
      });
    }
    const warn1 = await antifloodUtils.handleAntiFloodMessage({
      sock: env.sock,
      from: groupJid,
      sender: flooder,
      msg: buildMsg('wk-a-3', flooder),
      store,
      tracker,
    });
    assert.equal(warn1.handled, true);
    assert.equal(warn1.warnCount, 1);
    assert.equal(warn1.kicked, false);
    assert.match(env.sent.at(-1).payload.text, /1\/2/);

    // Burst 2 (3 messages -> 2nd warn -> kicked)
    for (let i = 1; i <= 2; i += 1) {
      await antifloodUtils.handleAntiFloodMessage({
        sock: env.sock,
        from: groupJid,
        sender: flooder,
        msg: buildMsg(`wk-b-${i}`, flooder),
        store,
        tracker,
      });
    }
    const warn2 = await antifloodUtils.handleAntiFloodMessage({
      sock: env.sock,
      from: groupJid,
      sender: flooder,
      msg: buildMsg('wk-b-3', flooder),
      store,
      tracker,
    });
    assert.equal(warn2.handled, true);
    assert.equal(warn2.warnCount, 2);
    assert.equal(warn2.kicked, true);
    assert.equal(env.kicked.length, 1);
    assert.equal(Object.keys(store.getGroupConfig(groupJid).warns).length, 0);

    // 3. Mute mode: sets group to announcement on flood
    nowMs += 20_000;
    tracker.clear();
    store.setGroupConfig(groupJid, { enabled: true, action: 'mute', limit: 2, windowSec: 10, notify: true });
    env = createGroupMockSock();
    for (let i = 1; i <= 2; i += 1) {
      await antifloodUtils.handleAntiFloodMessage({
        sock: env.sock,
        from: groupJid,
        sender: flooder,
        msg: buildMsg(`mute-${i}`, flooder),
        store,
        tracker,
      });
    }
    const muteRes = await antifloodUtils.handleAntiFloodMessage({
      sock: env.sock,
      from: groupJid,
      sender: flooder,
      msg: buildMsg('mute-3', flooder),
      store,
      tracker,
    });
    assert.equal(muteRes.handled, true);
    assert.equal(muteRes.muted, true);
    assert.deepEqual(env.settingsUpdates, [{ jid: groupJid, setting: 'announcement' }]);
    assert.match(env.sent.at(-1).payload.text, /GROUP MUTED/);

    // 4. Whitelisted user, group admins, and non-admin bot are skipped
    store.addWhitelist(groupJid, '254700000004');
    env = createGroupMockSock();
    for (let i = 1; i <= 5; i += 1) {
      const wlRes = await antifloodUtils.handleAntiFloodMessage({
        sock: env.sock,
        from: groupJid,
        sender: whitelistedUser,
        msg: buildMsg(`wl-${i}`, whitelistedUser),
        store,
        tracker,
      });
      assert.equal(wlRes.handled, false);
      assert.equal(wlRes.reason, 'whitelisted');
    }
    assert.equal(env.sent.length, 0);

    for (let i = 1; i <= 3; i += 1) {
      const admRes = await antifloodUtils.handleAntiFloodMessage({
        sock: env.sock,
        from: groupJid,
        sender: adminUser,
        msg: buildMsg(`adm-${i}`, adminUser),
        store,
        tracker,
      });
      if (i <= 2) assert.equal(admRes.handled, false);
      else {
        assert.equal(admRes.handled, false);
        assert.equal(admRes.reason, 'sender-is-admin');
      }
    }
    assert.equal(env.sent.length, 0);

    const nonBotAdminEnv = createGroupMockSock({ botIsAdmin: false });
    tracker.clear();
    let botRes;
    for (let i = 1; i <= 3; i += 1) {
      botRes = await antifloodUtils.handleAntiFloodMessage({
        sock: nonBotAdminEnv.sock,
        from: groupJid,
        sender: flooder,
        msg: buildMsg(`nba-${i}`, flooder),
        store,
        tracker,
      });
    }
    assert.equal(botRes.handled, false);
    assert.equal(botRes.reason, 'bot-not-admin');
    assert.equal(nonBotAdminEnv.sent.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('spider/index.js hooks handleAntiFloodMessage into live group message handling', () => {
  const indexSource = fs.readFileSync(path.join(process.cwd(), 'spider', 'index.js'), 'utf8');
  assert.ok(indexSource.includes('./utils/antiflood.js'), 'spider/index.js must import utils/antiflood.js');
  assert.ok(indexSource.includes('handleAntiFloodMessage('), 'spider/index.js must call handleAntiFloodMessage');
});
