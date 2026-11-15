export const DEFAULT_DISCONNECT_REASONS = {
  connectionClosed: 428,
  connectionLost: 408,
  connectionReplaced: 440,
  timedOut: 408,
  loggedOut: 401,
  temporaryBan: 402,
  forbidden: 403,
  banned: 406,
  badSession: 500,
  unavailableService: 503,
  restartRequired: 515,
  multideviceMismatch: 411,
  sessionInvalidated: 516,
};

export function classifyDisconnect(
  statusCode,
  { attempt = 1, badSessionRetries = 0, replacedRetries = 0, baseDelayMs = 2_000, maxDelayMs = 30_000 } = {},
) {
  const code = statusCode !== undefined && statusCode !== null ? Number(statusCode) : NaN;

  if (code === DEFAULT_DISCONNECT_REASONS.restartRequired) {
    return {
      reasonLabel: 'Restart Required',
      shouldReconnect: true,
      fatal: false,
      delayMs: 1_000,
      kind: 'restartRequired',
    };
  }

  if (
    code === DEFAULT_DISCONNECT_REASONS.loggedOut ||
    code === DEFAULT_DISCONNECT_REASONS.temporaryBan ||
    code === DEFAULT_DISCONNECT_REASONS.forbidden ||
    code === DEFAULT_DISCONNECT_REASONS.banned ||
    code === DEFAULT_DISCONNECT_REASONS.multideviceMismatch ||
    code === DEFAULT_DISCONNECT_REASONS.sessionInvalidated
  ) {
    return {
      reasonLabel: `Session Terminated (${code})`,
      shouldReconnect: false,
      fatal: true,
      delayMs: 0,
      kind: 'fatalAuth',
    };
  }

  if (code === DEFAULT_DISCONNECT_REASONS.connectionReplaced) {
    const allowed = replacedRetries < 2;
    return {
      reasonLabel: 'Connection Replaced (440)',
      shouldReconnect: allowed,
      fatal: !allowed,
      delayMs: allowed ? 30_000 : 0,
      kind: 'connectionReplaced',
    };
  }

  if (code === DEFAULT_DISCONNECT_REASONS.badSession) {
    const allowed = badSessionRetries < 2;
    return {
      reasonLabel: 'Bad Session (500)',
      shouldReconnect: allowed,
      fatal: !allowed,
      delayMs: allowed ? 15_000 : 0,
      kind: 'badSession',
    };
  }

  let reasonLabel = 'Unknown';
  if (code === DEFAULT_DISCONNECT_REASONS.connectionClosed) {
    reasonLabel = 'Connection Closed';
  } else if (code === DEFAULT_DISCONNECT_REASONS.connectionLost || code === DEFAULT_DISCONNECT_REASONS.timedOut) {
    reasonLabel = 'Connection Lost / Timed Out';
  } else if (code === DEFAULT_DISCONNECT_REASONS.unavailableService) {
    reasonLabel = 'Service Unavailable (503)';
  } else if (Number.isFinite(code)) {
    reasonLabel = `Disconnected (${code})`;
  }

  const exp = Math.min(Math.max(0, attempt - 1), 5);
  const rawDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** exp);
  const jitter = Math.floor(Math.random() * Math.min(1_000, Math.max(250, rawDelay * 0.15)));
  return {
    reasonLabel,
    shouldReconnect: true,
    fatal: false,
    delayMs: rawDelay + jitter,
    kind: 'transient',
  };
}

export async function safeTeardownSocket(sock, { flushStores = null, timeoutMs = 1_500 } = {}) {
  const flushWork = async () => {
    if (typeof flushStores === 'function') {
      await flushStores();
    }
  };

  if (typeof flushStores === 'function') {
    await Promise.race([
      flushWork().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ]);
  }

  if (!sock || typeof sock !== 'object') return;

  try {
    sock.end?.();
  } catch {}
  try {
    sock.ws?.close?.();
  } catch {}
  try {
    sock.ev?.removeAllListeners?.();
  } catch {}
}

export function createConnectionController({
  createSocket,
  flushStores = null,
  onFatalDisconnect = null,
  onReconnectScheduled = null,
  onStartError = null,
  baseDelayMs = 2_000,
  maxDelayMs = 30_000,
  stableConnectionMs = 15_000,
} = {}) {
  if (typeof createSocket !== 'function') {
    throw new TypeError('createSocket callback is required');
  }

  let generation = 0;
  let activeSock = null;
  let startInFlight = null;
  let reconnectTimer = null;
  let stableTimer = null;
  let shuttingDown = false;
  let attempt = 0;
  let badSessionRetries = 0;
  let replacedRetries = 0;

  function clearTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
  }

  function isCurrent(gen) {
    return !shuttingDown && gen === generation;
  }

  function getActiveSocket() {
    return activeSock;
  }

  function getGeneration() {
    return generation;
  }

  function markConnected(gen) {
    if (!isCurrent(gen)) return false;
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      if (isCurrent(gen)) {
        attempt = 0;
        badSessionRetries = 0;
        replacedRetries = 0;
      }
    }, stableConnectionMs);
    stableTimer.unref?.();
    return true;
  }

  function scheduleReconnect(delayMs, reasonInfo) {
    if (shuttingDown || reconnectTimer) return false;
    onReconnectScheduled?.({
      ...reasonInfo,
      attempt,
      delaySeconds: Math.max(1, Math.round(delayMs / 1000)),
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!shuttingDown) {
        void start();
      }
    }, delayMs);
    reconnectTimer.unref?.();
    return true;
  }

  async function handleDisconnect({ generation: gen, statusCode, error } = {}) {
    if (!isCurrent(gen)) return { ignored: true };
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }

    attempt += 1;
    const info = classifyDisconnect(statusCode, {
      attempt,
      badSessionRetries,
      replacedRetries,
      baseDelayMs,
      maxDelayMs,
    });

    if (info.kind === 'badSession') badSessionRetries += 1;
    if (info.kind === 'connectionReplaced') replacedRetries += 1;

    if (!info.shouldReconnect) {
      clearTimers();
      const sockToClose = activeSock;
      activeSock = null;
      generation += 1;
      await safeTeardownSocket(sockToClose, { flushStores });
      onFatalDisconnect?.({ ...info, statusCode, error });
      return { ...info, ignored: false };
    }

    scheduleReconnect(info.delayMs, info);
    return { ...info, ignored: false };
  }

  async function start() {
    if (shuttingDown) return null;
    if (startInFlight) {
      return startInFlight;
    }

    clearTimers();
    const nextGen = ++generation;
    const prevSock = activeSock;
    activeSock = null;

    const run = (async () => {
      if (prevSock) {
        await safeTeardownSocket(prevSock, { flushStores });
      }
      if (shuttingDown || nextGen !== generation) {
        return null;
      }

      try {
        const sock = await createSocket({
          generation: nextGen,
          isCurrent: () => isCurrent(nextGen),
        });
        if (shuttingDown || nextGen !== generation) {
          await safeTeardownSocket(sock, { flushStores });
          return null;
        }
        activeSock = sock;
        return sock;
      } catch (err) {
        if (shuttingDown || nextGen !== generation) {
          return null;
        }
        attempt += 1;
        const info = classifyDisconnect(undefined, {
          attempt,
          baseDelayMs,
          maxDelayMs,
        });
        onStartError?.(err, info);
        scheduleReconnect(info.delayMs, info);
        return null;
      }
    })();

    startInFlight = run;
    try {
      return await run;
    } finally {
      if (startInFlight === run) {
        startInFlight = null;
      }
    }
  }

  async function shutdown() {
    shuttingDown = true;
    clearTimers();
    const sockToClose = activeSock;
    activeSock = null;
    generation += 1;
    await safeTeardownSocket(sockToClose, { flushStores });
  }

  return {
    start,
    shutdown,
    handleDisconnect,
    markConnected,
    isCurrent,
    getActiveSocket,
    getGeneration,
  };
}
