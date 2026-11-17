import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import axios from 'axios';
import { reloadCommandsFromDisk } from '../../spider/utils/runtimeControl.js';
import { loadLegacyCommands } from '../utils/legacyPlugins.js';

const origFetch = globalThis.fetch;
const origAxiosGet = axios.get.bind(axios);

const commandsMap = new Map();
const aliasesMap = new Map();
let loadStats;

function makeSock(sent = []) {
  return {
    sendMessage: async (jid, payload, opts = {}) => {
      sent.push({ jid, payload, opts });
      return { key: { id: `msg-${sent.length}`, remoteJid: jid, fromMe: true } };
    },
    groupMetadata: async (jid) => ({
      id: jid,
      subject: 'Spider Test HQ',
      participants: [
        { id: '254700000001@s.whatsapp.net', admin: 'superadmin' },
        { id: '254700000002@s.whatsapp.net', admin: 'admin' },
        { id: '254700000003@s.whatsapp.net', admin: null },
      ],
    }),
  };
}

function ctx(name, { sock, from = '120363000000000000@g.us', text = '', isGroupAdmin = true, isOwner = true, msg = null } = {}) {
  const args = text ? text.trim().split(/\s+/) : [];
  return {
    sock,
    from,
    sender: '254700000001@s.whatsapp.net',
    senderNumber: '254700000001',
    text,
    args,
    msg: msg || { key: { id: `in-${name}`, remoteJid: from, fromMe: true }, message: { conversation: `.${name} ${text}`.trim() } },
    commands: commandsMap,
    commandAliases: aliasesMap,
    isGroupAdmin,
    isOwner,
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
      cacheBust: 888001,
    });
  } finally {
    globalThis.setInterval = origSetInterval;
  }
});

after(() => {
  globalThis.fetch = origFetch;
  axios.get = origAxiosGet;
});

test('Spider command modules register with zero collisions and preserve single-message menu', async () => {
  const spiderCollisions = loadStats.collisions.filter((c) => /Spider(Fun|Group|Search|Text|Utils)\.js/.test(JSON.stringify(c)));
  assert.deepEqual(spiderCollisions, [], 'New Spider modules should introduce zero command or alias collisions');

  for (const name of [
    '8ball', 'truth', 'dare', 'tod', 'riddle', 'answer', 'roast', 'compliment', 'ship',
    'dice', 'rps', 'slot', 'horoscope', 'proverb', 'numberfact',
    'base64', 'decode64', 'binary', 'unbinary', 'hex', 'unhex', 'morse', 'unmorse', 'rot13', 'roman', 'unitconvert',
    'calc', 'passgen', 'uuid', 'hash', 'timestamp', 'jsonformat', 'qr', 'colorinfo', 'ip', 'dns', 'chmod', 'bmi', 'compound', 'tip',
    'wiki', 'ghstalk', 'crypto', 'news', 'rhyme', 'tts', 'carbon',
    'admins', 'rules', 'setrules', 'delrules',
  ]) {
    assert.ok(commandsMap.has(name), `Expected command "${name}" to be registered`);
  }

  const sent = [];
  await commandsMap.get('menu').execute(ctx('menu', { sock: makeSock(sent), from: '254700000001@s.whatsapp.net' }));
  assert.equal(sent.length, 1, '.menu must remain a single combined message');
  const caption = sent[0].payload.caption || sent[0].payload.text || '';
  assert.ok(caption.length <= 1024, `Menu caption (${caption.length}) should remain <= 1024 chars`);
});

test('SpiderFun games, riddle/answer state, and ship work cleanly', async () => {
  const sent = [];
  const sock = makeSock(sent);

  await commandsMap.get('8ball').execute(ctx('8ball', { sock, text: 'Will tests pass?' }));
  assert.match(sent.at(-1).payload.text, /MAGIC 8-BALL/);

  await commandsMap.get('ship').execute(ctx('ship', { sock, text: 'Spider and MJ' }));
  assert.match(sent.at(-1).payload.text, /% /);

  await commandsMap.get('rps').execute(ctx('rps', { sock, text: 'rock' }));
  assert.match(sent.at(-1).payload.text, /ROCK PAPER SCISSORS/);

  await commandsMap.get('dice').execute(ctx('dice', { sock, text: '3' }));
  assert.match(sent.at(-1).payload.text, /TOTAL/);

  axios.get = async () => ({ data: { riddle: 'What has keys but no locks?', answer: 'A piano' } });
  await commandsMap.get('riddle').execute(ctx('riddle', { sock }));
  assert.match(sent.at(-1).payload.text, /What has keys but no locks/);

  await commandsMap.get('answer').execute(ctx('answer', { sock, text: 'piano' }));
  assert.match(sent.at(-1).payload.text, /Correct/);
});

test('SpiderText encoders, ciphers, and unit converters produce exact results', async () => {
  const sent = [];
  const sock = makeSock(sent);

  await commandsMap.get('base64').execute(ctx('base64', { sock, text: 'Spider' }));
  assert.equal(sent.at(-1).payload.text, 'U3BpZGVy');
  await commandsMap.get('decode64').execute(ctx('decode64', { sock, text: 'U3BpZGVy' }));
  assert.equal(sent.at(-1).payload.text, 'Spider');

  await commandsMap.get('morse').execute(ctx('morse', { sock, text: 'SOS' }));
  assert.equal(sent.at(-1).payload.text, '... --- ...');
  await commandsMap.get('unmorse').execute(ctx('unmorse', { sock, text: '... --- ...' }));
  assert.equal(sent.at(-1).payload.text, 'SOS');

  await commandsMap.get('rot13').execute(ctx('rot13', { sock, text: 'Hello' }));
  assert.equal(sent.at(-1).payload.text, 'Uryyb');

  await commandsMap.get('roman').execute(ctx('roman', { sock, text: '2026' }));
  assert.match(sent.at(-1).payload.text, /\*MMXXVI\*/);

  await commandsMap.get('unitconvert').execute(ctx('unitconvert', { sock, text: '10 km mi' }));
  assert.match(sent.at(-1).payload.text, /6\.2137 mi/);
});

test('SpiderUtils calculators, crypto hashing, chmod, and mocked network lookups work', async () => {
  const sent = [];
  const sock = makeSock(sent);

  await commandsMap.get('calc').execute(ctx('calc', { sock, text: '(25 * 4) + 10' }));
  assert.match(sent.at(-1).payload.text, /110/);

  await commandsMap.get('compound').execute(ctx('compound', { sock, text: '' }));
  assert.match(sent.at(-1).payload.text, /Usage:/);
  await commandsMap.get('compound').execute(ctx('compound', { sock, text: '1000 10 2' }));
  assert.match(sent.at(-1).payload.text, /1210\.00/);

  await commandsMap.get('hash').execute(ctx('hash', { sock, text: 'spider' }));
  assert.match(sent.at(-1).payload.text, /SHA256/);

  await commandsMap.get('chmod').execute(ctx('chmod', { sock, text: '755' }));
  assert.match(sent.at(-1).payload.text, /rwxr-xr-x/);

  await commandsMap.get('bmi').execute(ctx('bmi', { sock, text: '70 175' }));
  assert.match(sent.at(-1).payload.text, /Normal/);

  axios.get = async (url) => {
    if (String(url).includes('qrserver.com')) {
      return { data: Buffer.from('png-bytes') };
    }
    if (String(url).includes('ip-api.com')) {
      return {
        data: { status: 'success', query: '8.8.8.8', country: 'United States', city: 'Mountain View', regionName: 'California', timezone: 'America/Los_Angeles', isp: 'Google LLC', proxy: false },
      };
    }
    return { data: {} };
  };

  await commandsMap.get('qr').execute(ctx('qr', { sock, text: 'https://example.com' }));
  assert.ok(Buffer.isBuffer(sent.at(-1).payload.image));

  await commandsMap.get('ip').execute(ctx('ip', { sock, text: '8.8.8.8' }));
  assert.match(sent.at(-1).payload.text, /Google LLC/);
});

test('SpiderSearch commands (wiki, ghstalk, crypto, news, rhyme, tts) handle mocked APIs', async () => {
  const sent = [];
  const sock = makeSock(sent);

  axios.get = async (url) => {
    const u = String(url);
    if (u.includes('en.wikipedia.org/w/api.php')) {
      return { data: { query: { search: [{ title: 'Spider-Man' }] } } };
    }
    if (u.includes('wikipedia.org/api/rest_v1')) {
      return { data: { displaytitle: 'Spider-Man', extract: 'Superhero appearing in comic books.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Spider-Man' } } } };
    }
    if (u.includes('api.github.com/users/torvalds/repos')) {
      return { data: [{ name: 'linux', language: 'C', stargazers_count: 180000 }] };
    }
    if (u.includes('api.github.com/users/torvalds')) {
      return { data: { login: 'torvalds', name: 'Linus Torvalds', public_repos: 8, followers: 220000, following: 0, html_url: 'https://github.com/torvalds' } };
    }
    if (u.includes('api.coingecko.com')) {
      return { data: { bitcoin: { usd: 90000, usd_24h_change: 2.5 } } };
    }
    if (u.includes('rss2json.com')) {
      return { data: { items: [{ title: 'Breaking Tech Update', link: 'https://bbc.co.uk/news/1' }] } };
    }
    if (u.includes('datamuse.com')) {
      return { data: [{ word: 'tune' }, { word: 'June' }] };
    }
    if (u.includes('translate_tts')) {
      return { data: Buffer.from('mp3-bytes') };
    }
    return { data: {} };
  };

  await commandsMap.get('wiki').execute(ctx('wiki', { sock, text: 'Spider-Man' }));
  assert.match(sent.at(-1).payload.text, /Superhero appearing in comic books/);

  await commandsMap.get('ghstalk').execute(ctx('ghstalk', { sock, text: 'torvalds' }));
  assert.match(sent.at(-1).payload.text, /Linus Torvalds/);

  await commandsMap.get('crypto').execute(ctx('crypto', { sock, text: 'bitcoin' }));
  assert.match(sent.at(-1).payload.text, /90,000/);

  await commandsMap.get('news').execute(ctx('news', { sock, text: 'tech' }));
  assert.match(sent.at(-1).payload.text, /Breaking Tech Update/);

  await commandsMap.get('rhyme').execute(ctx('rhyme', { sock, text: 'moon' }));
  assert.match(sent.at(-1).payload.text, /tune, June/);

  await commandsMap.get('tts').execute(ctx('tts', { sock, text: 'Hello Spider Man' }));
  assert.ok(Buffer.isBuffer(sent.at(-1).payload.audio));
  assert.equal(sent.at(-1).payload.ptt, true);
});

test('SpiderGroup admins and persistent rules work cleanly', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-group-rules-'));
  t.mock.method(process, 'cwd', () => tmpDir);

  try {
    const sent = [];
    const sock = makeSock(sent);
    const groupJid = '120363000000000000@g.us';

    await commandsMap.get('admins').execute(ctx('admins', { sock, from: groupJid }));
    assert.match(sent.at(-1).payload.text, /ADMIN ROSTER/);
    assert.equal(sent.at(-1).payload.mentions.length, 2);

    await commandsMap.get('rules').execute(ctx('rules', { sock, from: groupJid }));
    assert.match(sent.at(-1).payload.text, /No rules have been set/);

    await commandsMap.get('setrules').execute(ctx('setrules', { sock, from: groupJid, text: '1. Be respectful\n2. No spam' }));
    assert.match(sent.at(-1).payload.text, /GROUP RULES UPDATED/);

    await commandsMap.get('rules').execute(ctx('rules', { sock, from: groupJid }));
    assert.match(sent.at(-1).payload.text, /1\. Be respectful/);

    await commandsMap.get('delrules').execute(ctx('delrules', { sock, from: groupJid }));
    assert.match(sent.at(-1).payload.text, /Group rules cleared/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
