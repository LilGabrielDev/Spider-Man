const pacersBySocket = new WeakMap();

export const DEFAULT_OUTBOUND_MIN_INTERVAL_MS = 350;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getOutboundPacer(sock, minIntervalMs = DEFAULT_OUTBOUND_MIN_INTERVAL_MS) {
  if (!sock || typeof sock !== 'object') {
    throw new TypeError('A socket object is required.');
  }

  const existing = pacersBySocket.get(sock);
  if (existing) return existing;

  const interval = Number.isFinite(Number(minIntervalMs))
    ? Math.max(0, Math.floor(Number(minIntervalMs)))
    : DEFAULT_OUTBOUND_MIN_INTERVAL_MS;
  let tail = Promise.resolve();
  let nextAllowedAt = 0;

  const pacer = {
    run(operation) {
      if (typeof operation !== 'function') {
        return Promise.reject(new TypeError('A pacing operation is required.'));
      }

      const task = tail.catch(() => {}).then(async () => {
        const waitMs = Math.max(0, nextAllowedAt - Date.now());
        if (waitMs > 0) await sleep(waitMs);
        nextAllowedAt = Date.now() + interval;
        return operation();
      });
      tail = task.catch(() => {});
      return task;
    },
  };

  pacersBySocket.set(sock, pacer);
  return pacer;
}

export function resetOutboundPacer(sock) {
  if (!sock || typeof sock !== 'object') return false;
  return pacersBySocket.delete(sock);
}
