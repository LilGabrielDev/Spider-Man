const DEFAULT_LIMIT = 8;
const DEFAULT_WINDOW_MS = 10_000;

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
 * consume another sender's allowance.
 */
export function createCommandRateLimiter({
  limit = DEFAULT_LIMIT,
  windowMs = DEFAULT_WINDOW_MS,
  now = Date.now,
} = {}) {
  const maxCalls = Math.max(0, Math.floor(Number(limit) || 0));
  const duration = Math.max(0, Number(windowMs) || 0);
  const timestampsBySender = new Map();

  return {
    allow(sender) {
      const key = String(sender ?? '');
      const currentTime = Number(now());
      const windowStart = currentTime - duration;
      const timestamps = timestampsBySender.get(key) ?? [];

      while (timestamps.length > 0 && timestamps[0] <= windowStart) {
        timestamps.shift();
      }

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
