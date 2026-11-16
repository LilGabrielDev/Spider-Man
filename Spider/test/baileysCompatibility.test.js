import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { S_WHATSAPP_NET, generateWAMessageFromContent } from '@whiskeysockets/baileys';

import { commands as gcStCommands } from '../commands/GcSt.js';
import { commands as gppCommands } from '../commands/Gpp.js';
import { commands as whatsAppCommands } from '../commands/WhatsApp.js';
import { commands as userCommands } from '../commands/User.js';
import { getOnlineMembers } from '../france/Presence.js';
import { createQuotedContact, downloadContentFromMessage } from '../france/utils.js';
import { ensureSocketMediaHelpers } from '../utils/legacyPlugins.js';
import { installPresenceTracking } from '../../spider/utils/socketResilience.js';
import gctoolsPlugins from '../legacy/lilgabriel/plugins/Groups/gctools.js';
import pinmPlugin from '../legacy/lilgabriel/plugins/Groups/pinm.js';
import listonlinePlugin from '../legacy/lilgabriel/plugins/Groups/listonline.js';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function findCmd(list, name) {
  return list.find((c) => c.name === name || c.aliases?.includes(name));
}

test('blueTickRemoval test is safely removed and createQuotedContact returns undefined (no Meta fake vCard quote)', () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'Spider', 'test', 'blueTickRemoval.test.js')), false);
  assert.equal(createQuotedContact(), undefined);

  const utilsSrc = fs.readFileSync(path.join(REPO_ROOT, 'Spider', 'france', 'utils.js'), 'utf8');
  assert.equal(/(?:^|[^0-9])0@s\.whatsapp\.net/.test(utilsSrc), false);
});

test('GcSt.js .status sends groupStatusMessageV2 with userJid & timestamp via 3-arg generateWAMessageFromContent', async () => {
  const statusCmd = findCmd(gcStCommands, 'status');
  assert.ok(statusCmd);

  const relayed = [];
  const sent = [];
  const sock = {
    user: { id: '254700000001:0@s.whatsapp.net' },
    waUploadToServer: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/test', directPath: '/v/t' }),
    relayMessage: async (jid, message, opts) => {
      relayed.push({ jid, message, opts });
    },
    sendMessage: async (jid, payload, opts) => {
      sent.push({ jid, payload, opts });
    },
  };

  await statusCmd.execute({
    sock,
    from: '120363000000000000@g.us',
    text: 'Hello group status',
    msg: { key: { remoteJid: '120363000000000000@g.us', id: 'MSG1', fromMe: false }, message: { conversation: '.status Hello group status' } },
  });

  assert.equal(relayed.length, 1);
  assert.ok(relayed[0].message?.groupStatusMessageV2?.message);
  assert.ok(relayed[0].opts?.messageId);
  assert.ok(sent.some((s) => s.payload?.text?.includes('sent to group status')));
});

test('Gpp.js and WhatsApp.js fall back to S_WHATSAPP_NET (@s.whatsapp.net) instead of bare domain string', () => {
  const gppSrc = fs.readFileSync(path.join(REPO_ROOT, 'Spider', 'commands', 'Gpp.js'), 'utf8');
  const waSrc = fs.readFileSync(path.join(REPO_ROOT, 'Spider', 'commands', 'WhatsApp.js'), 'utf8');
  assert.equal(S_WHATSAPP_NET, '@s.whatsapp.net');
  assert.ok(gppSrc.includes('S_WHATSAPP_NET'));
  assert.ok(waSrc.includes('S_WHATSAPP_NET'));
  assert.equal(/to:\s*['"]s\.whatsapp\.net['"]/.test(gppSrc), false);
  assert.equal(/to:\s*['"]s\.whatsapp\.net['"]/.test(waSrc), false);
});

test('User.js .setbio uses sock.updateProfileStatus when available', async () => {
  const setbioCmd = findCmd(userCommands, 'setbio');
  assert.ok(setbioCmd);

  const calls = [];
  const sock = {
    updateProfileStatus: async (bio) => {
      calls.push({ method: 'updateProfileStatus', bio });
    },
    query: async (node) => {
      calls.push({ method: 'query', node });
      return { attrs: { type: 'result' } };
    },
    sendMessage: async () => ({ key: { id: 'OK' } }),
  };

  await setbioCmd.execute({
    sock,
    from: '254700000002@s.whatsapp.net',
    text: 'New Spider Bio',
    msg: { key: { id: 'M1' }, message: { conversation: '.setbio New Spider Bio' } },
  });

  assert.deepEqual(calls, [{ method: 'updateProfileStatus', bio: 'New Spider Bio' }]);
});

test('installPresenceTracking, Presence.getOnlineMembers, and listonline resolve PN and LID presence updates', async () => {
  const prevMap = globalThis._spiderPresenceMap;
  const prevResolver = globalThis.resolvePhoneFromLid;
  try {
    globalThis._spiderPresenceMap = new Map();
    globalThis.resolvePhoneFromLid = (lid) => (lid.startsWith('111222333') ? '254711223344' : '');

    const ev = new EventEmitter();
    const subscribed = [];
    const sent = [];
    const sock = {
      ev,
      user: { id: '254700000000:0@s.whatsapp.net' },
      signalRepository: {
        lidMapping: {
          getPNForLID: async (lid) => (lid.startsWith('111222333') ? '254711223344:0@s.whatsapp.net' : null),
          getLIDForPN: async () => null,
        },
      },
      groupMetadata: async () => ({
        id: '120363000000000001@g.us',
        participants: [
          { id: '111222333@lid', admin: null },
          { id: '254799887766@s.whatsapp.net', admin: 'admin' },
        ],
      }),
      presenceSubscribe: async (jid) => {
        subscribed.push(jid);
      },
      sendMessage: async (jid, payload) => {
        sent.push({ jid, payload });
        return { key: { id: 'SENT1' } };
      },
    };

    assert.equal(installPresenceTracking(sock), true);

    ev.emit('presence.update', {
      id: '120363000000000001@g.us',
      presences: {
        '111222333@lid': { lastKnownPresence: 'available' },
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    const online = await getOnlineMembers(sock, '120363000000000001@g.us');
    assert.ok(online.includes('254711223344@s.whatsapp.net'));
    assert.ok(subscribed.includes('254711223344@s.whatsapp.net'));

    await listonlinePlugin.run({
      client: sock,
      isGroup: true,
      m: {
        chat: '120363000000000001@g.us',
        isGroup: true,
        reactKey: { id: 'REQ1', remoteJid: '120363000000000001@g.us' },
        key: { id: 'REQ1', remoteJid: '120363000000000001@g.us' },
      },
    });

    const listMsg = sent.find((s) => s.payload?.text?.includes('Oɴʟɪɴᴇ Mᴇᴍʙᴇʀs'));
    assert.ok(listMsg, 'Expected listonline to post online members list');
    assert.ok(listMsg.payload.mentions.includes('254711223344@s.whatsapp.net'));
  } finally {
    globalThis._spiderPresenceMap = prevMap;
    globalThis.resolvePhoneFromLid = prevResolver;
  }
});

test('ensureSocketMediaHelpers attaches downloadMediaMessage and downloadAndSaveMediaMessage using Baileys helper', async () => {
  const sock = {};
  ensureSocketMediaHelpers(sock);
  assert.equal(typeof sock.downloadMediaMessage, 'function');
  assert.equal(typeof sock.downloadAndSaveMediaMessage, 'function');

  await assert.rejects(async () => {
    await sock.downloadMediaMessage(null);
  }, /unavailable/i);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-media-test-'));
  try {
    const customSock = {
      downloadMediaMessage: async () => Buffer.from('hello-image'),
    };
    ensureSocketMediaHelpers(customSock);
    const outPath = await customSock.downloadAndSaveMediaMessage(
      { mimetype: 'image/jpeg', url: 'https://example.com' },
      path.join(tmpDir, 'sample'),
      true,
    );
    assert.equal(outPath.endsWith('.jpg'), true);
    assert.equal(fs.readFileSync(outPath, 'utf8'), 'hello-image');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('downloadContentFromMessage validates missing media object before calling Baileys', async () => {
  await assert.rejects(async () => {
    await downloadContentFromMessage(null, 'image');
  }, /required/i);
});

test('gctools.js and pinm.js generate interactive messages with valid key/userJid', async () => {
  const relayed = [];
  const client = {
    user: { id: '254700000001:0@s.whatsapp.net' },
    sendMessage: async () => ({ key: { id: 'M1' } }),
    relayMessage: async (jid, message, opts) => {
      relayed.push({ jid, message, opts });
    },
  };

  const disappearingCmd = gctoolsPlugins.find((c) => c.name === 'disappearing');
  assert.ok(disappearingCmd);
  await disappearingCmd.run({
    client,
    m: { chat: '120363000000000002@g.us', isGroup: true, reactKey: { id: 'R1' } },
    isGroup: true,
    isAdmin: true,
    isBotAdmin: true,
    args: [],
    prefix: '.',
  });

  assert.equal(relayed.length, 1);
  assert.ok(relayed[0].message?.interactiveMessage);
  assert.ok(relayed[0].opts?.messageId);

  relayed.length = 0;
  await pinmPlugin.run({
    client,
    isGroup: true,
    prefix: '.',
    args: [],
    m: {
      chat: '120363000000000002@g.us',
      sender: '254700000002@s.whatsapp.net',
      isGroup: true,
      reactKey: { id: 'R2' },
      quoted: { id: 'Q1', fromMe: false, sender: '254700000002@s.whatsapp.net' },
    },
  });

  assert.equal(relayed.length, 1);
  assert.ok(relayed[0].message?.interactiveMessage);
  assert.ok(relayed[0].opts?.messageId);
});

test('keith_features.js getbio parses Baileys v7 fetchStatus array shape', async () => {
  const lilMod = require('../legacy/lil/index.js');
  const origGmd = lilMod.gmd;
  const registered = [];
  lilMod.gmd = (info, fn) => {
    registered.push({ info, fn });
  };
  try {
    delete require.cache[require.resolve('../legacy/lilgabriel/keith_features.js')];
    require('../legacy/lilgabriel/keith_features.js');
  } finally {
    lilMod.gmd = origGmd;
  }

  const getbioCmd = registered.find((c) => c.info?.pattern === 'getbio');
  assert.ok(getbioCmd, 'getbio command should register via keith_features.js');

  const replies = [];
  const reactions = [];
  await getbioCmd.fn(
    '254700000009@s.whatsapp.net',
    {
      fetchStatus: async () => [{ status: { status: 'Always friendly neighborhood Spider', setAt: new Date().toISOString() } }],
    },
    {
      reply: async (txt) => replies.push(txt),
      react: async (r) => reactions.push(r),
      sender: '254700000009@s.whatsapp.net',
      botFooter: 'Spider Man',
    },
  );

  assert.ok(reactions.includes('✅'));
  assert.ok(replies.some((r) => r.includes('Always friendly neighborhood Spider')));
});

test('legacy obfuscated search/sports plugins pass options object to generateWAMessageFromContent', () => {
  for (const relPath of [
    'Spider/legacy/lilgabriel/search.js',
    'Spider/legacy/lilgabriel/search2.js',
    'Spider/legacy/lilgabriel/sports.js',
  ]) {
    const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
    const calls = src.match(/generateWAMessageFromContent\(/g) || [];
    assert.ok(calls.length > 0);
    assert.equal(src.includes("'userJid':"), true, `${relPath} should pass userJid`);
    assert.equal(src.includes("'timestamp':new Date()"), true, `${relPath} should pass timestamp`);
  }

  // Sanity check Baileys generateWAMessageFromContent produces a message ID when options include userJid & timestamp
  const msg = generateWAMessageFromContent(
    '254700000000@s.whatsapp.net',
    { conversation: 'hi' },
    { userJid: '254700000001@s.whatsapp.net', timestamp: new Date() },
  );
  assert.ok(msg?.key?.id);
});
