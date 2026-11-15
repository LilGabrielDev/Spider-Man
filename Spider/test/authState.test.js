import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import {
  applyCredsUpdate,
  fixAuthFileName,
  isValidAuthCreds,
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
