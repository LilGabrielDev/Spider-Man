import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BufferJSON, encodeSignedDeviceIdentity, initAuthCreds, proto } from '@whiskeysockets/baileys';
import {
  applyCredsUpdate,
  fixAuthFileName,
  isValidAuthCreds,
  normalizeAuthCreds,
  normalizeMeCredentials,
  parseJidParts,
  useHardenedMultiFileAuthState,
} from '../../spider/utils/authState.js';

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-auth-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test('parseJidParts and normalizeMeCredentials preserve companion device ID on me.lid', () => {
  assert.deepEqual(parseJidParts('254712345678:15@s.whatsapp.net'), {
    user: '254712345678',
    device: 15,
    server: 's.whatsapp.net',
  });
  assert.deepEqual(parseJidParts('998877665544@lid'), {
    user: '998877665544',
    device: undefined,
    server: 'lid',
  });

  // Companion device > 0 and bare me.lid -> appends :device
  const creds = {
    me: {
      id: '254712345678:15@s.whatsapp.net',
      lid: '998877665544@lid',
    },
  };
  assert.equal(normalizeMeCredentials(creds), true);
  assert.equal(creds.me.lid, '998877665544:15@lid');

  // Idempotent on subsequent call
  assert.equal(normalizeMeCredentials(creds), false);

  // Repairs me.lid when emitted with :0 on a non-zero companion device
  const zeroLid = {
    me: {
      id: '254712345678:7@s.whatsapp.net',
      lid: '998877665544:0@lid',
    },
  };
  assert.equal(normalizeMeCredentials(zeroLid), true);
  assert.equal(zeroLid.me.lid, '998877665544:7@lid');

  // Primary device (:0) leaves bare LID unchanged
  const primary = {
    me: {
      id: '254712345678:0@s.whatsapp.net',
      lid: '998877665544@lid',
    },
  };
  assert.equal(normalizeMeCredentials(primary), false);
  assert.equal(primary.me.lid, '998877665544@lid');
});

test('applyCredsUpdate merges partial me objects without dropping me.id and fixes me.lid', () => {
  const creds = initAuthCreds();
  creds.me = { id: '254712345678:4@s.whatsapp.net', name: 'Spider' };

  applyCredsUpdate(creds, {
    me: { lid: '112233445566@lid' },
    registered: true,
  });

  assert.equal(creds.me.id, '254712345678:4@s.whatsapp.net');
  assert.equal(creds.me.name, 'Spider');
  assert.equal(creds.me.lid, '112233445566:4@lid');
  assert.equal(creds.registered, true);
  assert.equal(isValidAuthCreds(creds), true);
  assert.equal(fixAuthFileName('sender-key-120363@g.us::9988:4.json'), 'sender-key-120363@g.us--9988-4.json');
});

test('useHardenedMultiFileAuthState hardens permissions on existing valid credentials and backup', async () => {
  await withTempDir(async (authDir) => {
    const creds = initAuthCreds();
    const serialized = JSON.stringify(creds, BufferJSON.replacer);
    const credsPath = path.join(authDir, 'creds.json');
    const backupPath = `${credsPath}.bak`;
    fs.writeFileSync(credsPath, serialized, { mode: 0o644 });
    fs.writeFileSync(backupPath, serialized, { mode: 0o644 });
    fs.chmodSync(credsPath, 0o644);
    fs.chmodSync(backupPath, 0o644);

    const auth = await useHardenedMultiFileAuthState(authDir);
    assert.equal(fs.statSync(credsPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
    await auth.flush();
    assert.equal(fs.statSync(credsPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
  });
});

test('useHardenedMultiFileAuthState writes atomically, maintains .bak, recovers corrupt creds.json, and refuses silent wipe', async () => {
  await withTempDir(async (authDir) => {
    // 1. Seed valid credentials with companion device :9 and a leftover crashed .tmp file
    const initialCreds = initAuthCreds();
    initialCreds.me = { id: '254712345678:9@s.whatsapp.net', lid: '445566778899@lid' };
    fs.writeFileSync(
      path.join(authDir, 'creds.json'),
      JSON.stringify(initialCreds, BufferJSON.replacer),
    );
    const orphanTmp = path.join(authDir, 'session-old.json.tmp-999-1');
    fs.writeFileSync(orphanTmp, '{');

    const logs = [];
    const errors = [];
    const auth = await useHardenedMultiFileAuthState(authDir, {
      logInfo: (m) => logs.push(m),
      logError: (ctx, _c, _j, msg) => errors.push(`${ctx}:${msg}`),
    });

    assert.equal(fs.existsSync(orphanTmp), false, 'crashed tmp file should be removed at startup');
    assert.equal(auth.state.creds.me.lid, '445566778899:9@lid');
    assert.equal(fs.existsSync(path.join(authDir, 'creds.json.bak')), true);

    // Concurrent creds.update + Signal key writes + flush()
    await Promise.all([
      auth.saveCreds({ me: { lid: '445566778899@lid', name: 'Bot' }, myAppStateKeyId: 'k1' }),
      auth.saveCreds({ platform: 'smba' }),
      auth.state.keys.set({
        'sender-key': {
          '1203630001@g.us--445566778899--9': { senderKeyId: 77 },
        },
        session: {
          '99887766.1': { chainKey: Uint8Array.from([1, 2, 3]) },
        },
      }),
    ]);
    await auth.flush();

    const loadedKey = await auth.state.keys.get('sender-key', ['1203630001@g.us--445566778899--9']);
    assert.deepEqual(loadedKey['1203630001@g.us--445566778899--9'], { senderKeyId: 77 });
    assert.equal(auth.state.creds.me.lid, '445566778899:9@lid');
    assert.equal(auth.state.creds.platform, 'smba');

    // 2. Truncate creds.json and verify automatic recovery from creds.json.bak
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{"truncated":');
    const recoveredLogs = [];
    const recoveredAuth = await useHardenedMultiFileAuthState(authDir, {
      logInfo: (m) => recoveredLogs.push(m),
    });
    assert.equal(recoveredAuth.state.creds.me.lid, '445566778899:9@lid');
    assert.equal(recoveredAuth.state.creds.platform, 'smba');
    assert.ok(recoveredLogs.some((m) => /Recovered valid credentials/.test(m)));

    // 3. Corrupt BOTH creds.json and creds.json.bak -> MUST throw instead of silently resetting with initAuthCreds()
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{bad');
    fs.writeFileSync(path.join(authDir, 'creds.json.bak'), '{also-bad');
    await assert.rejects(
      () =>
        useHardenedMultiFileAuthState(authDir, {
          logError: (ctx, _c, _j, msg) => errors.push(`${ctx}:${msg}`),
        }),
      /corrupted/i,
    );
    assert.ok(errors.some((e) => /Refusing to wipe corrupted creds\.json/.test(e)));
  });
});

test('normalizeAuthCreds coerces plain-object and base64 credential fields so encodeSignedDeviceIdentity preserves accountSignatureKey', () => {
  const detailsBuf = Buffer.from([8, 1, 16, 2]);
  const sigKeyBuf = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
  const acctSigBuf = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 3) & 0xff));
  const devSigBuf = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 7) & 0xff));

  const toPlainIndexed = (buf) => Object.fromEntries(Array.from(buf.entries()));

  const creds = {
    registrationId: 4242,
    me: { id: '254712345678:3@s.whatsapp.net', lid: '998877665544@lid' },
    noiseKey: {
      public: toPlainIndexed(Buffer.from([1, 2, 3, 4])),
      private: Buffer.from([5, 6, 7, 8]).toString('base64'),
    },
    signedIdentityKey: {
      public: { type: 'Buffer', data: [9, 10, 11, 12] },
      private: [13, 14, 15, 16],
    },
    signedPreKey: {
      keyPair: {
        public: toPlainIndexed(Buffer.from([21, 22])),
        private: toPlainIndexed(Buffer.from([23, 24])),
      },
      signature: Buffer.from([25, 26]).toString('base64'),
    },
    account: {
      details: toPlainIndexed(detailsBuf),
      accountSignatureKey: toPlainIndexed(sigKeyBuf),
      accountSignature: acctSigBuf.toString('base64'),
      deviceSignature: { type: 'Buffer', data: Array.from(devSigBuf) },
    },
    signalIdentities: [
      {
        identifier: { name: '254712345678:3@s.whatsapp.net', deviceId: 3 },
        identifierKey: toPlainIndexed(Buffer.from([31, 32, 33])),
      },
    ],
  };

  assert.equal(normalizeAuthCreds(creds), true);
  assert.equal(Buffer.isBuffer(creds.noiseKey.public), true);
  assert.equal(Buffer.isBuffer(creds.noiseKey.private), true);
  assert.equal(Buffer.isBuffer(creds.signedIdentityKey.public), true);
  assert.equal(Buffer.isBuffer(creds.signedIdentityKey.private), true);
  assert.equal(Buffer.isBuffer(creds.signedPreKey.signature), true);
  assert.equal(Buffer.isBuffer(creds.account.accountSignatureKey), true);
  assert.equal(Buffer.isBuffer(creds.signalIdentities[0].identifierKey), true);
  assert.equal(creds.me.lid, '998877665544:3@lid');

  const encoded = encodeSignedDeviceIdentity(creds.account, true);
  const decoded = proto.ADVSignedDeviceIdentity.decode(encoded);
  assert.deepEqual(Buffer.from(decoded.details), detailsBuf);
  assert.deepEqual(Buffer.from(decoded.accountSignatureKey), sigKeyBuf);
  assert.deepEqual(Buffer.from(decoded.accountSignature), acctSigBuf);
  assert.deepEqual(Buffer.from(decoded.deviceSignature), devSigBuf);

  assert.equal(normalizeAuthCreds(creds), false, 'subsequent call is idempotent');
});

test('normalizeAuthCreds clamps firstUnuploadedPreKeyId and useHardenedMultiFileAuthState advances stale pre-key cursor on hydrated sessions', async () => {
  const aheadCreds = initAuthCreds();
  aheadCreds.nextPreKeyId = 35;
  aheadCreds.firstUnuploadedPreKeyId = 50;
  assert.equal(normalizeAuthCreds(aheadCreds), true);
  assert.equal(aheadCreds.firstUnuploadedPreKeyId, 35);
  assert.equal(normalizeAuthCreds(aheadCreds), false);

  // Hydrated session: nextPreKeyId=50, firstUnuploadedPreKeyId=10, but no pre-key-10.json on disk
  await withTempDir(async (hydratedDir) => {
    const creds = initAuthCreds();
    creds.nextPreKeyId = 50;
    creds.firstUnuploadedPreKeyId = 10;
    fs.writeFileSync(
      path.join(hydratedDir, 'creds.json'),
      JSON.stringify(creds, BufferJSON.replacer),
    );

    const auth = await useHardenedMultiFileAuthState(hydratedDir);
    assert.equal(auth.state.creds.firstUnuploadedPreKeyId, 50);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(hydratedDir, 'creds.json'), 'utf8'),
      BufferJSON.reviver,
    );
    assert.equal(persisted.firstUnuploadedPreKeyId, 50);
  });

  // Healthy dir: pre-key-10.json exists on disk -> cursor is preserved
  await withTempDir(async (healthyDir) => {
    const creds = initAuthCreds();
    creds.nextPreKeyId = 50;
    creds.firstUnuploadedPreKeyId = 10;
    fs.writeFileSync(
      path.join(healthyDir, 'creds.json'),
      JSON.stringify(creds, BufferJSON.replacer),
    );
    fs.writeFileSync(path.join(healthyDir, 'pre-key-10.json'), '{}');

    const auth = await useHardenedMultiFileAuthState(healthyDir);
    assert.equal(auth.state.creds.firstUnuploadedPreKeyId, 10);
  });
});

