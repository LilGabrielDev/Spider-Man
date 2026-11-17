import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createAntibugStore,
  detectBugPayload,
  handleAntiBugMessage,
} from '../../spider/utils/antibug.js';
import {
  createAntiforwardStore,
  detectForwardedMessage,
  handleAntiForwardMessage,
} from '../../spider/utils/antiforward.js';
import {
  createAntichannelStore,
  detectChannelMessage,
  handleAntiChannelMessage,
} from '../../spider/utils/antichannel.js';
import {
  createAntimediaStore,
  detectAttachmentMessage,
  doesAttachmentMatchFilter,
  handleAntiAttachmentMessage,
} from '../../spider/utils/antimedia.js';
import {
  createAntirejoinStore,
  handleAntiRejoinUpdate,
  recordRemoveForAntiRejoin,
} from '../../spider/utils/antirejoin.js';
import {
  createAntiaddStore,
  handleAntiAddUpdate,
} from '../../spider/utils/antiadd.js';
import { reloadCommandsFromDisk } from '../../spider/utils/runtimeControl.js';
import { loadLegacyCommands } from '../utils/legacyPlugins.js';
import { commands as antiExtendedCommands } from '../commands/AntiExtended.js';

const GROUP_JID = '120363000000000999@g.us';
const BOT_JID = '254700000001@s.whatsapp.net';
const ADMIN_JID = '254700000002@s.whatsapp.net';
const USER_JID = '254700000003@s.whatsapp.net';
const USER_LID = '999888777@lid';
const OWNER_JID = '254700000000@s.whatsapp.net';

function createTempPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-anti-ext-'));
  return { dir, file: path.join(dir, name) };
}

function makeMockSock() {
  const sent = [];
  const updates = [];
  const ws = new EventEmitter();
  const sock = {
    user: { id: '254700000001:1@s.whatsapp.net', lid: '111222333@lid' },
    ws,
    groupMetadata: async (jid) => ({
      id: jid,
      subject: 'Shield Test Group',
      owner: OWNER_JID,
      participants: [
        { id: BOT_JID, admin: 'admin' },
        { id: ADMIN_JID, admin: 'admin' },
        { id: USER_JID, admin: null, lid: USER_LID },
      ],
    }),
    sendMessage: async (jid, payload, opts) => {
      const id = `msg-${sent.length + 1}`;
      sent.push({ jid, payload, opts, id });
      queueMicrotask(() => ws.emit('CB:ack,class:message', { attrs: { id } }));
      return { key: { id, remoteJid: jid, fromMe: true } };
    },
    groupParticipantsUpdate: async (jid, participants, action) => {
      updates.push({ jid, participants, action });
      return participants.map((p) => ({ status: '200', jid: p }));
    },
  };
  return { sock, sent, updates };
}

test('antibug: detects oversized text, Zalgo combining flood, zero-width spam, and vCard bombs', async () => {
  const clean = detectBugPayload({ text: 'Normal long discussion message '.repeat(30) });
  assert.equal(clean.isBug, false);

  const oversized = detectBugPayload({ text: 'A'.repeat(3005), maxLength: 3000 });
  assert.equal(oversized.isBug, true);
  assert.equal(oversized.type, 'oversized-text');

  const zalgo = detectBugPayload({ text: 'H' + '\u0301\u0302\u0308\u0327'.repeat(12) });
  assert.equal(zalgo.isBug, true);
  assert.equal(zalgo.type, 'combining-spam');

  const zw = detectBugPayload({ text: 'hi' + '\u200B\u200C\u200D'.repeat(20) });
  assert.equal(zw.isBug, true);
  assert.equal(zw.type, 'zero-width-spam');

  const vcardBomb = detectBugPayload({
    msg: { message: { contactMessage: { vcard: 'BEGIN:VCARD\n' + 'X'.repeat(8500) } } },
  });
  assert.equal(vcardBomb.isBug, true);
  assert.equal(vcardBomb.type, 'vcard-bomb');

  const { dir, file } = createTempPath('antibug.json');
  try {
    const store = createAntibugStore(file);
    store.setGroupConfig(GROUP_JID, { enabled: true, action: 'kick', maxLength: 3000 });
    const { sock, sent, updates } = makeMockSock();
    const res = await handleAntiBugMessage({
      sock,
      from: GROUP_JID,
      sender: USER_JID,
      msg: {
        key: { id: 'bug-1', remoteJid: GROUP_JID, participant: USER_JID },
        message: { conversation: 'V'.repeat(3200) },
      },
      text: 'V'.repeat(3200),
      store,
    });
    assert.equal(res.handled, true);
    assert.equal(res.deleted, true);
    assert.equal(res.kicked, true);
    assert.ok(sent.some((s) => s.payload?.delete?.id === 'bug-1'));
    assert.ok(updates.some((u) => u.action === 'remove' && u.participants.includes(USER_JID)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('antiforward: supports all vs many-times modes and exempts admins', async () => {
  const singleFwdMsg = {
    key: { id: 'fwd-1', remoteJid: GROUP_JID, participant: USER_JID },
    message: {
      extendedTextMessage: {
        text: 'Forwarded promo without link',
        contextInfo: { isForwarded: true, forwardingScore: 1 },
      },
    },
  };
  const viralFwdMsg = {
    key: { id: 'fwd-2', remoteJid: GROUP_JID, participant: USER_JID },
    message: {
      extendedTextMessage: {
        text: 'Viral chain',
        contextInfo: { isForwarded: true, forwardingScore: 12 },
      },
    },
  };

  assert.equal(detectForwardedMessage({ msg: singleFwdMsg, mode: 'all' }).isForwarded, true);
  assert.equal(detectForwardedMessage({ msg: singleFwdMsg, mode: 'many' }).isForwarded, false);
  assert.equal(detectForwardedMessage({ msg: viralFwdMsg, mode: 'many' }).isForwarded, true);
  assert.equal(detectForwardedMessage({ msg: viralFwdMsg, mode: 'many' }).isManyTimes, true);

  const { dir, file } = createTempPath('antiforward.json');
  try {
    const store = createAntiforwardStore(file);
    store.setGroupConfig(GROUP_JID, { enabled: true, action: 'delete', mode: 'many' });
    const { sock, sent } = makeMockSock();

    const skippedSingle = await handleAntiForwardMessage({
      sock,
      from: GROUP_JID,
      sender: USER_JID,
      msg: singleFwdMsg,
      store,
    });
    assert.equal(skippedSingle.handled, false);

    const handledViral = await handleAntiForwardMessage({
      sock,
      from: GROUP_JID,
      sender: USER_JID,
      msg: viralFwdMsg,
      store,
    });
    assert.equal(handledViral.handled, true);
    assert.equal(handledViral.deleted, true);
    assert.ok(sent.some((s) => s.payload?.delete?.id === 'fwd-2'));

    const adminSkipped = await handleAntiForwardMessage({
      sock,
      from: GROUP_JID,
      sender: ADMIN_JID,
      msg: { ...viralFwdMsg, key: { id: 'fwd-adm', remoteJid: GROUP_JID, participant: ADMIN_JID } },
      store,
    });
    assert.equal(adminSkipped.handled, false);
    assert.equal(adminSkipped.reason, 'sender-is-admin');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('antichannel: catches forwardedNewsletterMessageInfo cards without blocking plain user forwards', async () => {
  const channelCardMsg = {
    key: { id: 'ch-1', remoteJid: GROUP_JID, participant: USER_JID },
    message: {
      extendedTextMessage: {
        text: 'Join updates',
        contextInfo: {
          isForwarded: true,
          forwardingScore: 2,
          forwardedNewsletterMessageInfo: {
            newsletterJid: '120363999999@newsletter',
            newsletterName: 'Promo News',
            serverMessageId: 42,
          },
        },
      },
    },
  };
  const plainUserForward = {
    key: { id: 'ch-2', remoteJid: GROUP_JID, participant: USER_JID },
    message: {
      extendedTextMessage: {
        text: 'Just a friend quote',
        contextInfo: { isForwarded: true, forwardingScore: 2 },
      },
    },
  };

  assert.equal(detectChannelMessage({ msg: channelCardMsg }).isChannel, true);
  assert.equal(detectChannelMessage({ msg: plainUserForward }).isChannel, false);

  const { dir, file } = createTempPath('antichannel.json');
  try {
    const store = createAntichannelStore(file);
    store.setGroupConfig(GROUP_JID, { enabled: true, action: 'warn', maxWarns: 2 });
    const { sock, sent, updates } = makeMockSock();

    const r1 = await handleAntiChannelMessage({ sock, from: GROUP_JID, sender: USER_JID, msg: channelCardMsg, store });
    assert.equal(r1.handled, true);
    assert.equal(r1.warnCount, 1);
    assert.equal(r1.kicked, false);

    // Second offense hits maxWarns=2 -> kicks
    const r2 = await handleAntiChannelMessage({ sock, from: GROUP_JID, sender: USER_JID, msg: channelCardMsg, store });
    assert.equal(r2.handled, true);
    assert.equal(r2.kicked, true);
    assert.ok(updates.some((u) => u.action === 'remove'));

    // Whitelisting the channel JID exempts it
    store.addWhitelist(GROUP_JID, '120363999999@newsletter');
    const r3 = await handleAntiChannelMessage({ sock, from: GROUP_JID, sender: USER_JID, msg: channelCardMsg, store });
    assert.equal(r3.handled, false);
    assert.equal(r3.reason, 'whitelisted');
    assert.ok(sent.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('antimedia suite: granular toggles & filters for antisticker, antimedia, antivoice, antidoc', async () => {
  const stickerMsg = {
    key: { id: 'm-1', remoteJid: GROUP_JID, participant: USER_JID },
    message: { stickerMessage: { mimetype: 'image/webp' } },
  };
  const viewOnceImage = {
    key: { id: 'm-2', remoteJid: GROUP_JID, participant: USER_JID },
    message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } } },
  };
  const voicePtt = {
    key: { id: 'm-3', remoteJid: GROUP_JID, participant: USER_JID },
    message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } },
  };
  const apkDoc = {
    key: { id: 'm-4', remoteJid: GROUP_JID, participant: USER_JID },
    message: {
      documentWithCaptionMessage: {
        message: {
          documentMessage: {
            fileName: 'mod-app.apk',
            mimetype: 'application/vnd.android.package-archive',
          },
        },
      },
    },
  };
  const vcardMsg = {
    key: { id: 'm-5', remoteJid: GROUP_JID, participant: USER_JID },
    message: { contactMessage: { displayName: 'Tester', vcard: 'BEGIN:VCARD' } },
  };

  assert.equal(detectAttachmentMessage(stickerMsg).type, 'sticker');
  assert.equal(detectAttachmentMessage(viewOnceImage).type, 'media');
  assert.equal(detectAttachmentMessage(voicePtt).type, 'voice');
  assert.equal(detectAttachmentMessage(apkDoc).subType, 'apk');
  assert.equal(detectAttachmentMessage(vcardMsg).subType, 'vcard');
  assert.equal(doesAttachmentMatchFilter(detectAttachmentMessage(apkDoc), 'apk'), true);
  assert.equal(doesAttachmentMatchFilter(detectAttachmentMessage(vcardMsg), 'apk'), false);

  const { dir, file } = createTempPath('antimedia.json');
  try {
    const store = createAntimediaStore(file);
    store.setTypeConfig(GROUP_JID, 'sticker', { enabled: true, action: 'delete' });
    store.setTypeConfig(GROUP_JID, 'doc', { enabled: true, action: 'kick', filter: 'apk' });

    const { sock, sent, updates } = makeMockSock();

    // Sticker deleted (not kicked)
    const sRes = await handleAntiAttachmentMessage({ sock, from: GROUP_JID, sender: USER_JID, msg: stickerMsg, store });
    assert.equal(sRes.handled, true);
    assert.equal(sRes.deleted, true);
    assert.equal(sRes.kicked, false);

    // Image ignored since antimedia is OFF
    const imgRes = await handleAntiAttachmentMessage({ sock, from: GROUP_JID, sender: USER_JID, msg: viewOnceImage, store });
    assert.equal(imgRes.handled, false);

    // vCard ignored because antidoc filter is set to 'apk'
    const vRes = await handleAntiAttachmentMessage({ sock, from: GROUP_JID, sender: USER_JID, msg: vcardMsg, store });
    assert.equal(vRes.handled, false);

    // APK deleted & kicked
    const apkRes = await handleAntiAttachmentMessage({ sock, from: GROUP_JID, sender: USER_JID, msg: apkDoc, store });
    assert.equal(apkRes.handled, true);
    assert.equal(apkRes.deleted, true);
    assert.equal(apkRes.kicked, true);
    assert.ok(sent.some((s) => s.payload?.delete?.id === 'm-1'));
    assert.ok(updates.some((u) => u.action === 'remove'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('antirejoin & antiadd: remembers kicks, auto-removes rejoined bans, and blocks rogue member/co-admin adds', async () => {
  const { dir, file } = createTempPath('antirejoin.json');
  const { dir: addDir, file: addFile } = createTempPath('antiadd.json');
  try {
    const rejoinStore = createAntirejoinStore(file);
    rejoinStore.setGroupConfig(GROUP_JID, { enabled: true, autobanOnKick: true });

    const addStore = createAntiaddStore(addFile);
    addStore.setGroupConfig(GROUP_JID, { enabled: true, action: 'remove', allowAdmins: false });

    const { sock, updates } = makeMockSock();

    // Voluntary leave should NOT be banned
    const selfLeave = await recordRemoveForAntiRejoin({
      sock,
      update: { id: GROUP_JID, action: 'remove', author: USER_JID, participants: [USER_JID] },
      store: rejoinStore,
    });
    assert.equal(selfLeave.recorded, 0);

    // Admin kick SHOULD be recorded
    const adminKick = await recordRemoveForAntiRejoin({
      sock,
      update: { id: GROUP_JID, action: 'remove', author: ADMIN_JID, participants: [USER_JID] },
      store: rejoinStore,
    });
    assert.equal(adminKick.recorded, 1);

    // Banned user rejoins via invite link using their LID -> auto-removed!
    const rejoinAttempt = await handleAntiRejoinUpdate({
      sock,
      update: { id: GROUP_JID, action: 'add', participants: [USER_LID] },
      store: rejoinStore,
    });
    assert.equal(rejoinAttempt.handled, true);
    assert.deepEqual(rejoinAttempt.removedParticipants, [USER_LID]);
    assert.ok(updates.some((u) => u.action === 'remove' && u.participants.includes(USER_LID)));

    // Explicitly unban -> rejoin passes
    rejoinStore.unbanUser(GROUP_JID, [USER_JID]);
    const cleanRejoin = await handleAntiRejoinUpdate({
      sock,
      update: { id: GROUP_JID, action: 'add', participants: [USER_JID] },
      store: rejoinStore,
    });
    assert.equal(cleanRejoin.handled, false);

    // Rogue co-admin adds new account -> antiadd removes added account!
    const newMember = '254711111111@s.whatsapp.net';
    const addBlocked = await handleAntiAddUpdate({
      sock,
      update: { id: GROUP_JID, action: 'add', author: ADMIN_JID, participants: [newMember] },
      store: addStore,
    });
    assert.equal(addBlocked.handled, true);
    assert.deepEqual(addBlocked.removedTargets, [newMember]);

    // When allowAdmins: true, admin add is allowed; non-admin add is still blocked
    addStore.setGroupConfig(GROUP_JID, { allowAdmins: true });
    const adminAllowed = await handleAntiAddUpdate({
      sock,
      update: { id: GROUP_JID, action: 'add', author: ADMIN_JID, participants: [newMember] },
      store: addStore,
    });
    assert.equal(adminAllowed.handled, false);
    assert.equal(adminAllowed.reason, 'added-by-allowed-admin');

    // Invite-link self-join (!author) is never blocked by antiadd
    const linkJoin = await handleAntiAddUpdate({
      sock,
      update: { id: GROUP_JID, action: 'add', participants: [newMember] },
      store: addStore,
    });
    assert.equal(linkJoin.handled, false);
    assert.equal(linkJoin.reason, 'no-author-self-join');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(addDir, { recursive: true, force: true });
  }
});

test('AntiExtended commands load with zero collisions and respond cleanly', async () => {
  const repoRoot = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-anti-cmds-'));
  const commandsMap = new Map();
  const aliasesMap = new Map();
  try {
    await reloadCommandsFromDisk({
      commandsDir: path.join(repoRoot, 'Spider', 'commands'),
      commandsMap,
      aliasesMap,
      loadLegacyFn: loadLegacyCommands,
      pathToFileUrlFn: pathToFileURL,
      fsImpl: fs,
      pathImpl: path,
    });

    const expectedNames = [
      'antibug',
      'antiforward',
      'antichannel',
      'antirejoin',
      'antiadd',
      'antisticker',
      'antimedia',
      'antivoice',
      'antidoc',
    ];
    for (const name of expectedNames) {
      assert.ok(commandsMap.has(name), `Command "${name}" must be registered`);
    }
    for (const alias of ['antivirtex', 'anticrash', 'antinewsletter', 'autoban', 'antiapk']) {
      assert.ok(aliasesMap.has(alias), `Alias "${alias}" must be registered`);
    }

    const { sock, sent } = makeMockSock();
    for (const cmd of antiExtendedCommands) {
      await cmd.execute({
        sock,
        from: GROUP_JID,
        sender: ADMIN_JID,
        msg: { key: { id: `cmd-${cmd.name}`, remoteJid: GROUP_JID, fromMe: true, participant: ADMIN_JID } },
        args: [],
        text: '',
        isGroupAdmin: true,
        isBotGroupAdmin: true,
        isOwner: true,
        config: { BOT_NAME: 'Spider Man', PREFIXES: ['.'] },
      });
    }
    assert.equal(sent.length, antiExtendedCommands.length);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
