import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALL_APP_STATE_COLLECTIONS,
  clearCachedUserDevices,
  countLocalPreKeyFiles,
  createGuardedSignalKeyStore,
  createHardenedSignalRepository,
  ensureActiveOnlinePresence,
  ensureAppStateSynced,
  ensureFallbackMeName,
  ensureHealthyPreKeys,
  installSocketResilience,
  requestMissingAppStateSyncKeys,
  syncMessageKeyAliases,
  wrapAckErrorRecovery,
  wrapLidMappingResilience,
  wrapPresenceResilience,
  wrapSendOptionsNormalization,
  wrapSignalAndSenderKeyGuard,
  wrapWebSocketTagSanitizer,
} from '../../spider/utils/socketResilience.js';

function createEmitter() {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    emit(event, payload) {
      for (const fn of listeners.get(event) || []) {
        fn(payload);
      }
    },
  };
}

test('ensureHealthyPreKeys replenishes Katabump creds-only sessions and skips healthy dirs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-prekey-test-'));
  try {
    // 1. Fresh Katabump container: nextPreKeyId = 50, zero local pre-key-*.json files
    let uploadedCounts = [];
    const loggedInfo = [];
    const katabumpSock = {
      authState: {
        creds: { nextPreKeyId: 50 },
        keys: { get: async () => ({}) },
      },
      uploadPreKeys: async (count) => {
        uploadedCounts.push(count);
      },
    };

    assert.equal(countLocalPreKeyFiles(tmpDir), 0);
    const didUpload = await ensureHealthyPreKeys(katabumpSock, {
      authDir: tmpDir,
      logInfo: (msg) => loggedInfo.push(msg),
    });
    assert.equal(didUpload, true);
    assert.deepEqual(uploadedCounts, [50]);
    assert.match(loggedInfo[0], /Uploaded 50 fresh pre-keys/);

    // Subsequent call on same socket is a no-op
    assert.equal(
      await ensureHealthyPreKeys(katabumpSock, { authDir: tmpDir }),
      false,
    );
    assert.deepEqual(uploadedCounts, [50]);

    // 2. Low local pre-key count (< 15) triggers replenish
    for (let i = 1; i <= 5; i += 1) {
      fs.writeFileSync(path.join(tmpDir, `pre-key-${i}.json`), '{}');
    }
    assert.equal(countLocalPreKeyFiles(tmpDir), 5);
    const lowUploaded = [];
    const lowSock = {
      authState: {
        creds: { nextPreKeyId: 6 },
        keys: { get: async () => ({ '5': {} }) },
      },
      uploadPreKeys: async (count) => {
        lowUploaded.push(count);
      },
    };
    assert.equal(await ensureHealthyPreKeys(lowSock, { authDir: tmpDir }), true);
    assert.deepEqual(lowUploaded, [50]);

    // 3. Healthy dir (>= 15 local pre-keys and current key present) skips upload
    for (let i = 6; i <= 20; i += 1) {
      fs.writeFileSync(path.join(tmpDir, `pre-key-${i}.json`), '{}');
    }
    const healthyUploaded = [];
    const healthySock = {
      authState: {
        creds: { nextPreKeyId: 21 },
        keys: { get: async () => ({ '20': {} }) },
      },
      uploadPreKeys: async (count) => {
        healthyUploaded.push(count);
      },
    };
    assert.equal(await ensureHealthyPreKeys(healthySock, { authDir: tmpDir }), false);
    assert.deepEqual(healthyUploaded, []);

    // 4. Failed upload resets guard and logs error for later retry
    const errors = [];
    let shouldFail = true;
    const retrySock = {
      authState: {
        creds: { nextPreKeyId: 40 },
        keys: { get: async () => ({}) },
      },
      uploadPreKeys: async () => {
        if (shouldFail) throw new Error('upload timed out');
      },
    };
    assert.equal(
      await ensureHealthyPreKeys(retrySock, {
        authDir: tmpDir,
        logError: (ctx, _c, _j, err) => errors.push(`${ctx}:${err}`),
      }),
      false,
    );
    assert.equal(errors[0], 'Signal PreKey Replenish:upload timed out');
    shouldFail = false;
    assert.equal(
      await ensureHealthyPreKeys(retrySock, { authDir: tmpDir, logInfo: () => {} }),
      true,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('syncMessageKeyAliases correlates PN/LID across direct and group message keys', () => {
  const registered = [];
  const phoneToLidMap = new Map();
  const lidToPhoneMap = new Map();

  // Direct chat key
  const directUpdated = syncMessageKeyAliases(
    {
      remoteJid: '12345678901234@lid',
      remoteJidAlt: '254711111111@s.whatsapp.net',
      senderPn: '254711111111@s.whatsapp.net',
      senderLid: '12345678901234@lid',
    },
    {
      registerChatAlias: (a, b) => {
        registered.push([a, b]);
        return true;
      },
      phoneToLidMap,
      lidToPhoneMap,
    },
  );

  assert.equal(directUpdated, true);
  assert.ok(registered.length >= 1);
  assert.equal(phoneToLidMap.get('254711111111'), '12345678901234@lid');
  assert.equal(lidToPhoneMap.get('12345678901234@lid'), '254711111111');

  // Group chat key: should NOT alias remoteJid (@g.us), should populate participant PN/LID maps
  const groupRegistered = [];
  const groupUpdated = syncMessageKeyAliases(
    {
      remoteJid: '120363000000000001@g.us',
      participant: '998877665544@lid',
      participantAlt: '254722222222@s.whatsapp.net',
    },
    {
      registerChatAlias: (a, b) => {
        groupRegistered.push([a, b]);
        return true;
      },
      phoneToLidMap,
      lidToPhoneMap,
    },
  );

  assert.equal(groupUpdated, true);
  assert.equal(groupRegistered.length, 0);
  assert.equal(phoneToLidMap.get('254722222222'), '998877665544@lid');
  assert.equal(lidToPhoneMap.get('998877665544@lid'), '254722222222');
});

test('wrapLidMappingResilience recovers partial batches and injects fallback PNs into encrypt IQs', async () => {
  const queriesSent = [];
  const errors = [];
  const sock = {
    signalRepository: {
      lidMapping: {
        getKnownLIDsForPNs: async (pns) => {
          if (pns.includes('254700000001@s.whatsapp.net')) {
            return [{ pn: '254700000001@s.whatsapp.net', lid: '111111111111@lid' }];
          }
          return [];
        },
        getLIDsForPNs: async (pns) => {
          // Simulate Baileys returning null for batch containing an unmapped PN
          if (pns.length > 1) return null;
          if (pns[0] === '254700000002@s.whatsapp.net') {
            return [{ pn: '254700000002@s.whatsapp.net', lid: '222222222222@lid' }];
          }
          // PN3 cannot be mapped to any LID
          return [];
        },
      },
    },
    query: async (node) => {
      queriesSent.push(node);
      return { tag: 'iq', attrs: { type: 'result' }, content: [] };
    },
  };

  assert.equal(wrapLidMappingResilience(sock, { logError: (...a) => errors.push(a) }), true);
  assert.equal(wrapLidMappingResilience(sock), true, 'wrapper must be idempotent');

  const recovered = await sock.signalRepository.lidMapping.getLIDsForPNs([
    '254700000001@s.whatsapp.net',
    '254700000002@s.whatsapp.net',
    '254700000003@s.whatsapp.net',
  ]);

  assert.deepEqual(recovered, [
    { pn: '254700000001@s.whatsapp.net', lid: '111111111111@lid' },
    { pn: '254700000002@s.whatsapp.net', lid: '222222222222@lid' },
  ]);

  // Next encrypt <key/> IQ with identity reason injects the unmapped PN3 with reason='identity'
  const iqNode = {
    tag: 'iq',
    attrs: { xmlns: 'encrypt', type: 'get' },
    content: [
      {
        tag: 'key',
        attrs: {},
        content: [{ tag: 'user', attrs: { jid: '111111111111@lid', reason: 'identity' } }],
      },
    ],
  };
  await sock.query(iqNode);
  assert.equal(queriesSent.length, 1);
  assert.deepEqual(queriesSent[0].content[0].content, [
    { tag: 'user', attrs: { jid: '111111111111@lid', reason: 'identity' } },
    { tag: 'user', attrs: { jid: '254700000003@s.whatsapp.net', reason: 'identity' } },
  ]);

  // Empty <key/> IQ with no pending unmapped PNs is short-circuited cleanly
  const emptyRes = await sock.query({
    tag: 'iq',
    attrs: { xmlns: 'encrypt', type: 'get' },
    content: [{ tag: 'key', attrs: {}, content: [] }],
  });
  assert.deepEqual(emptyRes, { tag: 'iq', attrs: { type: 'result' }, content: [] });
  assert.equal(queriesSent.length, 1);
});

test('wrapAckErrorRecovery clears stale caches and recreates sessions on 421/479 errors', async () => {
  const ev = createEmitter();
  const groupCache = new Map([['120363000000000001@g.us', { subject: 'Old' }]]);
  const deletedKeys = [];
  const userDevicesCache = {
    del: (k) => {
      deletedKeys.push(k);
      return true;
    },
  };
  const refreshedGroups = [];
  const asserted = [];
  const logged = [];
  const keyWrites = [];

  const sock = {
    ev,
    authState: {
      creds: {
        me: {
          id: '254700000000:5@s.whatsapp.net',
          lid: '887766554433:5@lid',
        },
      },
      keys: {
        set: async (data) => {
          keyWrites.push(data);
        },
      },
    },
    groupMetadata: async (jid) => {
      refreshedGroups.push(jid);
      return { id: jid };
    },
    assertSessions: async (jids, force) => {
      asserted.push({ jids, force });
      return true;
    },
  };

  assert.equal(
    wrapAckErrorRecovery(sock, {
      groupCache,
      userDevicesCache,
      logError: (ctx, _cmd, jid, detail) => logged.push({ ctx, jid, detail }),
    }),
    true,
  );

  // 421 in group clears groupCache and refreshes metadata
  ev.emit('messages.update', [
    {
      key: { remoteJid: '120363000000000001@g.us', id: 'm1' },
      update: { messageStubParameters: ['421'] },
    },
  ]);
  assert.equal(groupCache.has('120363000000000001@g.us'), false);
  assert.deepEqual(refreshedGroups, ['120363000000000001@g.us']);

  // Duplicate 421 within cooldown is ignored
  ev.emit('messages.update', [
    {
      key: { remoteJid: '120363000000000001@g.us', id: 'm2' },
      update: { messageStubParameters: ['421'] },
    },
  ]);
  assert.deepEqual(refreshedGroups, ['120363000000000001@g.us']);

  // 479 in DM clears userDevicesCache variants and force-asserts sessions
  ev.emit('messages.update', [
    {
      key: { remoteJid: '554433221100:2@lid', id: 'm3' },
      update: { messageStubParameters: ['479'] },
    },
  ]);
  assert.ok(deletedKeys.includes('554433221100:2@lid'));
  assert.ok(deletedKeys.includes('554433221100@s.whatsapp.net'));
  assert.ok(deletedKeys.includes('554433221100@lid'));
  assert.deepEqual(asserted, [{ jids: ['554433221100:2@lid'], force: true }]);
  assert.equal(logged.length, 2);

  // 479 in group clears groupCache and invalidates sender-key-memory entries
  ev.emit('messages.update', [
    {
      key: { remoteJid: '120363000000000001@g.us', id: 'm4' },
      update: { messageStubParameters: ['479'] },
    },
  ]);
  assert.equal(keyWrites.length, 1);
  assert.equal(keyWrites[0]['sender-key-memory']['120363000000000001@g.us'], null);
  assert.equal(keyWrites[0]['sender-key-memory']['120363000000000001@g.us:887766554433:5@lid'], null);

  // 475 in DM clears userDevicesCache and force-asserts sessions
  ev.emit('messages.update', [
    {
      key: { remoteJid: '776655443322@lid', id: 'm5' },
      update: { messageStubParameters: ['475'] },
    },
  ]);
  assert.ok(deletedKeys.includes('776655443322@lid'));
  assert.deepEqual(asserted[1], { jids: ['776655443322@lid'], force: true });

  assert.equal(clearCachedUserDevices(null, 'x'), false);
});

test('wrapSendOptionsNormalization propagates ephemeralExpiration only when omitted', async () => {
  const calls = [];
  const sock = {
    sendMessage: async (jid, content, options) => {
      calls.push({ jid, content, options });
      return { key: { remoteJid: jid, id: '1' } };
    },
  };

  assert.equal(wrapSendOptionsNormalization(sock), true);
  assert.equal(wrapSendOptionsNormalization(sock), true, 'idempotent');

  // Quoted disappearing message -> adds ephemeralExpiration: 86400
  await sock.sendMessage(
    '254711111111@s.whatsapp.net',
    { text: 'menu' },
    {
      quoted: {
        message: {
          ephemeralMessage: {
            message: {
              extendedTextMessage: {
                text: '.menu',
                contextInfo: { expiration: 86400 },
              },
            },
          },
        },
      },
    },
  );
  assert.equal(calls[0].options.ephemeralExpiration, 86400);

  // Explicit ephemeralExpiration preserved
  await sock.sendMessage(
    '254711111111@s.whatsapp.net',
    { text: 'menu' },
    {
      quoted: { message: { extendedTextMessage: { contextInfo: { expiration: 86400 } } } },
      ephemeralExpiration: 0,
    },
  );
  assert.equal(calls[1].options.ephemeralExpiration, 0);

  // Non-ephemeral call untouched
  await sock.sendMessage('254711111111@s.whatsapp.net', { text: 'plain' }, undefined);
  assert.equal(calls[2].options, undefined);
});

test('installSocketResilience wires connection.update open prekey check and all wrappers idempotently', async () => {
  const ev = createEmitter();
  const uploaded = [];
  const sock = {
    ev,
    authState: {
      creds: { nextPreKeyId: 25 },
      keys: { get: async () => ({}) },
    },
    uploadPreKeys: async (n) => uploaded.push(n),
    signalRepository: {
      lidMapping: {
        getLIDsForPNs: async () => [],
      },
    },
    query: async () => ({ tag: 'iq', attrs: { type: 'result' }, content: [] }),
    sendMessage: async (_j, _c, o) => o,
  };

  assert.equal(
    installSocketResilience(sock, { authDir: '', logInfo: () => {} }),
    true,
  );
  assert.equal(installSocketResilience(sock), true);

  ev.emit('connection.update', { connection: 'open' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(uploaded, [50]);
});

test('stripPartialEncryptErrors isolates errored user nodes without discarding valid sessions', async () => {
  const errors = [];
  const sock = {
    signalRepository: {
      lidMapping: {
        getLIDsForPNs: async () => [],
      },
    },
    query: async () => ({
      tag: 'iq',
      attrs: { type: 'result' },
      content: [
        {
          tag: 'list',
          attrs: {},
          content: [
            { tag: 'user', attrs: { jid: '1111@lid' }, content: [{ tag: 'identity' }] },
            { tag: 'user', attrs: { jid: '2222@lid' }, content: [{ tag: 'error', attrs: { code: '404' } }] },
          ],
        },
      ],
    }),
  };

  wrapLidMappingResilience(sock, { logError: (...a) => errors.push(a) });
  const res = await sock.query({
    tag: 'iq',
    attrs: { xmlns: 'encrypt', type: 'get' },
    content: [{ tag: 'key', attrs: {}, content: [{ tag: 'user', attrs: { jid: '1111@lid' } }] }],
  });

  assert.equal(res.content[0].content.length, 1);
  assert.equal(res.content[0].content[0].attrs.jid, '1111@lid');
  assert.equal(errors.length, 1);
  assert.match(errors[0][3], /Isolated 1 errored recipient key bundle/);
});

test('createGuardedSignalKeyStore and wrapSignalAndSenderKeyGuard prevent sender-key poisoning and fix bare LIDs', async () => {
  const ev = createEmitter();
  const persistedSets = [];
  const asserted = [];
  const clearedDevices = [];
  const recordedGroupCalls = [];
  const failedEncryptJids = new Map();

  const innerKeys = {
    get: async () => ({}),
    set: async (data) => {
      persistedSets.push(data);
    },
  };
  const guardedKeys = createGuardedSignalKeyStore(innerKeys, failedEncryptJids);

  const sock = {
    ev,
    authState: {
      creds: {
        me: {
          id: '254712345678:12@s.whatsapp.net',
          lid: '998877665544@lid',
        },
      },
      keys: guardedKeys,
    },
    assertSessions: async (jids, force) => {
      asserted.push({ jids, force });
      return true;
    },
    signalRepository: {
      encryptGroupMessage: async (opts) => {
        recordedGroupCalls.push(['encryptGroupMessage', opts.meId]);
        return { ciphertext: Buffer.from('ok'), senderKeyDistributionMessage: Buffer.from('skdm') };
      },
      hasSenderKey: async (opts) => {
        recordedGroupCalls.push(['hasSenderKey', opts.meId]);
        return false;
      },
      getSenderKeyDistributionMessage: async (opts) => {
        recordedGroupCalls.push(['getSenderKeyDistributionMessage', opts.meId]);
        return Buffer.from('skdm');
      },
      encryptMessage: async ({ jid }) => {
        if (jid === 'badrecipient:0@lid') {
          throw new Error('No session record');
        }
        return { type: 'pkmsg', ciphertext: Buffer.from('enc') };
      },
    },
  };

  const userDevicesCache = {
    del: (k) => {
      clearedDevices.push(k);
      return true;
    },
  };

  assert.equal(
    wrapSignalAndSenderKeyGuard(sock, { failedEncryptJids, userDevicesCache }),
    true,
  );
  // Immediately normalizes creds.me.lid on init
  assert.equal(sock.authState.creds.me.lid, '998877665544:12@lid');

  // Re-emitted bare me.lid via creds.update is normalized in-place
  const update = { me: { lid: '998877665544@lid' } };
  ev.emit('creds.update', update);
  assert.equal(update.me.lid, '998877665544:12@lid');

  // Bare LID passed into group Signal methods is rewritten to device-suffixed :12@lid
  await sock.signalRepository.hasSenderKey({ group: '120363@g.us', meId: '998877665544@lid' });
  await sock.signalRepository.getSenderKeyDistributionMessage({ group: '120363@g.us', meId: '998877665544@lid' });
  await sock.signalRepository.encryptGroupMessage({ group: '120363@g.us', meId: '998877665544@lid', data: Buffer.from('hi') });
  assert.deepEqual(recordedGroupCalls, [
    ['hasSenderKey', '998877665544:12@lid'],
    ['getSenderKeyDistributionMessage', '998877665544:12@lid'],
    ['encryptGroupMessage', '998877665544:12@lid'],
  ]);

  // Failing SKDM encryption records failed JID, clears userDevicesCache, force-asserts session,
  // and strips that JID from sender-key-memory persistence while preserving successful recipients.
  await assert.rejects(
    () => sock.signalRepository.encryptMessage({ jid: 'badrecipient:0@lid', data: Buffer.from('x') }),
    /No session record/,
  );
  assert.equal(clearedDevices.includes('badrecipient:0@lid'), true);
  assert.deepEqual(asserted, [{ jids: ['badrecipient:0@lid'], force: true }]);

  await sock.authState.keys.set({
    'sender-key-memory': {
      '120363@g.us': {
        'badrecipient:0@lid': true,
        'goodrecipient:0@lid': true,
      },
    },
  });
  assert.deepEqual(persistedSets[0]['sender-key-memory']['120363@g.us'], {
    'goodrecipient:0@lid': true,
  });
});

test('wrapPresenceResilience and ensureActiveOnlinePresence prevent silent no-name drop that keeps sendActiveReceipts false', async () => {
  const creds = { me: { id: '254700000001:5@s.whatsapp.net', name: '' } };
  assert.equal(ensureFallbackMeName(creds, 'Spider Man'), true);
  assert.equal(creds.me.name, 'Spider Man');
  // Does not overwrite an existing non-empty name
  creds.me.name = 'Custom Bot';
  assert.equal(ensureFallbackMeName(creds, 'Spider Man'), false);
  assert.equal(creds.me.name, 'Custom Bot');

  const presenceCalls = [];
  const sock = {
    authState: { creds: { me: { id: '254700000001:5@s.whatsapp.net' } } },
    sendPresenceUpdate: async (type, toJid) => {
      // Simulate Baileys chats.js:843 returning early without emitting isOnline if !me.name
      if ((type === 'available' || type === 'unavailable') && !sock.authState.creds.me?.name) {
        return 'ignored-no-name';
      }
      presenceCalls.push({ type, toJid, meName: sock.authState.creds.me?.name });
      return 'sent';
    },
  };

  assert.equal(wrapPresenceResilience(sock, { defaultPushName: 'Spider Man' }), true);
  assert.equal(wrapPresenceResilience(sock, { defaultPushName: 'Spider Man' }), true);

  // Even if me.name is cleared later before sendPresenceUpdate('available'), wrapper restores it
  sock.authState.creds.me.name = '';
  const ok = await ensureActiveOnlinePresence(sock, { defaultPushName: 'Spider Man' });
  assert.equal(ok, true);
  assert.deepEqual(presenceCalls, [{ type: 'available', toJid: undefined, meName: 'Spider Man' }]);
});

test('ensureAppStateSynced syncs unsynced collections on receivedPendingNotifications and key arrival', async () => {
  const ev = createEmitter();
  const syncedBatches = [];
  const storedVersions = { critical_block: { version: 1 } };

  const sock = {
    ev,
    authState: {
      creds: {
        me: { id: '254700000001:5@s.whatsapp.net' },
        nextPreKeyId: 1,
      },
      keys: {
        get: async (type, names) => {
          if (type !== 'app-state-sync-version') return {};
          const res = {};
          for (const n of names) {
            if (storedVersions[n]) res[n] = storedVersions[n];
          }
          return res;
        },
        set: async () => {},
      },
    },
    resyncAppState: async (collections, isInitialSync) => {
      syncedBatches.push({ collections, isInitialSync });
      for (const c of collections) {
        storedVersions[c] = { version: 1 };
      }
    },
    sendPresenceUpdate: async () => {},
    signalRepository: {
      lidMapping: { getLIDsForPNs: async () => [] },
    },
    query: async () => ({ tag: 'iq', attrs: { type: 'result' }, content: [] }),
    sendMessage: async (_j, _c, o) => o,
  };

  installSocketResilience(sock, { authDir: '', logInfo: () => {} });

  ev.emit('connection.update', { receivedPendingNotifications: true });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(syncedBatches.length, 1);
  assert.equal(syncedBatches[0].isInitialSync, true);
  assert.deepEqual(
    syncedBatches[0].collections,
    ALL_APP_STATE_COLLECTIONS.filter((c) => c !== 'critical_block'),
  );

  // Subsequent call when all collections have versions is a no-op
  const secondRun = await ensureAppStateSynced(sock, { logInfo: () => {} });
  assert.equal(secondRun, false);
  assert.equal(syncedBatches.length, 1);

  // New myAppStateKeyId triggers re-check if any collection became unsynced
  delete storedVersions.regular_high;
  ev.emit('creds.update', { myAppStateKeyId: 'new-key-id' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(syncedBatches.length, 2);
  assert.deepEqual(syncedBatches[1], { collections: ['regular_high'], isInitialSync: true });
});

test('spider/index.js enables markOnlineOnConnect for active delivery receipts and updated version fallback', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'spider/index.js'), 'utf8');
  assert.match(source, /'markOnlineOnConnect':!!\[\]/);
  assert.doesNotMatch(source, /1027934701/);
  assert.match(source, /_0xbaileysDefaultVersion/);
  assert.match(source, /defaultPushName:/);
  assert.doesNotMatch(source, /sendPresenceUpdate\([^)]*unavailable/);
});

test('ensureHealthyPreKeys detects Baileys MIN_UPLOAD_INTERVAL silent skip and retries until pre-keys replenish', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-prekey-throttle-'));
  try {
    // Simulate CB:success uploadPreKeysToServerIfRequired() having just uploaded 5 pre-keys (<15)
    for (let i = 51; i <= 55; i += 1) {
      fs.writeFileSync(path.join(tmpDir, `pre-key-${i}.json`), '{}');
    }

    const ev = createEmitter();
    const uploadAttempts = [];
    const loggedInfo = [];
    let throttled = true;

    const innerKeys = {
      get: async (_type, ids) => Object.fromEntries(ids.map((id) => [id, id === '55' ? {} : null])),
      set: async (data) => {
        if (data?.['pre-key']) {
          for (const [id, val] of Object.entries(data['pre-key'])) {
            fs.writeFileSync(path.join(tmpDir, `pre-key-${id}.json`), JSON.stringify(val));
          }
        }
      },
    };

    const guardedKeys = createGuardedSignalKeyStore(innerKeys, new Map());
    const sock = {
      ev,
      authState: {
        creds: { nextPreKeyId: 56 },
        keys: guardedKeys,
      },
      uploadPreKeys: async (count) => {
        uploadAttempts.push({ count, throttled });
        if (throttled) {
          // Simulate Baileys socket.js skipping upload silently when within MIN_UPLOAD_INTERVAL
          return;
        }
        const batch = {};
        const startId = sock.authState.creds.nextPreKeyId;
        for (let i = 0; i < count; i += 1) {
          batch[String(startId + i)] = { keyPair: {} };
        }
        await sock.authState.keys.set({ 'pre-key': batch });
        sock.authState.creds.nextPreKeyId = startId + count;
      },
    };

    // First call during throttle: returns false (not permanently cached) and schedules retry
    const firstResult = await ensureHealthyPreKeys(sock, {
      authDir: tmpDir,
      retryDelayMs: 30,
      maxRetries: 2,
      logInfo: (msg) => loggedInfo.push(msg),
    });
    assert.equal(firstResult, false);
    assert.equal(uploadAttempts.length, 1);
    assert.equal(countLocalPreKeyFiles(tmpDir), 5);

    // Throttle expires before the scheduled retry runs
    throttled = false;
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(uploadAttempts.length, 2);
    assert.equal(countLocalPreKeyFiles(tmpDir), 55);
    assert.equal(sock.authState.creds.nextPreKeyId, 106);
    assert.match(loggedInfo[0], /Uploaded 50 fresh pre-keys/);

    // Subsequent call now sees healthy dir and is a no-op
    assert.equal(await ensureHealthyPreKeys(sock, { authDir: tmpDir }), false);
    assert.equal(uploadAttempts.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('installSocketResilience cancels scheduled pre-key retry cleanly when socket closes', async () => {
  const ev = createEmitter();
  const calls = [];
  const sock = {
    ev,
    authState: {
      creds: { nextPreKeyId: 40, me: { id: '254700000001:1@s.whatsapp.net' } },
      keys: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    uploadPreKeys: async (n) => {
      calls.push(n);
      // Never calls keys.set -> simulates silent throttle
    },
    sendPresenceUpdate: async () => {},
    signalRepository: { lidMapping: { getLIDsForPNs: async () => [] } },
    query: async () => ({ tag: 'iq', attrs: { type: 'result' }, content: [] }),
    sendMessage: async (_j, _c, o) => o,
  };

  installSocketResilience(sock, { authDir: '', logInfo: () => {} });
  ev.emit('connection.update', { connection: 'open' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);

  // Closing the socket cancels the pending retry timer without throwing
  ev.emit('connection.update', { connection: 'close' });
});

test('createHardenedSignalRepository synchronously asserts missing sessions and retries encryptMessage in-flight', async () => {
  const failedEncryptJids = new Map();
  const cleared = [];
  const userDevicesCache = {
    del: (k) => {
      cleared.push(k);
      return true;
    },
  };
  let hasSession = false;
  let encryptAttempts = 0;

  const baseFactory = (auth) => {
    assert.equal(Buffer.isBuffer(auth.creds.account.accountSignatureKey), true);
    return {
      encryptGroupMessage: async (opts) => ({ opts }),
      encryptMessage: async ({ jid }) => {
        encryptAttempts += 1;
        if (!hasSession) {
          throw new Error(`No session record for ${jid}`);
        }
        return { type: 'pkmsg', ciphertext: Buffer.from('recovered-cipher') };
      },
    };
  };

  const factory = createHardenedSignalRepository(baseFactory, {
    failedEncryptJids,
    userDevicesCache,
  });

  const authCreds = {
    me: { id: '254700000001:4@s.whatsapp.net', lid: '1122334455@lid' },
    account: { accountSignatureKey: { '0': 1, '1': 2, '2': 3 } },
  };
  const repo = factory({ creds: authCreds });
  assert.equal(authCreds.me.lid, '1122334455:4@lid');

  const sock = {
    ev: createEmitter(),
    authState: { creds: authCreds, keys: createGuardedSignalKeyStore({ get: async () => ({}), set: async () => {} }, failedEncryptJids) },
    signalRepository: repo,
    assertSessions: async (jids, force) => {
      assert.deepEqual(jids, ['222233334444:0@lid']);
      assert.equal(force, true);
      hasSession = true;
      return true;
    },
  };

  // Binds live sock context onto the pre-wrapped repository without double-wrapping
  assert.equal(
    wrapSignalAndSenderKeyGuard(sock, { failedEncryptJids, userDevicesCache }),
    true,
  );

  // Simulates a caller (like Baileys messages-send.js) invoking the early-captured encryptMessage reference
  const result = await repo.encryptMessage({ jid: '222233334444:0@lid', data: Buffer.from('skdm') });
  assert.equal(encryptAttempts, 2);
  assert.equal(result.type, 'pkmsg');
  assert.deepEqual(result.ciphertext, Buffer.from('recovered-cipher'));
  assert.equal(failedEncryptJids.has('222233334444:0@lid'), false);
  assert.equal(cleared.includes('222233334444:0@lid'), true);

  // Bare meId passed into group encrypt also resolves to device-suffixed LID from bound sock creds
  const groupRes = await repo.encryptGroupMessage({ group: '120363@g.us', meId: '1122334455@lid' });
  assert.equal(groupRes.opts.meId, '1122334455:4@lid');
});

test('wrapWebSocketTagSanitizer strips partial encrypt IQ errors directly from TAG:* events', () => {
  const cleared = [];
  const logged = [];
  const emitted = [];
  const ws = {
    emit(event, payload) {
      emitted.push({ event, payload });
      return true;
    },
  };
  const sock = { ws };
  const userDevicesCache = {
    del: (k) => {
      cleared.push(k);
      return true;
    },
  };

  assert.equal(
    wrapWebSocketTagSanitizer(sock, {
      userDevicesCache,
      logError: (ctx, _c, _j, msg) => logged.push(`${ctx}:${msg}`),
    }),
    true,
  );
  assert.equal(wrapWebSocketTagSanitizer(sock), true, 'idempotent');

  ws.emit('TAG:1234', {
    tag: 'iq',
    attrs: { type: 'result', id: '1234' },
    content: [
      {
        tag: 'list',
        attrs: {},
        content: [
          { tag: 'user', attrs: { jid: '1111@lid' }, content: [{ tag: 'identity' }] },
          { tag: 'user', attrs: { jid: '2222@lid' }, content: [{ tag: 'error', attrs: { code: '404' } }] },
        ],
      },
    ],
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.content[0].content.length, 1);
  assert.equal(emitted[0].payload.content[0].content[0].attrs.jid, '1111@lid');
  assert.equal(cleared.includes('2222@lid'), true);
  assert.match(logged[0], /Isolated 1 errored recipient key bundle/);
});

test('wrapSignalAndSenderKeyGuard recovers decrypt failures (Bad MAC, No matching sessions, status scope, Invalid PreKey ID) cleanly', async () => {
  const deletedSessions = [];
  const keyWrites = [];
  const uploaded = [];
  const logged = [];
  const ev = createEmitter();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-decrypt-guard-'));
  try {
    const innerKeys = {
      get: async (_type, ids) => Object.fromEntries(ids.map((id) => [id, null])),
      set: async (data) => {
        keyWrites.push(data);
      },
    };
    const guardedKeys = createGuardedSignalKeyStore(innerKeys, new Map());

    let nextDecryptErr = null;
    let nextGroupDecryptErr = null;
    const sock = {
      ev,
      authState: {
        creds: {
          nextPreKeyId: 50,
          firstUnuploadedPreKeyId: 10,
          me: { id: '254700000001:1@s.whatsapp.net', lid: '1122334455:1@lid' },
        },
        keys: guardedKeys,
      },
      uploadPreKeys: async (n) => {
        uploaded.push(n);
      },
      signalRepository: {
        lidMapping: {
          getPNForLID: async (lid) => (lid === '998877665514@lid' ? '254711111114@s.whatsapp.net' : null),
        },
        jidToSignalProtocolAddress: (jid) => jid.split('@')[0],
        deleteSession: async (jids) => {
          deletedSessions.push(jids);
        },
        decryptMessage: async () => {
          if (nextDecryptErr) throw nextDecryptErr;
          return Buffer.from('ok');
        },
        decryptGroupMessage: async () => {
          if (nextGroupDecryptErr) throw nextGroupDecryptErr;
          return Buffer.from('ok');
        },
      },
    };

    wrapSignalAndSenderKeyGuard(sock, {
      authDir: tmpDir,
      logError: (ctx, _c, target, msg) => logged.push({ ctx, target, msg }),
    });

    // 1. Unscoped 'No matching sessions found for message' -> deletes session, tags Bad MAC for retry, no noisy log box
    nextDecryptErr = new Error('No matching sessions found for message');
    await assert.rejects(
      () => sock.signalRepository.decryptMessage({ jid: '998877665514@lid', type: 'msg', ciphertext: Buffer.from('x') }),
      /Bad MAC.*No matching sessions found/,
    );
    assert.deepEqual(deletedSessions, [['998877665514@lid']]);
    assert.equal(logged.length, 0);

    // 2. Scoped (status) Bad MAC -> clears ONLY *_status session (+ PN alias), never calling unscoped deleteSession
    nextDecryptErr = new Error('Bad MAC');
    await assert.rejects(
      () =>
        sock.signalRepository.decryptMessage({
          jid: '998877665514@lid',
          scope: 'status',
          type: 'msg',
          ciphertext: Buffer.from('x'),
        }),
      /Bad MAC/,
    );
    assert.equal(deletedSessions.length, 1);
    assert.deepEqual(keyWrites[0].session, {
      '998877665514_status': null,
      '254711111114_status': null,
    });
    assert.equal(logged.length, 0);

    // 3. Invalid PreKey ID -> repairs stale firstUnuploadedPreKeyId cursor and triggers throttled pre-key upload
    nextDecryptErr = new Error('Invalid PreKey ID');
    await assert.rejects(
      () => sock.signalRepository.decryptMessage({ jid: '887766554485@lid', type: 'pkmsg', ciphertext: Buffer.from('x') }),
      /Invalid PreKey ID/,
    );
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sock.authState.creds.firstUnuploadedPreKeyId, 50);
    assert.deepEqual(uploaded, [50]);
    assert.equal(logged.length, 0);

    // 4. Unexpected non-retryable error logs once within cooldown window
    nextDecryptErr = new Error('Unsupported message envelope');
    await assert.rejects(
      () => sock.signalRepository.decryptMessage({ jid: '887766554485@lid', type: 'msg', ciphertext: Buffer.from('x') }),
      /Unsupported message envelope/,
    );
    await assert.rejects(
      () => sock.signalRepository.decryptMessage({ jid: '887766554485@lid', type: 'msg', ciphertext: Buffer.from('x') }),
      /Unsupported message envelope/,
    );
    assert.equal(logged.length, 1);
    assert.equal(logged[0].ctx, 'Signal Decrypt Failure');

    // 5. Group transient keyId miss suppresses redundant box; unexpected error logs once with cooldown
    nextGroupDecryptErr = new Error('No session found to decrypt message for keyId=60, group=status@broadcast::111_1::0');
    await assert.rejects(
      () => sock.signalRepository.decryptGroupMessage({ group: 'status@broadcast', authorJid: '111@lid', msg: Buffer.from('x') }),
      /No session found/,
    );
    assert.equal(logged.length, 1);

    nextGroupDecryptErr = new Error('Malformed group frame');
    await assert.rejects(
      () => sock.signalRepository.decryptGroupMessage({ group: '120363@g.us', authorJid: '111@lid', msg: Buffer.from('x') }),
      /Malformed group frame/,
    );
    await assert.rejects(
      () => sock.signalRepository.decryptGroupMessage({ group: '120363@g.us', authorJid: '111@lid', msg: Buffer.from('x') }),
      /Malformed group frame/,
    );
    assert.equal(logged.length, 2);
    assert.equal(logged[1].ctx, 'Signal Group Decrypt Failure');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('requestMissingAppStateSyncKeys sends APP_STATE_SYNC_KEY_REQUEST, enforces cooldown, and skips existing keys', async () => {
  const peerCalls = [];
  const storedKeys = new Set();
  const sock = {
    authState: {
      keys: {
        get: async (_type, ids) => Object.fromEntries(ids.map((id) => [id, storedKeys.has(id) ? { keyData: Buffer.from('k') } : null])),
      },
    },
    sendPeerMessage: async (msg) => {
      peerCalls.push(msg);
      return 'msg-id-1';
    },
  };

  assert.equal(await requestMissingAppStateSyncKeys(sock, 'AAAAAHGA'), true);
  assert.equal(peerCalls.length, 1);
  assert.equal(peerCalls[0].protocolMessage.type, 7);
  assert.deepEqual(
    peerCalls[0].protocolMessage.appStateSyncKeyRequest.keyIds.map((k) => Buffer.from(k.keyId).toString('base64')),
    ['AAAAAHGA'],
  );

  // Cooldown prevents duplicate requests for the same keyId
  assert.equal(await requestMissingAppStateSyncKeys(sock, 'AAAAAHGA'), false);
  assert.equal(peerCalls.length, 1);

  // Already-stored key is skipped even with 0ms cooldown
  storedKeys.add('AAAAAHGB');
  assert.equal(await requestMissingAppStateSyncKeys(sock, 'AAAAAHGB', { cooldownMs: 0 }), false);
  assert.equal(peerCalls.length, 1);
});

test('ensureAppStateSynced checks post-resync stored versions and requests missing myAppStateKeyId when collections remain parked', async () => {
  const peerCalls = [];
  const infoLogs = [];
  const parkedSock = {
    authState: {
      creds: { myAppStateKeyId: 'AAAAAHGA' },
      keys: {
        get: async () => ({}),
      },
    },
    resyncAppState: async () => {
      // Simulates all collections parking due to missing historical key (no versions persisted)
    },
    sendPeerMessage: async (msg) => {
      peerCalls.push(msg);
      return 'peer-req-1';
    },
  };

  const didSync = await ensureAppStateSynced(parkedSock, {
    logInfo: (m) => infoLogs.push(m),
  });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(didSync, false);
  assert.ok(!infoLogs.some((m) => /Synced \d+ app-state/.test(m)), 'Should not falsely log Synced when collections parked');
  assert.equal(peerCalls.length, 1);
  assert.equal(peerCalls[0].protocolMessage.type, 7);
});



