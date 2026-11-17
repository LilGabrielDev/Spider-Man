import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import axios from 'axios';

const origAxiosGet = axios.get.bind(axios);
const origFetch = globalThis.fetch;

let commandsMap;
let aliasesMap;

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
    const h = origSetInterval(...args);
    h?.unref?.();
    return h;
  };

  try {
    const { reloadCommandsFromDisk } = await import('../../spider/utils/runtimeControl.js');
    const { loadLegacyCommands } = await import('../utils/legacyPlugins.js');
    commandsMap = new Map();
    aliasesMap = new Map();
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
  axios.get = origAxiosGet;
  globalThis.fetch = origFetch;
});

function createSock() {
  const sent = [];
  return {
    sent,
    sock: {
      sendMessage: async (jid, payload, opts = {}) => {
        sent.push({ jid, payload, opts });
        return { key: { id: `m-${sent.length}`, remoteJid: jid, fromMe: true } };
      },
    },
  };
}

test('KnightBotAPI commands (download, imgfx, kapi) and aliases are registered cleanly', () => {
  for (const name of ['download', 'imgfx', 'kapi']) {
    const cmd = commandsMap.get(name);
    assert.ok(cmd, `Expected command ${name} to be loaded`);
    assert.equal(typeof cmd.execute, 'function');
  }
  assert.equal(aliasesMap.get('unidownload'), 'download');
  assert.equal(aliasesMap.get('knightdownload'), 'download');
  assert.equal(aliasesMap.get('imagefx'), 'imgfx');
  assert.equal(aliasesMap.get('knightapi'), 'kapi');
  assert.equal(aliasesMap.get('knightbotapi'), 'kapi');
});

test('download, imgfx, and kapi validate input and execute mocked KnightBotAPI requests', async () => {
  const from = '120363000000001234@g.us';
  const msg = { key: { id: 'in-1', remoteJid: from } };
  const calls = [];

  axios.get = async (url, cfg) => {
    calls.push({ url, params: cfg?.params });
    if (url.endsWith('/api/download')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: {
          success: true,
          result: {
            title: 'Sample Clip',
            url:
              cfg?.params?.type === 'mp3'
                ? 'https://cdn.example.com/clip.mp3'
                : 'https://cdn.example.com/clip.mp4',
          },
        },
      };
    }
    if (url.endsWith('/api/img/blur')) {
      return {
        status: 200,
        headers: { 'content-type': 'image/png' },
        data: Buffer.from([137, 80, 78, 71]),
      };
    }
    if (url.endsWith('/api/tools/weather')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: Buffer.from(JSON.stringify({ success: true, result: { text: 'Nairobi: 22C Clear' } })),
      };
    }
    return { status: 404, headers: {}, data: { error: 'Not found' } };
  };

  const { sock, sent } = createSock();

  // 1. download validation + mp3/mp4 handling
  const dlCmd = commandsMap.get('download');
  await dlCmd.execute({ sock, from, text: '', msg });
  assert.match(sent.at(-1).payload.text, /Usage:/i);

  await dlCmd.execute({ sock, from, text: 'not-a-url', msg });
  assert.match(sent.at(-1).payload.text, /valid public http\/https URL/i);

  await dlCmd.execute({ sock, from, text: 'https://example.com/video mp3', msg });
  assert.equal(sent.at(-1).payload.audio.url, 'https://cdn.example.com/clip.mp3');

  await dlCmd.execute({ sock, from, text: 'https://example.com/video mp4', msg });
  assert.equal(sent.at(-1).payload.video.url, 'https://cdn.example.com/clip.mp4');

  // 2. imgfx validation + binary image response
  const fxCmd = commandsMap.get('imgfx');
  await fxCmd.execute({ sock, from, text: '', msg });
  assert.match(sent.at(-1).payload.text, /Choose an image effect:/i);

  await fxCmd.execute({ sock, from, text: 'blur', msg });
  assert.match(sent.at(-1).payload.text, /publicly accessible image URL/i);

  await fxCmd.execute({ sock, from, text: 'blur https://example.com/pic.jpg level=25', msg });
  assert.ok(Buffer.isBuffer(sent.at(-1).payload.image));
  assert.equal(calls.at(-1).params.level, '25');
  assert.equal(calls.at(-1).params.url, 'https://example.com/pic.jpg');

  // 3. kapi validation + route alias + default param + apikey stripping
  const kapiCmd = commandsMap.get('kapi');
  await kapiCmd.execute({ sock, from, text: '', msg });
  assert.match(sent.at(-1).payload.text, /112 documented routes/i);

  await kapiCmd.execute({ sock, from, text: 'unknown/route', msg });
  assert.match(sent.at(-1).payload.text, /Unknown route/i);

  await kapiCmd.execute({ sock, from, text: 'weather Nairobi', msg });
  assert.match(sent.at(-1).payload.text, /Nairobi: 22C Clear/);
  assert.equal(calls.at(-1).params.city, 'Nairobi');
});
