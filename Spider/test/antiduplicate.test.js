import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let reloadCommandsFromDisk;
let loadLegacyCommands;
let config;
let antiduplicateUtils;

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
    antiduplicateUtils = await import('../../spider/utils/antiduplicate.js');

    await reloadCommandsFromDisk({
      commandsDir: path.join(process.cwd(), 'Spider', 'commands'),
      commandsMap,
      aliasesMap,
      loadLegacyFn: loadLegacyCommands,
      pathToFileUrlFn: pathToFileURL,
      cacheBust: 999303,
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
  const ws = new EventEmitter();
  const kicked = [];
  const settingsUpdates = [];
  const metadata = {
    id: '120363000000007777@g.us',
    subject: 'Duplicate Test Group',
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
      ws,
      sendMessage: async (jid, payload, options = {}) => {
        const record = { id: `msg-${sent.length + 1}`, jid, payload, options };
        sent.push(record);
        queueMicrotask(() => ws.emit('CB:ack,class:message', { attrs: { id: record.id } }));
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

test('antiduplicate command is registered with group/admin/botAdmin guards and aliases', async () => {
  const cmd = commandsMap.get('antiduplicate');
  assert.ok(cmd, 'antiduplicate command must be registered');
  assert.equal(cmd.category, 'Group');
  assert.equal(cmd.groupOnly, true);
  assert.equal(cmd.adminOnly, true);
  assert.equal(cmd.botAdminOnly, true);
  assert.equal(aliasesMap.get('antidup'), 'antiduplicate');
  assert.equal(aliasesMap.get('nodup'), 'antiduplicate');
  assert.equal(aliasesMap.get('noduplicate'), 'antiduplicate');
  assert.equal(aliasesMap.get('dupguard'), 'antiduplicate');

  const { sock, sent } = createGroupMockSock();
  await commandsMap.get('category').execute({
    sock,
    from: '120363000000007777@g.us',
    text: 'group',
    args: ['group'],
    commands: commandsMap,
    commandAliases: aliasesMap,
    config,
    msg: { key: { id: 'cat-ad-1' } },
  });
  assert.match(sent[0].payload.text, /ᴀɴᴛɪᴅᴜᴘʟɪᴄᴀᴛᴇ|antiduplicate/i);
});

test('sensitive duplicate detection catches exact, case, invisible, homoglyph, spaced, stretched, fuzzy, emoji, and media repeats without false positives', () => {
  let nowMs = 100_000;
  const tracker = antiduplicateUtils.createDuplicateTracker({ now: () => nowMs });
  const groupJid = '120363000000007777@g.us';
  const senderA = '254700000003@s.whatsapp.net';
  const senderB = '254700000004@s.whatsapp.net';

  const sendText = (sender, body, opts = {}) =>
    tracker.checkAndRecord(groupJid, sender, {
      msg: { key: { id: `m-${nowMs}`, remoteJid: groupJid, participant: sender }, message: { conversation: body } },
      text: body,
      sensitivity: 'sensitive',
      windowSec: 600,
      ...opts,
    });

  // First message is unique
  assert.equal(sendText(senderA, 'Join our weekend coding bootcamp today').isDuplicate, false);
  // Exact repeat
  assert.equal(sendText(senderA, 'Join our weekend coding bootcamp today').isDuplicate, true);
  // Case + punctuation variation
  assert.equal(sendText(senderA, 'JOIN OUR WEEKEND CODING BOOTCAMP TODAY!!!').isDuplicate, true);
  // Zero-width / invisible character variation
  assert.equal(sendText(senderA, 'Join\u200B our\u200C weekend\uFEFF coding bootcamp today').isDuplicate, true);
  // Homoglyph + fancy font variation (Cyrillic 'о', 'е', bold '𝐉')
  assert.equal(sendText(senderA, '𝐉oin оur wееkеnd coding bootcamp today').isDuplicate, true);
  // Near-duplicate fuzzy match (typo/extra word)
  const fuzzy = sendText(senderA, 'Join our weekend coding bootcamps today please!');
  assert.equal(fuzzy.isDuplicate, true);
  assert.equal(fuzzy.matchType, 'fuzzy');

  // Spaced & stretched word variations
  assert.equal(sendText(senderA, 'hello').isDuplicate, false);
  assert.equal(sendText(senderA, 'h e l l o').isDuplicate, true);
  assert.equal(sendText(senderA, 'h.e.l.l.o').isDuplicate, true);
  assert.equal(sendText(senderA, 'helloooo').isDuplicate, true);
  assert.equal(sendText(senderA, 'hheelllloooo').isDuplicate, true);

  // Emoji repeat detection
  assert.equal(sendText(senderA, '🔥🔥').isDuplicate, false);
  assert.equal(sendText(senderA, '🔥🔥🔥🔥').isDuplicate, true);

  // Distinct short everyday words must NOT false-positive
  assert.equal(sendText(senderA, 'ok').isDuplicate, false);
  assert.equal(sendText(senderA, 'no').isDuplicate, false);
  assert.equal(sendText(senderA, 'good').isDuplicate, false);
  assert.equal(sendText(senderA, 'god').isDuplicate, false);
  assert.equal(sendText(senderA, 'to').isDuplicate, false);
  assert.equal(sendText(senderA, 'too').isDuplicate, false);

  // User scope: another user sending same message is allowed when scope === 'user'
  assert.equal(sendText(senderB, 'Join our weekend coding bootcamp today', { scope: 'user' }).isDuplicate, false);

  // Group scope: sender B repeating sender A's group-scoped message is caught
  assert.equal(sendText(senderA, 'Group wide announcement message', { scope: 'group' }).isDuplicate, false);
  assert.equal(sendText(senderB, 'Group wide announcement message!', { scope: 'group' }).isDuplicate, true);

  // Sticker/media duplicate detection vs distinct media
  const sticker1 = {
    key: { id: 'stk-1', remoteJid: groupJid, participant: senderA },
    message: { stickerMessage: { fileSha256: Buffer.from('same-sticker-hash'), mimetype: 'image/webp' } },
  };
  const sticker2 = {
    key: { id: 'stk-2', remoteJid: groupJid, participant: senderA },
    message: { stickerMessage: { fileSha256: Buffer.from('other-sticker-hash'), mimetype: 'image/webp' } },
  };
  assert.equal(tracker.checkAndRecord(groupJid, senderA, { msg: sticker1 }).isDuplicate, false);
  assert.equal(tracker.checkAndRecord(groupJid, senderA, { msg: sticker1 }).isDuplicate, true);
  assert.equal(tracker.checkAndRecord(groupJid, senderA, { msg: sticker2 }).isDuplicate, false);

  // Clock rollback does not expire entries prematurely; still duplicate at 23h 59m, expires after 24h (default window)
  nowMs = 50_000;
  assert.equal(sendText(senderA, 'Join our weekend coding bootcamp today', { windowSec: 86400 }).isDuplicate, true);
  nowMs = 100_000 + 86_340 * 1000; // 23h 59m after first message
  assert.equal(sendText(senderA, 'Join our weekend coding bootcamp today', { windowSec: 86400 }).isDuplicate, true);
  nowMs = 100_000 + 86_400 * 1000 + 1; // strictly > 24h after original message
  assert.equal(sendText(senderA, 'Join our weekend coding bootcamp today', { windowSec: 86400 }).isDuplicate, false);

  // Incoming messages with messageTimestamp older than 24h are ignored (e.g., history sync replay)
  const oldUnixSec = Math.floor((nowMs - 86_401 * 1000) / 1000);
  const oldMsgCheck = tracker.checkAndRecord(groupJid, senderA, {
    msg: {
      key: { id: 'old-1', remoteJid: groupJid, participant: senderA },
      messageTimestamp: oldUnixSec,
      message: { conversation: 'Join our weekend coding bootcamp today' },
    },
    text: 'Join our weekend coding bootcamp today',
  });
  assert.equal(oldMsgCheck.isDuplicate, false);
  assert.equal(oldMsgCheck.skipped, 'message-older-than-24h');
});

test('antiduplicate command manages on/off, sensitivity, scope, window, media, actions, warnlimit, notify, whitelist, clear', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antidup-cmd-'));
  t.mock.method(process, 'cwd', () => tmpDir);
  antiduplicateUtils.defaultAntiduplicateStore.clearCache();
  antiduplicateUtils.defaultDuplicateTracker.clear();

  try {
    const groupJid = '120363000000007777@g.us';
    const { sock, sent } = createGroupMockSock();
    const cmd = commandsMap.get('antiduplicate');
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
        message: { conversation: `.antiduplicate ${text}` },
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

    // Status card shows sensitive default and 24h window
    await cmd.execute(makeCmdCtx(''));
    assert.match(sent.at(-1).payload.text, /ANTIDUPLICATE SHIELD/);
    assert.match(sent.at(-1).payload.text, /SENSITIVE/);
    assert.match(sent.at(-1).payload.text, /24h \(86400s\)/);
    assert.match(sent.at(-1).payload.text, /OFF ❌/);

    // Enable with warnkick
    await cmd.execute(makeCmdCtx('on warnkick'));
    assert.match(sent.at(-1).payload.text, /ANTIDUPLICATE ENABLED/);
    assert.equal(antiduplicateUtils.defaultAntiduplicateStore.getGroupConfig(groupJid).enabled, true);
    assert.equal(antiduplicateUtils.defaultAntiduplicateStore.getGroupConfig(groupJid).action, 'warnkick');

    // Sensitivity, scope, window (numeric + 24h shorthand + >24h rejected), media
    await cmd.execute(makeCmdCtx('sensitivity strict'));
    assert.equal(antiduplicateUtils.defaultAntiduplicateStore.getGroupConfig(groupJid).sensitivity, 'strict');
    await cmd.execute(makeCmdCtx('scope group'));
    assert.equal(antiduplicateUtils.defaultAntiduplicateStore.getGroupConfig(groupJid).scope, 'group');
    await cmd.execute(makeCmdCtx('window 12h'));
    assert.equal(antiduplicateUtils.defaultAntiduplicateStore.getGroupConfig(groupJid).windowSec, 43200);
    await cmd.execute(makeCmdCtx('window 24h'));
    assert.equal(antiduplicateUtils.defaultAntiduplicateStore.getGroupConfig(groupJid).windowSec, 86400);
    await cmd.execute(makeCmdCtx('window 25h'));
    assert.match(sent.at(-1).payload.text, /between 10 and 86400/i);
    await cmd.execute(makeCmdCtx('window 900'));
    assert.equal(antiduplicateUtils.defaultAntiduplicateStore.getGroupConfig(groupJid).windowSec, 900);
    await cmd.execute(makeCmdCtx('window 2'));
    assert.match(sent.at(-1).payload.text, /between 10 and 86400/i);
    await cmd.execute(makeCmdCtx('media off'));
    assert.equal(antiduplicateUtils.defaultAntiduplicateStore.getGroupConfig(groupJid).includeMedia, false);
    await cmd.execute(makeCmdCtx('media on'));
    assert.equal(antiduplicateUtils.defaultAntiduplicateStore.getGroupConfig(groupJid).includeMedia, true);

    // Warnlimit, notify, mute, whitelist, clear, off
    await cmd.execute(makeCmdCtx('warnlimit 2'));
    assert.equal(antiduplicateUtils.defaultAntiduplicateStore.getGroupConfig(groupJid).maxWarns, 2);
    await cmd.execute(makeCmdCtx('mute'));
    assert.equal(antiduplicateUtils.defaultAntiduplicateStore.getGroupConfig(groupJid).action, 'mute');
    await cmd.execute(makeCmdCtx('notify off'));
    assert.equal(antiduplicateUtils.defaultAntiduplicateStore.getGroupConfig(groupJid).notify, false);
    await cmd.execute(makeCmdCtx('whitelist add 254700000004'));
    assert.match(sent.at(-1).payload.text, /Added \*254700000004\*/);
    await cmd.execute(makeCmdCtx('whitelist remove 254700000004'));
    assert.match(sent.at(-1).payload.text, /Removed \*254700000004\*/);
    await cmd.execute(makeCmdCtx('clear'));
    assert.match(sent.at(-1).payload.text, /Cleared tracked duplicate/i);

    await cmd.execute(makeCmdCtx('off'));
    assert.equal(antiduplicateUtils.defaultAntiduplicateStore.getGroupConfig(groupJid).enabled, false);
    assert.ok(fs.existsSync(path.join(tmpDir, 'data', 'antiduplicate.json')));
  } finally {
    antiduplicateUtils.defaultAntiduplicateStore.clearCache();
    antiduplicateUtils.defaultDuplicateTracker.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('handleAntiDuplicateMessage enforces delete, warnkick, mute, and respects admin/whitelist/owner/botAdmin guards', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antidup-enforce-'));
  const store = antiduplicateUtils.createAntiduplicateStore(path.join(tmpDir, 'antiduplicate.json'));
  let nowMs = 5_000;
  const tracker = antiduplicateUtils.createDuplicateTracker({ now: () => nowMs });

  try {
    const groupJid = '120363000000007777@g.us';
    const member = '254700000003@s.whatsapp.net';
    const whitelistedUser = '254700000004@s.whatsapp.net';
    const adminUser = '254700000002@s.whatsapp.net';

    const buildMsg = (id, sender, text) => ({
      key: { id, remoteJid: groupJid, fromMe: false, participant: sender },
      message: { conversation: text },
    });

    // 1. Delete mode deletes near-duplicate immediately on 2nd send
    store.setGroupConfig(groupJid, {
      enabled: true,
      action: 'delete',
      sensitivity: 'sensitive',
      windowSec: 600,
      notify: true,
    });
    let env = createGroupMockSock();

    const first = await antiduplicateUtils.handleAntiDuplicateMessage({
      sock: env.sock,
      from: groupJid,
      sender: member,
      msg: buildMsg('d-1', member, 'Check out my shop link'),
      text: 'Check out my shop link',
      store,
      tracker,
    });
    assert.equal(first.handled, false);
    assert.equal(env.sent.length, 0);

    const dup1 = await antiduplicateUtils.handleAntiDuplicateMessage({
      sock: env.sock,
      from: groupJid,
      sender: member,
      msg: buildMsg('d-2', member, 'CHECK OUT MY SHOP LINKS!!'),
      text: 'CHECK OUT MY SHOP LINKS!!',
      store,
      tracker,
    });
    assert.equal(dup1.handled, true);
    assert.equal(dup1.deleted, true);
    assert.equal(env.sent.length, 2); // delete + alert
    assert.match(env.sent[1].payload.text, /ANTIDUPLICATE SHIELD/);

    // 2. Warnkick mode kicks at maxWarns
    tracker.clear();
    store.setGroupConfig(groupJid, {
      enabled: true,
      action: 'warnkick',
      sensitivity: 'sensitive',
      maxWarns: 2,
      notify: true,
    });
    env = createGroupMockSock();

    await antiduplicateUtils.handleAntiDuplicateMessage({
      sock: env.sock,
      from: groupJid,
      sender: member,
      msg: buildMsg('wk-0', member, 'Spam offer one'),
      text: 'Spam offer one',
      store,
      tracker,
    });
    const wk1 = await antiduplicateUtils.handleAntiDuplicateMessage({
      sock: env.sock,
      from: groupJid,
      sender: member,
      msg: buildMsg('wk-1', member, 'Spam offer one!'),
      text: 'Spam offer one!',
      store,
      tracker,
    });
    assert.equal(wk1.handled, true);
    assert.equal(wk1.warnCount, 1);
    assert.equal(wk1.kicked, false);

    const wk2 = await antiduplicateUtils.handleAntiDuplicateMessage({
      sock: env.sock,
      from: groupJid,
      sender: member,
      msg: buildMsg('wk-2', member, 'Spamm offerr onee'),
      text: 'Spamm offerr onee',
      store,
      tracker,
    });
    assert.equal(wk2.handled, true);
    assert.equal(wk2.warnCount, 2);
    assert.equal(wk2.kicked, true);
    assert.equal(env.kicked.length, 1);
    assert.equal(Object.keys(store.getGroupConfig(groupJid).warns).length, 0);

    // 3. Mute mode locks group
    tracker.clear();
    store.setGroupConfig(groupJid, { enabled: true, action: 'mute', sensitivity: 'sensitive', notify: true });
    env = createGroupMockSock();
    await antiduplicateUtils.handleAntiDuplicateMessage({
      sock: env.sock,
      from: groupJid,
      sender: member,
      msg: buildMsg('mu-1', member, 'Repeated ad text'),
      text: 'Repeated ad text',
      store,
      tracker,
    });
    const mu2 = await antiduplicateUtils.handleAntiDuplicateMessage({
      sock: env.sock,
      from: groupJid,
      sender: member,
      msg: buildMsg('mu-2', member, 'Repeated ad text'),
      text: 'Repeated ad text',
      store,
      tracker,
    });
    assert.equal(mu2.handled, true);
    assert.equal(mu2.muted, true);
    assert.deepEqual(env.settingsUpdates, [{ jid: groupJid, setting: 'announcement' }]);

    // 4. Whitelisted, admin, owner, non-admin bot guards
    store.addWhitelist(groupJid, '254700000004');
    env = createGroupMockSock();
    for (let i = 1; i <= 3; i += 1) {
      const wl = await antiduplicateUtils.handleAntiDuplicateMessage({
        sock: env.sock,
        from: groupJid,
        sender: whitelistedUser,
        msg: buildMsg(`wl-${i}`, whitelistedUser, 'Same line'),
        text: 'Same line',
        store,
        tracker,
      });
      assert.equal(wl.handled, false);
      assert.equal(wl.reason, 'whitelisted');
    }

    for (let i = 1; i <= 3; i += 1) {
      const adm = await antiduplicateUtils.handleAntiDuplicateMessage({
        sock: env.sock,
        from: groupJid,
        sender: adminUser,
        msg: buildMsg(`adm-${i}`, adminUser, 'Admin line'),
        text: 'Admin line',
        store,
        tracker,
      });
      assert.equal(adm.handled, false);
      assert.equal(adm.reason, 'sender-is-admin');
    }

    const nonAdminEnv = createGroupMockSock({ botIsAdmin: false });
    tracker.clear();
    await antiduplicateUtils.handleAntiDuplicateMessage({
      sock: nonAdminEnv.sock,
      from: groupJid,
      sender: member,
      msg: buildMsg('nba-1', member, 'Bot check line'),
      text: 'Bot check line',
      store,
      tracker,
    });
    const nba2 = await antiduplicateUtils.handleAntiDuplicateMessage({
      sock: nonAdminEnv.sock,
      from: groupJid,
      sender: member,
      msg: buildMsg('nba-2', member, 'Bot check line'),
      text: 'Bot check line',
      store,
      tracker,
    });
    assert.equal(nba2.handled, false);
    assert.equal(nba2.reason, 'bot-not-admin');
    assert.equal(nonAdminEnv.sent.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('spider/index.js hooks handleAntiDuplicateMessage and flushes defaultAntiduplicateStore', () => {
  const indexSource = fs.readFileSync(path.join(process.cwd(), 'spider', 'index.js'), 'utf8');
  assert.ok(indexSource.includes('./utils/antiduplicate.js'), 'spider/index.js must import utils/antiduplicate.js');
  assert.ok(indexSource.includes('handleAntiDuplicateMessage('), 'spider/index.js must call handleAntiDuplicateMessage');
  assert.ok(indexSource.includes("defaultAntiduplicateStore['flush']"), 'spider/index.js must flush defaultAntiduplicateStore');
});
