'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

let Database = null;
try {
  Database = require('better-sqlite3');
} catch {
  Database = null;
}

const MAX_MEM_PER_JID = 200;
const MAX_AD_PER_JID = 100;
const memoryMsgs = new Map();
const memoryAntiDelete = new Map();

let _db = null;
let _stmts = {};
let _sqliteDisabled = !Database;
let _cleanupTimer = null;

function resolveDbPath() {
  const candidates = [
    path.join(process.cwd(), 'lil', 'session', 'store.db'),
    path.join(process.cwd(), 'data', 'store.db'),
    path.join(os.tmpdir(), 'spider-man-md', 'store.db'),
  ];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      const probe = path.join(path.dirname(candidate), `.probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.unlinkSync(probe);
      return candidate;
    } catch {
      // try next writable location
    }
  }
  return null;
}

function safeStringify(obj) {
  return JSON.stringify(obj, (_key, val) => {
    if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
      return { __type: 'Buffer', data: Buffer.from(val).toString('base64') };
    }
    return val;
  });
}

function safeParse(raw) {
  return JSON.parse(raw, (_key, val) => {
    if (val && typeof val === 'object' && val.__type === 'Buffer' && val.data) {
      return Buffer.from(val.data, 'base64');
    }
    return val;
  });
}

function getDb() {
  if (_sqliteDisabled || !Database) return null;
  if (_db) return _db;
  const dbPath = resolveDbPath();
  if (!dbPath) {
    _sqliteDisabled = true;
    return null;
  }
  try {
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('cache_size = -10000');
    _db.pragma('temp_store = memory');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS msg_store (
        id TEXT NOT NULL,
        jid TEXT NOT NULL,
        data TEXT NOT NULL,
        ts INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (jid, id)
      );
      CREATE INDEX IF NOT EXISTS idx_msg_ts ON msg_store(ts);
      CREATE TABLE IF NOT EXISTS antidelete_store (
        id TEXT NOT NULL,
        jid TEXT NOT NULL,
        sender TEXT,
        push_name TEXT,
        data TEXT NOT NULL,
        ts INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (jid, id)
      );
      CREATE INDEX IF NOT EXISTS idx_ad_jid_ts ON antidelete_store(jid, ts);
    `);
    _stmts.saveMsg = _db.prepare('INSERT OR REPLACE INTO msg_store (id, jid, data, ts) VALUES (?, ?, ?, unixepoch())');
    _stmts.loadMsg = _db.prepare('SELECT data FROM msg_store WHERE jid = ? AND id = ?');
    _stmts.saveAD = _db.prepare('INSERT OR REPLACE INTO antidelete_store (id, jid, sender, push_name, data, ts) VALUES (?, ?, ?, ?, ?, unixepoch())');
    _stmts.findAD = _db.prepare('SELECT data FROM antidelete_store WHERE jid = ? AND id = ?');
    _stmts.delAD = _db.prepare('DELETE FROM antidelete_store WHERE jid = ? AND id = ?');
    _stmts.cleanAD = _db.prepare('DELETE FROM antidelete_store WHERE ts < unixepoch() - 86400');
    _stmts.cleanMsg = _db.prepare('DELETE FROM msg_store WHERE ts < unixepoch() - 604800');
    return _db;
  } catch {
    _sqliteDisabled = true;
    _db = null;
    return null;
  }
}

function setBounded(outerMap, jid, id, value, cap) {
  if (!jid || !id) return;
  let inner = outerMap.get(jid);
  if (!inner) {
    inner = new Map();
    outerMap.set(jid, inner);
  }
  inner.set(id, { value, ts: Date.now() });
  while (inner.size > cap) {
    const oldest = inner.keys().next().value;
    if (oldest === undefined) break;
    inner.delete(oldest);
  }
}

function saveMsg(jid, msg) {
  try {
    const db = getDb();
    if (db && _stmts.saveMsg) {
      _stmts.saveMsg.run(msg.key.id, jid, safeStringify(msg));
      return;
    }
    setBounded(memoryMsgs, jid, msg?.key?.id, msg, MAX_MEM_PER_JID);
  } catch (err) {
    console.error('[msgStore] save:', err.message);
  }
}

function loadMsg(jid, id) {
  try {
    const db = getDb();
    if (db && _stmts.loadMsg) {
      const row = _stmts.loadMsg.get(jid, id);
      return row ? safeParse(row.data) : null;
    }
    return memoryMsgs.get(jid)?.get(id)?.value || null;
  } catch {
    return null;
  }
}

function saveAntiDelete(jid, msg) {
  try {
    const db = getDb();
    if (db && _stmts.saveAD) {
      _stmts.saveAD.run(
        msg.key.id,
        jid,
        msg.originalSender || null,
        msg.originalPushName || null,
        safeStringify(msg),
      );
      return;
    }
    setBounded(memoryAntiDelete, jid, msg?.key?.id, msg, MAX_AD_PER_JID);
  } catch (err) {
    console.error('[antiDeleteStore] save:', err.message);
  }
}

function findAntiDelete(jid, id) {
  try {
    const db = getDb();
    if (db && _stmts.findAD) {
      const row = _stmts.findAD.get(jid, id);
      return row ? safeParse(row.data) : null;
    }
    return memoryAntiDelete.get(jid)?.get(id)?.value || null;
  } catch {
    return null;
  }
}

function removeAntiDelete(jid, id) {
  try {
    const db = getDb();
    if (db && _stmts.delAD) {
      _stmts.delAD.run(jid, id);
      return;
    }
    memoryAntiDelete.get(jid)?.delete(id);
  } catch {
    // ignore
  }
}

function startCleanup() {
  if (_cleanupTimer) return _cleanupTimer;
  _cleanupTimer = setInterval(() => {
    try {
      const db = getDb();
      if (db && _stmts.cleanAD && _stmts.cleanMsg) {
        _stmts.cleanAD.run();
        _stmts.cleanMsg.run();
      } else {
        const now = Date.now();
        for (const inner of memoryAntiDelete.values()) {
          for (const [k, entry] of inner.entries()) {
            if (now - entry.ts > 86400 * 1000) inner.delete(k);
          }
        }
        for (const inner of memoryMsgs.values()) {
          for (const [k, entry] of inner.entries()) {
            if (now - entry.ts > 604800 * 1000) inner.delete(k);
          }
        }
      }
    } catch {
      // ignore cleanup error
    }
  }, 300000);
  _cleanupTimer?.unref?.();
  return _cleanupTimer;
}

class SQLiteStore {
  constructor() {
    getDb();
  }
  loadMessage(jid, id) {
    return loadMsg(jid, id);
  }
  saveMessage(jid, msg) {
    saveMsg(jid, msg);
  }
  bind(ev) {
    this._handler = ({ messages }) => {
      for (const m of messages || []) {
        if (m.key?.remoteJid && m.key?.id) {
          this.saveMessage(m.key.remoteJid, m);
        }
      }
    };
    ev.on('messages.upsert', this._handler);
  }
  destroy() {
    try {
      if (_cleanupTimer) {
        clearInterval(_cleanupTimer);
        _cleanupTimer = null;
      }
      if (_db) {
        _db.pragma('wal_checkpoint(TRUNCATE)');
        _db.close();
        _db = null;
        _stmts = {};
      }
    } catch (err) {
      console.error('[msgStore] destroy:', err.message);
    }
  }
}

module.exports = {
  saveMsg,
  loadMsg,
  saveAntiDelete,
  findAntiDelete,
  removeAntiDelete,
  startCleanup,
  SQLiteStore,
};