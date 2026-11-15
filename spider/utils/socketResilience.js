import fs from 'node:fs';
import { normalizeMeCredentials, parseJidParts } from './authState.js';

const wrappedSockets = new WeakSet();
const preKeyCheckedSockets = new WeakSet();
const appStateSyncedSockets = new WeakSet();
const appStateInFlightSockets = new WeakSet();
const VALID_PN_DOMAINS = new Set(['s.whatsapp.net', 'hosted', 'c.us']);
export const ALL_APP_STATE_COLLECTIONS = [
  'critical_block',
  'critical_unblock_low',
  'regular_high',
  'regular_low',
  'regular',
];

function isPnOrHostedPnJid(jid) {
  const raw = String(jid || '').trim();
  const atIdx = raw.indexOf('@');
  if (atIdx <= 0) return false;
  const domain = raw.slice(atIdx + 1).toLowerCase();
  return VALID_PN_DOMAINS.has(domain);
}

function isLidOrHostedLidJid(jid) {
  const raw = String(jid || '').trim().toLowerCase();
  return raw.endsWith('@lid') || raw.endsWith('@hosted.lid');
}

function extractUserPart(jid) {
  const raw = String(jid || '').trim();
  if (!raw) return '';
  const beforeAt = raw.split('@')[0] || '';
  return beforeAt.split(':')[0] || '';
}

function normalizePnJid(jid) {
  const raw = String(jid || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase().endsWith('@c.us')) {
    return `${raw.slice(0, -5)}@s.whatsapp.net`;
  }
  return raw;
}

function resolveEffectiveLidIdentity(candidateId, credsMe) {
  if (!candidateId || !credsMe?.id) return candidateId;
  const candParts = parseJidParts(candidateId);
  const meParts = parseJidParts(credsMe.id);
  if (!candParts || !meParts) return candidateId;
  const isLidServer = candParts.server === 'lid' || candParts.server === 'hosted.lid';
  if (!isLidServer) return candidateId;
  if (typeof meParts.device === 'number' && meParts.device > 0 && (candParts.device === undefined || candParts.device === 0)) {
    return `${candParts.user}:${meParts.device}@${candParts.server}`;
  }
  return candidateId;
}

function extractEphemeralExpiration(quotedMsg) {
  if (!quotedMsg || typeof quotedMsg !== 'object') return undefined;
  const root = quotedMsg.message || quotedMsg;
  if (!root || typeof root !== 'object') return undefined;

  const candidates = [
    root,
    root.ephemeralMessage?.message,
    root.viewOnceMessage?.message,
    root.viewOnceMessageV2?.message,
    root.viewOnceMessageV2Extension?.message,
    root.documentWithCaptionMessage?.message,
  ].filter(Boolean);

  for (const layer of candidates) {
    if (typeof layer !== 'object') continue;
    for (const value of Object.values(layer)) {
      const exp = value?.contextInfo?.expiration;
      if (Number.isFinite(Number(exp)) && Number(exp) > 0) {
        return Number(exp);
      }
    }
  }
  return undefined;
}

export function countLocalPreKeyFiles(authDir, fsImpl = fs) {
  if (!authDir) return 0;
  try {
    if (!fsImpl.existsSync(authDir)) return 0;
    const entries = fsImpl.readdirSync(authDir);
    let count = 0;
    for (const name of entries) {
      if (name.startsWith('pre-key-') && name.endsWith('.json')) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

export async function ensureHealthyPreKeys(
  sock,
  {
    authDir = '',
    fsImpl = fs,
    minLocalPreKeys = 15,
    replenishCount = 50,
    logInfo = console.log,
    logError = null,
  } = {},
) {
  if (!sock || typeof sock.uploadPreKeys !== 'function') return false;
  if (preKeyCheckedSockets.has(sock)) return false;

  const nextPreKeyId = Number(sock?.authState?.creds?.nextPreKeyId || 0);
  const localCount = authDir ? countLocalPreKeyFiles(authDir, fsImpl) : 0;

  let currentExists = true;
  if (nextPreKeyId > 1 && typeof sock?.authState?.keys?.get === 'function') {
    try {
      const currentId = String(nextPreKeyId - 1);
      const res = await sock.authState.keys.get('pre-key', [currentId]);
      currentExists = Boolean(res?.[currentId]);
    } catch {
      currentExists = localCount > 0;
    }
  }

  // Fresh container deployments (e.g. Katabump with SESSION env var) hydrate creds.json with
  // nextPreKeyId > 1 while having 0 pre-key-*.json files locally. Baileys only uploads 5 pre-keys
  // when serverCount > 5, which quickly exhausts or leaves orphaned server pre-keys behind.
  const needsReplenish =
    (nextPreKeyId > 1 && localCount < minLocalPreKeys) ||
    (nextPreKeyId > 1 && !currentExists);

  if (!needsReplenish) {
    preKeyCheckedSockets.add(sock);
    return false;
  }

  preKeyCheckedSockets.add(sock);
  try {
    await sock.uploadPreKeys(replenishCount);
    logInfo?.(
      `[SIGNAL] Uploaded ${replenishCount} fresh pre-keys (local=${localCount}, nextPreKeyId=${nextPreKeyId})`,
    );
    return true;
  } catch (err) {
    preKeyCheckedSockets.delete(sock);
    logError?.('Signal PreKey Replenish', null, null, err?.message || String(err));
    return false;
  }
}

export function ensureFallbackMeName(creds, fallbackName = 'Spider Man') {
  if (!creds?.me || typeof creds.me !== 'object') return false;
  const current = String(creds.me.name || '').trim();
  if (current) return false;
  const safeName = String(fallbackName || 'Spider Man').replace(/@/g, '').trim() || 'Spider Man';
  creds.me.name = safeName;
  return true;
}

export function wrapPresenceResilience(sock, { defaultPushName = 'Spider Man' } = {}) {
  if (!sock || typeof sock.sendPresenceUpdate !== 'function') return false;
  ensureFallbackMeName(sock.authState?.creds, defaultPushName);
  if (sock.sendPresenceUpdate.__spiderPresenceWrapped) return true;

  const origSendPresenceUpdate = sock.sendPresenceUpdate.bind(sock);
  const wrappedSendPresence = async (type, toJid) => {
    if (type === 'available' || type === 'unavailable') {
      ensureFallbackMeName(sock.authState?.creds, defaultPushName);
    }
    return origSendPresenceUpdate(type, toJid);
  };
  wrappedSendPresence.__spiderPresenceWrapped = true;
  sock.sendPresenceUpdate = wrappedSendPresence;
  return true;
}

export async function ensureActiveOnlinePresence(
  sock,
  { defaultPushName = 'Spider Man', logError = null } = {},
) {
  if (!sock || typeof sock !== 'object') return false;
  ensureFallbackMeName(sock.authState?.creds, defaultPushName);
  if (typeof sock.sendPresenceUpdate !== 'function') return false;
  try {
    await sock.sendPresenceUpdate('available');
    return true;
  } catch (err) {
    logError?.('Presence Update', null, null, err?.message || String(err));
    return false;
  }
}

export async function ensureAppStateSynced(
  sock,
  { logInfo = null, logError = null } = {},
) {
  if (
    !sock ||
    typeof sock.resyncAppState !== 'function' ||
    typeof sock.authState?.keys?.get !== 'function'
  ) {
    return false;
  }
  if (appStateSyncedSockets.has(sock) || appStateInFlightSockets.has(sock)) {
    return false;
  }

  appStateInFlightSockets.add(sock);
  try {
    const versions = await sock.authState.keys.get(
      'app-state-sync-version',
      [...ALL_APP_STATE_COLLECTIONS],
    );
    const unsynced = ALL_APP_STATE_COLLECTIONS.filter((name) => !versions?.[name]);
    if (unsynced.length === 0) {
      appStateSyncedSockets.add(sock);
      return false;
    }

    await sock.resyncAppState(unsynced, true);
    appStateSyncedSockets.add(sock);
    logInfo?.(
      `[APP-STATE] Synced ${unsynced.length} app-state collection(s): ${unsynced.join(', ')}`,
    );
    return true;
  } catch (err) {
    logError?.('App State Sync', null, null, err?.message || String(err));
    return false;
  } finally {
    appStateInFlightSockets.delete(sock);
  }
}

export function syncMessageKeyAliases(
  key,
  { registerChatAlias = null, phoneToLidMap = null, lidToPhoneMap = null } = {},
) {
  if (!key || typeof key !== 'object') return false;
  let updated = false;

  const rJid = String(key.remoteJid || '').trim();
  const rAlt = String(key.remoteJidAlt || '').trim();
  const sPn = String(key.senderPn || '').trim();
  const sLid = String(key.senderLid || '').trim();

  if (rJid && rAlt) {
    if (registerChatAlias?.(rJid, rAlt)) updated = true;
  }
  if (rJid && !rJid.endsWith('@g.us') && !rJid.endsWith('@broadcast')) {
    if (sPn && registerChatAlias?.(rJid, sPn)) updated = true;
    if (sLid && registerChatAlias?.(rJid, sLid)) updated = true;
    if (sPn && sLid && registerChatAlias?.(sPn, sLid)) updated = true;
  }

  const pairCandidates = [
    [rJid, rAlt],
    [rJid, sPn],
    [rJid, sLid],
    [sPn, sLid],
    [key.participant, key.participantAlt],
    [key.participant, key.participantPn],
  ];

  for (const [aRaw, bRaw] of pairCandidates) {
    const a = String(aRaw || '').trim();
    const b = String(bRaw || '').trim();
    if (!a || !b || a === b) continue;

    const aIsLid = isLidOrHostedLidJid(a);
    const bIsLid = isLidOrHostedLidJid(b);
    const aIsPn = isPnOrHostedPnJid(a);
    const bIsPn = isPnOrHostedPnJid(b);

    let lid = null;
    let pnUser = null;
    if (aIsLid && bIsPn) {
      lid = `${extractUserPart(a)}@lid`;
      pnUser = extractUserPart(b);
    } else if (bIsLid && aIsPn) {
      lid = `${extractUserPart(b)}@lid`;
      pnUser = extractUserPart(a);
    }

    if (lid && pnUser && /^\d{5,16}$/.test(pnUser)) {
      if (phoneToLidMap && typeof phoneToLidMap.set === 'function') {
        phoneToLidMap.set(pnUser, lid);
        updated = true;
      }
      if (lidToPhoneMap && typeof lidToPhoneMap.set === 'function') {
        lidToPhoneMap.set(lid, pnUser);
        updated = true;
      }
    }
  }

  return updated;
}

function stripPartialEncryptErrors(iqResult, logError) {
  if (!iqResult || typeof iqResult !== 'object' || !Array.isArray(iqResult.content)) {
    return iqResult;
  }
  const listIdx = iqResult.content.findIndex((child) => child?.tag === 'list');
  if (listIdx === -1) return iqResult;

  const listNode = iqResult.content[listIdx];
  if (!Array.isArray(listNode?.content) || listNode.content.length === 0) {
    return iqResult;
  }

  const userNodes = listNode.content.filter((child) => child?.tag === 'user');
  if (userNodes.length === 0) return iqResult;

  const validUsers = [];
  const erroredCodes = [];
  for (const child of listNode.content) {
    if (child?.tag !== 'user') {
      validUsers.push(child);
      continue;
    }
    const errChild = Array.isArray(child.content)
      ? child.content.find((sub) => sub?.tag === 'error')
      : null;
    if (errChild) {
      erroredCodes.push(String(errChild?.attrs?.code || errChild?.attrs?.text || 'error'));
    } else {
      validUsers.push(child);
    }
  }

  // Only strip failed <user> children if at least one valid user bundle survived
  const validUserCount = validUsers.filter((child) => child?.tag === 'user').length;
  if (erroredCodes.length > 0 && validUserCount > 0) {
    logError?.(
      'Encrypt PreKey Fetch',
      null,
      null,
      `Isolated ${erroredCodes.length} errored recipient key bundle(s) [${erroredCodes.join(',')}] while injecting ${validUserCount} valid session(s)`,
    );
    const nextContent = [...iqResult.content];
    nextContent[listIdx] = { ...listNode, content: validUsers };
    return { ...iqResult, content: nextContent };
  }

  return iqResult;
}

export function wrapLidMappingResilience(sock, { logError = null } = {}) {
  const signalRepository = sock?.signalRepository;
  const lidMapping = signalRepository?.lidMapping;
  if (!lidMapping || typeof lidMapping.getLIDsForPNs !== 'function') {
    return false;
  }
  if (lidMapping.__spiderWrapped) return true;

  const origGetLIDsForPNs = lidMapping.getLIDsForPNs.bind(lidMapping);
  const origGetKnownLIDsForPNs =
    typeof lidMapping.getKnownLIDsForPNs === 'function'
      ? lidMapping.getKnownLIDsForPNs.bind(lidMapping)
      : null;

  // Track PNs whose LID resolution returned no mapping so an immediately following
  // <iq xmlns="encrypt" type="get"><key/></iq> falls back to querying the PN itself
  // rather than omitting the recipient from the PreKey fetch.
  const pendingUnmappedPns = new Map();
  const TRACK_TTL_MS = 10_000;

  function pruneStale(map, now = Date.now()) {
    for (const [k, ts] of map.entries()) {
      if (now - ts > TRACK_TTL_MS) map.delete(k);
    }
    while (map.size > 500) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  function markUnmappedPns(requestedPns, resolvedPairs) {
    const now = Date.now();
    pruneStale(pendingUnmappedPns, now);
    const resolvedSet = new Set();
    for (const pair of resolvedPairs || []) {
      if (pair?.pn && pair?.lid) {
        resolvedSet.add(normalizePnJid(pair.pn));
        resolvedSet.add(extractUserPart(pair.pn));
      }
    }
    for (const rawPn of requestedPns || []) {
      const pn = normalizePnJid(rawPn);
      if (!isPnOrHostedPnJid(pn)) continue;
      const user = extractUserPart(pn);
      if (!resolvedSet.has(pn) && !resolvedSet.has(user)) {
        pendingUnmappedPns.set(pn, now);
      } else {
        pendingUnmappedPns.delete(pn);
      }
    }
  }

  lidMapping.getLIDsForPNs = async (pns) => {
    const input = Array.isArray(pns) ? pns.filter(Boolean) : [];
    if (input.length === 0) return [];

    let primaryResult = null;
    try {
      primaryResult = await origGetLIDsForPNs(input);
    } catch (err) {
      logError?.('LID Mapping Lookup', null, null, err?.message || String(err));
      primaryResult = null;
    }

    if (Array.isArray(primaryResult)) {
      markUnmappedPns(input, primaryResult);
      return primaryResult;
    }

    // Baileys returns null for the whole batch if any single PN fails USync lookup.
    // Recover known mappings and isolate individual PN lookups so valid recipients aren't dropped.
    const mergedByPn = new Map();
    if (origGetKnownLIDsForPNs) {
      try {
        const known = await origGetKnownLIDsForPNs(input);
        for (const pair of known || []) {
          if (pair?.pn && pair?.lid) {
            mergedByPn.set(normalizePnJid(pair.pn), pair);
          }
        }
      } catch {}
    }

    const unresolved = input.filter((pn) => !mergedByPn.has(normalizePnJid(pn)));
    if (unresolved.length > 0 && input.length > 1) {
      for (const singlePn of unresolved) {
        try {
          const singleRes = await origGetLIDsForPNs([singlePn]);
          if (Array.isArray(singleRes)) {
            for (const pair of singleRes) {
              if (pair?.pn && pair?.lid) {
                mergedByPn.set(normalizePnJid(pair.pn), pair);
              }
            }
          }
        } catch {}
      }
    }

    const recovered = Array.from(mergedByPn.values());
    markUnmappedPns(input, recovered);
    return recovered;
  };
  lidMapping.__spiderWrapped = true;

  if (typeof sock.query === 'function' && !sock.query.__spiderWrapped) {
    const origQuery = sock.query.bind(sock);
    const wrappedQuery = async (node, timeoutMs) => {
      if (
        node?.tag === 'iq' &&
        node?.attrs?.xmlns === 'encrypt' &&
        node?.attrs?.type === 'get' &&
        Array.isArray(node.content)
      ) {
        const keyNode = node.content.find((child) => child?.tag === 'key');
        if (keyNode) {
          const existingUsers = Array.isArray(keyNode.content) ? [...keyNode.content] : [];
          const existingJids = new Set(
            existingUsers.map((u) => u?.attrs?.jid).filter(Boolean),
          );
          const hasIdentityReason = existingUsers.some(
            (u) => u?.attrs?.reason === 'identity',
          );
          const now = Date.now();
          pruneStale(pendingUnmappedPns, now);

          const fallbackPns = [];
          for (const [pn, ts] of pendingUnmappedPns.entries()) {
            if (now - ts <= TRACK_TTL_MS && !existingJids.has(pn)) {
              fallbackPns.push(pn);
            }
          }
          pendingUnmappedPns.clear();

          if (fallbackPns.length > 0) {
            keyNode.content = [
              ...existingUsers,
              ...fallbackPns.map((jid) => ({
                tag: 'user',
                attrs: hasIdentityReason ? { jid, reason: 'identity' } : { jid },
              })),
            ];
          } else if (existingUsers.length === 0) {
            // Avoid sending a pointless empty <key/> IQ that can fail or hang
            return { tag: 'iq', attrs: { type: 'result' }, content: [] };
          }
        }
        const rawRes = await origQuery(node, timeoutMs);
        return stripPartialEncryptErrors(rawRes, logError);
      }
      return origQuery(node, timeoutMs);
    };
    wrappedQuery.__spiderWrapped = true;
    sock.query = wrappedQuery;
  }

  return true;
}

export function clearCachedUserDevices(userDevicesCache, jid) {
  if (!userDevicesCache || !jid || typeof userDevicesCache.del !== 'function') return false;
  const raw = String(jid).trim();
  const user = extractUserPart(raw);
  const candidates = new Set([raw]);
  if (user) {
    candidates.add(user);
    candidates.add(`${user}@s.whatsapp.net`);
    candidates.add(`${user}@lid`);
  }
  let cleared = false;
  for (const key of candidates) {
    if (userDevicesCache.del(key)) cleared = true;
  }
  return cleared;
}

/**
 * Wraps SignalKeyStore (outside makeWASocket / makeCacheableSignalKeyStore) so that
 * any recipient device whose `encryptMessage` failed during a group SKDM fanout
 * is never persisted as `true` in `sender-key-memory`.
 */
export function createGuardedSignalKeyStore(keys, failedEncryptJids) {
  if (!keys || typeof keys.get !== 'function' || typeof keys.set !== 'function') {
    return keys;
  }
  if (keys.__spiderGuarded) return keys;
  const failureMap = failedEncryptJids instanceof Map ? failedEncryptJids : new Map();
  const FAILURE_WINDOW_MS = 30_000;

  return {
    __spiderGuarded: true,
    __failedEncryptJids: failureMap,
    get: (...args) => keys.get(...args),
    clear: keys.clear ? (...args) => keys.clear(...args) : undefined,
    set: async (data) => {
      if (data && typeof data === 'object' && data['sender-key-memory']) {
        const now = Date.now();
        for (const [k, ts] of failureMap.entries()) {
          if (now - ts > FAILURE_WINDOW_MS) {
            failureMap.delete(k);
          }
        }
        if (failureMap.size > 0) {
          const nextMemory = { ...data['sender-key-memory'] };
          for (const [memoryKey, valueMap] of Object.entries(nextMemory)) {
            if (!valueMap || typeof valueMap !== 'object') continue;
            let mutated = false;
            const cleanedMap = { ...valueMap };
            for (const failedJid of failureMap.keys()) {
              if (Object.prototype.hasOwnProperty.call(cleanedMap, failedJid)) {
                delete cleanedMap[failedJid];
                mutated = true;
              }
            }
            if (mutated) {
              nextMemory[memoryKey] = cleanedMap;
            }
          }
          data = { ...data, 'sender-key-memory': nextMemory };
        }
      }
      return keys.set(data);
    },
  };
}

export function wrapSignalAndSenderKeyGuard(
  sock,
  { failedEncryptJids = null, userDevicesCache = null, logError = null } = {},
) {
  if (!sock || typeof sock !== 'object') return false;
  if (sock.__spiderSignalGuardWrapped) return true;
  sock.__spiderSignalGuardWrapped = true;

  normalizeMeCredentials(sock.authState?.creds);

  const trackedFailures =
    failedEncryptJids instanceof Map
      ? failedEncryptJids
      : sock.authState?.keys?.__failedEncryptJids instanceof Map
        ? sock.authState.keys.__failedEncryptJids
        : new Map();
  const refreshCooldown = new Map();

  if (sock.ev && typeof sock.ev.on === 'function') {
    sock.ev.on('creds.update', (update) => {
      if (update && typeof update === 'object' && update.me) {
        const mergedMe = {
          ...(sock.authState?.creds?.me || {}),
          ...update.me,
        };
        if (normalizeMeCredentials(mergedMe)) {
          update.me.lid = mergedMe.lid;
        }
      }
      normalizeMeCredentials(sock.authState?.creds);
    });
  }

  const repo = sock.signalRepository;
  if (!repo || typeof repo !== 'object') return true;

  if (typeof repo.encryptGroupMessage === 'function') {
    const origEncryptGroup = repo.encryptGroupMessage.bind(repo);
    repo.encryptGroupMessage = async (opts) => {
      if (opts && typeof opts === 'object' && opts.meId) {
        const nextMeId = resolveEffectiveLidIdentity(opts.meId, sock.authState?.creds?.me);
        if (nextMeId !== opts.meId) {
          opts = { ...opts, meId: nextMeId };
        }
      }
      try {
        return await origEncryptGroup(opts);
      } catch (err) {
        logError?.('Signal Group Encrypt', null, opts?.group || null, err?.message || String(err));
        throw err;
      }
    };
  }

  if (typeof repo.hasSenderKey === 'function') {
    const origHasSenderKey = repo.hasSenderKey.bind(repo);
    repo.hasSenderKey = async (opts) => {
      if (opts && typeof opts === 'object' && opts.meId) {
        const nextMeId = resolveEffectiveLidIdentity(opts.meId, sock.authState?.creds?.me);
        if (nextMeId !== opts.meId) {
          opts = { ...opts, meId: nextMeId };
        }
      }
      return origHasSenderKey(opts);
    };
  }

  if (typeof repo.getSenderKeyDistributionMessage === 'function') {
    const origGetSkdm = repo.getSenderKeyDistributionMessage.bind(repo);
    repo.getSenderKeyDistributionMessage = async (opts) => {
      if (opts && typeof opts === 'object' && opts.meId) {
        const nextMeId = resolveEffectiveLidIdentity(opts.meId, sock.authState?.creds?.me);
        if (nextMeId !== opts.meId) {
          opts = { ...opts, meId: nextMeId };
        }
      }
      return origGetSkdm(opts);
    };
  }

  if (typeof repo.encryptMessage === 'function') {
    const origEncryptMessage = repo.encryptMessage.bind(repo);
    repo.encryptMessage = async (opts) => {
      try {
        return await origEncryptMessage(opts);
      } catch (err) {
        const jid = opts?.jid;
        if (jid) {
          trackedFailures.set(jid, Date.now());
          if (trackedFailures.size > 500) {
            trackedFailures.delete(trackedFailures.keys().next().value);
          }
          clearCachedUserDevices(userDevicesCache, jid);
          logError?.('Signal Encrypt Failure', null, jid, err?.message || String(err));
          const now = Date.now();
          const lastRefresh = refreshCooldown.get(jid) || 0;
          if (typeof sock.assertSessions === 'function' && now - lastRefresh >= 10_000) {
            refreshCooldown.set(jid, now);
            if (refreshCooldown.size > 200) {
              refreshCooldown.delete(refreshCooldown.keys().next().value);
            }
            Promise.resolve(sock.assertSessions([jid], true)).catch(() => {});
          }
        }
        throw err;
      }
    };
  }

  if (typeof repo.decryptMessage === 'function') {
    const origDecryptMessage = repo.decryptMessage.bind(repo);
    repo.decryptMessage = async (opts) => {
      try {
        return await origDecryptMessage(opts);
      } catch (err) {
        const msg = err?.message || String(err);
        if (err?.name !== 'MessageCounterError' && !msg.includes('Key used already')) {
          logError?.('Signal Decrypt Failure', null, opts?.jid || null, msg);
        }
        throw err;
      }
    };
  }

  if (typeof repo.decryptGroupMessage === 'function') {
    const origDecryptGroupMessage = repo.decryptGroupMessage.bind(repo);
    repo.decryptGroupMessage = async (opts) => {
      try {
        return await origDecryptGroupMessage(opts);
      } catch (err) {
        const msg = err?.message || String(err);
        if (err?.name !== 'MessageCounterError' && !msg.includes('Key used already')) {
          logError?.('Signal Group Decrypt Failure', null, opts?.group || null, msg);
        }
        throw err;
      }
    };
  }

  return true;
}

export function wrapAckErrorRecovery(
  sock,
  { groupCache = null, userDevicesCache = null, logError = null } = {},
) {
  if (!sock?.ev || typeof sock.ev.on !== 'function') return false;
  const recentRecoveryCooldown = new Map();
  const COOLDOWN_MS = 10_000;

  sock.ev.on('messages.update', (updates) => {
    if (!Array.isArray(updates)) return;
    for (const entry of updates) {
      const status = entry?.update?.status;
      const stubParams = entry?.update?.messageStubParameters;
      const errorCode = Array.isArray(stubParams) && stubParams.length > 0 ? String(stubParams[0]) : '';
      const isErrorUpdate = status === 0 || (errorCode && /^(?:421|463|475|479)$/.test(errorCode));
      if (!isErrorUpdate) continue;

      const remoteJid = entry?.key?.remoteJid || '';
      const msgId = entry?.key?.id || '';
      const cooldownKey = `${remoteJid}:${errorCode}`;
      const now = Date.now();
      const last = recentRecoveryCooldown.get(cooldownKey) || 0;
      if (now - last < COOLDOWN_MS) continue;
      recentRecoveryCooldown.set(cooldownKey, now);
      if (recentRecoveryCooldown.size > 300) {
        recentRecoveryCooldown.delete(recentRecoveryCooldown.keys().next().value);
      }

      logError?.(
        'Message Delivery Error',
        null,
        remoteJid || null,
        `Ack error ${errorCode || 'unknown'} for message ${msgId || '(unknown)'}`,
      );

      if (!remoteJid) continue;

      if (errorCode === '421' && remoteJid.endsWith('@g.us')) {
        groupCache?.delete?.(remoteJid);
        if (typeof sock.groupMetadata === 'function') {
          Promise.resolve(sock.groupMetadata(remoteJid)).catch(() => {});
        }
      } else if (errorCode === '479') {
        clearCachedUserDevices(userDevicesCache, remoteJid);
        if (remoteJid.endsWith('@g.us')) {
          groupCache?.delete?.(remoteJid);
          const keysSet = sock?.authState?.keys?.set;
          if (typeof keysSet === 'function') {
            const meId = sock.authState?.creds?.me?.id;
            const meLid = sock.authState?.creds?.me?.lid;
            const clears = { [remoteJid]: null };
            if (meId) clears[`${remoteJid}:${meId}`] = null;
            if (meLid) clears[`${remoteJid}:${meLid}`] = null;
            Promise.resolve(keysSet({ 'sender-key-memory': clears })).catch(() => {});
          }
        } else if (
          typeof sock.assertSessions === 'function' &&
          (isPnOrHostedPnJid(remoteJid) || isLidOrHostedLidJid(remoteJid))
        ) {
          Promise.resolve(sock.assertSessions([remoteJid], true)).catch(() => {});
        }
      } else if (errorCode === '463') {
        clearCachedUserDevices(userDevicesCache, remoteJid);
        void ensureAppStateSynced(sock, { logError });
      }
    }
  });

  return true;
}

export function wrapSendOptionsNormalization(sock) {
  if (!sock || typeof sock.sendMessage !== 'function') return false;
  if (sock.sendMessage.__spiderOptsNormalized) return true;

  const origSendMessage = sock.sendMessage.bind(sock);
  const wrappedSend = async (jid, content, options) => {
    let nextOptions = options;
    if (
      options &&
      typeof options === 'object' &&
      !Array.isArray(options) &&
      options.quoted &&
      options.ephemeralExpiration === undefined
    ) {
      const exp = extractEphemeralExpiration(options.quoted);
      if (exp && exp > 0) {
        nextOptions = { ...options, ephemeralExpiration: exp };
      }
    }
    return origSendMessage(jid, content, nextOptions);
  };
  wrappedSend.__spiderOptsNormalized = true;
  sock.sendMessage = wrappedSend;
  return true;
}

export function installSocketResilience(
  sock,
  {
    authDir = '',
    fsImpl = fs,
    groupCache = null,
    userDevicesCache = null,
    failedEncryptJids = null,
    defaultPushName = 'Spider Man',
    logInfo = console.log,
    logError = null,
  } = {},
) {
  if (!sock || typeof sock !== 'object') return false;
  if (wrappedSockets.has(sock)) return true;

  wrapLidMappingResilience(sock, { logError });
  wrapSignalAndSenderKeyGuard(sock, { failedEncryptJids, userDevicesCache, logError });
  wrapAckErrorRecovery(sock, { groupCache, userDevicesCache, logError });
  wrapSendOptionsNormalization(sock);
  wrapPresenceResilience(sock, { defaultPushName });

  if (sock?.ev && typeof sock.ev.on === 'function') {
    let appStateFallbackTimer = null;
    sock.ev.on('connection.update', ({ connection, receivedPendingNotifications }) => {
      if (connection === 'close') {
        if (appStateFallbackTimer) {
          clearTimeout(appStateFallbackTimer);
          appStateFallbackTimer = null;
        }
      }
      if (connection === 'open') {
        normalizeMeCredentials(sock.authState?.creds);
        void ensureHealthyPreKeys(sock, { authDir, fsImpl, logInfo, logError });
        void ensureActiveOnlinePresence(sock, { defaultPushName, logError });
        if (!appStateSyncedSockets.has(sock) && !appStateFallbackTimer) {
          appStateFallbackTimer = setTimeout(() => {
            appStateFallbackTimer = null;
            void ensureAppStateSynced(sock, { logInfo, logError });
          }, 1500);
          appStateFallbackTimer?.unref?.();
        }
      }
      if (receivedPendingNotifications) {
        if (appStateFallbackTimer) {
          clearTimeout(appStateFallbackTimer);
          appStateFallbackTimer = null;
        }
        void ensureAppStateSynced(sock, { logInfo, logError });
      }
    });
    sock.ev.on('creds.update', (update) => {
      if (update && typeof update === 'object' && update.myAppStateKeyId) {
        appStateSyncedSockets.delete(sock);
        void ensureAppStateSynced(sock, { logInfo, logError });
      }
    });
  }

  wrappedSockets.add(sock);
  return true;
}
