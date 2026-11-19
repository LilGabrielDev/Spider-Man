import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import {
  configureMessageRetryStore,
  createPreSendPatchCapture,
  flushMessageRetryStore,
  getMessageForRetry,
  installMessageRetryStore,
  messageStore,
  registerChatAlias,
  rememberMessage,
  resetMessageRetryStore,
  setChatAliasResolver,
  trimMessageRetryStore,
} from '../../spider/anti.js';
import {
  createBaileysCacheStore,
  startResourceMaintenance,
} from '../../spider/utils/resourceGuard.js';

const groupA = '120363000000000001@g.us';
const groupB = '120363000000000002@g.us';

test('retry cache returns original content by remote chat and message ID', async () => {
  const sharedId = `retry-${Date.now()}-${Math.random()}`;
  const inbound = { conversation: 'incoming group content' };
  const outbound = { extendedTextMessage: { text: 'outgoing bot content' } };

  assert.equal(rememberMessage({ key: { remoteJid: groupA, id: sharedId, fromMe: false }, message: inbound }), true);
  assert.equal(rememberMessage({ key: { remoteJid: groupB, id: sharedId, fromMe: true }, message: outbound }), true);

  assert.deepEqual(await getMessageForRetry({ remoteJid: groupA, id: sharedId }), inbound);
  assert.deepEqual(await getMessageForRetry({ remoteJid: groupB, id: sharedId }), outbound);
  assert.equal(await getMessageForRetry({ remoteJid: '120363000000000003@g.us', id: sharedId }), undefined);
  assert.equal(await getMessageForRetry({ id: `missing-${sharedId}` }), undefined);
});

test('retry cache immediately captures sendMessage and relayMessage payloads', async () => {
  const id = `send-${Date.now()}-${Math.random()}`;
  const relayedId = `relay-${Date.now()}-${Math.random()}`;
  const relayedStringId = `relay-str-${Date.now()}-${Math.random()}`;
  const sentContent = { conversation: 'sent with sendMessage' };
  const relayedContent = { extendedTextMessage: { text: 'sent with relayMessage' } };
  const relayedNoOptContent = { extendedTextMessage: { text: 'relayed without explicit id' } };
  let preRelayLookup;
  const sock = {
    sendMessage: async (jid) => ({ key: { remoteJid: jid, id, fromMe: true }, message: sentContent }),
    relayMessage: async (jid, _msg, opts = {}) => {
      if (opts.messageId === relayedId) {
        preRelayLookup = await getMessageForRetry({ remoteJid: jid, id: relayedId });
        return { key: { remoteJid: groupA, id: relayedId, fromMe: true } };
      }
      return relayedStringId;
    },
  };

  assert.equal(installMessageRetryStore(sock), true);
  assert.equal(installMessageRetryStore(sock), true, 'install should be idempotent');
  await sock.sendMessage(groupA, sentContent);
  await sock.relayMessage(groupA, relayedContent, { messageId: relayedId });
  await sock.relayMessage(groupA, relayedNoOptContent);

  assert.deepEqual(preRelayLookup, relayedContent, 'explicit messageId should be cached before relay completes');
  assert.deepEqual(await getMessageForRetry({ remoteJid: groupA, id }), sentContent);
  assert.deepEqual(await getMessageForRetry({ remoteJid: groupA, id: relayedId }), relayedContent);
  assert.deepEqual(await getMessageForRetry({ remoteJid: groupA, id: relayedStringId }), relayedNoOptContent);
});

test('pre-send patch keeps native-flow messages direct and wraps only legacy buttons like atassa', async () => {
  const nativeFlow = {
    interactiveMessage: {
      body: { text: 'Pong!' },
      nativeFlowMessage: {
        buttons: [{ name: 'quick_reply', buttonParamsJson: '{"id":".uptime"}' }],
      },
    },
  };
  const patch = createPreSendPatchCapture();

  assert.equal(await patch(nativeFlow, [groupA]), nativeFlow, 'native-flow payloads are sent directly');

  const legacyButtons = { buttonsMessage: { contentText: 'Choose', buttons: [] } };
  const expectedLegacy = {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} },
        ...legacyButtons,
      },
    },
  };
  assert.deepEqual(await patch(legacyButtons, [groupA]), expectedLegacy);
  assert.deepEqual(await patch(expectedLegacy, [groupA]), expectedLegacy, 'do not double-wrap an already patched message');
  for (const legacyMessage of [
    { templateMessage: { hydratedTemplate: {} } },
    { listMessage: { title: 'Choose' } },
  ]) {
    assert.deepEqual(await patch(legacyMessage, [groupA]), {
      viewOnceMessage: {
        message: {
          messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} },
          ...legacyMessage,
        },
      },
    });
  }

  const plainMessage = { conversation: 'plain text stays unchanged' };
  assert.equal(await patch(plainMessage, [groupA]), plainMessage);

  const recipientSpecificPatch = createPreSendPatchCapture(async (content) => [
    { recipientJid: groupA, message: content },
  ]);
  assert.deepEqual(await recipientSpecificPatch(nativeFlow, [groupA]), [{ recipientJid: groupA, message: nativeFlow }]);
  assert.deepEqual(await recipientSpecificPatch(legacyButtons, [groupA]), [
    { recipientJid: groupA, message: expectedLegacy },
  ]);
});

test('retry cache resolves device-suffixed JIDs and PN/LID aliases without leaking across groups', async () => {
  const pn = '254711111111@s.whatsapp.net';
  const pnDevice = '254711111111:3@s.whatsapp.net';
  const lid = '998877665544@lid';
  const lidDevice = '998877665544:2@lid';
  const msgId = `alias-${Date.now()}-${Math.random()}`;
  const payload = { conversation: 'hello linked device' };

  rememberMessage({ key: { remoteJid: pnDevice, id: msgId, fromMe: true }, message: payload });
  registerChatAlias(pn, lid);

  assert.deepEqual(await getMessageForRetry({ remoteJid: pn, id: msgId }), payload);
  assert.deepEqual(await getMessageForRetry({ remoteJid: lid, id: msgId }), payload);
  assert.deepEqual(await getMessageForRetry({ remoteJid: lidDevice, id: msgId }), payload);
  assert.equal(await getMessageForRetry({ remoteJid: '254799999999@s.whatsapp.net', id: msgId }), undefined);

  const dynamicId = `dyn-${Date.now()}-${Math.random()}`;
  const dynamicPn = '254722222222@s.whatsapp.net';
  const dynamicLid = '112233445566@lid';
  setChatAliasResolver(async (jid) => (jid === dynamicLid ? [dynamicPn] : []));
  rememberMessage({ key: { remoteJid: dynamicPn, id: dynamicId, fromMe: true }, message: payload });
  assert.deepEqual(await getMessageForRetry({ remoteJid: dynamicLid, id: dynamicId }), payload);
  setChatAliasResolver(null);
});

test('configureMessageRetryStore persists binary message fields and restores across restarts', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-retry-store-'));
  const storePath = path.join(tmpDir, 'retry-message-store.json');
  const msgId = `persist-${Date.now()}`;
  const mediaKey = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const msgContent = { imageMessage: { caption: 'persisted media', mediaKey } };

  try {
    resetMessageRetryStore();
    configureMessageRetryStore({ persistPath: storePath, maxMessages: 50 });
    rememberMessage({ key: { remoteJid: groupA, id: msgId, fromMe: true }, message: msgContent });
    flushMessageRetryStore();

    // Simulate process restart with fresh memory maps
    resetMessageRetryStore();
    assert.equal(await getMessageForRetry({ remoteJid: groupA, id: msgId }), undefined);

    const loaded = configureMessageRetryStore({ persistPath: storePath, maxMessages: 50 });
    assert.ok(loaded >= 1);
    const restored = await getMessageForRetry({ remoteJid: groupA, id: msgId });
    assert.equal(restored?.imageMessage?.caption, 'persisted media');
    assert.deepEqual(Uint8Array.from(restored.imageMessage.mediaKey), mediaKey);
  } finally {
    resetMessageRetryStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('serializes concurrent sends per chat while keeping different chats parallel', async () => {
  const events = [];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sock = {
    sendMessage: async (jid, message) => {
      events.push(`start:${jid}:${message.text}`);
      await wait(5);
      events.push(`end:${jid}:${message.text}`);
      return { key: { remoteJid: jid, id: `${jid}-${message.text}`, fromMe: true }, message };
    },
  };

  installMessageRetryStore(sock);
  await Promise.all([
    sock.sendMessage(groupA, { text: 'one' }),
    sock.sendMessage(groupA, { text: 'two' }),
    sock.sendMessage(groupB, { text: 'other' }),
  ]);

  assert.equal(events[0], `start:${groupA}:one`);
  assert.equal(events.indexOf(`end:${groupA}:one`) < events.indexOf(`start:${groupA}:two`), true);
  assert.equal(events.includes(`start:${groupB}:other`), true);
  assert.equal(events.indexOf(`start:${groupA}:two`) > events.indexOf(`end:${groupA}:one`), true);
});

test('resourceGuard preserves protected retry/LID caches during aggressive memory trim', () => {
  const ephemeral = createBaileysCacheStore({ maxEntries: 10, ttlMs: 60_000 });
  const retryCache = createBaileysCacheStore({ maxEntries: 10, ttlMs: 60_000 });
  ephemeral.set('temp', 1);
  retryCache.set('msg-1:user', 2);

  const maint = startResourceMaintenance({
    caches: [ephemeral],
    protectedCaches: [retryCache],
    quiet: true,
    intervalMs: 60_000,
  });
  try {
    maint.runNow({ forceMemoryTrim: true });
    assert.equal(ephemeral.get('temp'), undefined);
    assert.equal(retryCache.get('msg-1:user'), 2);
  } finally {
    maint.stop();
  }
});

test('live Baileys socket wires getMessage, signal key cache, placeholder resend, and caches upserted and own-sent messages', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'spider/index.js'), 'utf8');
  assert.match(source, /'getMessage':getMessageForRetry/);
  assert.match(source, /'emitOwnEvents':!!\[\]/);
  assert.match(source, /'shouldSyncHistoryMessage':\(\)=>!!\[\]/);
  assert.match(source, /makeCacheableSignalKeyStore\(/);
  assert.match(source, /'placeholderResendCache':placeholderResendCache/);
  assert.match(source, /'enableAutoSessionRecreation':!!\[\]/);
  assert.match(source, /'enableRecentMessageCache':!!\[\]/);
  assert.match(source, /configureMessageRetryStore\(/);
  assert.match(source, /installMessageRetryStore\(sock\)/);
  assert.match(source, /installSocketResilience\(sock/);
  assert.match(source, /'lid-mapping\.update'/);
  assert.match(source, /'messages\.update'/);
  assert.match(source, /messaging-history\.set/);
  assert.match(source, /rememberMessage\(_0x16a3b2\);/);
});

test('configureMessageRetryStore preserves nested binary fields on proto.Message instances', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-proto-retry-'));
  const storePath = path.join(tmpDir, 'retry-message-store.json');
  const msgId = `proto-${Date.now()}`;
  const mediaKey = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
  const messageSecret = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1]);
  const protoMsg = proto.Message.fromObject({
    imageMessage: { caption: 'menu', mediaKey },
    messageContextInfo: { messageSecret },
  });

  try {
    resetMessageRetryStore();
    configureMessageRetryStore({ persistPath: storePath, maxMessages: 50 });
    rememberMessage({ key: { remoteJid: groupA, id: msgId, fromMe: true }, message: protoMsg });
    flushMessageRetryStore();

    resetMessageRetryStore();
    configureMessageRetryStore({ persistPath: storePath, maxMessages: 50 });
    const restored = await getMessageForRetry({ remoteJid: groupA, id: msgId });
    assert.equal(restored?.imageMessage?.caption, 'menu');
    assert.deepEqual(Uint8Array.from(restored.imageMessage.mediaKey), mediaKey);
    assert.deepEqual(Uint8Array.from(restored.messageContextInfo.messageSecret), messageSecret);
  } finally {
    resetMessageRetryStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('installMessageRetryStore serializes concurrent sends to aliased PN and LID JIDs', async () => {
  const pn = '254733333333@s.whatsapp.net';
  const lid = '776655443322@lid';
  const events = [];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sock = {
    sendMessage: async (jid, message) => {
      events.push(`start:${jid}:${message.text}`);
      await wait(10);
      events.push(`end:${jid}:${message.text}`);
      return { key: { remoteJid: jid, id: `${jid}-${message.text}`, fromMe: true }, message };
    },
  };

  resetMessageRetryStore();
  registerChatAlias(pn, lid);
  installMessageRetryStore(sock);

  await Promise.all([
    sock.sendMessage(pn, { text: 'first' }),
    sock.sendMessage(lid, { text: 'second' }),
  ]);

  assert.deepEqual(events, [
    `start:${pn}:first`,
    `end:${pn}:first`,
    `start:${lid}:second`,
    `end:${lid}:second`,
  ]);
  resetMessageRetryStore();
});

test('createPreSendPatchCapture caches outbound payload BEFORE sendMessage returns', async () => {
  resetMessageRetryStore();
  const patcher = createPreSendPatchCapture();
  let midFlightRetryHit = null;
  let capturedMsgId = null;

  const sock = {
    user: { id: '254712345678:12@s.whatsapp.net' },
    sendMessage: async (jid, content, options) => {
      capturedMsgId = options?.messageId;
      assert.ok(capturedMsgId, 'live socket must assign deterministic messageId before dispatch');
      const protoPayload = proto.Message.fromObject({
        extendedTextMessage: { text: content.text },
      });
      await patcher(protoPayload, [jid]);
      midFlightRetryHit = await getMessageForRetry({ remoteJid: jid, id: capturedMsgId });
      return { key: { remoteJid: jid, id: capturedMsgId, fromMe: true }, message: protoPayload };
    },
  };

  installMessageRetryStore(sock);
  const res = await sock.sendMessage(groupA, { text: 'menu output' });
  assert.equal(res.key.id, capturedMsgId);
  assert.equal(midFlightRetryHit?.extendedTextMessage?.text, 'menu output');
  resetMessageRetryStore();
});

test('spider/index.js wires hardened auth state, connection controller, signal guard, and pre-send capture', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'spider/index.js'), 'utf8');
  assert.match(source, /useHardenedMultiFileAuthState\(/);
  assert.match(source, /createConnectionController\(/);
  assert.match(source, /createGuardedSignalKeyStore\(/);
  assert.match(source, /'patchMessageBeforeSending':createPreSendPatchCapture\(\)/);
  assert.match(source, /createBaileysSignalLogger\(/);
  assert.match(source, /'preserveSignalKeys':!!\[\]/);
});

test('trimMessageRetryStore shrinks retry cache and retains newest messages under memory pressure', async () => {
  resetMessageRetryStore();
  try {
    configureMessageRetryStore({ maxMessages: 500, maxChatAliases: 500 });
    for (let i = 0; i < 40; i += 1) {
      rememberMessage({
        key: { remoteJid: groupA, id: `trim-msg-${i}`, fromMe: true },
        message: { conversation: `msg-${i}` },
      });
    }
    assert.equal(messageStore.size, 40);

    const removed = trimMessageRetryStore({ maxEntries: 10, maxAliasEntries: 10 });
    assert.equal(removed, 30);
    assert.equal(messageStore.size, 10);
    assert.equal(await getMessageForRetry({ remoteJid: groupA, id: 'trim-msg-0' }), undefined);
    assert.deepEqual(await getMessageForRetry({ remoteJid: groupA, id: 'trim-msg-39' }), {
      conversation: 'msg-39',
    });
  } finally {
    resetMessageRetryStore();
  }
});
