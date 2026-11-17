import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { commands as groupCommands } from '../commands/Group.js';
import { loadLegacyCommands } from '../utils/legacyPlugins.js';
import { pinMessageSafely } from '../../spider/utils/groupActionHelper.js';
import { reloadCommandsFromDisk } from '../../spider/utils/runtimeControl.js';

function createGroupSock(groupJid = '120363000000009999@g.us') {
  const sent = [];
  let invalidated = 0;
  const sock = {
    user: { id: '254700000001:1@s.whatsapp.net', lid: '10000001@lid' },
    async __spiderInvalidateGroupCache() {
      invalidated += 1;
    },
    async groupMetadata(jid) {
      return {
        id: jid,
        subject: 'Pin Test Group',
        addressingMode: 'pn',
        participants: [
          { id: '254700000001@s.whatsapp.net', lid: '10000001@lid', admin: 'superadmin' },
          { id: '254700000004@s.whatsapp.net', lid: '40000004@lid', admin: null },
        ],
      };
    },
    async sendMessage(jid, payload, opts) {
      const id = `sent-${sent.length + 1}`;
      sent.push({ id, jid, payload, opts });
      return { key: { id, remoteJid: jid, fromMe: true } };
    },
  };
  return { sock, sent, groupJid, getInvalidated: () => invalidated };
}

test('pinmsg and unpinmsg register cleanly alongside legacy pinm', async () => {
  const commandsMap = new Map();
  const aliasesMap = new Map();
  const commandsDir = path.resolve(process.cwd(), 'Spider', 'commands');

  await reloadCommandsFromDisk({
    commandsDir,
    commandsMap,
    aliasesMap,
    loadLegacyFn: loadLegacyCommands,
    pathToFileUrlFn: pathToFileURL,
    cacheBust: Date.now(),
  });

  const pinmsg = commandsMap.get('pinmsg');
  const unpinmsg = commandsMap.get('unpinmsg');
  assert.ok(pinmsg, 'pinmsg command must be registered');
  assert.ok(unpinmsg, 'unpinmsg command must be registered');
  assert.equal(pinmsg.groupOnly, true);
  assert.equal(pinmsg.adminOnly, true);
  assert.equal(pinmsg.botAdminOnly, true);
  assert.equal(unpinmsg.groupOnly, true);
  assert.equal(unpinmsg.adminOnly, true);
  assert.equal(unpinmsg.botAdminOnly, true);
  assert.equal(aliasesMap.get('pininchat'), 'pinmsg');
  assert.equal(aliasesMap.get('pinannounce'), 'pinmsg');
  assert.equal(aliasesMap.get('unpinmessage'), 'unpinmsg');
  assert.equal(aliasesMap.get('unpinm'), 'unpinmsg');
  assert.equal(commandsMap.get('pinm')?.name.toLowerCase(), 'pinm');
});

test('pinmsg enforces groupOnly, shows usage when empty, and validates duration tokens on reply', async () => {
  const { sock, sent, groupJid } = createGroupSock();
  const pinmsg = groupCommands.find((c) => c.name === 'pinmsg');
  const unpinmsg = groupCommands.find((c) => c.name === 'unpinmsg');
  const cfg = { BOT_NAME: 'Spider Man' };

  // DM check
  await pinmsg.execute({
    sock,
    from: '254700000001@s.whatsapp.net',
    text: '',
    args: [],
    msg: { key: { id: 'dm-1', remoteJid: '254700000001@s.whatsapp.net' } },
    config: cfg,
  });
  await unpinmsg.execute({
    sock,
    from: '254700000001@s.whatsapp.net',
    text: '',
    args: [],
    msg: { key: { id: 'dm-2', remoteJid: '254700000001@s.whatsapp.net' } },
    config: cfg,
  });
  assert.equal(sent.filter((s) => s.payload.pin).length, 0);

  // Usage card without reply or text
  await pinmsg.execute({
    sock,
    from: groupJid,
    text: '',
    args: [],
    msg: { key: { id: 'g-usage', remoteJid: groupJid } },
    config: cfg,
  });
  assert.match(sent.at(-1).payload.text, /PIN MESSAGE/);
  assert.match(sent.at(-1).payload.text, /24h • 7d • 30d/);

  // Invalid duration on quoted reply
  await pinmsg.execute({
    sock,
    from: groupJid,
    text: '5d',
    args: ['5d'],
    msg: {
      key: { id: 'g-bad-dur', remoteJid: groupJid },
      message: {
        extendedTextMessage: {
          text: '.pinmsg 5d',
          contextInfo: {
            stanzaId: 'quoted-1',
            participant: '254700000004@s.whatsapp.net',
            quotedMessage: { conversation: 'Target announcement' },
          },
        },
      },
    },
    config: cfg,
  });
  assert.match(sent.at(-1).payload.text, /Supported pin durations/i);
  assert.equal(sent.filter((s) => s.payload.pin).length, 0);
});

test('pinmsg pins replied messages (24h/7d/30d) and unpinmsg unpins both replied and tracked pins', async () => {
  const { sock, sent, groupJid } = createGroupSock();
  const pinmsg = groupCommands.find((c) => c.name === 'pinmsg');
  const unpinmsg = groupCommands.find((c) => c.name === 'unpinmsg');
  const cfg = { BOT_NAME: 'Spider Man' };

  // 1. Reply + pinmsg 30d
  await pinmsg.execute({
    sock,
    from: groupJid,
    text: '30d',
    args: ['30d'],
    msg: {
      key: { id: 'cmd-pin-1', remoteJid: groupJid },
      message: {
        extendedTextMessage: {
          text: '.pinmsg 30d',
          contextInfo: {
            stanzaId: 'member-msg-1',
            participant: '254700000004@s.whatsapp.net',
            quotedMessage: { conversation: 'Group Rules Updated!' },
          },
        },
      },
    },
    config: cfg,
  });

  const pinPayload1 = sent.find((s) => s.payload.pin?.id === 'member-msg-1')?.payload;
  assert.ok(pinPayload1, 'should send Baileys pin payload for replied message');
  assert.equal(pinPayload1.type, 1);
  assert.equal(pinPayload1.time, 2_592_000);
  assert.equal(pinPayload1.pin.remoteJid, groupJid);
  assert.equal(pinPayload1.pin.fromMe, false);
  assert.equal(pinPayload1.pin.participant, '254700000004@s.whatsapp.net');
  assert.match(sent.at(-1).payload.text, /MESSAGE PINNED/);
  assert.match(sent.at(-1).payload.text, /30 Days/);

  // 2. Direct announcement text `.pinmsg 7d Meeting at 8 PM`
  await pinmsg.execute({
    sock,
    from: groupJid,
    text: '7d Meeting at 8 PM',
    args: ['7d', 'Meeting', 'at', '8', 'PM'],
    msg: {
      key: { id: 'cmd-pin-2', remoteJid: groupJid },
      message: { conversation: '.pinmsg 7d Meeting at 8 PM' },
    },
    config: cfg,
  });

  const announceMsg = sent.find((s) => String(s.payload.text || '').includes('Meeting at 8 PM'));
  assert.ok(announceMsg, 'should post announcement text into the group');
  const pinPayload2 = sent.find((s) => s.payload.pin?.id === announceMsg.id)?.payload;
  assert.ok(pinPayload2, 'should immediately pin the newly sent announcement');
  assert.equal(pinPayload2.type, 1);
  assert.equal(pinPayload2.time, 604_800);
  assert.match(sent.at(-1).payload.text, /7 Days/);

  // 3. Unpin without quoting — uses tracked last pinned announcement
  await unpinmsg.execute({
    sock,
    from: groupJid,
    text: '',
    args: [],
    msg: { key: { id: 'cmd-unpin-1', remoteJid: groupJid }, message: { conversation: '.unpinmsg' } },
    config: cfg,
  });
  const unpinTracked = sent.find((s) => s.payload.pin?.id === announceMsg.id && s.payload.type === 2)?.payload;
  assert.ok(unpinTracked, 'should unpin tracked pinned announcement when called directly');
  assert.equal('time' in unpinTracked, false, 'unpin payload should omit pin duration');
  assert.match(sent.at(-1).payload.text, /MESSAGE UNPINNED/);

  // 4. Calling unpinmsg again with no tracked key and no reply prompts cleanly
  await unpinmsg.execute({
    sock,
    from: groupJid,
    text: '',
    args: [],
    msg: { key: { id: 'cmd-unpin-none', remoteJid: groupJid }, message: { conversation: '.unpinmsg' } },
    config: cfg,
  });
  assert.match(sent.at(-1).payload.text, /Reply to the pinned message/i);

  // 5. Explicit reply unpin on any quoted message
  await unpinmsg.execute({
    sock,
    from: groupJid,
    text: '',
    args: [],
    msg: {
      key: { id: 'cmd-unpin-2', remoteJid: groupJid },
      message: {
        extendedTextMessage: {
          text: '.unpinmsg',
          contextInfo: {
            stanzaId: 'member-msg-1',
            participant: '254700000004@s.whatsapp.net',
            quotedMessage: { conversation: 'Old pin' },
          },
        },
      },
    },
    config: cfg,
  });
  const unpinQuoted = sent.find((s) => s.payload.pin?.id === 'member-msg-1' && s.payload.type === 2)?.payload;
  assert.ok(unpinQuoted, 'should unpin replied message cleanly');
});

test('pinMessageSafely omits duration on unpin (type 2) and retries once after cache invalidation on stale group ack', async () => {
  let calls = 0;
  let invalidated = 0;
  const sock = {
    async __spiderInvalidateGroupCache() {
      invalidated += 1;
    },
    async sendMessage(jid, payload, opts) {
      calls += 1;
      if (calls === 1) {
        return { status: 406, error: 'stale group cache' };
      }
      return { key: { id: 'ok-1', remoteJid: jid, fromMe: true }, opts, payload };
    },
  };

  const res = await pinMessageSafely({
    sock,
    from: '120363000000009999@g.us',
    key: { remoteJid: '120363000000009999@g.us', id: 'm-1', fromMe: false },
    type: 2,
    time: 86400,
  });

  assert.equal(res.ok, true);
  assert.equal(res.retriedWithoutCache, true);
  assert.equal(invalidated, 1);
  assert.equal(calls, 2);
});
