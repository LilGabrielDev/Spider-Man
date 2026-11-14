import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cleanJid,
  collectBotIdentities,
  collectSenderIdentities,
  extractLid,
  extractPhoneDigits,
  resolveGroupRoles,
  resolveGroupRolesAsync,
  resolveParticipantRole,
  syncLidMappingsFromMetadata,
} from '../../spider/utils/groupRoleResolver.js';
import { createAntiscamStore, handleAntiScamMessage } from '../../spider/utils/antiscam.js';
import { createAntifloodStore, createFloodTracker, handleAntiFloodMessage } from '../../spider/utils/antiflood.js';
import { groupAdminActionDecision } from '../../spider/utils/groupAdminProtection.js';

test('cleanJid, extractLid, and extractPhoneDigits normalize device JIDs and never confuse LIDs with phones', () => {
  assert.equal(cleanJid('254700000099:12@s.whatsapp.net'), '254700000099@s.whatsapp.net');
  assert.equal(cleanJid('98765432109876:2@lid'), '98765432109876@lid');
  assert.equal(extractLid('98765432109876:2@LID'), '98765432109876@lid');
  assert.equal(extractLid('254700000099@s.whatsapp.net'), '');

  assert.equal(extractPhoneDigits('254700000099:1@s.whatsapp.net'), '254700000099');
  // Echoing LID digits from a naive getPhoneFn must NOT be treated as a phone number
  assert.equal(
    extractPhoneDigits('98765432109876@lid', (jid) => jid.split('@')[0]),
    '',
  );

  const lidToPhoneMap = new Map([['98765432109876@lid', '254700000099']]);
  assert.equal(extractPhoneDigits('98765432109876@lid', { lidToPhoneMap }), '254700000099');
});

test('resolveGroupRoles recognizes bot and sender admins in LID-addressed WhatsApp groups', () => {
  const metadata = {
    id: '120363000000001111@g.us',
    addressingMode: 'lid',
    owner: '111222333444@lid',
    ownerPn: '254700000001@s.whatsapp.net',
    participants: [
      { id: '111222333444@lid', admin: null }, // owner fallback
      { id: '555666777888@lid', phoneNumber: '254700000002@s.whatsapp.net', admin: 'admin' },
      { id: '98765432109876@lid', admin: 'admin' }, // bot listed ONLY by @lid
      { id: '444333222111@lid', isAdmin: true }, // Baileys boolean flag
      { id: '999000111222@lid', admin: null },
    ],
  };

  const sock = {
    user: {
      id: '254700000099:1@s.whatsapp.net',
      lid: '98765432109876:2@lid',
    },
  };

  // Bot recognized via sock.user.lid even when participant has no phoneNumber
  const botOnlyCheck = resolveGroupRoles({
    metadata,
    sock,
    senderJids: ['999000111222@lid'],
  });
  assert.equal(botOnlyCheck.isBotAdmin, true);
  assert.equal(botOnlyCheck.isSenderAdmin, false);

  // Sender admin recognized when msg has LID participant and PN participantAlt
  const senderViaAlt = collectSenderIdentities({
    key: {
      participant: '555666777888@lid',
      participantAlt: '254700000002@s.whatsapp.net',
    },
  });
  const adminViaAlt = resolveGroupRoles({ metadata, sock, senderJids: senderViaAlt });
  assert.equal(adminViaAlt.isSenderAdmin, true);
  assert.equal(adminViaAlt.isBotAdmin, true);

  // Sender recognized via metadata.ownerPn
  const ownerCheck = resolveGroupRoles({
    metadata,
    sock,
    senderJids: ['254700000001@s.whatsapp.net'],
  });
  assert.equal(ownerCheck.isSenderAdmin, true);

  // Sender recognized via boolean isAdmin
  const boolAdminCheck = resolveGroupRoles({
    metadata,
    sock,
    senderJids: ['444333222111@lid'],
  });
  assert.equal(boolAdminCheck.isSenderAdmin, true);

  // Bot recognized via authState.creds.me.lid when sock.user.lid is absent
  const credsOnlySock = {
    user: { id: '254700000099:1@s.whatsapp.net' },
    authState: { creds: { me: { id: '254700000099:1@s.whatsapp.net', lid: '98765432109876:0@lid' } } },
  };
  assert.deepEqual(collectBotIdentities(credsOnlySock), [
    '254700000099@s.whatsapp.net',
    '98765432109876@lid',
  ]);
  const credsBotRole = resolveGroupRoles({ metadata, sock: credsOnlySock, senderJids: [] });
  assert.equal(credsBotRole.isBotAdmin, true);
});

test('resolveGroupRolesAsync falls back to Baileys signalRepository.lidMapping store when LID is absent on sock.user', async () => {
  const metadata = {
    id: '120363000000002222@g.us',
    participants: [
      { id: '98765432109876@lid', admin: 'superadmin' },
      { id: '254700000005@s.whatsapp.net', admin: 'admin' },
    ],
  };

  const sock = {
    user: { id: '254700000099:1@s.whatsapp.net' },
    signalRepository: {
      lidMapping: {
        getKnownLIDsForPNs: async (pns) => {
          assert.deepEqual(pns, ['254700000099@s.whatsapp.net']);
          return [{ pn: '254700000099@s.whatsapp.net', lid: '98765432109876@lid' }];
        },
        getPNForLID: async (lid) => (lid === '777888999000@lid' ? '254700000005@s.whatsapp.net' : null),
      },
    },
  };

  const lidToPhoneMap = new Map();
  const phoneToLidMap = new Map();
  const roles = await resolveGroupRolesAsync({
    metadata,
    sock,
    senderJids: ['777888999000@lid'],
    lidToPhoneMap,
    phoneToLidMap,
  });

  assert.equal(roles.isBotAdmin, true);
  assert.equal(roles.isSenderAdmin, true);
  assert.equal(phoneToLidMap.get('254700000099'), '98765432109876@lid');
  assert.equal(lidToPhoneMap.get('777888999000@lid'), '254700000005');
});

test('handleAntiScamMessage and handleAntiFloodMessage recognize bot and sender admins via LID in groupMetadata', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-lid-enforce-'));
  try {
    const groupJid = '120363000000003333@g.us';
    const scammerLid = '333444555666@lid';
    const adminLid = '222333444555@lid';
    const botLid = '98765432109876@lid';

    const metadata = {
      id: groupJid,
      participants: [
        { id: botLid, admin: 'admin' },
        { id: '254700000002@s.whatsapp.net', admin: 'admin' },
        { id: scammerLid, admin: null },
      ],
    };

    const sent = [];
    const sock = {
      user: { id: '254700000099:1@s.whatsapp.net', lid: `${botLid.split('@')[0]}:2@lid` },
      groupMetadata: async () => metadata,
      sendMessage: async (jid, payload) => {
        sent.push({ jid, payload });
        return { key: { id: `m-${sent.length}`, remoteJid: jid, fromMe: true } };
      },
      groupParticipantsUpdate: async () => [],
    };

    const scamStore = createAntiscamStore(path.join(tmpDir, 'antiscam.json'));
    scamStore.setGroupConfig(groupJid, { enabled: true, action: 'delete', notify: true });

    // Non-admin scammer IS enforced because bot IS recognized via sock.user.lid
    const scamResult = await handleAntiScamMessage({
      sock,
      from: groupJid,
      sender: scammerLid,
      msg: {
        key: { id: 'scam-lid-1', remoteJid: groupJid, fromMe: false, participant: scammerLid },
        message: { conversation: 'Send your 12-word seed phrase right now' },
      },
      store: scamStore,
    });
    assert.equal(scamResult.handled, true);
    assert.equal(scamResult.deleted, true);

    // Admin sending via LID with participantAlt PN IS skipped
    const adminScamResult = await handleAntiScamMessage({
      sock,
      from: groupJid,
      sender: adminLid,
      msg: {
        key: {
          id: 'scam-admin-lid',
          remoteJid: groupJid,
          fromMe: false,
          participant: adminLid,
          participantAlt: '254700000002@s.whatsapp.net',
        },
        message: { conversation: 'Send your 12-word seed phrase' },
      },
      store: scamStore,
    });
    assert.equal(adminScamResult.handled, false);
    assert.equal(adminScamResult.reason, 'sender-is-admin');

    // Antiflood enforces in LID group too
    const floodStore = createAntifloodStore(path.join(tmpDir, 'antiflood.json'));
    floodStore.setGroupConfig(groupJid, { enabled: true, action: 'delete', limit: 2, windowSec: 10, notify: false });
    const tracker = createFloodTracker({ now: () => 10_000 });
    for (let i = 1; i <= 2; i += 1) {
      const r = await handleAntiFloodMessage({
        sock,
        from: groupJid,
        sender: scammerLid,
        msg: { key: { id: `f-${i}`, remoteJid: groupJid, fromMe: false, participant: scammerLid }, message: { conversation: 'hi' } },
        store: floodStore,
        tracker,
      });
      assert.equal(r.handled, false);
    }
    const burst = await handleAntiFloodMessage({
      sock,
      from: groupJid,
      sender: scammerLid,
      msg: { key: { id: 'f-3', remoteJid: groupJid, fromMe: false, participant: scammerLid }, message: { conversation: 'hi' } },
      store: floodStore,
      tracker,
    });
    assert.equal(burst.handled, true);
    assert.equal(burst.deleted, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('groupAdminActionDecision protects admins across LID, :device, and ownerPn formats', () => {
  const metadata = {
    owner: '111222333444@lid',
    ownerPn: '254700000001@s.whatsapp.net',
    participants: [
      { id: '555666777888@lid', phoneNumber: '254700000002@s.whatsapp.net', admin: 'admin' },
      { id: '999000111222@lid', admin: null },
    ],
  };

  assert.equal(
    groupAdminActionDecision({
      enabled: true,
      action: 'remove',
      targets: ['555666777888:2@lid'],
      metadata,
    }).allowed,
    false,
  );
  assert.equal(
    groupAdminActionDecision({
      enabled: true,
      action: 'demote',
      targets: ['254700000001:0@s.whatsapp.net'],
      metadata,
    }).allowed,
    false,
  );
  assert.equal(
    groupAdminActionDecision({
      enabled: true,
      action: 'remove',
      targets: ['999000111222@lid'],
      metadata,
    }).allowed,
    true,
  );
});

test('syncLidMappingsFromMetadata learns pairs and spider/index.js hooks groupRoleResolver + cache invalidation', () => {
  const lidToPhoneMap = new Map();
  const phoneToLidMap = new Map();
  syncLidMappingsFromMetadata(
    {
      owner: '111222333444@lid',
      ownerPn: '254700000001@s.whatsapp.net',
      participants: [{ id: '555666777888@lid', phoneNumber: '254700000002@s.whatsapp.net', admin: 'admin' }],
    },
    { lidToPhoneMap, phoneToLidMap },
  );

  assert.equal(lidToPhoneMap.get('111222333444@lid'), '254700000001');
  assert.equal(phoneToLidMap.get('254700000002'), '555666777888@lid');

  const roleViaMap = resolveParticipantRole(
    { participants: [{ id: '555666777888@lid', admin: 'admin' }] },
    '254700000002@s.whatsapp.net',
    { lidToPhoneMap, phoneToLidMap },
  );
  assert.equal(roleViaMap.isAdmin, true);

  const indexSource = fs.readFileSync(path.join(process.cwd(), 'spider', 'index.js'), 'utf8');
  assert.ok(indexSource.includes('./utils/groupRoleResolver.js'));
  assert.ok(indexSource.includes('resolveGroupRolesAsync('));
  assert.ok(indexSource.includes("group-participants.update"));
  assert.ok(indexSource.includes("groups.update"));
});
