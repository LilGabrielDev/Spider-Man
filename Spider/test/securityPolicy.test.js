import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCommandRateLimiter,
  isOwnerOnlyDenied,
} from '../../spider/utils/securityPolicy.js';

test('owner-only policy denies non-owners but permits owners and public commands', () => {
  assert.equal(isOwnerOnlyDenied({ ownerOnly: true }, false), true);
  assert.equal(isOwnerOnlyDenied({ ownerOnly: true }, true), false);
  assert.equal(isOwnerOnlyDenied({ ownerOnly: false }, false), false);
  assert.equal(isOwnerOnlyDenied({}, false), false);
  assert.equal(isOwnerOnlyDenied(null, false), false);
});

test('sliding window keeps sender budgets separate and expires at the boundary', () => {
  let currentTime = 1_000;
  const limiter = createCommandRateLimiter({
    limit: 1,
    windowMs: 1_000,
    now: () => currentTime,
  });

  assert.equal(limiter.allow('sender-a'), true);
  assert.equal(limiter.allow('sender-a'), false);
  assert.equal(limiter.allow('sender-b'), true);

  currentTime = 1_999;
  assert.equal(limiter.allow('sender-a'), false);
  currentTime = 2_000;
  assert.equal(limiter.allow('sender-a'), true);
});

test('default rate limit allows eight calls per sender in the configured window', () => {
  const limiter = createCommandRateLimiter({ now: () => 1_000 });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal(limiter.allow('sender-a'), true);
  }
  assert.equal(limiter.allow('sender-a'), false);
});

test('invalid limits and non-positive or non-finite windows are rejected', () => {
  for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createCommandRateLimiter({ limit }),
      { name: 'RangeError' },
    );
  }

  for (const windowMs of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.throws(
      () => createCommandRateLimiter({ windowMs }),
      { name: 'RangeError' },
    );
  }
});

test('invalid clock configuration and non-finite clock readings fail explicitly', () => {
  assert.throws(
    () => createCommandRateLimiter({ now: 1_000 }),
    { name: 'TypeError' },
  );

  for (const clockValue of [Number.NaN, Number.POSITIVE_INFINITY, '1000']) {
    const limiter = createCommandRateLimiter({ now: () => clockValue });
    assert.throws(() => limiter.allow('sender-a'), { name: 'RangeError' });
  }
});

test('clock rollback does not reset or bypass a sender rate limit', () => {
  let currentTime = 1_000;
  const limiter = createCommandRateLimiter({
    limit: 1,
    windowMs: 1_000,
    now: () => currentTime,
  });

  assert.equal(limiter.allow('sender-a'), true);
  currentTime = 0;
  assert.equal(limiter.allow('sender-a'), false);
  currentTime = 2_000;
  assert.equal(limiter.allow('sender-a'), true);
});
