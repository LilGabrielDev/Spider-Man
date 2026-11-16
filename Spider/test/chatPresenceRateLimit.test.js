import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createCommandRateLimiter } from '../../spider/utils/securityPolicy.js';
import { getSenderPhone } from '../../spider/utils/userJid.js';

const runtimeSource = fs.readFileSync(
  new URL('../../spider/index.js', import.meta.url),
  'utf8',
);

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `Missing runtime function: ${signature}`);
  const openBrace = source.indexOf('{', start + signature.length);
  assert.notEqual(openBrace, -1, `Missing function body: ${signature}`);
  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`Unclosed runtime function: ${signature}`);
}

test('chat-presence clear replacement ignores an earlier callback after newer activity', () => {
  const scheduled = [];
  const cleared = [];
  const calls = [];
  const context = {
    chatPresenceClearTimers: new Map(),
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      cleared.push(timer);
    },
    clearChatPresence(chat) {
      calls.push(chat);
    },
  };
  const helper = extractFunction(
    runtimeSource,
    'function scheduleChatPresenceClear(',
  );
  const scheduleChatPresenceClear = vm.runInNewContext(
    `${helper}; scheduleChatPresenceClear`,
    context,
  );

  scheduleChatPresenceClear('chat-a', 5000);
  scheduleChatPresenceClear('chat-a', 5000);
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[0].delay, 5000);
  assert.deepEqual(cleared, [scheduled[0]]);

  // Exercise the cancelled callback too: if it was already queued, its identity
  // check must still prevent it from clearing the newer activity timer.
  scheduled[0].callback();
  assert.deepEqual(calls, []);
  scheduled[1].callback();
  assert.deepEqual(calls, ['chat-a']);
  assert.equal(context.chatPresenceClearTimers.has('chat-a'), false);
  assert.equal(
    (runtimeSource.match(/scheduleChatPresenceClear\(_0x4f69ff,0x1388\)/g) || []).length,
    11,
    'all delayed chat-presence clears must use the tracked replacement helper',
  );
  assert.doesNotMatch(runtimeSource, /setTimeout\(\(\)=>clearChatPresence\(/);
});

test('alternating PN and mapped LID forms share one command rate-limit budget', () => {
  const pn = '254712345678@s.whatsapp.net';
  const lid = '123456789012345@lid';
  const lidToPhoneMap = new Map([[lid, pn]]);
  const pnIdentity = getSenderPhone(pn, lidToPhoneMap);
  const lidIdentity = getSenderPhone(lid, lidToPhoneMap);
  assert.equal(pnIdentity, '254712345678');
  assert.equal(lidIdentity, pnIdentity);

  const limiter = createCommandRateLimiter({ limit: 1, windowMs: 10_000, now: () => 1_000 });
  assert.equal(limiter.allow(pnIdentity), true);
  assert.equal(limiter.allow(lidIdentity), false);

  assert.match(
    runtimeSource,
    /commandRateLimiter\[_0x399b90\(0x1f0\)\]\(_0x2bf134\|\|_0x194d28\)/,
    'runtime must key by the mapped canonical sender phone and fall back to raw sender identity',
  );
});

test('setChatPresence and clearChatPresence clear temporary available presence back to unavailable', async () => {
  const sentPresence = [];
  const presenceTimers = new Map();
  const scheduledTimeouts = [];
  const context = {
    presenceTimers,
    availablePresenceChats: new Set(),
    a0_0x46d183: {
      ALWAYS_ONLINE: false,
      DM_PRESENCE: 'online',
      GRP_PRESENCE: 'typing',
    },
    shouldShowPresence: () => true,
    getPresenceType: (isGroup) => (isGroup ? 'composing' : 'available'),
    updatePresence: async (jid, type) => {
      sentPresence.push({ jid, type });
    },
    a0_0x377309: (idx) => ({
      0x20e: 'has',
      0x231: 'get',
      0x18d: 'delete',
      0x1ba: 'paused',
    })[idx],
    _0x21a6: (idx) => ({
      0x2e: 'paused',
    })[idx],
    _0x463425: (idx) => ({
      0xb: 'get',
    })[idx],
    setTimeout(fn, delay) {
      const handle = { fn, delay };
      scheduledTimeouts.push(handle);
      return handle;
    },
    clearTimeout() {},
    Set,
  };

  const setFn = extractFunction(runtimeSource, 'async function setChatPresence(');
  const clearFn = extractFunction(runtimeSource, 'async function clearChatPresence(');
  const { setChatPresence, clearChatPresence } = vm.runInNewContext(
    `${setFn}\n${clearFn}\n({ setChatPresence, clearChatPresence })`,
    context,
  );

  // DM_PRESENCE='online' -> sends 'available', then clearing sends 'unavailable' (not 'paused')
  await setChatPresence('254700000001@s.whatsapp.net', false);
  await clearChatPresence('254700000001@s.whatsapp.net');
  assert.deepEqual(sentPresence, [
    { jid: '254700000001@s.whatsapp.net', type: 'available' },
    { jid: '254700000001@s.whatsapp.net', type: 'unavailable' },
  ]);

  // Timeout callback on 'available' also returns presence to 'unavailable'
  sentPresence.length = 0;
  scheduledTimeouts.length = 0;
  await setChatPresence('254700000002@s.whatsapp.net', false);
  await scheduledTimeouts[0].fn();
  assert.deepEqual(sentPresence, [
    { jid: '254700000002@s.whatsapp.net', type: 'available' },
    { jid: '254700000002@s.whatsapp.net', type: 'unavailable' },
  ]);

  // Group 'typing' ('composing') clears with 'paused'
  sentPresence.length = 0;
  await setChatPresence('120363000000000001@g.us', true);
  await clearChatPresence('120363000000000001@g.us');
  assert.deepEqual(sentPresence, [
    { jid: '120363000000000001@g.us', type: 'composing' },
    { jid: '120363000000000001@g.us', type: 'paused' },
  ]);
});
