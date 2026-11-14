import Module from 'node:module';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const origLoad = Module._load;

function createBetterSqliteMock() {
  return class MockBetterSqlite3 {
    constructor() {}
    pragma() {
      return [];
    }
    exec() {
      return this;
    }
    prepare() {
      return {
        get: () => undefined,
        all: () => [],
        run: () => ({ changes: 0, lastInsertRowid: 1 }),
        iterate: () => [][Symbol.iterator](),
      };
    }
    transaction(fn) {
      return (...args) => fn(...args);
    }
    close() {}
  };
}

const MockSqlite3Db = class MockSqlite3Database {
  constructor(_filename, mode, cb) {
    const callback = typeof mode === 'function' ? mode : cb;
    if (typeof callback === 'function') {
      setImmediate(() => callback(null));
    }
  }
  serialize(fn) {
    if (typeof fn === 'function') fn();
  }
  parallelize(fn) {
    if (typeof fn === 'function') fn();
  }
  run(_sql, params, cb) {
    const callback = typeof params === 'function' ? params : cb;
    if (typeof callback === 'function') {
      setImmediate(() => callback.call({ lastID: 1, changes: 0 }, null));
    }
    return this;
  }
  get(_sql, params, cb) {
    const callback = typeof params === 'function' ? params : cb;
    if (typeof callback === 'function') {
      setImmediate(() => callback(null, undefined));
    }
    return this;
  }
  all(_sql, params, cb) {
    const callback = typeof params === 'function' ? params : cb;
    if (typeof callback === 'function') {
      setImmediate(() => callback(null, []));
    }
    return this;
  }
  each(_sql, params, cb, complete) {
    const done = typeof params === 'function' ? cb : complete;
    if (typeof done === 'function') {
      setImmediate(() => done(null, 0));
    }
    return this;
  }
  exec(_sql, cb) {
    if (typeof cb === 'function') {
      setImmediate(() => cb(null));
    }
    return this;
  }
  prepare(_sql, cb) {
    if (typeof cb === 'function') {
      setImmediate(() => cb(null));
    }
    return {
      run: (_p, c) => { if (typeof c === 'function') setImmediate(() => c(null)); },
      get: (_p, c) => { if (typeof c === 'function') setImmediate(() => c(null, undefined)); },
      all: (_p, c) => { if (typeof c === 'function') setImmediate(() => c(null, [])); },
      finalize: (c) => { if (typeof c === 'function') setImmediate(() => c(null)); },
    };
  }
  close(cb) {
    if (typeof cb === 'function') {
      setImmediate(() => cb(null));
    }
  }
};

const mockSqlite3 = {
  OPEN_READONLY: 1,
  OPEN_READWRITE: 2,
  OPEN_CREATE: 4,
  verbose() {
    return mockSqlite3;
  },
  Database: MockSqlite3Db,
};

const mockPuppeteer = {
  launch: async () => ({
    newPage: async () => ({
      setViewport: async () => {},
      setUserAgent: async () => {},
      goto: async () => {},
      screenshot: async () => Buffer.alloc(0),
      evaluate: async () => null,
      close: async () => {},
    }),
    close: async () => {},
  }),
};

Module._load = function (request, parent, isMain) {
  if (request === 'better-sqlite3') {
    return createBetterSqliteMock();
  }
  if (request === 'sqlite3') {
    return mockSqlite3;
  }
  if (request === 'puppeteer') {
    return mockPuppeteer;
  }
  return origLoad.apply(this, arguments);
};
