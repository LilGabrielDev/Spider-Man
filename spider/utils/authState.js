import fs from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Mutex } from 'async-mutex';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

const REQUIRED_CRED_KEYS = ['noiseKey', 'signedIdentityKey', 'registrationId', 'signedPreKey'];
const fileLocks = new Map();

function getFileLock(filePath) {
  const resolved = path.resolve(filePath);
  let mutex = fileLocks.get(resolved);
  if (!mutex) {
    mutex = new Mutex();
    fileLocks.set(resolved, mutex);
  }
  return mutex;
}

export function fixAuthFileName(file) {
  return String(file || '')
    .replace(/\//g, '__')
    .replace(/:/g, '-');
}

export function parseJidParts(jid) {
  const raw = String(jid || '').trim();
  const atIdx = raw.indexOf('@');
  if (atIdx <= 0) return null;
  const userAndDevice = raw.slice(0, atIdx);
  const server = raw.slice(atIdx + 1);
  if (!server) return null;
  const colonIdx = userAndDevice.indexOf(':');
  if (colonIdx === -1) {
    return { user: userAndDevice, device: undefined, server };
  }
  const user = userAndDevice.slice(0, colonIdx);
  const deviceStr = userAndDevice.slice(colonIdx + 1);
  const device = /^\d+$/.test(deviceStr) ? Number(deviceStr) : undefined;
  return { user, device, server };
}

/**
 * Ensures `creds.me.lid` preserves the companion device ID from `creds.me.id`
 * whenever `me.id` has `:device` (> 0) and `me.lid` was emitted without `:device`.
 * Without this, Baileys' `messages-send.js` encrypts group `skmsg` + SKDM under
 * device `0` (`lidUser_1::0`) while WhatsApp delivers the stanza from `:N`.
 */
export function normalizeMeCredentials(credsOrMe) {
  if (!credsOrMe || typeof credsOrMe !== 'object') return false;
  const me =
    'me' in credsOrMe && credsOrMe.me && typeof credsOrMe.me === 'object'
      ? credsOrMe.me
      : 'id' in credsOrMe
        ? credsOrMe
        : null;
  if (!me || !me.id || !me.lid) return false;

  const idParts = parseJidParts(me.id);
  const lidParts = parseJidParts(me.lid);
  if (!idParts?.user || !lidParts?.user) return false;
  if (typeof idParts.device !== 'number' || idParts.device <= 0) return false;

  if (lidParts.device === undefined || lidParts.device === 0) {
    const server = lidParts.server || 'lid';
    const nextLid = `${lidParts.user}:${idParts.device}@${server}`;
    if (me.lid !== nextLid) {
      me.lid = nextLid;
      return true;
    }
  }
  return false;
}

export function isValidAuthCreds(creds) {
  if (!creds || typeof creds !== 'object' || Array.isArray(creds)) {
    return false;
  }
  for (const key of REQUIRED_CRED_KEYS) {
    if (creds[key] === undefined || creds[key] === null) {
      return false;
    }
  }
  if (!creds.noiseKey?.public || !creds.noiseKey?.private) return false;
  if (!creds.signedIdentityKey?.public || !creds.signedIdentityKey?.private) return false;
  if (!creds.signedPreKey?.keyPair?.public || !creds.signedPreKey?.keyPair?.private) return false;
  if (typeof creds.registrationId !== 'number' || !Number.isFinite(creds.registrationId)) {
    return false;
  }
  return true;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

export function applyCredsUpdate(creds, update) {
  if (!creds || typeof creds !== 'object') return creds;
  if (!update || typeof update !== 'object') {
    normalizeMeCredentials(creds);
    return creds;
  }

  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) continue;
    if (key === 'me' && value && typeof value === 'object') {
      const existingMe = isPlainObject(creds.me) ? creds.me : {};
      const mergedMe = { ...existingMe, ...value };
      // Never lose existing me.id if a partial update omits it
      if (!mergedMe.id && existingMe.id) {
        mergedMe.id = existingMe.id;
      }
      normalizeMeCredentials(mergedMe);
      creds.me = mergedMe;
    } else if (key === 'accountSettings' && isPlainObject(value) && isPlainObject(creds.accountSettings)) {
      creds.accountSettings = { ...creds.accountSettings, ...value };
    } else {
      creds[key] = value;
    }
  }

  normalizeMeCredentials(creds);
  return creds;
}

export async function useHardenedMultiFileAuthState(
  folder,
  { logError = null, logInfo = null } = {},
) {
  const folderInfo = await stat(folder).catch(() => null);
  if (folderInfo) {
    if (!folderInfo.isDirectory()) {
      throw new Error(
        `found something that is not a directory at ${folder}, either delete it or specify a different location`,
      );
    }
  } else {
    await mkdir(folder, { recursive: true });
  }

  // Clean up leftover crashed temporary files from earlier processes (never touch .bak or .json)
  try {
    const existingFiles = await readdir(folder);
    for (const name of existingFiles) {
      if (/\.json\.tmp-/.test(name)) {
        await unlink(path.join(folder, name)).catch(() => {});
      }
    }
  } catch {
    // Non-fatal startup sweep
  }

  let writeSeq = 0;
  const activeWrites = new Set();

  function trackWrite(promise) {
    activeWrites.add(promise);
    const cleanup = () => activeWrites.delete(promise);
    promise.then(cleanup, cleanup);
    return promise;
  }

  async function atomicWriteRaw(filePath, content) {
    writeSeq = (writeSeq + 1) % 1_000_000_000;
    const tmpPath = `${filePath}.tmp-${process.pid}-${writeSeq}`;
    await writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    await rename(tmpPath, filePath);
  }

  const writeData = (data, file, { backup = false } = {}) => {
    const filePath = path.join(folder, fixAuthFileName(file));
    const mutex = getFileLock(filePath);
    const serialized = JSON.stringify(data, BufferJSON.replacer);

    const job = mutex.runExclusive(async () => {
      await atomicWriteRaw(filePath, serialized);
      if (backup) {
        await atomicWriteRaw(`${filePath}.bak`, serialized).catch(() => {});
      }
    });

    return trackWrite(job);
  };

  const readData = async (file) => {
    const filePath = path.join(folder, fixAuthFileName(file));
    const mutex = getFileLock(filePath);
    return mutex.runExclusive(async () => {
      try {
        const raw = await readFile(filePath, { encoding: 'utf8' });
        if (!raw || !raw.trim()) return null;
        return JSON.parse(raw, BufferJSON.reviver);
      } catch {
        return null;
      }
    });
  };

  const removeData = (file) => {
    const filePath = path.join(folder, fixAuthFileName(file));
    const mutex = getFileLock(filePath);
    const job = mutex.runExclusive(async () => {
      try {
        await unlink(filePath);
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          throw err;
        }
      }
    });
    return trackWrite(job);
  };

  const loadCredsWithRecovery = async () => {
    const credsPath = path.join(folder, 'creds.json');
    const backupPath = `${credsPath}.bak`;
    const credsExists = fs.existsSync(credsPath);
    const backupExists = fs.existsSync(backupPath);

    let primaryError = null;
    if (credsExists) {
      const credsStat = await stat(credsPath).catch(() => null);
      if (credsStat && credsStat.size > 0) {
        try {
          const raw = await readFile(credsPath, { encoding: 'utf8' });
          const parsed = JSON.parse(raw, BufferJSON.reviver);
          if (isValidAuthCreds(parsed)) {
            return { creds: parsed, recoveredFromBackup: false };
          }
          primaryError = new Error('creds.json failed credential schema validation');
        } catch (err) {
          primaryError = err;
        }
      }
    }

    if (backupExists) {
      const bakStat = await stat(backupPath).catch(() => null);
      if (bakStat && bakStat.size > 0) {
        try {
          const rawBak = await readFile(backupPath, { encoding: 'utf8' });
          const parsedBak = JSON.parse(rawBak, BufferJSON.reviver);
          if (isValidAuthCreds(parsedBak)) {
            await atomicWriteRaw(credsPath, rawBak).catch(() => {});
            logInfo?.('[AUTH] Recovered valid credentials from creds.json.bak');
            return { creds: parsedBak, recoveredFromBackup: true };
          }
        } catch {
          // Fall through
        }
      }
    }

    if (primaryError) {
      logError?.(
        'Auth Credentials Load',
        null,
        null,
        `Refusing to wipe corrupted creds.json: ${primaryError.message || primaryError}`,
      );
      throw new Error(
        `Existing WhatsApp credentials at ${credsPath} are corrupted and backup recovery failed (${primaryError.message || primaryError}).`,
      );
    }

    const freshCreds = initAuthCreds();
    return { creds: freshCreds, recoveredFromBackup: false };
  };

  const { creds } = await loadCredsWithRecovery();
  const normalizedInitial = normalizeMeCredentials(creds);
  if (normalizedInitial && isValidAuthCreds(creds)) {
    await writeData(creds, 'creds.json', { backup: true }).catch(() => {});
  } else if (fs.existsSync(path.join(folder, 'creds.json')) && !fs.existsSync(path.join(folder, 'creds.json.bak'))) {
    if (isValidAuthCreds(creds)) {
      await writeData(creds, 'creds.json', { backup: true }).catch(() => {});
    }
  }

  let saveQueued = Promise.resolve();
  const saveCreds = async (update) => {
    if (update && typeof update === 'object' && update !== creds) {
      applyCredsUpdate(creds, update);
    } else {
      normalizeMeCredentials(creds);
    }

    if (!isValidAuthCreds(creds)) {
      logError?.(
        'Auth Credentials Save',
        null,
        null,
        'Skipped saving incomplete creds snapshot without overwriting existing creds.json',
      );
      return;
    }

    saveQueued = saveQueued
      .catch(() => {})
      .then(() => writeData(creds, 'creds.json', { backup: true }));
    return trackWrite(saveQueued);
  };

  const flush = async () => {
    await saveQueued.catch(() => {});
    while (activeWrites.size > 0) {
      const batch = Array.from(activeWrites);
      await Promise.allSettled(batch);
    }
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(
                value !== null && value !== undefined
                  ? writeData(value, file)
                  : removeData(file),
              );
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds,
    flush,
  };
}
