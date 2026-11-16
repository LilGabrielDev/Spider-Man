import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { commands as groupCommands } from '../commands/Group.js';
import { loadLegacyCommands } from '../utils/legacyPlugins.js';
import {
  createAntilinkStore,
  detectChannelForward,
  detectLinkMessage,
  handleAntiLinkMessage,
} from '../../spider/utils/antilink.js';
import config from '../../spider/config.js';

const require = createRequire(import.meta.url);

function createAckAwareMockSock({
  botId = '254700000099:1@s.whatsapp.net',
  botLid = '98765432109876:2@lid',
  metadata = null,
} = {}) {
  const sent = [];
  const participantUpdates = [];
  const ws = new EventEmitter();
  let seq = 0;

  const sock = {
    user: { id: botId, ...(botLid ? { lid: botLid } : {}) },
    ws,
    groupMetadata: async () => metadata,
    sendMessage: async (jid, payload, options = {}) => {
      seq += 1;
      const id = `msg-${seq}`;
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
    groupRequestParticipantsList: async () => [],
  };

  return { sock, sent, participantUpdates };
}

test('Group.js admin commands enforce adminOnly + botAdminOnly (not ownerOnly), while left stays ownerOnly', async () => {
  const byName = new Map(groupCommands.map((c) => [c.name, c]));
  const expectedAdminCmds = [
    'antilink',
    'rename',
    'kick',
    'add',
    'kickall',
    'promote',
    'demote',
    'approve',
    'lock',
    'unlock',
    'invite',
    'revoke',
  ];

  for (const name of expectedAdminCmds) {
    const cmd = byName.get(name);
    assert.ok(cmd, `Expected Group.js command '${name}'`);
    assert.equal(Boolean(cmd.ownerOnly), false, `'${name}' must NOT be ownerOnly`);
    assert.equal(cmd.adminOnly, true, `'${name}' must require adminOnly`);
    assert.equal(cmd.botAdminOnly, true, `'${name}' must require botAdminOnly`);
    assert.equal(cmd.groupOnly, true, `'${name}' must require groupOnly`);
  }

  const leftCmd = byName.get('left');
  assert.ok(leftCmd);
  assert.equal(leftCmd.ownerOnly, true, `'left' must remain ownerOnly`);

  // Verify dispatcher gate in spider/index.js: owner bypasses adminOnly while botAdminOnly remains enforced
  const indexSrc = fs.readFileSync(path.join(process.cwd(), 'spider', 'index.js'), 'utf8');
  assert.match(indexSrc, /_0x4edfc2\[_0x[\da-f]+\(0x129\)\]&&!_0x13a56b&&!_0x12b0f6\|\|_0x4edfc2\[_0x[\da-f]+\(0x68\)\]&&!_0x21595b/);

  // .tagall & .req display resolved phone numbers while .tagall keeps raw participant JIDs in mentions
  const groupJid = '120363000000009999@g.us';
  const lidMeta = {
    id: groupJid,
    subject: 'MixedAddressing',
    participants: [
      { id: '111222333444@lid', phoneNumber: '254711111111@s.whatsapp.net', admin: 'superadmin' },
      { id: '555666777888@lid', pn: '254722222222@s.whatsapp.net', admin: null },
    ],
  };
  const { sock, sent } = createAckAwareMockSock({ metadata: lidMeta });
  sock.groupRequestParticipantsList = async () => [
    { jid: '333444555666@lid', phoneNumber: '254733333333@s.whatsapp.net' },
  ];

  await byName.get('tagall').execute({
    sock,
    from: groupJid,
    text: 'Check in',
    msg: { key: { remoteJid: groupJid, id: 'cmd-tagall' } },
  });
  const tagMsg = sent.at(-1);
  assert.match(tagMsg.payload.text, /@254711111111/);
  assert.match(tagMsg.payload.text, /@254722222222/);
  assert.deepEqual(tagMsg.payload.mentions, ['111222333444@lid', '555666777888@lid']);

  await byName.get('req').execute({
    sock,
    from: groupJid,
    msg: { key: { remoteJid: groupJid, id: 'cmd-req' } },
  });
  const reqMsg = sent.at(-1);
  assert.match(reqMsg.payload.text, /\+254733333333/);
});

test('antilink detects shorteners, bare domains, matchedText previews, and forwarded channels without false positives', async () => {
  // Positive link matches
  for (const sample of [
    'join https://chat.whatsapp.com/AbCdEfGh1234',
    'channel https://whatsapp.com/channel/AbCdEfGh1234',
    'hit bit.ly/promo99',
    'watch youtu.be/dQw4w9WgXcQ',
    'visit example.com/invite',
    'check t.me/spiderupdates',
    'open wa.me/254700000001',
  ]) {
    const res = detectLinkMessage(sample);
    assert.equal(res.hasLink, true, `Expected link match for: ${sample}`);
  }

  // Negative (no false positives on emails, filenames, versions, decimals)
  for (const clean of [
    'email me at alice@gmail.com',
    'attach photo.jpg or notes.pdf please',
    'upgraded to v1.0 and 3.5 build',
    'plain chat with no links at all',
  ]) {
    const res = detectLinkMessage(clean);
    assert.equal(res.hasLink, false, `Unexpected false positive on: ${clean}`);
  }

  // Channel / newsletter forward detection (raw & ephemeral)
  const directNewsletterMsg = {
    key: { id: 'nl-1', remoteJid: '120363000000000001@g.us', fromMe: false, participant: '254700000003@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '',
        contextInfo: {
          isForwarded: true,
          forwardingScore: 2,
          forwardedNewsletterMessageInfo: {
            newsletterJid: '120363000000000000@newsletter',
            newsletterName: 'Channel Updates',
          },
        },
      },
    },
  };
  assert.equal(detectChannelForward(directNewsletterMsg).isChannelForward, true);

  const ephemeralForwardMsg = {
    key: { id: 'nl-2', remoteJid: '120363000000000001@g.us', fromMe: false },
    message: {
      ephemeralMessage: {
        message: {
          imageMessage: {
            caption: '',
            contextInfo: {
              isForwarded: true,
              forwardingScore: 5,
              remoteJid: '120363999@newsletter',
            },
          },
        },
      },
    },
  };
  assert.equal(detectChannelForward(ephemeralForwardMsg).isChannelForward, true);
  assert.equal(
    detectChannelForward({ message: { conversation: 'hello world' } }).isChannelForward,
    false,
  );

  // End-to-end handleAntiLinkMessage: captionless channel forward + matchedText + mixed LID/PN warn unification + exemptions
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antilink-fix-'));
  try {
    const store = createAntilinkStore(path.join(tmpDir, 'antilink.json'));
    const groupJid = '120363000000007777@g.us';
    const memberLid = '333444555666@lid';
    const memberPn = '254700000003@s.whatsapp.net';
    const superAdminLid = '111222333444@lid';
    const botLid = '98765432109876@lid';

    const metadata = {
      id: groupJid,
      addressingMode: 'lid',
      participants: [
        { id: botLid, admin: 'admin' },
        { id: superAdminLid, phoneNumber: '254700000001@s.whatsapp.net', admin: 'superadmin' },
        { id: memberLid, phoneNumber: memberPn, admin: null },
      ],
    };

    store.setGroupConfig(groupJid, { enabled: true, action: 'warn', maxWarns: 2 });
    const { sock, sent, participantUpdates } = createAckAwareMockSock({ metadata });

    // 1. Captionless forwarded channel message counts as Warn 1 (under LID identity)
    const warn1 = await handleAntiLinkMessage({
      sock,
      from: groupJid,
      sender: memberLid,
      msg: {
        ...directNewsletterMsg,
        key: { id: 'fwd-chan-1', remoteJid: groupJid, fromMe: false, participant: memberLid },
      },
      store,
      groupMeta: metadata,
    });
    assert.equal(warn1.handled, true);
    assert.equal(warn1.deleted, true);
    assert.equal(warn1.warned, true);
    assert.equal(warn1.warnCount, 1);
    assert.equal(warn1.kicked, false);

    // 2. Link in matchedText sent via PN alias merges warns to Warn 2/2 and kicks member
    const warn2 = await handleAntiLinkMessage({
      sock,
      from: groupJid,
      sender: memberPn,
      msg: {
        key: { id: 'matched-url-1', remoteJid: groupJid, fromMe: false, participant: memberPn },
        message: {
          extendedTextMessage: {
            text: 'Tap here',
            matchedText: 'https://bit.ly/hidden-link',
          },
        },
      },
      store,
      groupMeta: metadata,
    });
    assert.equal(warn2.handled, true);
    assert.equal(warn2.deleted, true);
    assert.equal(warn2.warnCount, 2);
    assert.equal(warn2.kicked, true);
    assert.equal(participantUpdates.length, 1);
    assert.equal(participantUpdates[0].action, 'remove');
    assert.deepEqual(store.getGroupConfig(groupJid).warns, {}, 'warns should be cleared across aliases after kick');
    assert.ok(sent.some((s) => s.payload?.text?.includes('MAX WARNS')));

    // 3. Superadmin & owner exemptions
    const superAdminRes = await handleAntiLinkMessage({
      sock,
      from: groupJid,
      sender: superAdminLid,
      msg: {
        key: { id: 'sa-1', remoteJid: groupJid, fromMe: false, participant: superAdminLid },
        message: { conversation: 'https://example.com' },
      },
      store,
      groupMeta: metadata,
    });
    assert.equal(superAdminRes.handled, false);
    assert.equal(superAdminRes.reason, 'sender-is-admin');

    const ownerRes = await handleAntiLinkMessage({
      sock,
      from: groupJid,
      sender: memberLid,
      isOwner: true,
      msg: {
        key: { id: 'own-1', remoteJid: groupJid, fromMe: false, participant: memberLid },
        message: { conversation: 'https://example.com' },
      },
      store,
      groupMeta: metadata,
    });
    assert.equal(ownerRes.handled, false);
    assert.equal(ownerRes.reason, 'owner-exempt');

    // 4. Bot not admin skips enforcement
    const nonAdminBotMeta = {
      id: groupJid,
      participants: [
        { id: botLid, admin: null },
        { id: memberLid, phoneNumber: memberPn, admin: null },
      ],
    };
    const noBotAdminRes = await handleAntiLinkMessage({
      sock,
      from: groupJid,
      sender: memberLid,
      msg: {
        key: { id: 'nb-1', remoteJid: groupJid, fromMe: false, participant: memberLid },
        message: { conversation: 'https://example.com' },
      },
      store,
      groupMeta: nonAdminBotMeta,
    });
    assert.equal(noBotAdminRes.handled, false);
    assert.equal(noBotAdminRes.reason, 'bot-not-admin');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('legacyPlugins.js and legacy loader.js fix isSuperAdmin, botAdminOnly, owner bypass, and admin context fields', async () => {
  const legacyCmds = await loadLegacyCommands();
  const byName = new Map(legacyCmds.map((c) => [c.name, c]));

  // Verify superadmin vs plain admin distinction in legacyPlugins.js using a real subdir plugin context probe
  const loaderMod = require('../legacy/lil/handlers/loader.js');
  let capturedCtx = null;
  loaderMod.addCmd({
    name: 'probe_role_ctx',
    category: 'groups',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      capturedCtx = ctx;
    },
  });

  const refreshed = await loadLegacyCommands();
  const probeCmd = refreshed.find((c) => c.name === 'probe_role_ctx');
  assert.ok(probeCmd);
  assert.equal(probeCmd.adminOnly, true);
  assert.equal(probeCmd.botAdminOnly, true);

  const groupJid = '120363000000008888@g.us';
  const plainAdminPn = '254700000010@s.whatsapp.net';
  const superAdminLid = '111222333444@lid';
  const botLid = '98765432109876@lid';
  const meta = {
    id: groupJid,
    participants: [
      { id: botLid, admin: 'admin' },
      { id: superAdminLid, phoneNumber: '254700000001@s.whatsapp.net', admin: 'superadmin' },
      { id: plainAdminPn, admin: 'admin' },
      { id: '254700000020@s.whatsapp.net', admin: null },
    ],
  };

  const { sock } = createAckAwareMockSock({ metadata: meta });

  // Plain admin must NOT get isSuperAdmin === true
  capturedCtx = null;
  await probeCmd.execute({
    sock,
    from: groupJid,
    sender: plainAdminPn,
    senderNumber: '254700000010',
    msg: { key: { id: 'p-1', remoteJid: groupJid, fromMe: false, participant: plainAdminPn }, message: { conversation: '.probe_role_ctx' } },
    args: [],
    text: '',
    config: { ...config },
    isOwner: false,
    groupMeta: meta,
  });
  assert.ok(capturedCtx);
  assert.equal(capturedCtx.isAdmin, true);
  assert.equal(capturedCtx.isBotAdmin, true);
  assert.equal(capturedCtx.isSuperAdmin, false, 'plain admin must have isSuperAdmin === false');
  assert.ok(capturedCtx.groupAdmins.includes(plainAdminPn));
  assert.ok(capturedCtx.groupSuperAdmins.includes('254700000001@s.whatsapp.net'));
  assert.equal(capturedCtx.botPrefix, '.');

  // Owner (even if non-admin in participants) bypasses adminOnly gate when bot IS admin
  capturedCtx = null;
  await probeCmd.execute({
    sock,
    from: groupJid,
    sender: '254700000020@s.whatsapp.net',
    senderNumber: '254700000020',
    msg: { key: { id: 'p-2', remoteJid: groupJid, fromMe: false, participant: '254700000020@s.whatsapp.net' }, message: { conversation: '.probe_role_ctx' } },
    args: [],
    text: '',
    config: { ...config },
    isOwner: true,
    groupMeta: meta,
  });
  assert.ok(capturedCtx, 'Owner should bypass legacy adminOnly check');
  assert.equal(capturedCtx.isSuperAdmin, true);
  assert.equal(capturedCtx.isSuperUser, true);
  assert.ok(Array.isArray(capturedCtx.superUser) && capturedCtx.superUser.includes('254700000020@s.whatsapp.net'));

  // botAdminOnly rejects even owner/admin when bot is NOT admin
  capturedCtx = null;
  const noBotMeta = {
    id: groupJid,
    participants: [
      { id: botLid, admin: null },
      { id: plainAdminPn, admin: 'admin' },
    ],
  };
  const noBotSock = createAckAwareMockSock({ metadata: noBotMeta });
  await probeCmd.execute({
    sock: noBotSock.sock,
    from: groupJid,
    sender: plainAdminPn,
    senderNumber: '254700000010',
    msg: { key: { id: 'p-3', remoteJid: groupJid, fromMe: false, participant: plainAdminPn }, message: { conversation: '.probe_role_ctx' } },
    args: [],
    text: '',
    config: { ...config },
    isOwner: true,
    groupMeta: noBotMeta,
  });
  assert.equal(capturedCtx, null, 'botAdminOnly must block execution when bot is not group admin');
  assert.match(noBotSock.sent.at(-1).payload.text, /need to be a group admin/i);
  assert.ok(byName.size > 0);
});

test('Legacy CJS commandHandler.getGroupInfo, gmdFunctions2, and legacy group.js handle superadmin, LID aliases, and .pn format cleanly', async () => {
  const { getGroupInfo } = require('../legacy/lil/connection/commandHandler.js');
  const groupCache = require('../legacy/lil/connection/groupCache.js');
  const gmd2 = require('../legacy/lil/utils/gmdFunctions2.js');
  const lilDb = require('../legacy/lil/db/database.js');
  const lilMod = require('../legacy/lil/index.js');

  const groupJid = '120363000000006666@g.us';
  const botLid = '888777666555@lid';
  const superAdminLid = '123456789012@lid';
  const superAdminPn = '254712345678@s.whatsapp.net';
  const adminLid = '222333444555@lid';
  const adminPn = '254723456789@s.whatsapp.net';
  const memberLid = '999888777666@lid';
  const memberPn = '254734567890@s.whatsapp.net';

  groupCache.storeLidMapping(superAdminLid, superAdminPn);
  groupCache.storeLidMapping(adminLid, adminPn);

  const meta = {
    id: groupJid,
    subject: 'Legacy CJS Test Group',
    participants: [
      { id: botLid, admin: 'admin' },
      { id: superAdminLid, pn: superAdminPn, admin: 'superadmin' },
      { id: adminLid, phoneNumber: adminPn, admin: 'admin' },
      { id: memberLid, pn: memberPn, admin: null },
    ],
  };

  const { sock, sent, participantUpdates } = createAckAwareMockSock({
    botId: '254700000099:1@s.whatsapp.net',
    botLid: '888777666555:0@lid',
    metadata: meta,
  });
  sock.decodeJid = (j) => String(j || '').replace(/:\d+(?=@)/, '');

  // 1. commandHandler.getGroupInfo: superadmin counts as isAdmin + isSuperAdmin, and LID bot counts as isBotAdmin
  const saInfo = await getGroupInfo(sock, groupJid, sock.decodeJid, superAdminPn);
  assert.equal(saInfo.isBotAdmin, true, 'LID-only bot must be recognized in getGroupInfo');
  assert.equal(saInfo.isSuperAdmin, true, 'superadmin mapped via LID<->PN must have isSuperAdmin=true');
  assert.equal(saInfo.isAdmin, true, 'superadmin must also have isAdmin=true in getGroupInfo');

  const adminInfo = await getGroupInfo(sock, groupJid, sock.decodeJid, adminPn);
  assert.equal(adminInfo.isAdmin, true);
  assert.equal(adminInfo.isSuperAdmin, false);

  const memberInfo = await getGroupInfo(sock, groupJid, sock.decodeJid, memberLid);
  assert.equal(memberInfo.isAdmin, false);
  assert.equal(memberInfo.isSuperAdmin, false);

  // 2. gmdFunctions2.SpiderAntiLink & SpiderAntiBot
  assert.equal(Boolean(gmd2.LINK_REGEX.test('check bit.ly/promo9')), true);
  gmd2.LINK_REGEX.lastIndex = 0;
  assert.equal(Boolean(gmd2.LINK_REGEX.test('email alice@gmail.com')), false);

  const prevSettings = lilDb.getGroupSettings(groupJid) || {};
  try {
    lilDb.setGroupSetting(groupJid, 'antilink', 'kick');
    lilDb.setGroupSetting(groupJid, 'antibot', true);

    const fwdRawMsg = {
      key: { id: 'leg-al-1', remoteJid: groupJid, fromMe: false, participant: memberLid },
      message: {
        extendedTextMessage: {
          text: '',
          contextInfo: {
            isForwarded: true,
            forwardingScore: 2,
            forwardedNewsletterMessageInfo: { newsletterJid: '120363000@newsletter', newsletterName: 'News' },
          },
        },
      },
    };
    await gmd2.SpiderAntiLink(
      sock,
      {
        from: groupJid,
        sender: memberLid,
        body: '',
        isAdmin: false,
        isOwner: false,
        fromMe: false,
        isGroup: true,
        key: fwdRawMsg.key,
        m: fwdRawMsg,
      },
      (s, gid) => s.groupMetadata(gid),
    );
    assert.ok(sent.some((s) => s.payload?.delete?.id === 'leg-al-1'), 'SpiderAntiLink should delete forwarded channel message');
    assert.ok(participantUpdates.some((u) => u.action === 'remove'), 'SpiderAntiLink should kick when action=kick');

    const abTriggered = await gmd2.SpiderAntiBot(sock, {
      from: groupJid,
      sender: memberLid,
      isGroup: true,
      isAdmin: false,
      isOwner: false,
      fromMe: false,
      isCmd: true,
      m: { key: { id: 'leg-ab-1', remoteJid: groupJid, fromMe: false, participant: memberLid } },
    });
    assert.equal(abTriggered, true, 'SpiderAntiBot should enforce when bot is LID-only admin');
  } finally {
    lilDb.setGroupSetting(groupJid, 'antilink', prevSettings.antilink || false);
    lilDb.setGroupSetting(groupJid, 'antibot', prevSettings.antibot || false);
  }

  // 3. legacy group.js demote must NOT double-append @s.whatsapp.net when participant.pn already contains it
  const captured = [];
  const origGmd = lilMod.gmd;
  lilMod.gmd = (metaObj, fn) => captured.push({ metaObj, fn });
  try {
    const resolvedGroupPath = require.resolve('../legacy/lilgabriel/group.js');
    delete require.cache[resolvedGroupPath];
    require('../legacy/lilgabriel/group.js');
  } finally {
    lilMod.gmd = origGmd;
  }

  const demoteCmd = captured.find((c) => c.metaObj?.pattern === 'demote');
  assert.ok(demoteCmd, 'legacy group.js should register demote');

  const demoteSockUpdates = [];
  const demoteMockSock = {
    user: { id: '254700000099:1@s.whatsapp.net', lid: botLid },
    groupParticipantsUpdate: async (gid, targets, act) => {
      demoteSockUpdates.push({ gid, targets, act });
      return targets.map((t) => ({ jid: t, status: '200' }));
    },
    sendMessage: async () => ({ key: { id: 'd-1' } }),
  };

  await demoteCmd.fn(groupJid, demoteMockSock, {
    reply: async () => {},
    react: async () => {},
    sender: superAdminPn,
    quotedUser: adminLid,
    superUser: [superAdminPn],
    isSuperAdmin: true,
    isAdmin: true,
    isGroup: true,
    isBotAdmin: true,
    q: '',
    mentionedJid: [],
    groupAdmins: [superAdminPn, adminPn],
    groupMetadata: meta,
  });

  assert.equal(demoteSockUpdates.length, 1);
  assert.equal(demoteSockUpdates[0].act, 'demote');
  assert.equal(
    demoteSockUpdates[0].targets[0].endsWith('@s.whatsapp.net@s.whatsapp.net'),
    false,
    'target JID must NEVER double-append @s.whatsapp.net',
  );
  assert.equal(demoteSockUpdates[0].targets[0], adminPn);
});
