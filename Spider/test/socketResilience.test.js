import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearCachedUserDevices,
  countLocalPreKeyFiles,
  ensureHealthyPreKeys,
  installSocketResilience,
  syncMessageKeyAliases,
  wrapAckErrorRecovery,
  wrapLidMappingResilience,
  wrapSendOptionsNormalization,
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

  const sock = {
    ev,
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
