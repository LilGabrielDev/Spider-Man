import fs from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
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

export function coerceToBuffer(value) {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    if (value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)) {
      return Buffer.from(value);
    }
    return value;
  }
  if (typeof value === 'object') {
    if (value.type === 'Buffer') {
      if (Array.isArray(value.data)) {
        return Buffer.from(value.data);
      }
      if (typeof value.data === 'string') {
        return Buffer.from(value.data, 'base64');
      }
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
        let maxIdx = -1;
        for (const k of keys) {
          const idx = Number(k);
          if (!Number.isSafeInteger(idx) || idx < 0 || idx > 1_048_576) {
            maxIdx = -1;
            break;
          }
          const b = value[k];
          if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
            maxIdx = -1;
            break;
          }
          if (idx > maxIdx) maxIdx = idx;
        }
        if (maxIdx >= 0) {
          const out = Buffer.alloc(maxIdx + 1);
          for (const k of keys) {
            out[Number(k)] = value[k];
          }
          return out;
        }
      }
    }
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return Buffer.alloc(0);
    if (/^[A-Za-z0-9+/=_-]+$/.test(trimmed)) {
      const std = trimmed.replace(/-/g, '+').replace(/_/g, '/');
      const padded = std.length % 4 === 0 ? std : std + '='.repeat(4 - (std.length % 4));
      return Buffer.from(padded, 'base64');
    }
  }
  return value;
}

function normalizeBinaryField(obj, key) {
  if (!obj || typeof obj !== 'object' || obj[key] === undefined || obj[key] === null) return false;
  const orig = obj[key];
  const coerced = coerceToBuffer(orig);
  if (Buffer.isBuffer(coerced) && (!Buffer.isBuffer(orig) || coerced !== orig)) {
    obj[key] = coerced;
    return true;
  }
  return false;
}

function normalizeKeyPair(pair) {
  if (!pair || typeof pair !== 'object') return false;
  let changed = false;
  if (normalizeBinaryField(pair, 'public')) changed = true;
  if (normalizeBinaryField(pair, 'private')) changed = true;
  return changed;
}

/**
 * Ensures binary credential fields (especially `creds.account`, `noiseKey`,
 * `signedIdentityKey`, `signedPreKey`, and `signalIdentities`) are real `Buffer`
 * instances and repairs device-suffixed `creds.me.lid`.
 * Plain-object `{ "0": ... }` or base64-string encodings silently cause
 * `encodeSignedDeviceIdentity` to drop `accountSignatureKey`, breaking every
 * `pkmsg` / retry delivery with "Waiting for this message".
 */
export function normalizeAuthCreds(creds) {
  if (!creds || typeof creds !== 'object' || Array.isArray(creds)) return false;
  let changed = false;

  if (normalizeKeyPair(creds.noiseKey)) changed = true;
  if (normalizeKeyPair(creds.pairingEphemeralKeyPair)) changed = true;
  if (normalizeKeyPair(creds.signedIdentityKey)) changed = true;

  if (creds.signedPreKey && typeof creds.signedPreKey === 'object') {
    if (normalizeKeyPair(creds.signedPreKey.keyPair)) changed = true;
    if (normalizeBinaryField(creds.signedPreKey, 'signature')) changed = true;
  }

  if (creds.account && typeof creds.account === 'object') {
    for (const field of ['details', 'accountSignatureKey', 'accountSignature', 'deviceSignature']) {
      if (normalizeBinaryField(creds.account, field)) changed = true;
    }
  }

  if (normalizeBinaryField(creds, 'companionEncStatic')) changed = true;
  if (normalizeBinaryField(creds, 'routingInfo')) changed = true;

  if (Array.isArray(creds.signalIdentities)) {
    for (const identity of creds.signalIdentities) {
      if (normalizeBinaryField(identity, 'identifierKey')) changed = true;
    }
  }

  if (
    typeof creds.nextPreKeyId === 'number' &&
    Number.isFinite(creds.nextPreKeyId) &&
    typeof creds.firstUnuploadedPreKeyId === 'number' &&
    Number.isFinite(creds.firstUnuploadedPreKeyId) &&
    creds.firstUnuploadedPreKeyId > creds.nextPreKeyId
  ) {
    creds.firstUnuploadedPreKeyId = creds.nextPreKeyId;
    changed = true;
  }

  if (normalizeMeCredentials(creds)) changed = true;
  return changed;
}

export function applyCredsUpdate(creds, update) {
  if (!creds || typeof creds !== 'object') return creds;
  if (!update || typeof update !== 'object') {
    normalizeAuthCreds(creds);
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

  normalizeAuthCreds(creds);
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

  async function hardenValidCredentialFile(filePath) {
    let handle;
    try {
      const pathInfo = await lstat(filePath).catch((err) => {
        if (err?.code === 'ENOENT') return null;
        throw err;
      });
      if (!pathInfo) return;
      if (pathInfo.isSymbolicLink()) {
        throw new Error(`Refusing symlinked WhatsApp credential file at ${filePath}`);
      }
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
      handle = await open(filePath, flags);
      if (!(await handle.stat()).isFile()) {
        throw new Error(`Refusing non-regular WhatsApp credential file at ${filePath}`);
      }
      const raw = await handle.readFile({ encoding: 'utf8' });
      let valid = false;
      try {
        const parsed = JSON.parse(raw, BufferJSON.reviver);
        normalizeAuthCreds(parsed);
        valid = isValidAuthCreds(parsed);
      } catch {
        // Invalid files are handled by the existing credential recovery logic.
      }
      if (valid) await handle.chmod(0o600);
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      if (err?.code === 'ELOOP') {
        throw new Error(`Refusing symlinked WhatsApp credential file at ${filePath}`);
      }
      throw err;
    } finally {
      await handle?.close();
    }
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
          const repaired = normalizeAuthCreds(parsed);
          if (isValidAuthCreds(parsed)) {
            return { creds: parsed, recoveredFromBackup: false, repaired };
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
          const repaired = normalizeAuthCreds(parsedBak);
          if (isValidAuthCreds(parsedBak)) {
            await atomicWriteRaw(credsPath, rawBak).catch(() => {});
            logInfo?.('[AUTH] Recovered valid credentials from creds.json.bak');
            return { creds: parsedBak, recoveredFromBackup: true, repaired };
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
    return { creds: freshCreds, recoveredFromBackup: false, repaired: false };
  };

  const credsPath = path.join(folder, 'creds.json');
  await hardenValidCredentialFile(credsPath);
  await hardenValidCredentialFile(`${credsPath}.bak`);
  const { creds, repaired: repairedOnLoad } = await loadCredsWithRecovery();
  let repairedPreKeyCursor = false;
  if (
    Number(creds?.nextPreKeyId) > 1 &&
    Number(creds?.firstUnuploadedPreKeyId) > 0 &&
    Number(creds?.firstUnuploadedPreKeyId) < Number(creds?.nextPreKeyId)
  ) {
    const firstKeyFile = path.join(
      folder,
      fixAuthFileName(`pre-key-${creds.firstUnuploadedPreKeyId}.json`),
    );
    if (!fs.existsSync(firstKeyFile)) {
      creds.firstUnuploadedPreKeyId = creds.nextPreKeyId;
      repairedPreKeyCursor = true;
    }
  }
  const normalizedInitial = normalizeAuthCreds(creds) || repairedOnLoad || repairedPreKeyCursor;
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
      normalizeAuthCreds(creds);
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
