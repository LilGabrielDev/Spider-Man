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
