import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cleanUserJid,
  getPhoneFromJid,
  getLidFromJid,
  getSenderPhone,
  getRealSenderJidFromMsg,
  normalizeSudoTarget,
  captureBotUserIdentities,
  resolveBotPhoneFromLidAsync,
  resolveRuntimeOwnerJid,
  resolveRuntimeOwnerPhone,
  isOwnerIdentity,
} from '../../spider/utils/userJid.js';
import { addSudoNumber, isSudoNumber, removeSudoNumber, loadSudoList } from '../../spider/utils/sudoStore.js';
import { commands as sudoCommands } from '../commands/Sudo.js';
import { commands as userCommands } from '../commands/User.js';
import { commands as saveCommands } from '../commands/Save.js';
import { commands as generalCommands } from '../commands/General.js';
import { commands as whatsappCommands } from '../commands/WhatsApp.js';
import * as franceUtils from '../france/utils.js';
import Ownermiddleware from '../legacy/lilgabriel/utils/botUtil/Ownermiddleware.js';

const findCmd = (list, name) => {
  const cmd = list.find((c) => c.name === name);
  assert.ok(cmd, `Expected command ${name}`);
  return cmd;
};

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function snapshotBotGlobals() {
  return {
    BOT_NUMBER: globalThis.BOT_NUMBER,
    BOT_JID: globalThis.BOT_JID,
    BOT_LID: globalThis.BOT_LID,
    BOT_LIDS: globalThis.BOT_LIDS,
    ALLOWED_USERS: globalThis.ALLOWED_USERS,
  };
}

function restoreBotGlobals(snap) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete globalThis[k];
    else globalThis[k] = v;
  }
}

test('env templates, deployment manifests, and configs exclude user JIDs while preserving CHANNEL_JID', () => {
  const envSample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const appJson = fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8');
  const renderYaml = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  for (const content of [envSample, appJson]) {
    assert.doesNotMatch(content, /\bUSER_LID\b/);
    assert.doesNotMatch(content, /\bOWNER_NUMBER\b/);
    assert.match(content, /\bCHANNEL_JID\b/);
  }
  for (const content of [renderYaml, readme]) {
    assert.doesNotMatch(content, /\bUSER_LID\b/);
    assert.doesNotMatch(content, /\bOWNER_NUMBER\b/);
  }

  const spiderConfig = fs.readFileSync(path.join(ROOT, 'spider', 'config.js'), 'utf8');
  const lilSettings = fs.readFileSync(path.join(ROOT, 'Spider', 'legacy', 'lil', 'config', 'settings.js'), 'utf8');
  const legacyPlugins = fs.readFileSync(path.join(ROOT, 'Spider', 'utils', 'legacyPlugins.js'), 'utf8');
  const ownerMiddleware = fs.readFileSync(path.join(ROOT, 'Spider', 'legacy', 'lilgabriel', 'utils', 'botUtil', 'Ownermiddleware.js'), 'utf8');

  assert.doesNotMatch(spiderConfig, /process\.env\.USER_LID|process\.env\.OWNER_NUMBER/);
  assert.match(spiderConfig, /process\.env\..*CHANNEL_JID|CHANNEL_JID/);
  assert.doesNotMatch(lilSettings, /process\.env\.USER_LID|process\.env\.OWNER_NUMBER/);
  assert.doesNotMatch(legacyPlugins, /process\.env\.USER_LID|process\.env\.OWNER_NUMBER/);
  assert.doesNotMatch(ownerMiddleware, /process\.env\.USER_LID|process\.env\.OWNER_NUMBER/);
});

test('userJid helpers normalize domains and avoid treating @lid digits as phone numbers', () => {
  assert.equal(cleanUserJid('254712345678:12@s.whatsapp.net'), '254712345678@s.whatsapp.net');
  assert.equal(cleanUserJid('254712345678@c.us'), '254712345678@s.whatsapp.net');
  assert.equal(cleanUserJid('254712345678:4@HOSTED'), '254712345678@s.whatsapp.net');
  assert.equal(cleanUserJid('123456789012345:2@hosted.lid'), '123456789012345@lid');

  assert.equal(getPhoneFromJid('254712345678:3@s.whatsapp.net'), '254712345678');
  assert.equal(getPhoneFromJid('123456789012345@lid'), null);
  assert.equal(getPhoneFromJid('123456789012345:0@hosted.lid'), null);
  assert.equal(getPhoneFromJid('120363000000000000@g.us'), null);

  assert.equal(getLidFromJid('123456789012345:7@hosted.lid'), '123456789012345@lid');
  assert.equal(getLidFromJid('254712345678@s.whatsapp.net'), null);

  const lidToPhoneMap = new Map([['123456789012345@lid', '254712345678']]);
  assert.equal(getSenderPhone('123456789012345@lid'), null);
  assert.equal(getSenderPhone(''), null);
  assert.equal(getSenderPhone('123456789012345@lid', lidToPhoneMap), '254712345678');

  assert.equal(normalizeSudoTarget('123456789012345:5@hosted.lid'), '123456789012345@lid');
  assert.equal(normalizeSudoTarget('+254 712 345 678'), '254712345678');
});

test('getRealSenderJidFromMsg prefers bot identity for fromMe and avoids group JIDs', () => {
  const sock = { user: { id: '254700111222:1@s.whatsapp.net', lid: '998877665544@lid' } };
  const fromMeGroup = {
    key: {
      fromMe: true,
      remoteJid: '120363000111222333@g.us',
      participant: '998877665544:2@lid',
    },
  };
  assert.equal(getRealSenderJidFromMsg(fromMeGroup, sock), '254700111222@s.whatsapp.net');

  const peerLidGroup = {
    key: {
      fromMe: false,
      remoteJid: '120363000111222333@g.us',
      participant: '112233445566:4@lid',
      participantAlt: '254799888777@s.whatsapp.net',
    },
  };
  assert.equal(getRealSenderJidFromMsg(peerLidGroup, sock), '112233445566@lid');
});

test('runtime capture populates PN/LID mappings, resolves LID via signalRepository, and blocks null===null owner elevation', async () => {
  const snap = snapshotBotGlobals();
  try {
    delete globalThis.BOT_NUMBER;
    delete globalThis.BOT_JID;
    delete globalThis.BOT_LID;
    delete globalThis.BOT_LIDS;

    const config = { OWNER_NUMBER: '', USER_LID: [] };
    const phoneToLidMap = new Map();
    const lidToPhoneMap = new Map();
    const aliases = [];

    const first = captureBotUserIdentities({
      sock: { user: { id: '555666777888:0@lid', lid: '555666777888:0@lid' } },
      config,
      phoneToLidMap,
      lidToPhoneMap,
      registerChatAlias: (a, b) => aliases.push([a, b]),
    });

    assert.equal(first.ownerNumber, null);
    assert.equal(first.ownerFullJid, '555666777888@lid');
    assert.deepEqual(first.ownerLids, ['555666777888@lid']);

    // Unmapped peer LID or null JID must never match null === null as owner
    assert.equal(
      isOwnerIdentity({
        jid: '999000111222@lid',
        ownerNumber: first.ownerNumber,
        ownerFullJid: first.ownerFullJid,
        ownerLids: first.ownerLids,
        config,
        lidToPhoneMap,
      }),
      false,
    );
    assert.equal(
      isOwnerIdentity({
        jid: '',
        ownerNumber: null,
        config,
      }),
      false,
    );

    const mockSock = {
      user: { id: '555666777888:0@lid', lid: '555666777888:0@lid' },
      signalRepository: {
        lidMapping: {
          getPNForLID: async (lid) => (lid === '555666777888@lid' ? '254711223344:0@s.whatsapp.net' : null),
        },
      },
    };

    const resolved = await resolveBotPhoneFromLidAsync(mockSock, {
      lids: first.ownerLids,
      lidToPhoneMap,
      phoneToLidMap,
      registerChatAlias: (a, b) => aliases.push([a, b]),
      config,
    });

    assert.deepEqual(resolved, {
      phone: '254711223344',
      jid: '254711223344@s.whatsapp.net',
      lid: '555666777888@lid',
    });
    assert.equal(config.OWNER_NUMBER, '254711223344');
    assert.equal(globalThis.BOT_NUMBER, '254711223344');
    assert.equal(resolveRuntimeOwnerJid({ sock: mockSock, config, lidToPhoneMap }), '254711223344@s.whatsapp.net');
    assert.equal(resolveRuntimeOwnerPhone({ sock: mockSock, config, lidToPhoneMap }), '254711223344');
    assert.equal(
      isOwnerIdentity({
        jid: '555666777888@lid',
        config,
        sock: mockSock,
        lidToPhoneMap,
      }),
      true,
    );
    assert.ok(aliases.some(([a, b]) => a === '254711223344@s.whatsapp.net' && b === '555666777888@lid'));
  } finally {
    restoreBotGlobals(snap);
  }
});

test('sudoStore, Sudo.js, and User.js preserve @lid JIDs without rewriting them as phone numbers', async () => {
  const snap = snapshotBotGlobals();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-sudo-lid-'));
  const sudoPath = path.join(tmpDir, 'sudo.json');
  try {
    globalThis.ALLOWED_USERS = new Set();
    assert.equal(addSudoNumber('123456789012345:2@hosted.lid', sudoPath), true);
    assert.equal(addSudoNumber('+254 700 000 111', sudoPath), true);
    assert.equal(isSudoNumber('123456789012345@lid', sudoPath), true);
    assert.equal(isSudoNumber('254700000111@s.whatsapp.net', sudoPath), true);

    const loaded = loadSudoList(sudoPath);
    assert.ok(loaded.has('123456789012345@lid'));
    assert.ok(loaded.has('254700000111'));

    const sent = [];
    const mockSock = {
      sendMessage: async (jid, payload) => {
        sent.push({ jid, payload });
      },
      updateBlockStatus: async () => {},
    };

    await findCmd(sudoCommands, 'sudo').execute({
      sock: mockSock,
      from: '12345@g.us',
      args: ['list'],
      msg: { key: {} },
      isOwner: true,
    });
    const listText = sent[0]?.payload?.text || '';
    assert.match(listText, /123456789012345@lid/);
    assert.doesNotMatch(listText, /\+123456789012345@lid/);
    assert.match(listText, /\+254700000111/);

    assert.equal(removeSudoNumber('123456789012345@lid', sudoPath), true);
    assert.equal(isSudoNumber('123456789012345@lid', sudoPath), false);

    const blockCalls = [];
    const blockSock = {
      updateBlockStatus: async (jid, action) => blockCalls.push({ jid, action }),
      sendMessage: async () => {},
    };
    await findCmd(userCommands, 'block').execute({
      sock: blockSock,
      from: '120363000111@g.us',
      args: [],
      text: '',
      msg: {
        key: {},
        message: {
          extendedTextMessage: {
            contextInfo: { participant: '445566778899:3@lid' },
          },
        },
      },
      isOwner: true,
    });
    assert.deepEqual(blockCalls, [{ jid: '445566778899@lid', action: 'block' }]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreBotGlobals(snap);
  }
});

test('Save, General(owner), WhatsApp(vv2/vcard), france/utils, and Ownermiddleware resolve runtime owner JIDs without env', async () => {
  const snap = snapshotBotGlobals();
  try {
    delete globalThis.BOT_NUMBER;
    delete globalThis.BOT_JID;
    delete globalThis.BOT_LID;
    delete globalThis.BOT_LIDS;

    const sent = [];
    const sockWithLidOnly = {
      user: { id: '778899001122:1@lid', lid: '778899001122:1@lid' },
      sendMessage: async (jid, payload) => sent.push({ jid, payload }),
      signalRepository: {
        lidMapping: {
          getPNForLID: async (lid) => (lid === '778899001122@lid' ? '254722334455@s.whatsapp.net' : null),
        },
      },
    };

    // General .owner uses lidMapping PN fallback cleanly even when config.OWNER_NUMBER is empty
    await findCmd(generalCommands, 'owner').execute({
      sock: sockWithLidOnly,
      from: '254700000001@s.whatsapp.net',
      args: [],
      text: '',
      msg: {
        key: { remoteJid: '254700000001@s.whatsapp.net' },
        message: { conversation: '.owner' },
      },
      config: { OWNER_NUMBER: '', OWNER_NAME: 'TestOwner', BOT_NAME: 'Spider Man' },
      sender: '254700000001@s.whatsapp.net',
    });
    assert.ok(sent.some((entry) => entry.payload?.contacts?.contacts?.[0]?.vcard?.includes('254722334455')));

    // Save resolves runtime owner JID without config.OWNER_NUMBER
    delete globalThis.BOT_NUMBER;
    delete globalThis.BOT_JID;
    const saveSent = [];
    await findCmd(saveCommands, 'save').execute({
      sock: {
        user: { id: '254733445566:0@s.whatsapp.net' },
        sendMessage: async (jid, payload) => saveSent.push({ jid, payload }),
      },
      from: 'status@broadcast',
      msg: {
        key: { remoteJid: 'status@broadcast' },
        message: {
          extendedTextMessage: {
            contextInfo: {
              quotedMessage: { conversation: 'Status note' },
              participant: '254700123456@s.whatsapp.net',
            },
          },
        },
      },
      config: { OWNER_NUMBER: '' },
    });
    assert.equal(saveSent[0]?.jid, '254733445566@s.whatsapp.net');

    // WhatsApp removedp & vcard resolve runtime self JID and LID->PN mapping without env
    const removedDpTargets = [];
    await findCmd(whatsappCommands, 'removedp').execute({
      sock: {
        user: { id: '887766554433:2@lid', lid: '887766554433:2@lid' },
        removeProfilePicture: async (jid) => {
          removedDpTargets.push(jid);
          return {};
        },
        sendMessage: async () => {},
      },
      from: '120363000222@g.us',
      msg: { key: { remoteJid: '120363000222@g.us' } },
      isOwner: true,
    });
    assert.equal(removedDpTargets[0], '887766554433@lid');

    const vcardSent = [];
    await findCmd(whatsappCommands, 'vcard').execute({
      sock: {
        groupMetadata: async () => ({ participants: [] }),
        signalRepository: {
          lidMapping: {
            getPNForLID: async (lid) => (lid === '112233445566@lid' ? '254744556677:0@s.whatsapp.net' : null),
          },
        },
        sendMessage: async (jid, payload) => vcardSent.push({ jid, payload }),
      },
      from: '120363000222@g.us',
      text: 'Friend Name',
      msg: {
        key: { remoteJid: '120363000222@g.us' },
        message: {
          extendedTextMessage: {
            text: '.vcard Friend Name',
            contextInfo: {
              participant: '112233445566:5@lid',
            },
          },
        },
      },
    });
    assert.match(vcardSent[0]?.payload?.contacts?.contacts?.[0]?.vcard || '', /waid=254744556677:254744556677/);

    // france/utils helpers handle LID vs PN cleanly
    assert.equal(franceUtils.getUserNumber('123456789012345@lid'), null);
    assert.equal(franceUtils.getUserNumber('254712345678:5@s.whatsapp.net'), '254712345678');
    assert.equal(franceUtils.formatJid('123456789012345:2@hosted.lid'), '123456789012345@lid');

    // Legacy Ownermiddleware authenticates runtime LID without env vars
    globalThis.BOT_LID = '778899001122@lid';
    let nextCalled = false;
    await Ownermiddleware(
      {
        m: { sender: '778899001122@lid', chat: '123@g.us', reply: async () => {} },
        client: { user: { id: '778899001122:0@lid', lid: '778899001122:0@lid' } },
        SuperOwner: false,
      },
      () => {
        nextCalled = true;
      },
    );
    assert.equal(nextCalled, true);
  } finally {
    restoreBotGlobals(snap);
  }
});
