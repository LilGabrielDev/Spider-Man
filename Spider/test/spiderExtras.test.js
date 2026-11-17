import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import axios from 'axios';
import { reloadCommandsFromDisk } from '../../spider/utils/runtimeControl.js';
import { loadLegacyCommands } from '../utils/legacyPlugins.js';
import { clearPendingGroupTimers } from '../commands/SpiderExtras.js';

const origFetch = globalThis.fetch;
const origAxiosGet = axios.get.bind(axios);

const commandsMap = new Map();
const aliasesMap = new Map();
let loadStats;

function makeSock(sent = [], extras = {}) {
  return {
    user: { id: '254700000001:1@s.whatsapp.net', name: 'Spider Man' },
    sendMessage: async (jid, payload, opts = {}) => {
      const id = `spider-extras-msg-${sent.length + 1}`;
      sent.push({ jid, payload, opts, id });
      return { key: { id, remoteJid: jid, fromMe: true } };
    },
    groupSettingUpdate: async (jid, setting) => {
      sent.push({ action: 'groupSettingUpdate', jid, setting });
    },
    groupAcceptInvite: async (code) => {
      sent.push({ action: 'groupAcceptInvite', code });
      return '120363000000099999@g.us';
    },
    groupFetchAllParticipating: async () => ({
      '120363000000000001@g.us': { id: '120363000000000001@g.us', subject: 'Spider HQ' },
      '120363000000000002@g.us': { id: '120363000000000002@g.us', subject: 'Dev Squad' },
    }),
    newsletterMetadata: async (_type, code) => ({ id: `${code}@newsletter`, name: 'Spider Channel' }),
    newsletterReactMessage: async (id, msgId, emoji) => {
      sent.push({ action: 'newsletterReactMessage', id, msgId, emoji });
    },
    ...extras,
  };
}

function makeCtx(name, {
  sock,
  from = '120363000000000000@g.us',
  sender = '254700000001@s.whatsapp.net',
  text = '',
  isOwner = true,
  isGroupAdmin = true,
  isBotGroupAdmin = true,
  msg = null,
} = {}) {
  const args = text ? text.trim().split(/\s+/) : [];
  return {
    sock,
    from,
    sender,
    senderNumber: '254700000001',
    text,
    args,
    msg: msg || {
      key: { id: `in-${name}`, remoteJid: from, fromMe: true },
      message: { conversation: `.${name} ${text}`.trim() },
    },
    commands: commandsMap,
    commandAliases: aliasesMap,
    isOwner,
    isGroupAdmin,
    isBotGroupAdmin,
  };
}

before(async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => ({}),
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const handle = origSetInterval(...args);
    handle?.unref?.();
    return handle;
  };
  try {
    loadStats = await reloadCommandsFromDisk({
      commandsDir: path.resolve('Spider/commands'),
      commandsMap,
      aliasesMap,
      loadLegacyFn: loadLegacyCommands,
      pathToFileUrlFn: pathToFileURL,
      cacheBust: 777001,
    });
  } finally {
    globalThis.setInterval = origSetInterval;
  }
});

after(() => {
  clearPendingGroupTimers();
  globalThis.fetch = origFetch;
  axios.get = origAxiosGet;
});

test('SpiderExtras module registers all 51 non-duplicate commands with zero collisions and preserves compact menu', async () => {
  const extrasCollisions = loadStats.collisions.filter((c) => /SpiderExtras\.js/.test(JSON.stringify(c)));
  assert.deepEqual(extrasCollisions, [], 'SpiderExtras.js must introduce zero command or alias collisions');

  const expectedCommands = [
    'lockgs', 'unlockgs', 'opentime', 'closetime', 'join',
    'jid', 'gjid', 'chr', 'tempnum', 'templist', 'otpbox',
    'srepo', 'gdrive', 'img', 'rw',
    'waifu', 'neko', 'megumin', 'maid', 'awoo', 'dog', 'couplepp', 'character',
    'hpy', 'hrt', 'anger', 'sad', 'shy', 'mon', 'confused', 'kiss',
    '3dcomic', 'deadpool', 'blackpink', 'neonlight', 'thor', 'america', 'eraser',
    '3dpaper', 'clouds', 'galaxy', 'nigeria', 'devilwings', 'luxury', 'angelwings',
    'tattoo', 'castle', 'paint', 'birthday', 'typography', 'bear',
  ];

  for (const name of expectedCommands) {
    assert.ok(commandsMap.has(name), `Expected SpiderExtras command "${name}" to be registered`);
  }

  assert.equal(aliasesMap.get('creact'), 'chr');
  assert.equal(aliasesMap.get('cpp'), 'couplepp');
  assert.equal(aliasesMap.get('tatoo'), 'tattoo');
  assert.equal(aliasesMap.get('pinterest'), 'img');
  assert.equal(aliasesMap.get('wallpaper'), 'rw');

  const sent = [];
  await commandsMap.get('menu').execute(makeCtx('menu', { sock: makeSock(sent), from: '254700000001@s.whatsapp.net' }));
  assert.equal(sent.length, 1);
  const caption = sent[0].payload.caption || sent[0].payload.text || '';
  assert.ok(caption.length <= 1024, `Menu caption (${caption.length}) must stay <= 1024 chars`);
});

test('SpiderExtras group and owner commands (lockgs, unlockgs, opentime, closetime, join, jid, gjid, chr) work cleanly', async () => {
  const sent = [];
  const sock = makeSock(sent);

  await commandsMap.get('lockgs').execute(makeCtx('lockgs', { sock }));
  assert.ok(sent.some((e) => e.action === 'groupSettingUpdate' && e.setting === 'locked'));

  await commandsMap.get('unlockgs').execute(makeCtx('unlockgs', { sock }));
  assert.ok(sent.some((e) => e.action === 'groupSettingUpdate' && e.setting === 'unlocked'));

  await commandsMap.get('opentime').execute(makeCtx('opentime', { sock, text: '10 minute' }));
  assert.match(sent.at(-1).payload.text, /SCHEDULED GROUP OPEN/);

  await commandsMap.get('closetime').execute(makeCtx('closetime', { sock, text: '15 minute' }));
  assert.match(sent.at(-1).payload.text, /SCHEDULED GROUP CLOSE/);
  clearPendingGroupTimers();

  await commandsMap.get('join').execute(makeCtx('join', { sock, text: 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv' }));
  assert.ok(sent.some((e) => e.action === 'groupAcceptInvite' && e.code === 'AbCdEfGhIjKlMnOpQrStUv'));

  await commandsMap.get('jid').execute(makeCtx('jid', { sock }));
  assert.match(sent.at(-1).payload.text, /120363000000000000@g\.us/);

  await commandsMap.get('gjid').execute(makeCtx('gjid', { sock }));
  assert.match(sent.at(-1).payload.text, /Spider HQ/);
  assert.match(sent.at(-1).payload.text, /Dev Squad/);

  await commandsMap.get('chr').execute(makeCtx('chr', { sock, text: 'https://whatsapp.com/channel/0029VbDh88NCMY0Fartkxm1g/42 hi 1' }));
  const reactCall = sent.find((e) => e.action === 'newsletterReactMessage');
  assert.ok(reactCall);
  assert.equal(reactCall.msgId, '42');
  assert.equal(reactCall.emoji, '🅗🅘―➊');
});

test('SpiderExtras search, utility, media, fun, and logo commands handle mocked APIs cleanly', async () => {
  const sent = [];
  const sock = makeSock(sent);

  axios.get = async (url) => {
    const u = String(url);
    if (u.includes('api.github.com/repos/')) {
      return {
        data: {
          full_name: 'LilGabrielDev/Spider-Man',
          description: 'WhatsApp Multi-Device Bot',
          language: 'JavaScript',
          stargazers_count: 150,
          forks_count: 80,
          open_issues_count: 2,
          license: { spdx_id: 'MIT' },
          html_url: 'https://github.com/LilGabrielDev/Spider-Man',
        },
      };
    }
    if (u.includes('fakenumber/listnumber')) {
      return { data: { result: [{ number: '+12025550123' }] } };
    }
    if (u.includes('fakenumber/country')) {
      return { data: { result: [{ id: 'us', title: 'United States' }] } };
    }
    if (u.includes('fakenumber/message')) {
      return { data: { result: [{ from: 'Verify', content: 'Your code is 849201' }] } };
    }
    if (u.includes('api.waifu.pics/sfw/waifu')) {
      return { data: { url: 'https://cdn.example/waifu.jpg' } };
    }
    if (u.includes('dog.ceo/api/breeds/image/random')) {
      return { data: { message: 'https://cdn.example/dog.jpg', status: 'success' } };
    }
    if (u.includes('davidcyriltech.my.id/couplepp')) {
      return { data: { success: true, male: 'https://cdn.example/m.jpg', female: 'https://cdn.example/f.jpg' } };
    }
    if (u.includes('api-pink-venom.vercel.app/api/logo')) {
      return { data: { result: { download_url: 'https://cdn.example/logo.png' } } };
    }
    if (u.includes('davidcyriltech.my.id/gdrive')) {
      return { data: { download_link: 'https://cdn.example/archive.zip', name: 'archive.zip', mimetype: 'application/zip' } };
    }
    return { data: {} };
  };

  await commandsMap.get('srepo').execute(makeCtx('srepo', { sock, text: 'LilGabrielDev/Spider-Man' }));
  assert.match(sent.at(-1).payload.text, /WhatsApp Multi-Device Bot/);

  await commandsMap.get('tempnum').execute(makeCtx('tempnum', { sock, text: 'us' }));
  assert.match(sent.at(-1).payload.text, /\+12025550123/);

  await commandsMap.get('templist').execute(makeCtx('templist', { sock }));
  assert.match(sent.at(-1).payload.text, /United States/);

  await commandsMap.get('otpbox').execute(makeCtx('otpbox', { sock, text: '+12025550123' }));
  assert.match(sent.at(-1).payload.text, /849201/);

  await commandsMap.get('waifu').execute(makeCtx('waifu', { sock }));
  assert.equal(sent.at(-1).payload.image.url, 'https://cdn.example/waifu.jpg');

  await commandsMap.get('dog').execute(makeCtx('dog', { sock }));
  assert.equal(sent.at(-1).payload.image.url, 'https://cdn.example/dog.jpg');

  const beforeCpp = sent.length;
  await commandsMap.get('couplepp').execute(makeCtx('couplepp', { sock }));
  assert.equal(sent.length - beforeCpp, 2);

  await commandsMap.get('character').execute(makeCtx('character', {
    sock,
    msg: {
      key: { id: 'char-1', remoteJid: '120363000000000000@g.us', fromMe: true },
      message: {
        extendedTextMessage: {
          text: '.character @254722222222',
          contextInfo: { mentionedJid: ['254722222222@s.whatsapp.net'] },
        },
      },
    },
  }));
  assert.match(sent.at(-1).payload.text, /CHARACTER CHECK/);
  assert.deepEqual(sent.at(-1).payload.mentions, ['254722222222@s.whatsapp.net']);

  await commandsMap.get('3dcomic').execute(makeCtx('3dcomic', { sock, text: 'Spider' }));
  assert.equal(sent.at(-1).payload.image.url, 'https://cdn.example/logo.png');

  await commandsMap.get('gdrive').execute(makeCtx('gdrive', { sock, text: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view' }));
  assert.equal(sent.at(-1).payload.document.url, 'https://cdn.example/archive.zip');
  assert.equal(sent.at(-1).payload.fileName, 'archive.zip');
});
