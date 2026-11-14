const DEFAULT_LIMIT = 8;
const DEFAULT_WINDOW_MS = 10_000;
const CLEANUP_INTERVAL = 128;

/**
 * Returns true when a command is restricted to owners and the current sender
 * is not an owner.
 */
export function isOwnerOnlyDenied(command, isOwner) {
  return Boolean(command?.ownerOnly) && !Boolean(isOwner);
}

/**
 * Create a per-sender sliding-window rate limiter.
 *
 * `now` is injectable to keep tests deterministic. Calls for one sender do not
 * consume another sender's allowance. Expired sender state is periodically
 * pruned so the map does not retain every sender seen during the process life.
 */
export function createCommandRateLimiter(options = {}) {
  const {
    limit = DEFAULT_LIMIT,
    windowMs = DEFAULT_WINDOW_MS,
    now = Date.now,
  } = options ?? {};

  const maxCalls = Number(limit);
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) {
    throw new RangeError('limit must be a non-negative safe integer.');
  }

  const duration = Number(windowMs);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RangeError('windowMs must be a positive finite number.');
  }

  if (typeof now !== 'function') {
    throw new TypeError('now must be a function.');
  }

  const timestampsBySender = new Map();
  let callsSinceCleanup = 0;
  let lastObservedTime = Number.NEGATIVE_INFINITY;

  function removeExpiredTimestamps(timestamps, windowStart) {
    let expiredCount = 0;
    while (
      expiredCount < timestamps.length &&
      timestamps[expiredCount] <= windowStart
    ) {
      expiredCount += 1;
    }
    if (expiredCount > 0) timestamps.splice(0, expiredCount);
  }

  function pruneExpiredSenders(windowStart) {
    for (const [sender, timestamps] of timestampsBySender) {
      removeExpiredTimestamps(timestamps, windowStart);
      if (timestamps.length === 0) timestampsBySender.delete(sender);
    }
  }

  return {
    allow(sender) {
      const rawTime = now();
      if (typeof rawTime !== 'number' || !Number.isFinite(rawTime)) {
        throw new RangeError('now() must return a finite number.');
      }

      // Clamp clock rollbacks so timestamps remain ordered and the limiter
      // fails closed until wall-clock time catches up.
      const currentTime = Math.max(rawTime, lastObservedTime);
      lastObservedTime = currentTime;
      const windowStart = currentTime - duration;

      callsSinceCleanup += 1;
      if (callsSinceCleanup >= CLEANUP_INTERVAL) {
        pruneExpiredSenders(windowStart);
        callsSinceCleanup = 0;
      }

      const key = String(sender ?? '');
      const timestamps = timestampsBySender.get(key) ?? [];
      removeExpiredTimestamps(timestamps, windowStart);

      if (timestamps.length >= maxCalls) {
        if (timestamps.length === 0) timestampsBySender.delete(key);
        else timestampsBySender.set(key, timestamps);
        return false;
      }

      timestamps.push(currentTime);
      timestampsBySender.set(key, timestamps);
      return true;
    },
  };
}
