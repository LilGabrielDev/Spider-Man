import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import config from '../../spider/config.js';
import { deleteMessageSafely } from '../../spider/utils/groupActionHelper.js';
import { createAntilinkStore, defaultAntilinkStore, handleAntiLinkMessage } from '../../spider/utils/antilink.js';
import {
  createAntibadwordStore,
  defaultAntibadwordStore,
  detectBadword,
  handleAntiBadwordMessage,
} from '../../spider/utils/antibadword.js';
import { createAntitagStore, detectMassTag, handleAntiTagMessage } from '../../spider/utils/antitag.js';
import { createAntimentionStore, detectGroupMention, handleAntiMentionMessage } from '../../spider/utils/antimention.js';
import { createAntispamStore, createSpamTracker, handleAntiSpamMessage } from '../../spider/utils/antispam.js';
import { createAntibotStore, detectBotActivity, handleAntiBotMessage } from '../../spider/utils/antibot.js';
import { createAntidemoteStore, handleAntiDemoteEvent } from '../../spider/utils/antidemote.js';
import {
  defaultAnticallStore,
  createAnticallStore,
  handleAntiCallEvents,
  resetAnticallCooldowns,
} from '../../spider/utils/anticall.js';
import {
  defaultAntideleteStore,
  handleDeletedMessage,
  handleEditedMessage,
  rememberMessage,
  resetMessageRetryStore,
} from '../../spider/anti.js';
import {
  createAntivvStore,
  defaultAntivvStore,
  extractViewOnceMedia,
  handleViewOnceAutoSave,
} from '../../spider/viewOnceAutoSave.js';

import { commands as antiCommands } from '../commands/Anti.js';
import { commands as groupCommands } from '../commands/Group.js';
import { commands as userCommands } from '../commands/User.js';
import { commands as adminCommands } from '../commands/Admin.js';
import { commands as antifloodCommands } from '../commands/Antiflood.js';
import { commands as antiscamCommands } from '../commands/Antiscam.js';
import { commands as antiadCommands } from '../commands/Antiadvertisement.js';

function createGroupMockSock({
  botId = '254700000099:1@s.whatsapp.net',
  botLid = '99887766554433:2@lid',
  metadata = null,
  lidToPn = {},
} = {}) {
  const sent = [];
  const participantUpdates = [];
  const settingUpdates = [];
  const rejectedCalls = [];
  const blockedUsers = [];
  const ws = new EventEmitter();
  let seq = 0;

  const sock = {
    user: { id: botId, lid: botLid },
    ws,
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid) => lidToPn[lid] || null,
        getLIDForPN: async (pn) => {
          const found = Object.entries(lidToPn).find(([, v]) => v === pn);
          return found ? found[0] : null;
        },
      },
    },
    groupMetadata: async () => metadata,
    sendMessage: async (jid, payload, options = {}) => {
      seq += 1;
      const id = `ack-msg-${seq}`;
      sent.push({ jid, payload, options, id });
      if (payload?.delete) {
        queueMicrotask(() => {
          ws.emit('CB:ack,class:message', { attrs: { id } });
        });
      }
      return { key: { id, remoteJid: jid, fromMe: true } };
    },
    groupParticipantsUpdate: async (jid, participants, action) => {
      participantUpdates.push({ jid, participants, action });
      return participants.map((p) => ({ jid: p, status: '200' }));
    },
    groupSettingUpdate: async (jid, setting) => {
      settingUpdates.push({ jid, setting });
      return { status: 200 };
    },
    rejectCall: async (id, from) => {
      rejectedCalls.push({ id, from });
    },
    updateBlockStatus: async (jid, status) => {
      blockedUsers.push({ jid, status });
    },
  };

  return { sock, sent, participantUpdates, settingUpdates, rejectedCalls, blockedUsers };
}

function makeTempFile(tmpDir, name) {
  return path.join(tmpDir, name);
}

test('deleteMessageSafely deletes on both sides (device-suffixed, clean PN, and LID) and marks moderated IDs', async () => {
  const groupJid = '120363000000100001@g.us';
  const metadata = {
    id: groupJid,
    addressingMode: 'lid',
    participants: [
      { id: '254700000099@s.whatsapp.net', lid: '99887766554433@lid', admin: 'admin' },
      { id: '11223344556677@lid', phoneNumber: '254712345678@s.whatsapp.net', admin: null },
    ],
  };

  const { sock, sent } = createGroupMockSock({
    metadata,
    lidToPn: { '11223344556677@lid': '254712345678@s.whatsapp.net' },
  });

  const targetMsg = {
    key: {
      remoteJid: groupJid,
      id: 'MSG-BOTH-SIDES-1',
      fromMe: false,
      participant: '11223344556677:17@lid',
    },
  };

  const res = await deleteMessageSafely({
    sock,
    from: groupJid,
    msg: targetMsg,
    metadata,
    getPhoneFn: () => '254712345678',
    broadcastAlternates: true,
  });

  assert.equal(res.ok, true);
  assert.ok(res.attempts >= 2, 'Expected both primary delete and alternate format delete attempts');

  const deleteKeys = sent.filter((s) => s.payload?.delete).map((s) => s.payload.delete);
  const participantFormats = deleteKeys.map((k) => k.participant);

  assert.ok(participantFormats.includes('11223344556677:17@lid'), 'Must send exact raw key');
  assert.ok(participantFormats.includes('11223344556677@lid'), 'Must send clean device-stripped LID');
  assert.ok(participantFormats.includes('254712345678@s.whatsapp.net'), 'Must send mapped PN format');

  // Verify antidelete ignores bot-moderated IDs so deleted spam is not re-posted
  resetMessageRetryStore();
  rememberMessage({
    key: targetMsg.key,
    message: { conversation: 'Spam link https://evil.test' },
  });
  const adRes = await handleDeletedMessage(
    {
      key: { remoteJid: groupJid, id: 'REV-1', fromMe: false },
      message: { protocolMessage: { type: 0, key: targetMsg.key } },
    },
    sock,
    () => '254712345678@s.whatsapp.net',
    () => '254700000099@s.whatsapp.net',
  );
  assert.equal(adRes.handled, false);
  assert.equal(adRes.reason, 'bot-moderated');
  resetMessageRetryStore();
});

test('User .del deletes replied message AND .del <count> batch-deletes recent messages on both sides', async () => {
  const groupJid = '120363000000100002@g.us';
  const metadata = {
    id: groupJid,
    participants: [
      { id: '254700000099@s.whatsapp.net', admin: 'admin' },
      { id: '223344556677@lid', phoneNumber: '254722223333@s.whatsapp.net', admin: null },
    ],
  };
  const { sock, sent } = createGroupMockSock({ metadata });
  const delCmd = userCommands.find((c) => c.name === 'del');
  assert.ok(delCmd);

  resetMessageRetryStore();
  try {
    // Seed 3 messages in chat store
    for (const id of ['M1', 'M2', 'M3']) {
      rememberMessage({
        key: { remoteJid: groupJid, id, fromMe: false, participant: '223344556677@lid' },
        message: { conversation: `hello ${id}` },
      });
    }

    // Quoted .del
    await delCmd.execute({
      sock,
      from: groupJid,
      text: '',
      args: [],
      msg: {
        key: { remoteJid: groupJid, id: 'CMD-DEL-1', fromMe: true },
        message: {
          extendedTextMessage: {
            contextInfo: {
              stanzaId: 'QUOTED-99',
              participant: '223344556677@lid',
              quotedMessage: { conversation: 'delete this' },
            },
          },
        },
      },
    });
    const quotedDeletes = sent.filter((s) => s.payload?.delete?.id === 'QUOTED-99').map((s) => s.payload.delete.participant);
    assert.ok(quotedDeletes.includes('223344556677@lid'));
    assert.ok(quotedDeletes.includes('254722223333@s.whatsapp.net'));

    // Batch .del 2
    await delCmd.execute({
      sock,
      from: groupJid,
      text: '2',
      args: ['2'],
      msg: {
        key: { remoteJid: groupJid, id: 'CMD-DEL-BATCH', fromMe: true },
        message: { conversation: '.del 2' },
      },
    });
    const batchDeletedIds = new Set(sent.filter((s) => s.payload?.delete).map((s) => s.payload.delete.id));
    assert.ok(batchDeletedIds.has('M3'));
    assert.ok(batchDeletedIds.has('M2'));
  } finally {
    resetMessageRetryStore();
  }
});

test('globalantilink protects groups when local antilink is disabled, and per-group config overrides it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-globalantilink-'));
  try {
    const store = createAntilinkStore(makeTempFile(tmpDir, 'antilink.json'));
    const groupJid = '120363000000100003@g.us';
    const metadata = {
      id: groupJid,
      participants: [
        { id: '254700000099@s.whatsapp.net', admin: 'admin' },
        { id: '254733334444@s.whatsapp.net', lid: '334455667788@lid', admin: null },
      ],
    };

    store.setGlobalConfig({ enabled: true, action: 'delete' });

    const { sock, sent } = createGroupMockSock({ metadata });
    const msg = {
      key: { remoteJid: groupJid, id: 'LINK-GLOBAL-1', fromMe: false, participant: '254733334444@s.whatsapp.net' },
      message: { conversation: 'Join https://chat.whatsapp.com/ABC12345678' },
    };

    const res = await handleAntiLinkMessage({ sock, from: groupJid, sender: '254733334444@s.whatsapp.net', msg, store });
    assert.equal(res.handled, true);
    assert.equal(res.deleted, true);
    assert.equal(res.action, 'delete');

    const delParts = sent.filter((s) => s.payload?.delete?.id === 'LINK-GLOBAL-1').map((s) => s.payload.delete.participant);
    assert.ok(delParts.includes('254733334444@s.whatsapp.net'));
    assert.ok(delParts.includes('334455667788@lid'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('antibadword detects default + custom words, deletes both sides, warns, and kicks at maxWarns', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antibadword-'));
  try {
    const store = createAntibadwordStore({ filePath: makeTempFile(tmpDir, 'antibadword.json') });
    const groupJid = '120363000000100004@g.us';
    const metadata = {
      id: groupJid,
      participants: [
        { id: '254700000099@s.whatsapp.net', admin: 'admin' },
        { id: '445566778899@lid', phoneNumber: '254744445555@s.whatsapp.net', admin: null },
      ],
    };

    store.setGroupConfig(groupJid, { enabled: true, action: 'warnkick', maxWarns: 2 });
    store.addCustomWord(groupJid, 'scamcoin');

    assert.equal(detectBadword('buy scamcoin now', store.getGroupConfig(groupJid)).matched, true);
    assert.equal(detectBadword('hello friend', store.getGroupConfig(groupJid)).matched, false);

    const { sock, sent, participantUpdates } = createGroupMockSock({ metadata });
    const sender = '445566778899@lid';

    const r1 = await handleAntiBadwordMessage({
      sock,
      from: groupJid,
      sender,
      msg: { key: { remoteJid: groupJid, id: 'BW-1', fromMe: false, participant: sender }, message: { conversation: 'what the fuck' } },
      store,
      getPhoneFromJid: () => '254744445555',
    });
    assert.equal(r1.handled, true);
    assert.equal(r1.deleted, true);
    assert.equal(r1.warnedCount, 1);
    assert.equal(r1.kicked, false);

    const r2 = await handleAntiBadwordMessage({
      sock,
      from: groupJid,
      sender,
      msg: { key: { remoteJid: groupJid, id: 'BW-2', fromMe: false, participant: sender }, message: { conversation: 'join scamcoin' } },
      store,
      getPhoneFromJid: () => '254744445555',
    });
    assert.equal(r2.handled, true);
    assert.equal(r2.deleted, true);
    assert.equal(r2.kicked, true);
    assert.equal(participantUpdates.length, 1);
    assert.equal(participantUpdates[0].action, 'remove');

    const bw1Deletes = sent.filter((s) => s.payload?.delete?.id === 'BW-1').map((s) => s.payload.delete.participant);
    assert.ok(bw1Deletes.includes('445566778899@lid'));
    assert.ok(bw1Deletes.includes('254744445555@s.whatsapp.net'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('antibadword strict mode catches obfuscation, homoglyphs, leetspeak, spacing, elongation, and mute while sparing clean words', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antibadword-strict-'));
  try {
    const store = createAntibadwordStore({ filePath: makeTempFile(tmpDir, 'antibadword.json') });
    const groupJid = '120363000000100099@g.us';
    const metadata = {
      id: groupJid,
      participants: [
        { id: '254700000099@s.whatsapp.net', admin: 'admin' },
        { id: '254766660001@s.whatsapp.net', admin: null },
      ],
    };

    const defaultCfg = store.getGroupConfig(groupJid);
    assert.equal(defaultCfg.strict, true);
    assert.equal(defaultCfg.action, 'warnkick');
    assert.equal(defaultCfg.maxWarns, 2);

    store.setGroupConfig(groupJid, { enabled: true, strict: true, action: 'mute' });
    store.addCustomWord(groupJid, 'scamcoin');

    const evasionPayloads = [
      'f\u200Buck this', // zero-width char
      'you ѕhіt', // Cyrillic homoglyphs
      '𝐟𝐮𝐜𝐤 off', // math bold unicode
      'f u c k you', // spaced characters
      's.h.i.t happens', // dot-separated
      'total b-i-t-c-h', // hyphen-separated
      'sh1thead', // leetspeak + compound
      'complete a$$hole', // symbol leetspeak
      's**t man', // wildcard masked
      'fuuuuuuuck', // elongated repeat
      'stop bullshitting', // compound profanity stem
      'join s.c.a.m.c.o.i.n', // separated custom word
    ];
    for (const sample of evasionPayloads) {
      assert.equal(
        detectBadword(sample, store.getGroupConfig(groupJid)).matched,
        true,
        `Expected strict antibadword to catch: ${sample}`,
      );
    }

    const cleanPayloads = [
      'hello friend',
      'classic cocktail party',
      'please assess the assumption',
      'passing through scunthorpe by parachute',
      'good morning class',
    ];
    for (const sample of cleanPayloads) {
      assert.equal(
        detectBadword(sample, store.getGroupConfig(groupJid)).matched,
        false,
        `Unexpected false positive on clean text: ${sample}`,
      );
    }

    // Whitelist allows specific term
    store.addWhitelistWord(groupJid, 'scamcoin');
    assert.equal(detectBadword('buy scamcoin', store.getGroupConfig(groupJid)).matched, false);

    // Standard mode (strict: false) only matches clean boundaries
    assert.equal(detectBadword('fuuuuuuuck', { strict: false }).matched, false);
    assert.equal(detectBadword('what the fuck', { strict: false }).matched, true);

    // Mute enforcement locks group chat and deletes offending document filename
    const { sock, settingUpdates, sent } = createGroupMockSock({ metadata });
    const muteRes = await handleAntiBadwordMessage({
      sock,
      from: groupJid,
      sender: '254766660001@s.whatsapp.net',
      msg: {
        key: { remoteJid: groupJid, id: 'BW-MUTE-1', fromMe: false, participant: '254766660001@s.whatsapp.net' },
        message: { documentMessage: { fileName: 'b.i.t.c.h.pdf' } },
      },
      store,
    });
    assert.equal(muteRes.handled, true);
    assert.equal(muteRes.deleted, true);
    assert.equal(muteRes.muted, true);
    assert.equal(settingUpdates.length, 1);
    assert.equal(settingUpdates[0].setting, 'announcement');
    assert.ok(sent.some((s) => s.payload?.delete?.id === 'BW-MUTE-1'));

    // Command `.antibadword strict` activates zero-tolerance preset cleanly
    const cmd = antiCommands.find((c) => c.name === 'antibadword');
    assert.ok(cmd);
    const cmdGroup = '120363000000100100@g.us';
    const cmdSent = [];
    const cmdSock = {
      async sendMessage(_to, payload) {
        cmdSent.push(payload);
      },
    };
    try {
      await cmd.execute({
        sock: cmdSock,
        from: cmdGroup,
        msg: { key: { remoteJid: cmdGroup, id: 'CMD-1' } },
        text: 'strict',
        args: ['strict'],
        config,
        isGroupAdmin: true,
        isBotGroupAdmin: true,
        isOwner: true,
      });
      const updated = defaultAntibadwordStore.getGroupConfig(cmdGroup);
      assert.equal(updated.enabled, true);
      assert.equal(updated.strict, true);
      assert.equal(updated.action, 'kick');
      assert.equal(updated.maxWarns, 1);
      assert.match(cmdSent[0].text, /ANTIBADWORD STRICT PRESET/);
    } finally {
      defaultAntibadwordStore.resetAll();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('antitag blocks mass mentions and deletes both sides / kicks offender', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antitag-'));
  try {
    const store = createAntitagStore({ filePath: makeTempFile(tmpDir, 'antitag.json') });
    const groupJid = '120363000000100005@g.us';
    const metadata = {
      id: groupJid,
      participants: [
        { id: '254700000099@s.whatsapp.net', admin: 'admin' },
        { id: '254755550001@s.whatsapp.net', admin: null },
        { id: '254755550002@s.whatsapp.net', admin: null },
        { id: '254755550003@s.whatsapp.net', admin: null },
        { id: '254755550004@s.whatsapp.net', admin: null },
        { id: '254755550005@s.whatsapp.net', admin: null },
      ],
    };

    store.setGroupConfig(groupJid, { enabled: true, action: 'kick' });

    const { sock, sent, participantUpdates } = createGroupMockSock({ metadata });
    const sender = '254755550001@s.whatsapp.net';
    const tagMsg = {
      key: { remoteJid: groupJid, id: 'TAG-1', fromMe: false, participant: sender },
      message: {
        extendedTextMessage: {
          text: '@254755550002 @254755550003 @254755550004',
          contextInfo: {
            mentionedJid: [
              '254755550002@s.whatsapp.net',
              '254755550003@s.whatsapp.net',
              '254755550004@s.whatsapp.net',
              '254755550005@s.whatsapp.net',
            ],
          },
        },
      },
    };

    assert.equal(detectMassTag({ msg: tagMsg, participantsCount: 6 }).isMassTag, true);
    const res = await handleAntiTagMessage({ sock, from: groupJid, sender, msg: tagMsg, store });
    assert.equal(res.handled, true);
    assert.equal(res.deleted, true);
    assert.equal(res.kicked, true);
    assert.ok(sent.some((s) => s.payload?.delete?.id === 'TAG-1'));
    assert.equal(participantUpdates[0].action, 'remove');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('antimention & globalantimention detect groupMentions/statusMentions and enforce deletion/kick', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antimention-'));
  try {
    const store = createAntimentionStore({ filePath: makeTempFile(tmpDir, 'antimention.json') });
    const groupJid = '120363000000100006@g.us';
    const metadata = {
      id: groupJid,
      participants: [
        { id: '254700000099@s.whatsapp.net', admin: 'admin' },
        { id: '556677889900@lid', phoneNumber: '254766667777@s.whatsapp.net', admin: null },
      ],
    };

    // Enable via global config even while per-group is off
    store.setGlobalConfig({ enabled: true, action: 'delete' });

    const { sock, sent } = createGroupMockSock({ metadata });
    const mentionMsg = {
      key: { remoteJid: groupJid, id: 'GM-1', fromMe: false, participant: '556677889900@lid' },
      message: {
        groupMentionedMessage: { message: { conversation: '@group look here' } },
      },
    };

    assert.equal(detectGroupMention(mentionMsg).isGroupMention, true);
    const res = await handleAntiMentionMessage({
      sock,
      from: groupJid,
      sender: '556677889900@lid',
      msg: mentionMsg,
      store,
      getPhoneFromJid: () => '254766667777',
    });
    assert.equal(res.handled, true);
    assert.equal(res.deleted, true);
    const gmDeletes = sent.filter((s) => s.payload?.delete?.id === 'GM-1').map((s) => s.payload.delete.participant);
    assert.ok(gmDeletes.includes('556677889900@lid'));
    assert.ok(gmDeletes.includes('254766667777@s.whatsapp.net'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('antispam deletes repeated burst messages on both sides and mutes/kicks when configured', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antispam-'));
  try {
    const store = createAntispamStore({ filePath: makeTempFile(tmpDir, 'antispam.json') });
    const tracker = createSpamTracker();
    const groupJid = '120363000000100007@g.us';
    const metadata = {
      id: groupJid,
      participants: [
        { id: '254700000099@s.whatsapp.net', admin: 'admin' },
        { id: '254777778888@s.whatsapp.net', lid: '778899001122@lid', admin: null },
      ],
    };

    store.setGroupConfig(groupJid, { enabled: true, action: 'mute', repeatLimit: 3, windowSec: 15 });
    const { sock, sent, settingUpdates } = createGroupMockSock({ metadata });
    const sender = '254777778888@s.whatsapp.net';

    for (const id of ['SP-1', 'SP-2']) {
      const r = await handleAntiSpamMessage({
        sock,
        from: groupJid,
        sender,
        msg: { key: { remoteJid: groupJid, id, fromMe: false, participant: sender }, message: { conversation: 'BUY NOW' } },
        store,
        tracker,
      });
      assert.equal(r.handled, false);
    }

    const r3 = await handleAntiSpamMessage({
      sock,
      from: groupJid,
      sender,
      msg: { key: { remoteJid: groupJid, id: 'SP-3', fromMe: false, participant: sender }, message: { conversation: 'BUY NOW' } },
      store,
      tracker,
    });
    assert.equal(r3.handled, true);
    assert.equal(r3.deletedCount, 3);
    assert.equal(r3.muted, true);
    assert.equal(settingUpdates[0]?.setting, 'announcement');

    const deletedIds = new Set(sent.filter((s) => s.payload?.delete).map((s) => s.payload.delete.id));
    assert.deepEqual([...deletedIds].sort(), ['SP-1', 'SP-2', 'SP-3']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('antibot catches unauthorized commands & BAE5 bot payloads while exempting admins', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antibot-'));
  try {
    const store = createAntibotStore({ filePath: makeTempFile(tmpDir, 'antibot.json') });
    const groupJid = '120363000000100008@g.us';
    const metadata = {
      id: groupJid,
      participants: [
        { id: '254700000099@s.whatsapp.net', admin: 'admin' },
        { id: '254788889999@s.whatsapp.net', admin: null },
      ],
    };

    store.setGroupConfig(groupJid, { enabled: true, action: 'kick' });
    const { sock, sent, participantUpdates } = createGroupMockSock({ metadata });

    const baeMsg = {
      key: { remoteJid: groupJid, id: 'BAE5AABBCCDD1122', fromMe: false, participant: '254788889999@s.whatsapp.net' },
      message: { conversation: 'automated message' },
    };
    assert.equal(detectBotActivity({ msg: baeMsg }).isBot, true);

    const res = await handleAntiBotMessage({
      sock,
      from: groupJid,
      sender: '254788889999@s.whatsapp.net',
      msg: baeMsg,
      store,
    });
    assert.equal(res.handled, true);
    assert.equal(res.deleted, true);
    assert.equal(res.kicked, true);
    assert.ok(sent.some((s) => s.payload?.delete?.id === 'BAE5AABBCCDD1122'));
    assert.equal(participantUpdates[0]?.action, 'remove');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('antidemote re-promotes demoted admin and kicks unauthorized demoter while skipping owners', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antidemote-'));
  try {
    const store = createAntidemoteStore({ filePath: makeTempFile(tmpDir, 'antidemote.json') });
    const groupJid = '120363000000100009@g.us';
    const metadata = {
      id: groupJid,
      participants: [
        { id: '254700000099@s.whatsapp.net', admin: 'admin' },
        { id: '254711110000@s.whatsapp.net', admin: 'admin' },
        { id: '254799990000@s.whatsapp.net', admin: 'admin' },
      ],
    };

    store.setGroupConfig(groupJid, { enabled: true, action: 'revertkick' });
    const { sock, participantUpdates } = createGroupMockSock({ metadata });

    // Owner demotion is skipped
    const ownerRes = await handleAntiDemoteEvent({
      sock,
      update: {
        id: groupJid,
        action: 'demote',
        author: '254700000001@s.whatsapp.net',
        participants: ['254799990000@s.whatsapp.net'],
      },
      isOwnerJid: (jid) => jid === '254700000001@s.whatsapp.net',
      store,
    });
    assert.equal(ownerRes.handled, false);
    assert.equal(ownerRes.skipped, 'privileged-actor');

    // Non-owner demotion is reverted and demoter removed
    const rogueRes = await handleAntiDemoteEvent({
      sock,
      update: {
        id: groupJid,
        action: 'demote',
        author: '254711110000@s.whatsapp.net',
        participants: ['254799990000@s.whatsapp.net'],
      },
      isOwnerJid: () => false,
      store,
    });
    assert.equal(rogueRes.handled, true);
    assert.equal(rogueRes.revertedCount, 1);
    assert.equal(rogueRes.kickedActor, true);
    assert.deepEqual(
      participantUpdates.map((u) => u.action),
      ['promote', 'remove'],
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('anticall rejects and optionally blocks callers, respects cooldown and isAllowedCaller', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-anticall-'));
  try {
    resetAnticallCooldowns();
    const store = createAnticallStore({ filePath: makeTempFile(tmpDir, 'anticall.json') });
    store.setState({ enabled: true, mode: 'block' });

    const { sock, sent, rejectedCalls, blockedUsers } = createGroupMockSock();
    const caller = '254722001122@s.whatsapp.net';

    const res = await handleAntiCallEvents({
      calls: [
        { id: 'CALL-OWNER', from: '254700000001@s.whatsapp.net' },
        { id: 'CALL-1', from: caller },
      ],
      sock,
      isAllowedCaller: (jid) => jid === '254700000001@s.whatsapp.net',
      store,
    });

    assert.equal(res.handled, true);
    assert.equal(res.rejected, 1);
    assert.equal(res.blocked, 1);
    assert.equal(rejectedCalls[0].id, 'CALL-1');
    assert.equal(blockedUsers[0].jid, caller);
    assert.equal(sent.length, 1);
  } finally {
    resetAnticallCooldowns();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('antidelete (indm/inchat/both + media) and antiedit (BEFORE/AFTER diff) recover messages cleanly', async () => {
  resetMessageRetryStore();
  const prevCfg = defaultAntideleteStore.getConfig();
  try {
    const groupJid = '120363000000100010@g.us';
    const ownerJid = '254700000001@s.whatsapp.net';
    const senderJid = '889900112233@lid';
    const lidMap = new Map([['889900112233@lid', '254710203040']]);

    const { sock, sent } = createGroupMockSock({
      metadata: { id: groupJid, subject: 'Dev Test Group', participants: [] },
    });

    // Test antidelete in 'both' mode with inline image buffer
    defaultAntideleteStore.setConfig({ enabled: true, mode: 'both' });
    rememberMessage({
      key: { remoteJid: groupJid, id: 'DEL-TXT-1', fromMe: false, participant: senderJid },
      message: {
        imageMessage: {
          caption: 'secret photo',
          _buffer: Buffer.from('fake-img-bytes'),
        },
      },
    });

    const adRes = await handleDeletedMessage(
      {
        key: { remoteJid: groupJid, id: 'REVOKE-EVT-1', fromMe: false, participant: senderJid },
        message: { protocolMessage: { type: 0, key: { remoteJid: groupJid, id: 'DEL-TXT-1' } } },
      },
      sock,
      () => senderJid,
      () => ownerJid,
      lidMap,
    );
    assert.equal(adRes.handled, true);
    assert.equal(adRes.sentCount, 2, 'Should send recovered media to both owner DM and group');
    const destinations = sent.map((s) => s.jid).sort();
    assert.deepEqual(destinations, [groupJid, ownerJid].sort());
    assert.match(sent[0].payload.caption, /254710203040/);
    assert.match(sent[0].payload.caption, /secret photo/);

    // Test antiedit BEFORE / AFTER diffing
    sent.length = 0;
    defaultAntideleteStore.setConfig({ enabled: true, mode: 'indm' });
    rememberMessage({
      key: { remoteJid: groupJid, id: 'EDIT-MSG-1', fromMe: false, participant: senderJid },
      message: { conversation: 'original text' },
    });

    const editRes = await handleEditedMessage(
      {
        key: { remoteJid: groupJid, id: 'EDIT-EVT-1', fromMe: false, participant: senderJid },
        message: {
          editedMessage: {
            message: {
              protocolMessage: {
                type: 14,
                key: { remoteJid: groupJid, id: 'EDIT-MSG-1' },
                editedMessage: { conversation: 'edited text' },
              },
            },
          },
        },
      },
      sock,
      () => senderJid,
      () => ownerJid,
      lidMap,
    );
    assert.equal(editRes.handled, true);
    assert.equal(editRes.beforeText, 'original text');
    assert.equal(editRes.afterText, 'edited text');
    assert.equal(sent[0].jid, ownerJid);
    assert.match(sent[0].payload.text, /original text/);
    assert.match(sent[0].payload.text, /edited text/);
  } finally {
    defaultAntideleteStore.setConfig(prevCfg);
    resetMessageRetryStore();
  }
});

test('antivv captures viewOnceMessageV2 media when enabled and skips when disabled', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antivv-'));
  try {
    const store = createAntivvStore({ filePath: makeTempFile(tmpDir, 'antivv.json') });
    const ownerJid = '254700000001@s.whatsapp.net';
    const { sock, sent } = createGroupMockSock();

    const voMsg = {
      key: { remoteJid: '254711223344@s.whatsapp.net', id: 'VO-1', fromMe: false },
      message: {
        viewOnceMessageV2: {
          message: {
            imageMessage: {
              caption: 'peek once',
              _buffer: Buffer.from('vo-bytes'),
            },
          },
        },
      },
    };

    assert.ok(extractViewOnceMedia(voMsg.message));
    const disabledRes = await handleViewOnceAutoSave({
      sock,
      msg: voMsg,
      from: '254711223344@s.whatsapp.net',
      getOwnerJid: () => ownerJid,
      store,
    });
    assert.equal(disabledRes.handled, false);

    store.setEnabled(true);
    const enabledRes = await handleViewOnceAutoSave({
      sock,
      msg: voMsg,
      from: '254711223344@s.whatsapp.net',
      getOwnerJid: () => ownerJid,
      store,
    });
    assert.equal(enabledRes.handled, true);
    assert.equal(enabledRes.withMedia, true);
    assert.equal(sent[0].jid, ownerJid);
    assert.match(sent[0].payload.caption, /peek once/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('All updated anti command subcommands (set, get, strict, modes) execute cleanly without collisions', async () => {
  const isoCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-cmd-iso-'));
  const origCwd = process.cwd;
  const origAntiDel = config.ANTIDELETE;
  const origAntiCall = config.ANTICALL;
  const groupJid = '120363000000100099@g.us';

  try {
    process.cwd = () => isoCwd;
    // Isolate default stores that read process.cwd()/data or reset them at the end
    defaultAntilinkStore.clearCache?.();
    defaultAntilinkStore.setGlobalConfig({ enabled: false });
    defaultAntivvStore.setEnabled(false);

    const { sock, sent } = createGroupMockSock({
      metadata: { id: groupJid, participants: [{ id: '254700000099@s.whatsapp.net', admin: 'admin' }] },
    });

    const fakeMsg = (txt) => ({
      key: { remoteJid: groupJid, id: 'CMD-TEST-1', fromMe: false, participant: '254700000001@s.whatsapp.net' },
      message: { conversation: txt },
    });

    // Test Group.js antilink set/get
    const antilinkCmd = groupCommands.find((c) => c.name === 'antilink');
    await antilinkCmd.execute({ sock, from: groupJid, text: 'set kick', args: ['set', 'kick'], msg: fakeMsg('.antilink set kick') });
    assert.equal(defaultAntilinkStore.getGroupConfig(groupJid).action, 'kick');

    await antilinkCmd.execute({ sock, from: groupJid, text: 'get', args: ['get'], msg: fakeMsg('.antilink get') });
    assert.match(sent.at(-1).payload.text, /ANTILINK/i);

    // Test Antiflood strict/get/delete+warn
    const antifloodCmd = antifloodCommands.find((c) => c.name === 'antiflood');
    await antifloodCmd.execute({
      sock, from: groupJid, text: 'strict', args: ['strict'], msg: fakeMsg('.antiflood strict'),
      isGroupAdmin: true, isBotGroupAdmin: true, isOwner: true,
    });
    assert.match(sent.at(-1).payload.text, /STRICT/i);

    // Test Antiscam get & set delete+warn
    const antiscamCmd = antiscamCommands.find((c) => c.name === 'antiscam');
    await antiscamCmd.execute({
      sock, from: groupJid, text: 'set delete+warn', args: ['set', 'delete+warn'], msg: fakeMsg('.antiscam set delete+warn'),
      isGroupAdmin: true, isBotGroupAdmin: true, isOwner: true,
    });
    assert.match(sent.at(-1).payload.text, /WARN/i);

    // Test Antiadvertisement get & set delete+kick
    const antiadCmd = antiadCommands.find((c) => c.name === 'antiadvertisement');
    await antiadCmd.execute({
      sock, from: groupJid, text: 'set delete+kick', args: ['set', 'delete+kick'], msg: fakeMsg('.antiad set delete+kick'),
      isGroupAdmin: true, isBotGroupAdmin: true, isOwner: true,
    });
    assert.match(sent.at(-1).payload.text, /KICK/i);

    // Test Admin.js antidelete both mode
    const antideleteCmd = adminCommands.find((c) => c.name === 'antidelete');
    await antideleteCmd.execute({
      sock, from: groupJid, text: 'both', msg: fakeMsg('.antidelete both'), isOwner: true,
    });
    assert.equal(defaultAntideleteStore.getConfig().mode, 'both');

    // Test new Anti.js commands
    const byName = new Map(antiCommands.map((c) => [c.name, c]));
    await byName.get('globalantilink').execute({
      sock, from: groupJid, text: 'on kick', args: ['on', 'kick'], msg: fakeMsg('.globalantilink on kick'), isOwner: true,
    });
    assert.equal(defaultAntilinkStore.getGlobalConfig().enabled, true);

    await byName.get('anticall').execute({
      sock, from: groupJid, text: 'reject', args: ['reject'], msg: fakeMsg('.anticall reject'), isOwner: true,
    });
    assert.equal(config.ANTICALL, true);

    await byName.get('antivv').execute({
      sock, from: groupJid, text: 'toggle', args: ['toggle'], msg: fakeMsg('.antivv toggle'), isOwner: true,
    });
    assert.equal(defaultAntivvStore.getState().enabled, true);
  } finally {
    process.cwd = origCwd;
    config.ANTIDELETE = origAntiDel;
    config.ANTICALL = origAntiCall;
    defaultAntilinkStore.clearCache?.();
    defaultAnticallStore.reset();
    defaultAntivvStore.reset();
    defaultAntideleteStore.reset();
    resetAnticallCooldowns();
    fs.rmSync(isoCwd, { recursive: true, force: true });
  }
});
