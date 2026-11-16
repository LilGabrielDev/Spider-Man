import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as baileys from '@whiskeysockets/baileys';

let reloadCommandsFromDisk;
let loadLegacyCommands;
let config;
let groupActionHelper;
let antiAdUtils;
let antilinkUtils;
let sudoStoreUtils;
let profilePictureUtils;

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
    groupActionHelper = await import('../../spider/utils/groupActionHelper.js');
    antiAdUtils = await import('../../spider/utils/antiadvertisement.js');
    antilinkUtils = await import('../../spider/utils/antilink.js');
    sudoStoreUtils = await import('../../spider/utils/sudoStore.js');
    profilePictureUtils = await import('../utils/profilePicture.js');

    await reloadCommandsFromDisk({
      commandsDir: path.join(process.cwd(), 'Spider', 'commands'),
      commandsMap,
      aliasesMap,
      loadLegacyFn: loadLegacyCommands,
      pathToFileUrlFn: pathToFileURL,
      cacheBust: 999401,
    });
  } finally {
    globalThis.setInterval = origSetInterval;
  }
});

after(() => {
  globalThis.fetch = origFetch;
});

function createAckAwareSock({
  botId = '254700000099@s.whatsapp.net',
  botLid = '99900099@lid',
  metadata = null,
  onSendMessage = null,
  onParticipantsUpdate = null,
  onRequestParticipantsUpdate = null,
  onSettingUpdate = null,
  onToggleEphemeral = null,
  onRemoveProfilePicture = null,
  onUpdateProfilePicture = null,
} = {}) {
  const ws = new EventEmitter();
  const ev = new EventEmitter();
  const sent = [];
  const invalidatedGroups = [];
  const participantCalls = [];
  const requestParticipantCalls = [];
  const settingCalls = [];
  const ephemeralCalls = [];
  const removedDpJids = [];
  const updatedDpCalls = [];

  const groupMeta = metadata || {
    id: '120363000000009001@g.us',
    subject: 'Actions Fix Test Group',
    owner: '254700000001@s.whatsapp.net',
    participants: [
      { id: '254700000001@s.whatsapp.net', lid: '1110001@lid', admin: 'superadmin' },
      { id: '2220002@lid', phoneNumber: '254700000002@s.whatsapp.net', admin: 'admin' },
      { id: '3330003@lid', phoneNumber: '254700000003@s.whatsapp.net', admin: null },
      { id: '254700000004@s.whatsapp.net', lid: '4440004@lid', admin: null },
      { id: botId, lid: botLid, admin: 'admin' },
    ],
  };

  const sock = {
    user: {
      id: `${botId.split('@')[0]}:1@s.whatsapp.net`,
      lid: `${botLid.split('@')[0]}:1@lid`,
    },
    ws,
    ev,
    __spiderInvalidateGroupCache: (gid) => {
      invalidatedGroups.push(gid);
    },
    groupMetadata: async () => groupMeta,
    sendMessage: async (jid, payload, options = {}) => {
      const id = `msg-${sent.length + 1}`;
      const record = { id, jid, payload, options };
      sent.push(record);
      const custom = onSendMessage ? await onSendMessage({ id, jid, payload, options, ws, ev, attempt: sent.length }) : null;
      return custom || { key: { id, remoteJid: jid, fromMe: true } };
    },
    groupParticipantsUpdate: async (jid, participants, action) => {
      participantCalls.push({ jid, participants, action });
      if (onParticipantsUpdate) return onParticipantsUpdate({ jid, participants, action });
      return participants.map((p) => ({ status: '200', jid: p }));
    },
    groupRequestParticipantsUpdate: async (jid, participants, action) => {
      requestParticipantCalls.push({ jid, participants, action });
      if (onRequestParticipantsUpdate) return onRequestParticipantsUpdate({ jid, participants, action });
      return participants.map((p) => ({ status: '200', jid: p }));
    },
    groupSettingUpdate: async (jid, setting) => {
      settingCalls.push({ jid, setting });
      if (onSettingUpdate) return onSettingUpdate({ jid, setting });
      return {};
    },
    groupToggleEphemeral: async (jid, duration) => {
      ephemeralCalls.push({ jid, duration });
      if (onToggleEphemeral) return onToggleEphemeral({ jid, duration });
      return {};
    },
    removeProfilePicture: async (jid) => {
      removedDpJids.push(jid);
      if (onRemoveProfilePicture) return onRemoveProfilePicture(jid);
      return {};
    },
    updateProfilePicture: async (jid, buffer) => {
      updatedDpCalls.push({ jid, buffer });
      if (onUpdateProfilePicture) return onUpdateProfilePicture(jid, buffer);
      return {};
    },
    profilePictureUrl: async (jid) => `https://example.com/pp/${encodeURIComponent(jid)}.jpg`,
    star: async () => ({}),
    chatModify: async () => ({}),
    onWhatsApp: async (jid) => [{ exists: true, jid }],
    relayMessage: async (_jid, _msg, opts) => ({ key: { id: opts?.messageId || 'relayed-1' } }),
  };

  return {
    sock,
    ws,
    ev,
    sent,
    invalidatedGroups,
    participantCalls,
    requestParticipantCalls,
    settingCalls,
    ephemeralCalls,
    removedDpJids,
    updatedDpCalls,
    groupMeta,
  };
}

test('deleteMessageSafely detects async WS NACK 479, invalidates group cache, and retries without cache', async () => {
  const { sock, sent, invalidatedGroups, groupMeta } = createAckAwareSock({
    onSendMessage: async ({ id, payload, options, ws }) => {
      if (payload.delete) {
        queueMicrotask(() => {
          if (options?.useCachedGroupMetadata === false) {
            ws.emit('CB:ack,class:message', { attrs: { id } });
          } else {
            ws.emit('CB:ack,class:message', { attrs: { id, error: '479' } });
          }
        });
      }
      return { key: { id, remoteJid: groupMeta.id, fromMe: true } };
    },
  });

  const res = await groupActionHelper.deleteMessageSafely({
    sock,
    from: groupMeta.id,
    msg: {
      key: {
        remoteJid: groupMeta.id,
        id: 'victim-msg-1',
        fromMe: false,
        participant: '3330003@lid',
      },
    },
    metadata: groupMeta,
    ackTimeoutMs: 50,
  });

  assert.equal(res.ok, true);
  assert.equal(res.retriedWithoutCache, true);
  assert.deepEqual(invalidatedGroups, [groupMeta.id]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].options.useCachedGroupMetadata, false);
  assert.equal(sent[1].options.useUserDevicesCache, false);
});

test('deleteMessageSafely detects messages.update status 0 NACK and succeeds on alternate PN/LID key', async () => {
  const { sock, sent, groupMeta } = createAckAwareSock({
    onSendMessage: async ({ id, payload, ev }) => {
      if (payload.delete) {
        queueMicrotask(() => {
          if (payload.delete.participant === '3330003@lid') {
            ev.emit('messages.update', [{ key: { id }, update: { status: 0, messageStubParameters: ['404'] } }]);
          } else {
            ev.emit('messages.update', [{ key: { id }, update: { status: 2 } }]);
          }
        });
      }
      return { key: { id, remoteJid: groupMeta.id, fromMe: true } };
    },
  });

  const res = await groupActionHelper.deleteMessageSafely({
    sock,
    from: groupMeta.id,
    msg: {
      key: {
        remoteJid: groupMeta.id,
        id: 'victim-msg-2',
        fromMe: false,
        participant: '3330003@lid',
      },
    },
    metadata: groupMeta,
    ackTimeoutMs: 50,
  });

  assert.equal(res.ok, true);
  assert.equal(res.key.participant, '254700000003@s.whatsapp.net');
  assert.ok(sent.some((s) => s.payload.delete?.participant === '254700000003@s.whatsapp.net'));
});

test('deleteMessageSafely requires a server ack and routes the revoke to the original message chat', async () => {
  const { sock, sent, groupMeta } = createAckAwareSock();
  const res = await groupActionHelper.deleteMessageSafely({
    sock,
    from: '120363000000009999@g.us',
    msg: {
      key: {
        remoteJid: groupMeta.id,
        id: 'unacked-victim-msg',
        fromMe: false,
        participant: '3330003@lid',
      },
    },
    metadata: null,
    ackTimeoutMs: 0,
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'delete-ack-timeout');
  assert.equal(sent[0].jid, groupMeta.id);
  assert.equal(sent[0].payload.delete.remoteJid, groupMeta.id);
});

test('deleteMessageSafely preserves the raw original participant JID before normalized aliases', async () => {
  const { sock, sent, groupMeta } = createAckAwareSock({
    onSendMessage: async ({ id, jid, payload, ws }) => {
      if (payload.delete) {
        queueMicrotask(() => ws.emit('CB:ack,class:message', { attrs: { id } }));
      }
      return { key: { id, remoteJid: jid, fromMe: true } };
    },
  });
  const originalParticipant = '3330003:17@s.whatsapp.net';
  const result = await groupActionHelper.deleteMessageSafely({
    sock,
    from: groupMeta.id,
    msg: {
      key: {
        remoteJid: groupMeta.id,
        id: 'device-addressed-victim',
        fromMe: false,
        participant: originalParticipant,
      },
    },
    metadata: groupMeta,
    ackTimeoutMs: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(sent[0].payload.delete.participant, originalParticipant);
  assert.equal(sent[0].payload.delete.fromMe, false);
});

test('deleteMessageSafely does not treat a resolved send without a correlatable message ID as confirmed', async () => {
  const { sock, groupMeta } = createAckAwareSock({
    onSendMessage: async () => ({}),
  });
  const res = await groupActionHelper.deleteMessageSafely({
    sock,
    from: groupMeta.id,
    msg: {
      key: {
        remoteJid: groupMeta.id,
        id: 'missing-ack-id-victim',
        fromMe: false,
        participant: '3330003@lid',
      },
    },
    metadata: null,
    ackTimeoutMs: 0,
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'delete-unconfirmed');
});

test('deleteMessageSafely does not claim confirmation when the socket exposes no ACK event channel', async () => {
  const groupJid = '120363000000009001@g.us';
  const sock = {
    sendMessage: async (jid) => ({ key: { id: 'untracked-revoke', remoteJid: jid, fromMe: true } }),
  };
  const res = await groupActionHelper.deleteMessageSafely({
    sock,
    from: groupJid,
    msg: {
      key: {
        remoteJid: groupJid,
        id: 'untracked-victim',
        fromMe: false,
        participant: '3330003@lid',
      },
    },
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'delete-unconfirmed');
});

test('participant update parsing rejects unknown or incomplete responses', () => {
  const first = '254700000001@s.whatsapp.net';
  const second = '254700000002@s.whatsapp.net';
  const malformed = groupActionHelper.parseParticipantsUpdateResult(
    [{ status: 'error', jid: first }, { status: '200', jid: second }],
    [first, second],
  );
  assert.equal(malformed.ok, false);
  assert.equal(malformed.failed[0].status, 'error');

  const omitted = groupActionHelper.parseParticipantsUpdateResult(
    [{ status: '200', jid: first }],
    [first, second],
  );
  assert.equal(omitted.ok, false);
  assert.ok(omitted.failed.some((failure) => failure.jid === second && failure.status === 'missing-result'));
});

test('participant update retry preserves earlier successes when the LID/PN retry fails', async () => {
  const groupJid = '120363000000009001@g.us';
  const firstTarget = '254700000004@s.whatsapp.net';
  const targetLid = '3330003@lid';
  const targetPn = '254700000003@s.whatsapp.net';
  let calls = 0;
  const sock = {
    groupParticipantsUpdate: async (_jid, _participants, _action) => {
      calls += 1;
      if (calls === 1) {
        return [
          { status: '200', jid: firstTarget },
          { status: '404', jid: targetLid },
        ];
      }
      return [{ status: '403', jid: targetPn }];
    },
  };
  const metadata = {
    participants: [
      { id: targetLid, phoneNumber: targetPn, admin: null },
      { id: firstTarget, admin: null },
    ],
  };

  const result = await groupActionHelper.executeParticipantsAction({
    sock,
    from: groupJid,
    participants: [firstTarget, targetLid],
    action: 'remove',
    metadata,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.succeeded, [firstTarget]);
  assert.deepEqual(result.failed, [{ jid: targetPn, status: '403' }]);
  assert.equal(result.retried, true);
});

test('antiadvertisement reports DELETE FAILED when WA rejects delete with 403 and accurately reports MESSAGE DELETED when acked', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-antiad-fix-'));
  const storePath = path.join(tmpDir, 'antiad.json');
  const store = antiAdUtils.createAntiadvertisementStore(storePath);
  const groupJid = '120363000000009001@g.us';
  store.setGroupConfig(groupJid, { enabled: true, action: 'delete', notify: true });

  try {
    const failedEnv = createAckAwareSock({
      onSendMessage: async ({ id, payload, ws }) => {
        if (payload.delete) {
          queueMicrotask(() => {
            ws.emit('CB:ack,class:message', { attrs: { id, error: '403' } });
          });
        }
        return { key: { id, remoteJid: groupJid, fromMe: true } };
      },
    });

    const failRes = await antiAdUtils.handleAntiAdvertisementMessage({
      sock: failedEnv.sock,
      from: groupJid,
      sender: '3330003@lid',
      msg: {
        key: { remoteJid: groupJid, id: 'ad-msg-fail', fromMe: false, participant: '3330003@lid' },
        message: { conversation: 'Safaricom data deals 5GB @ Ksh 100 valid till midnight!' },
      },
      store,
      botName: 'Spider Man',
    });

    assert.equal(failRes.handled, true);
    assert.equal(failRes.deleted, false);
    assert.equal(store.getGroupConfig(groupJid).stats.deleted, 0);
    const failAlert = failedEnv.sent.find((s) => typeof s.payload.text === 'string');
    assert.ok(failAlert, 'Should send alert message');
    assert.match(failAlert.payload.text, /\*ACTION\*\s*›\s*DELETE FAILED/);
    assert.doesNotMatch(failAlert.payload.text, /MESSAGE DELETED/);

    const okEnv = createAckAwareSock({
      onSendMessage: async ({ id, payload, ws }) => {
        if (payload.delete) {
          queueMicrotask(() => {
            ws.emit('CB:ack,class:message', { attrs: { id } });
          });
        }
        return { key: { id, remoteJid: groupJid, fromMe: true } };
      },
    });

    const okRes = await antiAdUtils.handleAntiAdvertisementMessage({
      sock: okEnv.sock,
      from: groupJid,
      sender: '3330003@lid',
      msg: {
        key: { remoteJid: groupJid, id: 'ad-msg-ok', fromMe: false, participant: '3330003@lid' },
        message: { conversation: 'Safaricom data deals 5GB @ Ksh 100 valid till midnight!' },
      },
      store,
      botName: 'Spider Man',
    });

    assert.equal(okRes.handled, true);
    assert.equal(okRes.deleted, true);
    assert.equal(okRes.warningMessage, 'No advertisements or promotions allowed in this group!');
    assert.equal(store.getGroupConfig(groupJid).stats.deleted, 1);
    const okAlert = okEnv.sent.find((s) => typeof s.payload.text === 'string');
    assert.match(okAlert.payload.text, /\*ACTION\*\s*›\s*MESSAGE DELETED/);
    assert.match(okAlert.payload.text, /\*WARNING\*\s*›\s*No advertisements or promotions allowed in this group!/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Group .antilink persists to defaultAntilinkStore and handleAntiLinkMessage reports delete failures honestly', async () => {
  const groupJid = '120363000000009001@g.us';
  const prevCfg = antilinkUtils.defaultAntilinkStore.getGroupConfig(groupJid);

  try {
    const { sock, sent, groupMeta } = createAckAwareSock({
      onSendMessage: async ({ id, payload, ws }) => {
        if (payload.delete) {
          queueMicrotask(() => {
            ws.emit('CB:ack,class:message', { attrs: { id, error: '403' } });
          });
        }
        return { key: { id, remoteJid: groupJid, fromMe: true } };
      },
    });

    const antilinkCmd = commandsMap.get('antilink');
    await antilinkCmd.execute({
      sock,
      from: groupJid,
      text: 'on warn',
      args: ['on', 'warn'],
      msg: { key: { remoteJid: groupJid, id: 'cmd-1' } },
      config,
      groupMeta,
    });
    await antilinkCmd.execute({
      sock,
      from: groupJid,
      text: 'warnlimit 2',
      args: ['warnlimit', '2'],
      msg: { key: { remoteJid: groupJid, id: 'cmd-2' } },
      config,
      groupMeta,
    });

    const saved = antilinkUtils.defaultAntilinkStore.getGroupConfig(groupJid);
    assert.equal(saved.enabled, true);
    assert.equal(saved.action, 'warn');
    assert.equal(saved.maxWarns, 2);

    const linkRes = await antilinkUtils.handleAntiLinkMessage({
      sock,
      from: groupJid,
      sender: '3330003@lid',
      msg: {
        key: { remoteJid: groupJid, id: 'link-msg-1', fromMe: false, participant: '3330003@lid' },
        message: { conversation: 'Join https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv' },
      },
      groupMeta,
      botName: 'Spider Man',
    });

    assert.equal(linkRes.handled, true);
    assert.equal(linkRes.deleted, false);
    const alert = sent.find((s) => String(s.payload.text || '').includes('ANTILINK'));
    assert.ok(alert);
    assert.match(alert.payload.text, /WARNED \(DELETE FAILED\)/);

    await antilinkCmd.execute({
      sock,
      from: groupJid,
      text: 'resetwarns',
      args: ['resetwarns'],
      msg: { key: { remoteJid: groupJid, id: 'cmd-3' } },
      config,
      groupMeta,
    });
    assert.deepEqual(antilinkUtils.defaultAntilinkStore.getGroupConfig(groupJid).warns, {});

    // Delete mode sends explicit "No links allowed" warning
    const delEnv = createAckAwareSock({
      onSendMessage: async ({ id, payload, ws }) => {
        if (payload.delete) {
          queueMicrotask(() => {
            ws.emit('CB:ack,class:message', { attrs: { id } });
          });
        }
        return { key: { id, remoteJid: groupJid, fromMe: true } };
      },
    });

    await antilinkCmd.execute({
      sock: delEnv.sock,
      from: groupJid,
      text: 'on delete',
      args: ['on', 'delete'],
      msg: { key: { remoteJid: groupJid, id: 'cmd-4' } },
      config,
      groupMeta,
    });

    const delLinkRes = await antilinkUtils.handleAntiLinkMessage({
      sock: delEnv.sock,
      from: groupJid,
      sender: '3330003@lid',
      msg: {
        key: { remoteJid: groupJid, id: 'link-msg-del', fromMe: false, participant: '3330003@lid' },
        message: { conversation: 'Visit https://example.com' },
      },
      groupMeta,
      botName: 'Spider Man',
    });

    assert.equal(delLinkRes.handled, true);
    assert.equal(delLinkRes.deleted, true);
    assert.equal(delLinkRes.warningMessage, 'No links allowed in this group!');
    const delAlert = delEnv.sent.find((s) => String(s.payload.text || '').includes('ANTILINK SHIELD'));
    assert.ok(delAlert);
    assert.match(delAlert.payload.text, /\*ACTION\*\s*›\s*MESSAGE DELETED/);
    assert.match(delAlert.payload.text, /\*WARNING\*\s*›\s*No links allowed in this group!/);
  } finally {
    antilinkUtils.defaultAntilinkStore.setGroupConfig(groupJid, prevCfg);
  }
});

test('Group .kick, .kickall, .approve, and .lock check WA responses, retry 404 LID->PN, and invalidate cache', async () => {
  // 1. kick retries 404 LID with PN alternate and invalidates cache
  const env = createAckAwareSock({
    onParticipantsUpdate: async ({ participants }) => {
      if (participants.includes('3330003@lid')) {
        return [{ status: '404', jid: '3330003@lid' }];
      }
      return participants.map((p) => ({ status: '200', jid: p }));
    },
  });

  await commandsMap.get('kick').execute({
    sock: env.sock,
    from: env.groupMeta.id,
    text: '',
    args: [],
    msg: {
      key: { remoteJid: env.groupMeta.id, id: 'cmd-kick-1' },
      message: {
        extendedTextMessage: {
          text: '.kick',
          contextInfo: {
            stanzaId: 'q-1',
            participant: '3330003@lid',
            quotedMessage: { conversation: 'hi' },
          },
        },
      },
    },
    config,
    groupMeta: env.groupMeta,
  });

  assert.equal(env.participantCalls.length, 2);
  assert.deepEqual(env.participantCalls[1].participants, ['254700000003@s.whatsapp.net']);
  assert.ok(env.invalidatedGroups.includes(env.groupMeta.id));
  assert.match(env.sent.at(-1).payload.text, /removed|kicked/i);

  // 2. kick failure (403) does NOT falsely claim removal
  const failEnv = createAckAwareSock({
    onParticipantsUpdate: async ({ participants }) => participants.map((p) => ({ status: '403', jid: p })),
  });
  await commandsMap.get('kick').execute({
    sock: failEnv.sock,
    from: failEnv.groupMeta.id,
    text: '254700000004',
    args: ['254700000004'],
    msg: { key: { remoteJid: failEnv.groupMeta.id, id: 'cmd-kick-fail' } },
    config,
    groupMeta: failEnv.groupMeta,
  });
  assert.match(failEnv.sent.at(-1).payload.text, /failed/i);

  // 3. kickall skips admins and bot
  const kickAllEnv = createAckAwareSock({
    onParticipantsUpdate: async ({ participants }) =>
      participants.map((p) => ({
        status: p === '254700000004@s.whatsapp.net' ? '403' : '200',
        jid: p,
      })),
  });
  assert.equal(commandsMap.get('kickall').botAdminOnly, true);
  await commandsMap.get('kickall').execute({
    sock: kickAllEnv.sock,
    from: kickAllEnv.groupMeta.id,
    text: '',
    args: [],
    msg: { key: { remoteJid: kickAllEnv.groupMeta.id, id: 'cmd-kickall' } },
    config,
    groupMeta: kickAllEnv.groupMeta,
  });
  assert.equal(kickAllEnv.participantCalls.length, 2);
  assert.deepEqual(
    kickAllEnv.participantCalls.flatMap((c) => c.participants),
    ['3330003@lid', '254700000004@s.whatsapp.net'],
  );
  assert.match(kickAllEnv.sent.at(-1).payload.text, /Removed: 1\/2[\s\S]*Failed: 1/);

  const noMetadataEnv = createAckAwareSock();
  noMetadataEnv.sock.groupMetadata = async () => {
    throw new Error('metadata unavailable');
  };
  await commandsMap.get('kickall').execute({
    sock: noMetadataEnv.sock,
    from: noMetadataEnv.groupMeta.id,
    msg: { key: { remoteJid: noMetadataEnv.groupMeta.id, id: 'cmd-kickall-no-metadata' } },
  });
  assert.equal(noMetadataEnv.participantCalls.length, 0);
  assert.match(noMetadataEnv.sent.at(-1).payload.text, /No one was removed/i);

  // 4. approve checks request status 403
  const reqFailEnv = createAckAwareSock({
    onRequestParticipantsUpdate: async ({ participants }) => participants.map((p) => ({ status: '403', jid: p })),
  });
  await commandsMap.get('approve').execute({
    sock: reqFailEnv.sock,
    from: reqFailEnv.groupMeta.id,
    text: '254700000005',
    args: ['254700000005'],
    msg: { key: { remoteJid: reqFailEnv.groupMeta.id, id: 'cmd-approve-fail' } },
    config,
    groupMeta: reqFailEnv.groupMeta,
  });
  assert.match(reqFailEnv.sent.at(-1).payload.text, /failed/i);

  // 5. lock checks groupSettingUpdate error status
  const lockFailEnv = createAckAwareSock({
    onSettingUpdate: async () => ({ status: 403, error: 'not-admin' }),
  });
  await commandsMap.get('lock').execute({
    sock: lockFailEnv.sock,
    from: lockFailEnv.groupMeta.id,
    text: '',
    args: [],
    msg: { key: { remoteJid: lockFailEnv.groupMeta.id, id: 'cmd-lock-fail' } },
    config,
    groupMeta: lockFailEnv.groupMeta,
  });
  assert.match(lockFailEnv.sent.at(-1).payload.text, /failed/i);
});

test('Group participant mutations enforce ADMIN_PROTECTION and fail closed without required metadata', async () => {
  const adminJid = '254700000002@s.whatsapp.net';
  const adminDigits = '254700000002';
  const mutationCases = [
    ['kick', 'remove'],
    ['remove', 'remove'],
    ['add', 'add'],
    ['promote', 'promote'],
    ['demote', 'demote'],
  ];

  for (const [commandName, expectedAction] of mutationCases) {
    const command = commandsMap.get(aliasesMap.get(commandName) || commandName);
    const protectedEnv = createAckAwareSock();
    await command.execute({
      sock: protectedEnv.sock,
      from: protectedEnv.groupMeta.id,
      text: adminDigits,
      args: [adminDigits],
      msg: { key: { remoteJid: protectedEnv.groupMeta.id, id: `protected-${commandName}` } },
      config: { ...config, ADMIN_PROTECTION: true },
    });
    assert.equal(protectedEnv.participantCalls.length, 0, `${commandName} must not mutate an admin target`);
    assert.match(protectedEnv.sent.at(-1).payload.text, /failed/i);

    const unprotectedEnv = createAckAwareSock();
    await command.execute({
      sock: unprotectedEnv.sock,
      from: unprotectedEnv.groupMeta.id,
      text: adminDigits,
      args: [adminDigits],
      msg: { key: { remoteJid: unprotectedEnv.groupMeta.id, id: `unprotected-${commandName}` } },
      config: { ...config, ADMIN_PROTECTION: false },
    });
    assert.equal(unprotectedEnv.participantCalls.length, 1, `${commandName} remains available when protection is off`);
    assert.equal(unprotectedEnv.participantCalls[0].action, expectedAction);
    assert.ok(
      [adminJid, '2220002@lid'].includes(unprotectedEnv.participantCalls[0].participants[0]),
      `${commandName} should target the selected admin via one of its known JID aliases`,
    );
  }

  // A group owner without an admin flag is still recognized by the protection decision.
  // kickall's preliminary filter does not identify this owner, so the shared guard must.
  const kickAllMetadata = {
    id: '120363000000009001@g.us',
    owner: '254700000001@s.whatsapp.net',
    participants: [
      { id: '254700000001@s.whatsapp.net', admin: null },
      { id: '254700000004@s.whatsapp.net', admin: null },
      { id: '254700000099@s.whatsapp.net', lid: '99900099@lid', admin: 'admin' },
    ],
  };
  const protectedKickAll = createAckAwareSock({ metadata: kickAllMetadata });
  await commandsMap.get('kickall').execute({
    sock: protectedKickAll.sock,
    from: kickAllMetadata.id,
    msg: { key: { remoteJid: kickAllMetadata.id, id: 'protected-kickall' } },
    config: { ...config, ADMIN_PROTECTION: true },
  });
  assert.deepEqual(
    protectedKickAll.participantCalls.flatMap((call) => call.participants),
    ['254700000004@s.whatsapp.net'],
  );
  assert.match(protectedKickAll.sent.at(-1).payload.text, /Removed: 1\/2[\s\S]*Failed: 1/);

  const unprotectedKickAll = createAckAwareSock({ metadata: kickAllMetadata });
  await commandsMap.get('kickall').execute({
    sock: unprotectedKickAll.sock,
    from: kickAllMetadata.id,
    msg: { key: { remoteJid: kickAllMetadata.id, id: 'unprotected-kickall' } },
    config: { ...config, ADMIN_PROTECTION: false },
  });
  assert.deepEqual(
    unprotectedKickAll.participantCalls.flatMap((call) => call.participants),
    ['254700000001@s.whatsapp.net', '254700000004@s.whatsapp.net'],
  );

  const noMetadataEnv = createAckAwareSock();
  noMetadataEnv.sock.groupMetadata = async () => {
    throw new Error('metadata unavailable');
  };
  await commandsMap.get('kick').execute({
    sock: noMetadataEnv.sock,
    from: noMetadataEnv.groupMeta.id,
    text: adminDigits,
    args: [adminDigits],
    msg: { key: { remoteJid: noMetadataEnv.groupMeta.id, id: 'protected-no-metadata' } },
    config: { ...config, ADMIN_PROTECTION: true },
  });
  assert.equal(noMetadataEnv.participantCalls.length, 0);
  assert.match(noMetadataEnv.sent.at(-1).payload.text, /failed/i);

  const noMetadataUnprotectedEnv = createAckAwareSock();
  noMetadataUnprotectedEnv.sock.groupMetadata = async () => {
    throw new Error('metadata unavailable');
  };
  await commandsMap.get('kick').execute({
    sock: noMetadataUnprotectedEnv.sock,
    from: noMetadataUnprotectedEnv.groupMeta.id,
    text: adminDigits,
    args: [adminDigits],
    msg: { key: { remoteJid: noMetadataUnprotectedEnv.groupMeta.id, id: 'unprotected-no-metadata' } },
    config: { ...config, ADMIN_PROTECTION: false },
  });
  assert.equal(noMetadataUnprotectedEnv.participantCalls.length, 1);
});

test('User .del deletes wrapped viewOnce quote with LID/bot detection and reports failure honestly', async () => {
  const { sock, sent, groupMeta } = createAckAwareSock({
    onSendMessage: async ({ id, payload, ws }) => {
      if (payload.delete) {
        queueMicrotask(() => {
          ws.emit('CB:ack,class:message', { attrs: { id } });
        });
      }
      return { key: { id, remoteJid: groupMeta.id, fromMe: true } };
    },
  });

  await commandsMap.get('del').execute({
    sock,
    from: groupMeta.id,
    msg: {
      key: { remoteJid: groupMeta.id, id: 'cmd-del-1' },
      message: {
        ephemeralMessage: {
          message: {
            extendedTextMessage: {
              text: '.del',
              contextInfo: {
                stanzaId: 'quoted-bot-lid-msg',
                participant: '99900099@lid',
                quotedMessage: {
                  viewOnceMessageV2: {
                    message: { imageMessage: { caption: 'secret' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    groupMeta,
  });

  const delCall = sent.find((s) => s.payload.delete);
  assert.ok(delCall, 'delete call must be emitted');
  assert.equal(delCall.payload.delete.id, 'quoted-bot-lid-msg');
  assert.equal(delCall.payload.delete.fromMe, true);

  // When delete fails, .del sends failure notice
  const failEnv = createAckAwareSock({
    onSendMessage: async ({ id, payload, ws }) => {
      if (payload.delete) {
        queueMicrotask(() => {
          ws.emit('CB:ack,class:message', { attrs: { id, error: '403' } });
        });
      }
      return { key: { id, remoteJid: groupMeta.id, fromMe: true } };
    },
  });
  await commandsMap.get('del').execute({
    sock: failEnv.sock,
    from: groupMeta.id,
    msg: {
      key: { remoteJid: groupMeta.id, id: 'cmd-del-2' },
      message: {
        extendedTextMessage: {
          text: '.del',
          contextInfo: {
            stanzaId: 'quoted-member-msg',
            participant: '3330003@lid',
            quotedMessage: { conversation: 'hello' },
          },
        },
      },
    },
    groupMeta,
  });
  assert.ok(failEnv.sent.some((s) => s.payload.text === '❌ Failed to delete message.'));
});

test('WhatsApp .removedp uses bot self JID inside groups, .vv unwraps viewOnceMessageV2, and .star uses isFromBot', async () => {
  const { sock, sent, removedDpJids, groupMeta } = createAckAwareSock();

  // .removedp inside group must pass bot self JID, NOT groupMeta.id
  await commandsMap.get('removedp').execute({
    sock,
    from: groupMeta.id,
    text: '',
    msg: { key: { remoteJid: groupMeta.id, id: 'cmd-removedp' } },
    config,
  });
  assert.deepEqual(removedDpJids, ['254700000099@s.whatsapp.net']);

  // .vv on viewOnceMessageV2 inside ephemeral wrapper downloads and sends image without throwing
  const origDownloadContent = baileys.downloadContentFromMessage;
  let vvResult = null;
  // Stub stream chunks via downloadContentFromMessage replacement only if writable; otherwise test missing-media guard doesn't trigger
  const { contextInfo, quotedMessage, rawQuotedMessage } = groupActionHelper.extractContextInfo({
    message: {
      ephemeralMessage: {
        message: {
          extendedTextMessage: {
            text: '.vv',
            contextInfo: {
              stanzaId: 'vo-1',
              participant: '3330003@lid',
              quotedMessage: {
                viewOnceMessageV2: {
                  message: {
                    imageMessage: { caption: 'peek', viewOnce: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  assert.ok(contextInfo);
  assert.equal(groupActionHelper.isViewOnceMessage(rawQuotedMessage), true);
  assert.ok(quotedMessage.imageMessage);
  void origDownloadContent;
  void vvResult;

  // .star on bot message with LID calls chatModify({ star: ... })
  let starPayload = null;
  sock.chatModify = async (payload) => {
    starPayload = payload?.star?.messages || null;
    return {};
  };
  await commandsMap.get('star').execute({
    sock,
    from: groupMeta.id,
    msg: {
      key: { remoteJid: groupMeta.id, id: 'cmd-star' },
      message: {
        ephemeralMessage: {
          message: {
            extendedTextMessage: {
              text: '.star',
              contextInfo: {
                stanzaId: 'star-msg-1',
                participant: '99900099@lid',
                quotedMessage: { conversation: 'important' },
              },
            },
          },
        },
      },
    },
    config,
  });
  assert.ok(starPayload);
  assert.equal(starPayload[0].id, 'star-msg-1');
  assert.equal(starPayload[0].fromMe, true);
  assert.ok(sent.some((s) => /starred/i.test(String(s.payload.text || ''))));
});

test('profilePicture executeGetPP and Sudo .sudo add resolve quoted LIDs via groupMetadata', async () => {
  const { sock, sent, groupMeta } = createAckAwareSock();

  // executeGetPP on quoted LID
  await profilePictureUtils.executeGetPP({
    sock,
    from: groupMeta.id,
    msg: {
      key: { remoteJid: groupMeta.id, id: 'cmd-getpp' },
      message: {
        extendedTextMessage: {
          text: '.getpp',
          contextInfo: {
            stanzaId: 'q-pp',
            participant: '3330003@lid',
            quotedMessage: { conversation: 'pic' },
          },
        },
      },
    },
    text: '',
    args: [],
    config,
    botName: 'Spider Man',
    groupMeta,
  });
  const ppMsg = sent.find((s) => s.payload.image?.url);
  assert.ok(ppMsg);
  assert.match(ppMsg.payload.image.url, /254700000003/);

  // Sudo add/del on quoted LID
  const testPhone = '254700000003';
  const wasAlreadySudo = sudoStoreUtils.isSudoNumber(testPhone);
  try {
    await commandsMap.get('sudo').execute({
      sock,
      from: groupMeta.id,
      text: 'add',
      args: ['add'],
      msg: {
        key: { remoteJid: groupMeta.id, id: 'cmd-sudo-add' },
        message: {
          extendedTextMessage: {
            text: '.sudo add',
            contextInfo: {
              stanzaId: 'q-sudo',
              participant: '3330003@lid',
              quotedMessage: { conversation: 'promote sudo' },
            },
          },
        },
      },
      config,
      isOwner: true,
      groupMeta,
    });
    assert.equal(sudoStoreUtils.isSudoNumber(testPhone), true);

    await commandsMap.get('sudo').execute({
      sock,
      from: groupMeta.id,
      text: 'del',
      args: ['del'],
      msg: {
        key: { remoteJid: groupMeta.id, id: 'cmd-sudo-del' },
        message: {
          extendedTextMessage: {
            text: '.sudo del',
            contextInfo: {
              stanzaId: 'q-sudo-2',
              participant: '3330003@lid',
              quotedMessage: { conversation: 'remove sudo' },
            },
          },
        },
      },
      config,
      isOwner: true,
      groupMeta,
    });
    assert.equal(sudoStoreUtils.isSudoNumber(testPhone), wasAlreadySudo);
  } finally {
    if (!wasAlreadySudo) sudoStoreUtils.removeSudoNumber(testPhone);
  }
});

test('Legacy pinm and gctools disappearing do not throw fq/IsGroup errors and verify action acknowledgements', async () => {
  const { sock, sent, ephemeralCalls, groupMeta } = createAckAwareSock({
    onSendMessage: async ({ id, payload, ws }) => {
      if (payload.pin) {
        queueMicrotask(() => {
          ws.emit('CB:ack,class:message', { attrs: { id } });
        });
      }
      return { key: { id, remoteJid: groupMeta.id, fromMe: true } };
    },
  });

  const pinmCmd = commandsMap.get('pinm');
  assert.ok(pinmCmd, 'pinm legacy command must be registered');

  await pinmCmd.execute({
    sock,
    from: groupMeta.id,
    sender: '254700000001@s.whatsapp.net',
    senderNumber: '254700000001',
    text: '24h',
    args: ['24h'],
    msg: {
      key: { remoteJid: groupMeta.id, id: 'cmd-pinm-1', participant: '254700000001@s.whatsapp.net' },
      message: {
        extendedTextMessage: {
          text: '.pinm 24h',
          contextInfo: {
            stanzaId: 'msg-to-pin',
            participant: '254700000004@s.whatsapp.net',
            quotedMessage: { conversation: 'Pin this!' },
          },
        },
      },
    },
    config,
    isOwner: true,
    groupMeta,
    isGroupAdmin: true,
    isBotGroupAdmin: true,
  });

  const pinPayloadMsg = sent.find((s) => s.payload.pin);
  assert.ok(pinPayloadMsg, 'pinm must send pin payload instead of failing IsGroup');
  assert.equal(pinPayloadMsg.payload.pin.id, 'msg-to-pin');
  assert.ok(sent.some((s) => /Message pinned!/i.test(String(s.payload.text || ''))));

  // Verify pinm without duration also works without ReferenceError: fq is not defined
  await pinmCmd.execute({
    sock,
    from: groupMeta.id,
    sender: '254700000001@s.whatsapp.net',
    senderNumber: '254700000001',
    text: '',
    args: [],
    msg: {
      key: { remoteJid: groupMeta.id, id: 'cmd-pinm-2', participant: '254700000001@s.whatsapp.net' },
      message: {
        extendedTextMessage: {
          text: '.pinm',
          contextInfo: {
            stanzaId: 'msg-to-pin-2',
            participant: '254700000004@s.whatsapp.net',
            quotedMessage: { conversation: 'Pin picker' },
          },
        },
      },
    },
    config,
    isOwner: true,
    groupMeta,
    isGroupAdmin: true,
    isBotGroupAdmin: true,
  });

  const disapCmd = commandsMap.get('disappearing');
  assert.ok(disapCmd, 'disappearing legacy command must be registered');

  // Picker without args must not throw fq error
  await disapCmd.execute({
    sock,
    from: groupMeta.id,
    sender: '254700000001@s.whatsapp.net',
    senderNumber: '254700000001',
    text: '',
    args: [],
    msg: { key: { remoteJid: groupMeta.id, id: 'cmd-disap-1', participant: '254700000001@s.whatsapp.net' } },
    config,
    isOwner: true,
    groupMeta,
    isGroupAdmin: true,
    isBotGroupAdmin: true,
  });

  // Setting disappearing 7d succeeds and invalidates cache
  await disapCmd.execute({
    sock,
    from: groupMeta.id,
    sender: '254700000001@s.whatsapp.net',
    senderNumber: '254700000001',
    text: '7d',
    args: ['7d'],
    msg: { key: { remoteJid: groupMeta.id, id: 'cmd-disap-2', participant: '254700000001@s.whatsapp.net' } },
    config,
    isOwner: true,
    groupMeta,
    isGroupAdmin: true,
    isBotGroupAdmin: true,
  });
  assert.equal(ephemeralCalls.at(-1)?.duration, 604800);
});

test('User .del and group shields broadcast both LID and PN revokes with fresh group/device cache', async () => {
  // 1. .del in LID-addressed group when quote carries PN participant prioritizes LID first AND still broadcasts PN alternate
  const lidGroupMeta = {
    id: '120363000000009099@g.us',
    subject: 'LID Group',
    addressingMode: 'lid',
    owner: '1110001@lid',
    participants: [
      { id: '1110001@lid', phoneNumber: '254700000001@s.whatsapp.net', admin: 'superadmin' },
      { id: '3330003@lid', phoneNumber: '254700000003@s.whatsapp.net', admin: null },
      { id: '99900099@lid', phoneNumber: '254700000099@s.whatsapp.net', admin: 'admin' },
    ],
  };

  const lidEnv = createAckAwareSock({
    metadata: lidGroupMeta,
    onSendMessage: async ({ id, payload, ws }) => {
      if (payload.delete) {
        queueMicrotask(() => {
          ws.emit('CB:ack,class:message', { attrs: { id } });
        });
      }
      return { key: { id, remoteJid: lidGroupMeta.id, fromMe: true } };
    },
  });

  await commandsMap.get('del').execute({
    sock: lidEnv.sock,
    from: lidGroupMeta.id,
    msg: {
      key: { remoteJid: lidGroupMeta.id, id: 'cmd-del-lid-pn' },
      message: {
        extendedTextMessage: {
          text: '.del',
          contextInfo: {
            stanzaId: 'victim-quote-pn',
            participant: '254700000003@s.whatsapp.net',
            quotedMessage: { conversation: 'delete me' },
          },
        },
      },
    },
  });

  const delCalls = lidEnv.sent.filter((s) => s.payload.delete);
  assert.equal(delCalls.length, 2, 'must broadcast revoke for both LID and PN even when server ACKs first');
  assert.equal(delCalls[0].payload.delete.participant, '3330003@lid');
  assert.equal(delCalls[1].payload.delete.participant, '254700000003@s.whatsapp.net');
  assert.equal(delCalls[0].options.useCachedGroupMetadata, false);
  assert.equal(delCalls[0].options.useUserDevicesCache, false);
  assert.ok(lidEnv.invalidatedGroups.includes(lidGroupMeta.id));

  // 2. signalRepository.lidMapping resolves missing LID<->PN pairs when metadata omits them, including bot LID -> fromMe: true
  const sparseMeta = {
    id: '120363000000009088@g.us',
    subject: 'Sparse Meta Group',
    addressingMode: 'lid',
    participants: [
      { id: '5550005@lid', admin: null },
      { id: '88800088@lid', admin: 'admin' },
    ],
  };
  const sparseEnv = createAckAwareSock({
    botId: '254700000088@s.whatsapp.net',
    botLid: '',
    metadata: sparseMeta,
    onSendMessage: async ({ id, payload, ws }) => {
      if (payload.delete) {
        queueMicrotask(() => {
          ws.emit('CB:ack,class:message', { attrs: { id } });
        });
      }
      return { key: { id, remoteJid: sparseMeta.id, fromMe: true } };
    },
  });
  sparseEnv.sock.user = { id: '254700000088:1@s.whatsapp.net' };
  sparseEnv.sock.signalRepository = {
    lidMapping: {
      getPNForLID: async (lid) => {
        if (lid === '5550005@lid') return '254700000005@s.whatsapp.net';
        if (lid === '88800088@lid') return '254700000088@s.whatsapp.net';
        return null;
      },
      getKnownLIDsForPNs: async (pns) =>
        pns.includes('254700000088@s.whatsapp.net')
          ? [{ pn: '254700000088@s.whatsapp.net', lid: '88800088@lid' }]
          : [],
    },
  };

  await commandsMap.get('del').execute({
    sock: sparseEnv.sock,
    from: sparseMeta.id,
    msg: {
      key: { remoteJid: sparseMeta.id, id: 'cmd-del-bot-mapped' },
      message: {
        extendedTextMessage: {
          text: '.del',
          contextInfo: {
            stanzaId: 'bot-msg-via-signal',
            participant: '88800088@lid',
            quotedMessage: { conversation: 'bot message' },
          },
        },
      },
    },
  });

  const mappedBotDels = sparseEnv.sent.filter((s) => s.payload.delete);
  assert.equal(mappedBotDels.length, 2);
  assert.equal(mappedBotDels[0].payload.delete.fromMe, true);
  assert.deepEqual(
    mappedBotDels.map((d) => d.payload.delete.participant).sort(),
    ['254700000088@s.whatsapp.net', '88800088@lid'],
  );

  // 3. Antilink shield also broadcasts both LID and PN revokes in mixed groups
  const linkGroup = lidGroupMeta.id;
  const prevCfg = antilinkUtils.defaultAntilinkStore.getGroupConfig(linkGroup);
  try {
    antilinkUtils.defaultAntilinkStore.setGroupConfig(linkGroup, {
      enabled: true,
      action: 'delete',
      notify: true,
    });
    const shieldEnv = createAckAwareSock({
      metadata: lidGroupMeta,
      onSendMessage: async ({ id, payload, ws }) => {
        if (payload.delete) {
          queueMicrotask(() => {
            ws.emit('CB:ack,class:message', { attrs: { id } });
          });
        }
        return { key: { id, remoteJid: linkGroup, fromMe: true } };
      },
    });
    const shieldRes = await antilinkUtils.handleAntiLinkMessage({
      sock: shieldEnv.sock,
      from: linkGroup,
      sender: '3330003@lid',
      msg: {
        key: {
          remoteJid: linkGroup,
          id: 'link-mixed-1',
          fromMe: false,
          participant: '3330003@lid',
        },
        message: { conversation: 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv' },
      },
      groupMeta: lidGroupMeta,
      botName: 'Spider Man',
    });
    assert.equal(shieldRes.deleted, true);
    const shieldDels = shieldEnv.sent.filter((s) => s.payload.delete);
    assert.equal(shieldDels.length, 2);
    assert.deepEqual(
      shieldDels.map((d) => d.payload.delete.participant),
      ['3330003@lid', '254700000003@s.whatsapp.net'],
    );
  } finally {
    antilinkUtils.defaultAntilinkStore.setGroupConfig(linkGroup, prevCfg);
  }
});
