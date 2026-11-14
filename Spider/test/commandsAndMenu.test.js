import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import axios from 'axios';
import { Jimp } from 'jimp';

const origFetch = globalThis.fetch;
const origAxiosGet = axios.get.bind(axios);
const origAxiosPost = axios.post.bind(axios);
const origAxiosRequest = axios.request.bind(axios);
const origAxiosHead = axios.head?.bind(axios);

let reloadCommandsFromDisk;
let loadLegacyCommands;
let handleMenuCategoryReply;
let sendMenuVisual;
let config;
let securityStore;
let MESSAGES;

const commandsMap = new Map();
const aliasesMap = new Map();

function createMockSock(sentLog = [], options = {}) {
  const failFirstImage = Boolean(options.failFirstImage);
  let imageAttempts = 0;

  const base = {
    user: { id: '254700000001:1@s.whatsapp.net', lid: '111111@lid', name: 'Spider Man' },
    sendMessage: async (jid, payload, sendOpts = {}) => {
      if (failFirstImage && payload?.image?.url && imageAttempts === 0) {
        imageAttempts += 1;
        throw new Error('Remote BOT_PIC unreachable in test');
      }
      if (payload?.image?.url) {
        imageAttempts += 1;
      }
      const id = `sent-${sentLog.length + 1}`;
      sentLog.push({ jid, payload, sendOpts, id });
      return { key: { id, remoteJid: jid, fromMe: true } };
    },
    groupMetadata: async (jid) => ({
      id: jid,
      subject: 'Spider Test Group',
      owner: '254700000001@s.whatsapp.net',
      participants: [
        { id: '254700000001@s.whatsapp.net', admin: 'superadmin' },
        { id: '254700000002@s.whatsapp.net', admin: 'admin' },
        { id: '254700000003@s.whatsapp.net', admin: null },
      ],
    }),
    onWhatsApp: async (jid) => [{ exists: true, jid }],
    fetchPrivacySettings: async () => ({
      online: 'all',
      profile: 'all',
      last: 'contacts',
      readreceipts: 'all',
      status: 'all',
      groupadd: 'all',
      calladd: 'all',
    }),
    profilePictureUrl: async () => 'https://example.com/pic.jpg',
    getBusinessProfile: async () => ({ description: 'Test Biz', category: 'Technology' }),
    fetchBlocklist: async () => ['254799999999@s.whatsapp.net'],
    groupInviteCode: async () => 'INVITE123',
    groupRevokeInvite: async () => 'NEWINVITE123',
    groupRequestParticipantsList: async () => [],
    groupFetchAllParticipating: async () => ({ '120363000000000001@g.us': { id: '120363000000000001@g.us' } }),
    groupCreate: async (name) => ({ id: '120363000000000099@g.us', subject: name }),
    waUploadToServer: async () => ({
      mediaUrl: 'https://mmg.whatsapp.net/test-media',
      directPath: '/v/test-media',
    }),
  };

  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async () => ({});
    },
  });
}

function makeCtx(name, {
  sock,
  from = '120363000000000000@g.us',
  sender = '254700000001@s.whatsapp.net',
  senderNumber = '254700000001',
  text = '',
  args = [],
  msg = null,
  isOwner = true,
  isGroupAdmin = true,
  isBotGroupAdmin = true,
  customConfig = null,
} = {}) {
  return {
    sock,
    from,
    sender,
    senderNumber,
    msg: msg || {
      key: { id: `in-${name}`, remoteJid: from, fromMe: true, participant: sender },
      pushName: 'TestUser',
      message: { conversation: text ? `.${name} ${text}` : `.${name}` },
    },
    args,
    text,
    commands: commandsMap,
    commandAliases: aliasesMap,
    config: customConfig || { ...config },
    global,
    isOwner,
    isGroupAdmin,
    isBotGroupAdmin,
    totalCommands: commandsMap.size,
  };
}

before(async () => {
  // Prevent warmHostingProviderCache() in spider/config.js from hitting live DNS/HTTPS during import
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/json'], ['content-length', '64']]),
    json: async () => ({
      status: true,
      success: true,
      result: 'https://example.com/media.mp4',
      data: { url: 'https://example.com/media.mp4' },
      answer: 'ok',
      definition: 'A test term',
      example: 'Usage example',
      fact: 'Water boils at 100C.',
      quote: 'Stay curious.',
      author: 'Tester',
      lyrics: 'Test lyrics line',
      title: 'Test Song',
    }),
    text: async () => '<html><title>Test</title></html>',
    arrayBuffer: async () => Buffer.from('mock-bytes').buffer,
  });

  // Unref background intervals opened by third-party packages on import (e.g. aptoide_scrapper_fixed)
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const handle = origSetInterval(...args);
    handle?.unref?.();
    return handle;
  };

  try {
    ({ reloadCommandsFromDisk } = await import('../../spider/utils/runtimeControl.js'));
    ({ loadLegacyCommands } = await import('../utils/legacyPlugins.js'));
    ({ handleMenuCategoryReply, sendMenuVisual } = await import('../commands/Menu.js'));
    ({ default: config } = await import('../../spider/config.js'));
    ({ securityStore } = await import('../../spider/utils/securityStore.js'));
    ({ MESSAGES } = await import('../france/index.js'));

    await reloadCommandsFromDisk({
      commandsDir: path.join(process.cwd(), 'Spider', 'commands'),
      commandsMap,
      aliasesMap,
      loadLegacyFn: loadLegacyCommands,
      pathToFileUrlFn: pathToFileURL,
      cacheBust: 999001,
    });
  } finally {
    globalThis.setInterval = origSetInterval;
  }
});

after(() => {
  globalThis.fetch = origFetch;
  axios.get = origAxiosGet;
  axios.post = origAxiosPost;
  axios.request = origAxiosRequest;
  if (origAxiosHead) axios.head = origAxiosHead;
  globalThis.__spiderCategoryMenuSessions?.clear?.();
});

test('all 189 commands and aliases load cleanly with valid metadata and handlers', () => {
  assert.ok(commandsMap.size >= 189, `Expected >= 189 commands, got ${commandsMap.size}`);
  assert.ok(aliasesMap.size > 0, 'Expected command aliases to be populated');

  for (const [name, cmd] of commandsMap.entries()) {
    assert.equal(typeof cmd.name, 'string', `Command ${name} missing string name`);
    assert.equal(cmd.name.toLowerCase(), name, `Command ${name} key mismatch`);
    assert.equal(typeof cmd.execute, 'function', `Command ${name} missing execute function`);
    if (cmd.aliases !== undefined) {
      assert.ok(Array.isArray(cmd.aliases), `Command ${name} aliases must be an array`);
    }
  }

  for (const [alias, target] of aliasesMap.entries()) {
    assert.ok(commandsMap.has(target), `Alias ${alias} points to missing command ${target}`);
  }
});

test('menu command and handleMenuCategoryReply work across ?reload= module boundaries', async () => {
  globalThis.__spiderCategoryMenuSessions?.clear?.();
  const sent = [];
  const sock = createMockSock(sent);
  const chatJid = '120363000000001234@g.us';

  const reloadedMenuCmd = commandsMap.get('menu');
  assert.ok(reloadedMenuCmd, 'menu command must be loaded');

  const menuReturn = await reloadedMenuCmd.execute(makeCtx('menu', { sock, from: chatJid }));
  assert.ok(sent.length >= 1, 'menu should send at least one message');
  const firstMenuMsgId = sent[0].id;
  assert.ok(firstMenuMsgId, 'menu message should have a key.id');
  assert.ok(menuReturn?.key?.id, 'menu execute should return last sent message');

  const combinedMenuText = sent
    .map((m) => m.payload.caption || m.payload.text || '')
    .join('\n');
  assert.match(combinedMenuText, /SYSTEM MENU/);
  assert.match(combinedMenuText, /COMMAND CATEGORIES/);
  assert.match(combinedMenuText, /GENERAL/);

  // 1. Quoted reply targeting menu message ID
  const replySent = [];
  const replySock = createMockSock(replySent);
  const handledQuoted = await handleMenuCategoryReply({
    sock: replySock,
    from: chatJid,
    sender: '254700000002@s.whatsapp.net',
    body: '1',
    msg: {
      key: { id: 'reply-1', remoteJid: chatJid, fromMe: false },
      message: {
        extendedTextMessage: {
          text: '1',
          contextInfo: { stanzaId: firstMenuMsgId },
        },
      },
    },
  });
  assert.equal(handledQuoted, true, 'quoted numeric reply to menu should be handled');
  assert.equal(replySent.length, 1);
  assert.match(replySent[0].payload.text, /\*SECTOR\*\s+›\s+01/);
  assert.match(replySent[0].payload.text, /commands/i);

  // 2. Quoted reply targeting continuation message ID (when menu splits >900 chars)
  if (sent.length > 1) {
    const contSent = [];
    const handledCont = await handleMenuCategoryReply({
      sock: createMockSock(contSent),
      from: chatJid,
      sender: '254700000002@s.whatsapp.net',
      body: '2',
      msg: {
        key: { id: 'reply-cont', remoteJid: chatJid, fromMe: false },
        message: {
          extendedTextMessage: {
            text: '2',
            contextInfo: { stanzaId: sent[sent.length - 1].id },
          },
        },
      },
    });
    assert.equal(handledCont, true, 'quoted numeric reply to continuation message should be handled');
    assert.equal(contSent.length, 1);
    assert.match(contSent[0].payload.text, /\*SECTOR\*\s+›\s+02/);
  }

  // 3. Unquoted numeric reply in the same chat
  const unquotedSent = [];
  const handledUnquoted = await handleMenuCategoryReply({
    sock: createMockSock(unquotedSent),
    from: chatJid,
    sender: '254700000002@s.whatsapp.net',
    body: '1',
    msg: {
      key: { id: 'reply-2', remoteJid: chatJid, fromMe: false },
      message: { conversation: '1' },
    },
  });
  assert.equal(handledUnquoted, true, 'unquoted numeric reply in active menu chat should be handled');
  assert.equal(unquotedSent.length, 1);

  // 4. Quoted numeric reply pointing to an unrelated stanzaId should NOT be hijacked
  const wrongStanzaSent = [];
  const handledWrongStanza = await handleMenuCategoryReply({
    sock: createMockSock(wrongStanzaSent),
    from: chatJid,
    sender: '254700000002@s.whatsapp.net',
    body: '1',
    msg: {
      key: { id: 'reply-3', remoteJid: chatJid, fromMe: false },
      message: {
        extendedTextMessage: {
          text: '1',
          contextInfo: { stanzaId: 'unrelated-msg-id' },
        },
      },
    },
  });
  assert.equal(handledWrongStanza, false);
  assert.equal(wrongStanzaSent.length, 0);

  // 5. Out-of-range numeric reply gives helpful bounds message and returns true
  const outOfRangeSent = [];
  const handledOutOfRange = await handleMenuCategoryReply({
    sock: createMockSock(outOfRangeSent),
    from: chatJid,
    sender: '254700000002@s.whatsapp.net',
    body: '999',
    msg: {
      key: { id: 'reply-4', remoteJid: chatJid, fromMe: false },
      message: { conversation: '999' },
    },
  });
  assert.equal(handledOutOfRange, true);
  assert.match(outOfRangeSent[0].payload.text, /Please reply with a category number from 1 to/);

  // 6. Non-numeric reply returns false
  const textSent = [];
  const handledText = await handleMenuCategoryReply({
    sock: createMockSock(textSent),
    from: chatJid,
    sender: '254700000002@s.whatsapp.net',
    body: 'hello',
    msg: {
      key: { id: 'reply-5', remoteJid: chatJid, fromMe: false },
      message: { conversation: 'hello' },
    },
  });
  assert.equal(handledText, false);
  assert.equal(textSent.length, 0);

  // 7. Reply in a different chat returns false
  const otherChatSent = [];
  const handledOtherChat = await handleMenuCategoryReply({
    sock: createMockSock(otherChatSent),
    from: '999999999@s.whatsapp.net',
    sender: '999999999@s.whatsapp.net',
    body: '1',
    msg: {
      key: { id: 'reply-6', remoteJid: '999999999@s.whatsapp.net', fromMe: false },
      message: { conversation: '1' },
    },
  });
  assert.equal(handledOtherChat, false);
  assert.equal(otherChatSent.length, 0);

  // 8. Expired session returns false
  const session = globalThis.__spiderCategoryMenuSessions.get(chatJid);
  session.expiresAt = Date.now() - 1000;
  const expiredSent = [];
  const handledExpired = await handleMenuCategoryReply({
    sock: createMockSock(expiredSent),
    from: chatJid,
    sender: '254700000002@s.whatsapp.net',
    body: '1',
    msg: {
      key: { id: 'reply-7', remoteJid: chatJid, fromMe: false },
      message: { conversation: '1' },
    },
  });
  assert.equal(handledExpired, false);
  assert.equal(expiredSent.length, 0);
});

test('menu direct selection, fallback image buffer, list/help/category/categories/findcmd commands work', async () => {
  // Remote image fails -> falls back to local spider-man.jpg buffer + continuation message
  const fallbackSent = [];
  const fallbackSock = createMockSock(fallbackSent, { failFirstImage: true });
  const longText = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} with enough padding to exceed 900 chars`).join('\n');
  const visualMsgs = await sendMenuVisual(fallbackSock, '254700000002@s.whatsapp.net', longText, { key: { id: 'q-1' } });
  assert.equal(visualMsgs.length, 2, 'long menu should send image+caption and continuation text');
  assert.ok(Buffer.isBuffer(fallbackSent[0].payload.image), 'should fall back to local Buffer image');
  assert.ok(fallbackSent[0].payload.caption.length <= 900, 'caption must stay within 900 chars');
  assert.ok(fallbackSent[1].payload.text.length > 0, 'continuation message should contain remaining lines');

  const sent = [];
  const sock = createMockSock(sent);
  const menuCmd = commandsMap.get('menu');

  await menuCmd.execute(makeCtx('menu', { sock, text: '1', args: ['1'] }));
  await menuCmd.execute(makeCtx('menu', { sock, text: 'general', args: ['general'] }));
  await menuCmd.execute(makeCtx('menu', { sock, text: '999', args: ['999'] }));
  await commandsMap.get('help').execute(makeCtx('help', { sock }));
  await commandsMap.get('categories').execute(makeCtx('categories', { sock }));
  await commandsMap.get('category').execute(makeCtx('category', { sock, text: 'general', args: ['general'] }));
  await commandsMap.get('category').execute(makeCtx('category', { sock, text: 'nonexistent', args: ['nonexistent'] }));
  await commandsMap.get('findcmd').execute(makeCtx('findcmd', { sock, text: 'list', args: ['list'] }));
  await commandsMap.get('findcmd').execute(makeCtx('findcmd', { sock, text: 'doesnotexist', args: ['doesnotexist'] }));

  assert.match(sent[0].payload.text, /\*SECTOR\*\s+›\s+01/);
  assert.match(sent[1].payload.text, /GENERAL/);
  assert.match(sent[2].payload.text, /Choose a category with/);
  assert.match(sent[3].payload.text, /COMMAND DIRECTORY/);
  assert.match(sent[4].payload.text, /CATEGORIES/i);
  assert.match(sent[5].payload.text, /GENERAL/);
  assert.match(sent[6].payload.text, /not found/i);
  assert.match(sent[7].payload.text, /Command Information/i);
  assert.match(sent[8].payload.text, /❌ Command "doesnotexist"/);
});

test('spider/index.js guards fromMe menu replies with botSentMessageIds', () => {
  const indexSource = fs.readFileSync(path.join(process.cwd(), 'spider', 'index.js'), 'utf8');
  assert.ok(indexSource.includes('botSentMessageIds'), 'spider/index.js should track botSentMessageIds');
  assert.ok(indexSource.includes('_0xrecordSent'), 'installBrandedResponseContext should record sent message IDs');
});

test('regression checks for fixed commands: exec-help, exec, sudo, alldl, eval, poll, trt', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-fixed-cmds-'));
  const origAllowedUsers = global.ALLOWED_USERS;
  const origBotPic = config.BOT_PIC;
  t.mock.method(process, 'cwd', () => tmpDir);

  try {
    const sent = [];
    const sock = createMockSock(sent);

    // 1. exec-help (previously crashed because MESSAGES.execHelp was undefined)
    await commandsMap.get('exec-help').execute(makeCtx('exec-help', { sock }));
    assert.equal(sent.at(-1).payload.text, MESSAGES.execHelp.info);

    // 2. exec with empty and safe echo command
    await commandsMap.get('exec').execute(makeCtx('exec', { sock, text: '' }));
    assert.equal(sent.at(-1).payload.text, MESSAGES.exec.noCommand);
    await commandsMap.get('exec').execute(makeCtx('exec', { sock, text: 'echo spider-exec-ok' }));
    assert.match(sent.at(-1).payload.text, /spider-exec-ok/);

    // 3. sudo with uninitialized global.ALLOWED_USERS (previously threw non-iterable error)
    global.ALLOWED_USERS = undefined;
    await commandsMap.get('sudo').execute(makeCtx('sudo', { sock, args: ['list'], text: 'list' }));
    assert.ok(global.ALLOWED_USERS instanceof Set);
    assert.equal(sent.at(-1).payload.text, MESSAGES.sudo.listEmpty);

    await commandsMap.get('sudo').execute(
      makeCtx('sudo', {
        sock,
        args: ['add'],
        text: 'add',
        msg: {
          key: { id: 'sudo-add', remoteJid: '120363000000000000@g.us', fromMe: true },
          message: {
            extendedTextMessage: {
              text: '.sudo add',
              contextInfo: { participant: '254711111111@s.whatsapp.net' },
            },
          },
        },
      }),
    );
    assert.equal(global.ALLOWED_USERS.has('254711111111'), true);

    await commandsMap.get('sudo').execute(makeCtx('sudo', { sock, args: ['list'], text: 'list' }));
    assert.match(sent.at(-1).payload.text, /\+254711111111/);

    // 4. alldl with object result { url }, { video }, { image }, string, and empty
    axios.get = async (_url, cfg) => {
      if (String(_url).includes('alldl') || String(_url).includes('download')) {
        return { status: 200, data: { status: true, result: { url: 'https://cdn.test/photo.png' } } };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: cfg?.responseType === 'arraybuffer' ? Buffer.from('ok') : { status: true, result: { url: 'https://cdn.test/photo.png' } },
      };
    };
    const alldlCmd = commandsMap.get('alldl');
    await alldlCmd.execute(makeCtx('alldl', { sock, text: '' }));
    assert.equal(sent.at(-1).payload.text, MESSAGES.alldl.noUrl);

    await alldlCmd.execute(makeCtx('alldl', { sock, text: 'https://instagram.com/p/test' }));
    assert.ok(
      sent.some((m) => m.payload.image?.url === 'https://cdn.test/photo.png' || m.payload.video?.url === 'https://cdn.test/photo.png'),
      'alldl should normalize object result into media url',
    );

    // 5. General.js eval (without globalThis.require), poll & trt with undefined text
    const origRequire = globalThis.require;
    delete globalThis.require;
    try {
      await commandsMap.get('eval').execute(makeCtx('eval', { sock, text: '({ sum: 2 + 3 })' }));
      assert.match(sent.at(-1).payload.text, /sum: 5/);
    } finally {
      globalThis.require = origRequire;
    }

    await commandsMap.get('poll').execute(makeCtx('poll', { sock, text: undefined }));
    assert.match(sent.at(-1).payload.text, /Usage:/);
    await commandsMap.get('poll').execute(makeCtx('poll', { sock, text: 'Best bot? / Spider Man, Other' }));
    assert.deepEqual(sent.at(-1).payload.poll.values, ['Spider Man', 'Other']);

    await commandsMap.get('trt').execute(makeCtx('trt', { sock, text: undefined }));
    assert.match(sent.at(-1).payload.text, /reply to the message/i);
  } finally {
    global.ALLOWED_USERS = origAllowedUsers;
    config.BOT_PIC = origBotPic;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('quoted media & interactive commands handle valid quoted inputs', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-quoted-cmds-'));
  const origOwner = config.OWNER_NUMBER;
  config.OWNER_NUMBER = '254700000001';
  t.mock.method(process, 'cwd', () => tmpDir);

  try {
    const sent = [];
    const sock = createMockSock(sent);
    const groupJid = '120363000000000000@g.us';

    // Save quoted text message
    await commandsMap.get('save').execute(
      makeCtx('save', {
        sock,
        from: groupJid,
        msg: {
          key: { id: 'q-save', remoteJid: groupJid, fromMe: true },
          message: {
            extendedTextMessage: {
              text: '.save',
              contextInfo: { quotedMessage: { conversation: 'Important note to save' } },
            },
          },
        },
      }),
    );
    assert.ok(sent.some((m) => m.jid === '254700000001@s.whatsapp.net' && m.payload.text === 'Important note to save'));

    // Details of quoted message
    await commandsMap.get('details').execute(
      makeCtx('details', {
        sock,
        from: groupJid,
        msg: {
          key: { id: 'q-details', remoteJid: groupJid, fromMe: true },
          message: {
            extendedTextMessage: {
              text: '.details',
              contextInfo: { quotedMessage: { conversation: 'Inspect me' } },
            },
          },
        },
      }),
    );
    assert.match(sent.at(-1).payload.text, /Inspect me/);

    // Location from quoted locationMessage
    await commandsMap.get('location').execute(
      makeCtx('location', {
        sock,
        from: groupJid,
        msg: {
          key: { id: 'q-loc', remoteJid: groupJid, fromMe: true },
          message: {
            extendedTextMessage: {
              text: '.location',
              contextInfo: {
                quotedMessage: {
                  locationMessage: { degreesLatitude: -1.2921, degreesLongitude: 36.8219 },
                },
              },
            },
          },
        },
      }),
    );
    assert.match(sent.at(-1).payload.text, /maps\.google\.com\/\?q=-1\.2921,36\.8219/);

    // vCard from quoted participant
    await commandsMap.get('vcard').execute(
      makeCtx('vcard', {
        sock,
        from: groupJid,
        text: 'Alice Spider',
        msg: {
          key: { id: 'q-vcard', remoteJid: groupJid, fromMe: true },
          message: {
            extendedTextMessage: {
              text: '.vcard Alice Spider',
              contextInfo: { participant: '254722222222@s.whatsapp.net' },
            },
          },
        },
      }),
    );
    assert.equal(sent.at(-1).payload.contacts.displayName, 'Alice Spider');
    assert.match(sent.at(-1).payload.contacts.contacts[0].vcard, /254722222222/);

    // Group status command with text payload
    await commandsMap.get('status').execute(
      makeCtx('status', { sock, from: groupJid, text: 'Status announcement' }),
    );
    assert.match(sent.at(-1).payload.text, /sent to group status/i);

    // Ensure Jimp image processing pipeline works cleanly
    const img = new Jimp({ width: 4, height: 4, color: 0xff0000ff });
    const imgBuffer = await img.getBuffer('image/jpeg');
    assert.ok(Buffer.isBuffer(imgBuffer) && imgBuffer.length > 0);
  } finally {
    config.OWNER_NUMBER = origOwner;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('all 189 commands execute safely without throwing uncaught exceptions', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-all-cmds-'));
  const origMode = config.MODE;
  const origProcessMode = process.env.MODE;
  const origAdminProt = config.ADMIN_PROTECTION;
  const origAntiDelete = config.ANTIDELETE;
  const origAntiEdit = config.ANTIEDIT;
  const origAutoView = config.AUTO_VIEW;
  const origAutoLike = config.AUTO_LIKE;
  const origAllowedUsers = global.ALLOWED_USERS;
  const origSetTimeout = globalThis.setTimeout;

  t.mock.method(process, 'cwd', () => tmpDir);
  t.mock.method(process, 'exit', () => {});

  // Accelerate intentional delay() loops (hack, trivia, flip, online, kickall) and mock HTTP
  const safeSetTimeout = (fn, ms, ...rest) => origSetTimeout(fn, Math.min(Number(ms) || 0, 5), ...rest);
  globalThis.setTimeout = safeSetTimeout;

  axios.get = async (_url, cfg) => ({
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': '128' },
    data: cfg?.responseType === 'arraybuffer'
      ? Buffer.from('test-bytes')
      : { status: true, success: true, result: 'https://example.com/ok', data: 'ok' },
  });
  axios.post = async (_url, _body, cfg) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: cfg?.responseType === 'arraybuffer'
      ? Buffer.from('test-bytes')
      : { status: true, success: true, result: 'ok' },
  });
  axios.request = async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: { status: true, success: true, result: 'ok' },
  });

  // Commands that invoke external unmockable packages (yt-search/mumaker/aptoide/node-fetch) when given an argument
  const externalArgCommands = new Set([
    'gpt', 'tgs', 'apk', 'fact', 'play', 'playlist', 'ytmp3', 'ytmp4', 'song',
    'hacker', 'dragonball', 'naruto', 'sand', 'sunset', 'chocolate', 'mechanical',
    'rain', 'cloth', 'water', '1917', 'graffiti', 'boom', 'cat', 'purple', 'gold',
    'arena', 'incandescent', 'child', 'typo', 'light', 'steel', 'sunlight',
    'frozen', 'leaves', 'night', 'video', 'gitclone', 'imgur', 'tinyurl', 'mediafire',
  ]);
  // Commands that would mutate workspace or trigger external side effects if given active args
  const noArgOnlyCommands = new Set([
    'restart', 'restartbot', 'shutdown', 'kill', 'update', 'triggerupdate',
    'exec', 'eval', 'eval2', 'broadcast', 'bc', 'kickall', 'purge', 'left', 'zip',
  ]);

  const failures = [];
  try {
    const sent = [];
    const sock = createMockSock(sent);

    // 1. No-arg pass across all 189 commands
    await Promise.all([...commandsMap.entries()].map(async ([name, cmd]) => {
      if (['restart', 'restartbot', 'shutdown', 'kill', 'update', 'triggerupdate', 'exec', 'zip'].includes(name)) {
        return;
      }
      try {
        await Promise.race([
          cmd.execute(makeCtx(name, { sock, text: '', args: [] })),
          new Promise((_, rej) => origSetTimeout(() => rej(new Error('No-arg timeout')), 2000)),
        ]);
      } catch (err) {
        failures.push(`no-arg ${name}: ${err?.message || String(err)}`);
      }
    }));

    // 2. Safe sample-arg pass across commands that do not stall on unmocked network packages
    await Promise.all([...commandsMap.entries()].map(async ([name, cmd]) => {
      if (externalArgCommands.has(name) || noArgOnlyCommands.has(name)) {
        return;
      }
      const text =
        name === 'poll' ? 'Test?/Yes,No'
        : name === 'math' ? '2+2'
        : name === 'mod' ? 'status'
        : name === 'lockdown' ? 'status'
        : name === 'sudo' ? 'list'
        : name === 'language' || name === 'lang' || name === 'setlang' ? 'en'
        : name === 'country' ? 'Kenya'
        : '1';
      try {
        await Promise.race([
          cmd.execute(makeCtx(name, { sock, text, args: text.split(/\s+/) })),
          new Promise((_, rej) => origSetTimeout(() => rej(new Error('Sample-arg timeout')), 2000)),
        ]);
      } catch (err) {
        failures.push(`sample-arg ${name}: ${err?.message || String(err)}`);
      }
    }));

    assert.deepEqual(failures, [], `Unexpected command failures:\n${failures.join('\n')}`);
    assert.ok(sent.length > 50, 'Expected commands to send responses through sock');
  } finally {
    globalThis.setTimeout = origSetTimeout;
    config.MODE = origMode;
    if (origProcessMode === undefined) delete process.env.MODE;
    else process.env.MODE = origProcessMode;
    config.ADMIN_PROTECTION = origAdminProt;
    config.ANTIDELETE = origAntiDelete;
    config.ANTIEDIT = origAntiEdit;
    config.AUTO_VIEW = origAutoView;
    config.AUTO_LIKE = origAutoLike;
    global.ALLOWED_USERS = origAllowedUsers;
    securityStore.setLockdown(false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
