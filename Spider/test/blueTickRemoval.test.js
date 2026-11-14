import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createQuotedContact } from '../france/utils.js';

function extractBalancedFunction(src, name) {
  const idx = src.indexOf(`function ${name}`);
  if (idx === -1) throw new Error(`Function ${name} not found`);
  let depth = 0;
  let i = src.indexOf('{', idx);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(idx, i + 1);
    }
  }
  throw new Error(`Unbalanced braces for ${name}`);
}

test('spider/index.js installBrandedResponseContext removes the 0@s.whatsapp.net Meta blue tick quote and preserves real quotes', async () => {
  const indexSrc = fs.readFileSync(path.resolve(process.cwd(), 'spider/index.js'), 'utf8');
  const fnSrc = extractBalancedFunction(indexSrc, 'installBrandedResponseContext');

  assert.doesNotMatch(fnSrc, /escapeVCardField|getVCardPhotoBase64|_0x4114c0|VERIFIED_LABEL/);
  assert.doesNotMatch(indexSrc, /function getVCardPhotoBase64|function escapeVCardField/);
  assert.ok(fnSrc.includes('_0xrecordSent'), 'botSentMessageIds recorder must remain intact');

  // Evaluate the string tables + installBrandedResponseContext in a VM to test runtime behavior directly
  const iifeSrc = indexSrc.slice(indexSrc.indexOf('(function('), indexSrc.indexOf('const _0x463425'));
  const sentCalls = [];
  const recordedIds = new Set();

  const ctx = {
    Set,
    Object,
    Array,
    Buffer,
    String,
    console,
    parseInt,
    a0_0x46d183: { BOT_NAME: 'Spider Man', CHANNEL_URL: '' },
    botSentMessageIds: recordedIds,
  };

  const vmScript = [
    extractBalancedFunction(indexSrc, 'a0_0x3e57'),
    extractBalancedFunction(indexSrc, 'a0_0xea19'),
    'const a0_0x377309 = a0_0xea19;',
    iifeSrc,
    extractBalancedFunction(indexSrc, '_0x5e48'),
    extractBalancedFunction(indexSrc, '_0x21a6'),
    'const _0x463425 = _0x21a6;',
    fnSrc,
    'this.installBrandedResponseContext = installBrandedResponseContext;',
  ].join('\n');

  vm.runInNewContext(vmScript, ctx);

  const mockSock = {
    sendMessage: async (jid, payload, options) => {
      sentCalls.push({ jid, payload, options });
      return { key: { id: `msg-${sentCalls.length}`, remoteJid: jid, fromMe: true } };
    },
  };

  ctx.installBrandedResponseContext(mockSock);

  // 1. Call without quoted option: must NOT inject any fake 0@s.whatsapp.net quote
  await mockSock.sendMessage('120363000000000001@g.us', { text: 'Hello' });
  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].options?.quoted, undefined);
  assert.ok(recordedIds.has('msg-1'));

  // 2. Call with a real user message quote: must preserve the caller's quoted message
  const userMsg = { key: { id: 'user-msg-9', remoteJid: '120363000000000001@g.us', fromMe: false } };
  await mockSock.sendMessage('120363000000000001@g.us', { text: 'Reply' }, { quoted: userMsg });
  assert.equal(sentCalls.length, 2);
  assert.equal(sentCalls[1].options.quoted, userMsg);
  assert.ok(recordedIds.has('msg-2'));

  // 3. Blank forwardedNewsletterMessageInfo / businessMessageForwardInfo still gets stripped
  await mockSock.sendMessage(
    '120363000000000001@g.us',
    {
      text: 'Cleaned',
      contextInfo: {
        isForwarded: true,
        forwardingScore: 1,
        forwardedNewsletterMessageInfo: { newsletterJid: '', newsletterName: 'Spider Man' },
        businessMessageForwardInfo: { businessOwnerJid: '' },
      },
    },
    { quoted: userMsg },
  );
  assert.equal(sentCalls[2].payload.contextInfo, undefined);
  assert.equal(sentCalls[2].options.quoted, userMsg);
});

test('Spider/france/utils.js createQuotedContact and legacy commandHandler do not emit 0@s.whatsapp.net blue ticks', () => {
  assert.equal(createQuotedContact(), undefined);

  const cmdHandlerPath = path.resolve(process.cwd(), 'Spider/legacy/lil/connection/commandHandler.js');
  const cmdHandlerSrc = fs.readFileSync(cmdHandlerPath, 'utf8');
  assert.doesNotMatch(cmdHandlerSrc, /0@s\.whatsapp\.net/);
  assert.doesNotMatch(cmdHandlerSrc, /WhatsApp Business/);

  const createHelpersStart = cmdHandlerSrc.indexOf('const createHelpers=');
  const getGroupInfoStart = cmdHandlerSrc.indexOf('const getGroupInfo=');
  assert.ok(createHelpersStart !== -1 && getGroupInfoStart > createHelpersStart);

  const ctx = { console };
  vm.runInNewContext(
    [
      extractBalancedFunction(cmdHandlerSrc, '_0x4185'),
      extractBalancedFunction(cmdHandlerSrc, '_0x1733'),
      'const _0x203a31 = _0x4185;',
      cmdHandlerSrc.slice(createHelpersStart, getGroupInfoStart),
      'this.createHelpers = createHelpers;',
    ].join('\n'),
    ctx,
  );

  const sent = [];
  const fakeMsg = { key: { id: 'real-in-1', remoteJid: '12345@s.whatsapp.net', fromMe: false } };
  const helpers = ctx.createHelpers(
    { sendMessage: async (jid, payload, opts) => sent.push({ jid, payload, opts }) },
    fakeMsg,
    '12345@s.whatsapp.net',
  );
  helpers.reply('ok');
  assert.equal(sent[0].opts.quoted, fakeMsg);
});
