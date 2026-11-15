import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDisconnect,
  createConnectionController,
  safeTeardownSocket,
} from '../../spider/utils/connectionManager.js';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('classifyDisconnect distinguishes 515 restartRequired, fatal auth codes, slow retries, and transient backoff', () => {
  const r515 = classifyDisconnect(515, { attempt: 3 });
  assert.equal(r515.kind, 'restartRequired');
  assert.equal(r515.shouldReconnect, true);
  assert.equal(r515.delayMs, 1000);

  for (const fatalCode of [401, 402, 403, 406, 411, 516]) {
    const res = classifyDisconnect(fatalCode, { attempt: 1 });
    assert.equal(res.shouldReconnect, false, `code ${fatalCode} must not auto-reconnect`);
    assert.equal(res.fatal, true);
  }

  const r440First = classifyDisconnect(440, { replacedRetries: 0 });
  assert.equal(r440First.shouldReconnect, true);
  assert.equal(r440First.delayMs, 30_000);
  const r440Exhausted = classifyDisconnect(440, { replacedRetries: 2 });
  assert.equal(r440Exhausted.shouldReconnect, false);

  const r500First = classifyDisconnect(500, { badSessionRetries: 0 });
  assert.equal(r500First.shouldReconnect, true);
  assert.equal(r500First.delayMs, 15_000);
  const r500Exhausted = classifyDisconnect(500, { badSessionRetries: 2 });
  assert.equal(r500Exhausted.shouldReconnect, false);

  const t1 = classifyDisconnect(408, { attempt: 1, baseDelayMs: 2_000, maxDelayMs: 30_000 });
  const t3 = classifyDisconnect(428, { attempt: 3, baseDelayMs: 2_000, maxDelayMs: 30_000 });
  assert.equal(t1.shouldReconnect, true);
  assert.ok(t1.delayMs >= 2_000 && t1.delayMs < 3_000);
  assert.ok(t3.delayMs >= 8_000 && t3.delayMs < 9_500);
});

test('safeTeardownSocket flushes stores before closing and removing socket listeners', async () => {
  const order = [];
  const fakeSock = {
    end: () => order.push('end'),
    ws: { close: () => order.push('ws.close') },
    ev: { removeAllListeners: () => order.push('removeAllListeners') },
  };

  await safeTeardownSocket(fakeSock, {
    flushStores: async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('flushStores');
    },
    timeoutMs: 500,
  });

  assert.deepEqual(order, ['flushStores', 'end', 'ws.close', 'removeAllListeners']);

  const bufferOrder = [];
  await safeTeardownSocket({
    end: () => bufferOrder.push('end'),
    ws: { close: () => bufferOrder.push('ws.close') },
    ev: {
      removeAllListeners: () => bufferOrder.push('removeAllListeners'),
      flush: () => bufferOrder.push('ev.flush'),
    },
  });
  assert.deepEqual(bufferOrder, ['end', 'ws.close', 'removeAllListeners', 'ev.flush']);
});

test('fatal auth disconnect cancels pending transient reconnects and invalidates stale events', async () => {
  let socketCreates = 0;
  let fatalDisconnects = 0;
  const controller = createConnectionController({
    createSocket: async () => {
      socketCreates += 1;
      return { end() {}, ws: { close() {} }, ev: { removeAllListeners() {} } };
    },
    onFatalDisconnect: () => {
      fatalDisconnects += 1;
    },
    baseDelayMs: 1,
    maxDelayMs: 1,
  });

  try {
    await controller.start();
    const generation = controller.getGeneration();
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      await controller.handleDisconnect({ generation, statusCode: 408 });
    } finally {
      Math.random = originalRandom;
    }

    const fatal = await controller.handleDisconnect({ generation, statusCode: 401 });
    assert.equal(fatal.fatal, true);
    assert.equal(controller.isCurrent(generation), false);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(socketCreates, 1, 'fatal auth failure must not restart the socket');
    assert.equal(fatalDisconnects, 1);
    assert.equal(controller.getActiveSocket(), null);
  } finally {
    await controller.shutdown();
  }
});

test('createConnectionController prevents concurrent starts, isolates stale generations, and shuts down cleanly', async () => {
  const gate = createDeferred();
  const createdSockets = [];
  const fatalEvents = [];
  const reconnectEvents = [];
  let flushCount = 0;

  const controller = createConnectionController({
    createSocket: async ({ generation, isCurrent }) => {
      if (generation === 1) {
        await gate.promise;
      }
      const events = [];
      const sock = {
        generation,
        isCurrent,
        end: () => events.push('end'),
        ws: { close: () => events.push('ws.close') },
        ev: { removeAllListeners: () => events.push('removeAllListeners') },
        events,
      };
      createdSockets.push(sock);
      return sock;
    },
    flushStores: async () => {
      flushCount += 1;
    },
    onReconnectScheduled: (info) => reconnectEvents.push(info),
    onFatalDisconnect: (info) => fatalEvents.push(info),
    baseDelayMs: 20,
    maxDelayMs: 50,
    stableConnectionMs: 20,
  });

  // Concurrent start() calls share single-flight promise
  const p1 = controller.start();
  const p2 = controller.start();
  gate.resolve();
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(s1, s2);
  assert.equal(createdSockets.length, 1);
  assert.equal(controller.getGeneration(), 1);
  assert.equal(controller.isCurrent(1), true);

  // Trigger transient disconnect -> schedules reconnect to generation 2
  const d1 = await controller.handleDisconnect({ generation: 1, statusCode: 515 });
  assert.equal(d1.ignored, false);
  assert.equal(d1.kind, 'restartRequired');
  assert.equal(reconnectEvents.length, 1);

  // Manually starting gen 2 tears down gen 1 cleanly
  const s3 = await controller.start();
  assert.equal(controller.getGeneration(), 2);
  assert.equal(controller.isCurrent(1), false);
  assert.equal(controller.isCurrent(2), true);
  assert.deepEqual(createdSockets[0].events, ['end', 'ws.close', 'removeAllListeners']);
  assert.equal(s3.generation, 2);

  // Stale event from generation 1 is ignored completely
  const staleRes = await controller.handleDisconnect({ generation: 1, statusCode: 401 });
  assert.equal(staleRes.ignored, true);
  assert.equal(fatalEvents.length, 0);
  assert.equal(controller.isCurrent(2), true);

  // Fatal disconnect on current generation tears down socket and emits fatal callback
  const fatalRes = await controller.handleDisconnect({ generation: 2, statusCode: 401 });
  assert.equal(fatalRes.fatal, true);
  assert.equal(fatalEvents.length, 1);
  assert.equal(controller.getActiveSocket(), null);

  // Clean shutdown flushes stores without throwing
  await controller.shutdown();
  assert.ok(flushCount >= 2);
  assert.equal(controller.isCurrent(2), false);
});
