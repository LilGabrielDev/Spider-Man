import fs from 'node:fs';
import { createRequire } from 'node:module';
import { proto } from '@whiskeysockets/baileys';
import { normalizeAuthCreds, normalizeMeCredentials, parseJidParts } from './authState.js';
import { installConsoleSignalSanitizer } from './privacyLogger.js';
import { cleanUserJid } from './userJid.js';

const require = createRequire(import.meta.url);
let cachedHasLinkPreviewPkg = null;
function isLinkPreviewAvailable() {
  if (cachedHasLinkPreviewPkg === null) {
    try {
      require.resolve('link-preview-js');
      cachedHasLinkPreviewPkg = true;
    } catch {
      cachedHasLinkPreviewPkg = false;
    }
  }
  return cachedHasLinkPreviewPkg;
}

const wrappedSockets = new WeakSet();
const preKeyCheckedSockets = new WeakSet();
const preKeyRetryTimers = new WeakMap();
const preKeyRetryAttempts = new WeakMap();
const preKeyWriteCounters = new WeakMap();
const appStateSyncedSockets = new WeakSet();
const appStateInFlightSockets = new WeakSet();
const appStateRetryTimers = new WeakMap();
const appStateRetryAttempts = new WeakMap();
const appStateKeyRequestCooldowns = new WeakMap();
const appStateKeyInFlight = new WeakMap();
const statusReactionTargetsBySock = new WeakMap();
const VALID_PN_DOMAINS = new Set(['s.whatsapp.net', 'hosted', 'c.us']);
export const DEFAULT_PREKEY_RETRY_DELAY_MS = 5_500;
export const MAX_PREKEY_THROTTLE_RETRIES = 4;
export const ALL_APP_STATE_COLLECTIONS = [
  'critical_block',
  'critical_unblock_low',
  'regular_high',
  'regular_low',
  'regular',
];

function recordPreKeyWriteIfPresent(keys, data) {
  if (!keys || !data || typeof data !== 'object') return;
  const preKeys = data['pre-key'];
  if (preKeys && typeof preKeys === 'object' && Object.keys(preKeys).length > 0) {
    preKeyWriteCounters.set(keys, (preKeyWriteCounters.get(keys) || 0) + 1);
  }
}

function getPreKeyWriteCount(keys) {
  return keys ? preKeyWriteCounters.get(keys) || 0 : 0;
}

function clearPreKeyRetryTimer(sock) {
  if (!sock || typeof sock !== 'object') return;
  const timer = preKeyRetryTimers.get(sock);
  if (timer) {
    clearTimeout(timer);
    preKeyRetryTimers.delete(sock);
  }
}

function clearAppStateRetryTimer(sock) {
  if (!sock || typeof sock !== 'object') return;
  const timer = appStateRetryTimers.get(sock);
  if (timer) {
    clearTimeout(timer);
    appStateRetryTimers.delete(sock);
  }
}

function ensurePreKeyWriteTracking(keys) {
  if (!keys || typeof keys.set !== 'function') return false;
  if (keys.__spiderGuarded || keys.__spiderPreKeyTracked) return true;
  const origSet = keys.set.bind(keys);
  keys.set = async (data) => {
    recordPreKeyWriteIfPresent(keys, data);
    return origSet(data);
  };
  keys.__spiderPreKeyTracked = true;
  return true;
}

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
    retryDelayMs = DEFAULT_PREKEY_RETRY_DELAY_MS,
    maxRetries = MAX_PREKEY_THROTTLE_RETRIES,
    retryOnThrottle = true,
    isSocketActive = null,
    logInfo = console.log,
    logError = null,
  } = {},
) {
  if (!sock || typeof sock.uploadPreKeys !== 'function') return false;
  if (preKeyCheckedSockets.has(sock)) return false;

  const keysObj = sock?.authState?.keys;
  const hasObservableKeysSet = ensurePreKeyWriteTracking(keysObj);

  const nextPreKeyId = Number(sock?.authState?.creds?.nextPreKeyId || 0);
  const localCount = authDir ? countLocalPreKeyFiles(authDir, fsImpl) : 0;

  let currentExists = true;
  if (nextPreKeyId > 1 && typeof keysObj?.get === 'function') {
    try {
      const currentId = String(nextPreKeyId - 1);
      const res = await keysObj.get('pre-key', [currentId]);
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
    clearPreKeyRetryTimer(sock);
    preKeyRetryAttempts.delete(sock);
    preKeyCheckedSockets.add(sock);
    return false;
  }

  const firstUnuploaded = Number(sock?.authState?.creds?.firstUnuploadedPreKeyId || 0);
  if (
    nextPreKeyId > 1 &&
    firstUnuploaded > 0 &&
    firstUnuploaded < nextPreKeyId &&
    typeof keysObj?.get === 'function'
  ) {
    try {
      const checkRes = await keysObj.get('pre-key', [String(firstUnuploaded)]);
      if (!checkRes?.[String(firstUnuploaded)]) {
        sock.authState.creds.firstUnuploadedPreKeyId = nextPreKeyId;
      }
    } catch {
      sock.authState.creds.firstUnuploadedPreKeyId = nextPreKeyId;
    }
  }

  const writesBefore = getPreKeyWriteCount(keysObj);
  preKeyCheckedSockets.add(sock);
  try {
    await sock.uploadPreKeys(replenishCount);

    const writesAfter = getPreKeyWriteCount(keysObj);
    const afterNextPreKeyId = Number(sock?.authState?.creds?.nextPreKeyId || 0);
    const afterLocalCount = authDir ? countLocalPreKeyFiles(authDir, fsImpl) : localCount;
    const uploadExecuted =
      !hasObservableKeysSet ||
      writesAfter > writesBefore ||
      afterNextPreKeyId > nextPreKeyId ||
      afterLocalCount > localCount;

    if (!uploadExecuted) {
      // Baileys uploadPreKeys silently returns early within MIN_UPLOAD_INTERVAL (5000ms) right
      // after CB:success's initial uploadPreKeysToServerIfRequired(). Do not mark done; retry later.
      preKeyCheckedSockets.delete(sock);
      const attempts = preKeyRetryAttempts.get(sock) || 0;
      if (retryOnThrottle && attempts < maxRetries && !preKeyRetryTimers.has(sock)) {
        preKeyRetryAttempts.set(sock, attempts + 1);
        const timer = setTimeout(() => {
          preKeyRetryTimers.delete(sock);
          if (typeof isSocketActive === 'function' && !isSocketActive()) return;
          void ensureHealthyPreKeys(sock, {
            authDir,
            fsImpl,
            minLocalPreKeys,
            replenishCount,
            retryDelayMs,
            maxRetries,
            retryOnThrottle,
            isSocketActive,
            logInfo,
            logError,
          });
        }, Math.max(0, Number(retryDelayMs) || DEFAULT_PREKEY_RETRY_DELAY_MS));
        timer?.unref?.();
        preKeyRetryTimers.set(sock, timer);
      }
      return false;
    }

    clearPreKeyRetryTimer(sock);
    preKeyRetryAttempts.delete(sock);
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
  {
    logInfo = null,
    logError = null,
    retryDelayMs = 8_000,
    maxPartialRetries = 2,
    isSocketActive = null,
  } = {},
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
  if (typeof isSocketActive === 'function' && !isSocketActive()) {
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
      clearAppStateRetryTimer(sock);
      appStateRetryAttempts.delete(sock);
      appStateSyncedSockets.add(sock);
      return false;
    }

    const myKeyId = String(sock.authState?.creds?.myAppStateKeyId || '').trim();
    if (myKeyId) {
      void requestMissingAppStateSyncKeys(sock, myKeyId, { logInfo });
    }

    await sock.resyncAppState(unsynced, true);

    const afterVersions = await sock.authState.keys.get(
      'app-state-sync-version',
      unsynced,
    );
    const syncedNow = unsynced.filter((name) => Boolean(afterVersions?.[name]));
    const stillUnsynced = unsynced.filter((name) => !afterVersions?.[name]);
    if (stillUnsynced.length === 0) {
      clearAppStateRetryTimer(sock);
      appStateRetryAttempts.delete(sock);
      appStateSyncedSockets.add(sock);
    } else if (syncedNow.length > 0 && maxPartialRetries > 0 && !appStateRetryTimers.has(sock)) {
      const attempts = appStateRetryAttempts.get(sock) || 0;
      if (attempts < maxPartialRetries) {
        appStateRetryAttempts.set(sock, attempts + 1);
        const delay = Number.isFinite(Number(retryDelayMs)) ? Math.max(0, Number(retryDelayMs)) : 8_000;
        const timer = setTimeout(() => {
          appStateRetryTimers.delete(sock);
          if (typeof isSocketActive === 'function' && !isSocketActive()) return;
          void ensureAppStateSynced(sock, {
            logInfo,
            logError,
            retryDelayMs,
            maxPartialRetries,
            isSocketActive,
          });
        }, delay);
        timer?.unref?.();
        appStateRetryTimers.set(sock, timer);
      }
    }
    if (syncedNow.length > 0) {
      logInfo?.(
        `[APP-STATE] Synced ${syncedNow.length} app-state collection(s): ${syncedNow.join(', ')}`,
      );
      return true;
    }
    return false;
  } catch (err) {
    logError?.('App State Sync', null, null, err?.message || String(err));
    return false;
  } finally {
    appStateInFlightSockets.delete(sock);
  }
}

export async function requestMissingAppStateSyncKeys(
  sock,
  keyIds,
  { logInfo = null, cooldownMs = 60_000 } = {},
) {
  if (!sock || typeof sock.sendPeerMessage !== 'function') return false;
  const list = Array.isArray(keyIds) ? keyIds : [keyIds];
  const uniqueIds = Array.from(
    new Set(list.map((id) => String(id || '').trim()).filter(Boolean)),
  );
  if (uniqueIds.length === 0) return false;

  let cooldownMap = appStateKeyRequestCooldowns.get(sock);
  if (!cooldownMap) {
    cooldownMap = new Map();
    appStateKeyRequestCooldowns.set(sock, cooldownMap);
  }
  let inFlightSet = appStateKeyInFlight.get(sock);
  if (!inFlightSet) {
    inFlightSet = new Set();
    appStateKeyInFlight.set(sock, inFlightSet);
  }

  const now = Date.now();
  const candidates = [];
  for (const b64KeyId of uniqueIds) {
    if (inFlightSet.has(b64KeyId)) continue;
    const lastReq = cooldownMap.get(b64KeyId) || 0;
    if (now - lastReq < cooldownMs) continue;
    let decoded;
    try {
      decoded = Buffer.from(b64KeyId, 'base64');
    } catch {
      decoded = null;
    }
    if (!decoded || decoded.length === 0) continue;
    candidates.push({ b64KeyId, buf: decoded });
  }
  if (candidates.length === 0) return false;

  for (const item of candidates) {
    inFlightSet.add(item.b64KeyId);
  }

  try {
    // Skip keys already present in local store
    let toRequest = candidates;
    const keysGet = sock?.authState?.keys?.get;
    if (typeof keysGet === 'function') {
      try {
        const existing = await keysGet(
          'app-state-sync-key',
          candidates.map((c) => c.b64KeyId),
        );
        toRequest = candidates.filter((c) => !existing?.[c.b64KeyId]);
      } catch {
        // Proceed with candidates
      }
    }
    if (toRequest.length === 0) return false;

    const reqTime = Date.now();
    for (const item of toRequest) {
      cooldownMap.set(item.b64KeyId, reqTime);
      if (cooldownMap.size > 100) {
        cooldownMap.delete(cooldownMap.keys().next().value);
      }
    }

    const requestType = proto?.Message?.ProtocolMessage?.Type?.APP_STATE_SYNC_KEY_REQUEST ?? 7;
    try {
      await sock.sendPeerMessage({
        protocolMessage: {
          type: requestType,
          appStateSyncKeyRequest: {
            keyIds: toRequest.map((item) => ({ keyId: item.buf })),
          },
        },
      });
      logInfo?.(
        `[APP-STATE] Requested ${toRequest.length} missing app-state sync key(s) from primary device`,
      );
      return true;
    } catch {
      return false;
    }
  } finally {
    for (const item of candidates) {
      inFlightSet.delete(item.b64KeyId);
    }
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

function stripPartialEncryptErrors(iqResult, logError, { userDevicesCache = null } = {}) {
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
      if (child?.attrs?.jid) {
        clearCachedUserDevices(userDevicesCache, child.attrs.jid);
      }
    } else {
      validUsers.push(child);
    }
  }

  // Only strip failed <user> children if at least one valid user bundle survived
  // (avoids marking nonexistent sessions true in peerSessionsCache when all fail).
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

export function wrapWebSocketTagSanitizer(sock, { userDevicesCache = null, logError = null } = {}) {
  const ws = sock?.ws;
  if (!ws || typeof ws.emit !== 'function') return false;

  const state = ws.__spiderTagState || { userDevicesCache, logError };
  if (userDevicesCache) state.userDevicesCache = userDevicesCache;
  if (logError) state.logError = logError;
  ws.__spiderTagState = state;

  if (ws.__spiderTagSanitizerWrapped) return true;
  const origEmit = ws.emit.bind(ws);
  ws.emit = (event, ...args) => {
    if (
      typeof event === 'string' &&
      event.startsWith('TAG:') &&
      args[0] &&
      typeof args[0] === 'object' &&
      args[0].tag === 'iq' &&
      args[0].attrs?.type === 'result' &&
      Array.isArray(args[0].content)
    ) {
      const sanitized = stripPartialEncryptErrors(args[0], state.logError, {
        userDevicesCache: state.userDevicesCache,
      });
      if (sanitized && sanitized !== args[0]) {
        args[0] = sanitized;
      }
    }
    return origEmit(event, ...args);
  };
  ws.__spiderTagSanitizerWrapped = true;
  return true;
}

export function wrapLidMappingResilience(sock, { logError = null, userDevicesCache = null } = {}) {
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
        return stripPartialEncryptErrors(rawRes, logError, { userDevicesCache });
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

  const guardedStore = {
    __spiderGuarded: true,
    __failedEncryptJids: failureMap,
    get: (...args) => keys.get(...args),
    clear: keys.clear ? (...args) => keys.clear(...args) : undefined,
    set: async (data) => {
      recordPreKeyWriteIfPresent(guardedStore, data);
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

  return guardedStore;
}

function isTransientRetryableDecryptError(msg, err) {
  if (err?.name === 'MessageCounterError') return true;
  const text = String(msg || err?.message || '');
  return (
    text.includes('Key used already') ||
    text.includes('Invalid PreKey ID') ||
    text.includes('No session record') ||
    text.includes('No session found') ||
    text.includes('No SenderKeyRecord found') ||
    text.includes('No matching sessions found') ||
    text.includes('No sessions available') ||
    text.includes('InvalidMessageException') ||
    text.includes('Received message with old counter') ||
    text.includes('Bad MAC')
  );
}

function isMacOrMissingSessionError(msg) {
  const text = String(msg || '');
  return (
    text.includes('No session record') ||
    text.includes('No matching sessions found') ||
    text.includes('No sessions available') ||
    text.includes('Bad MAC')
  );
}

function normalizeDecryptErrorForDedupe(msg) {
  return String(msg || '')
    .replace(/keyId=[^,\s]+/g, 'keyId=*')
    .replace(/group=[^,\s]+/g, 'group=*')
    .slice(0, 140);
}

function shouldEmitDecryptLog(state, context, target, msg, cooldownMs = 15_000) {
  const key = `${context}:${target || ''}:${normalizeDecryptErrorForDedupe(msg)}`;
  const now = Date.now();
  const prev = state.decryptLogCooldown.get(key) || 0;
  if (now - prev < cooldownMs) return false;
  state.decryptLogCooldown.set(key, now);
  if (state.decryptLogCooldown.size > 300) {
    state.decryptLogCooldown.delete(state.decryptLogCooldown.keys().next().value);
  }
  return true;
}

async function resetBrokenSessionForDecrypt(state, repo, opts, errorMsg = '') {
  const jid = opts?.jid;
  if (!jid || opts?.stateless) return false;
  clearCachedUserDevices(state.userDevicesCache, jid);
  const scope = opts?.scope ? String(opts.scope) : '';
  const cooldownKey = `${jid}:${scope || 'default'}`;
  const errText = String(errorMsg || '');
  const isMissingSessionOnly =
    errText.includes('No session record') &&
    !errText.includes('Bad MAC') &&
    !errText.includes('No matching sessions found');
  const now = Date.now();
  if (!isMissingSessionOnly) {
    const lastReset = state.decryptCooldown.get(cooldownKey) || 0;
    if (now - lastReset < 5_000) return false;
    state.decryptCooldown.set(cooldownKey, now);
    if (state.decryptCooldown.size > 300) {
      state.decryptCooldown.delete(state.decryptCooldown.keys().next().value);
    }
  }

  const keysObj = state.sock?.authState?.keys || state.keys;
  if (!scope) {
    let deletedViaRepo = false;
    if (typeof repo.deleteSession === 'function') {
      try {
        await repo.deleteSession([jid]);
        deletedViaRepo = true;
      } catch {
        // Fallback to direct key clear below
      }
    }
    const isHostedJid =
      String(jid).toLowerCase().endsWith('@hosted') ||
      String(jid).toLowerCase().endsWith('@hosted.lid');
    if (
      (!deletedViaRepo || isHostedJid) &&
      typeof keysObj?.set === 'function' &&
      typeof repo.jidToSignalProtocolAddress === 'function'
    ) {
      try {
        const addr = String(repo.jidToSignalProtocolAddress(jid));
        await keysObj.set({ session: { [addr]: null } });
        return true;
      } catch {
        return deletedViaRepo;
      }
    }
    return deletedViaRepo;
  }

  // Status-scoped (or other explicit scope) session corruption: delete ONLY the scoped session
  // so default DM sessions and group sender keys remain intact.
  if (typeof keysObj?.set !== 'function' || typeof repo.jidToSignalProtocolAddress !== 'function') {
    return false;
  }
  try {
    const clears = {};
    const primaryAddr = String(repo.jidToSignalProtocolAddress(jid));
    clears[`${primaryAddr}_${scope}`] = null;

    if (repo.lidMapping) {
      try {
        if (isPnOrHostedPnJid(jid) && typeof repo.lidMapping.getLIDForPN === 'function') {
          const lid = await repo.lidMapping.getLIDForPN(jid);
          if (lid) {
            clearCachedUserDevices(state.userDevicesCache, lid);
            const lidAddr = String(repo.jidToSignalProtocolAddress(lid));
            clears[`${lidAddr}_${scope}`] = null;
          }
        } else if (isLidOrHostedLidJid(jid) && typeof repo.lidMapping.getPNForLID === 'function') {
          const pn = await repo.lidMapping.getPNForLID(jid);
          if (pn) {
            clearCachedUserDevices(state.userDevicesCache, pn);
            const pnAddr = String(repo.jidToSignalProtocolAddress(pn));
            clears[`${pnAddr}_${scope}`] = null;
          }
        }
      } catch {
        // Best-effort alias clear
      }
    }
    await keysObj.set({ session: clears });
    return true;
  } catch {
    return false;
  }
}

function wrapSignalRepositoryObject(repo, ctx = {}) {
  if (!repo || typeof repo !== 'object') return false;

  const state = repo.__spiderCtx || {
    sock: null,
    creds: null,
    keys: null,
    authDir: '',
    trackedFailures: new Map(),
    userDevicesCache: null,
    logError: null,
    refreshCooldown: new Map(),
    decryptCooldown: new Map(),
    decryptLogCooldown: new Map(),
    preKeyReplenishAt: 0,
  };

  if (ctx.sock) state.sock = ctx.sock;
  if (ctx.creds) state.creds = ctx.creds;
  if (ctx.keys) state.keys = ctx.keys;
  if (ctx.authDir) state.authDir = ctx.authDir;
  if (ctx.failedEncryptJids instanceof Map) state.trackedFailures = ctx.failedEncryptJids;
  else if (ctx.sock?.authState?.keys?.__failedEncryptJids instanceof Map) {
    state.trackedFailures = ctx.sock.authState.keys.__failedEncryptJids;
  }
  if (ctx.userDevicesCache) state.userDevicesCache = ctx.userDevicesCache;
  if (ctx.logError) state.logError = ctx.logError;
  repo.__spiderCtx = state;

  if (repo.__spiderSignalRepoWrapped) return true;
  repo.__spiderSignalRepoWrapped = true;

  const getCredsMe = () => state.sock?.authState?.creds?.me || state.creds?.me;

  if (typeof repo.encryptGroupMessage === 'function') {
    const origEncryptGroup = repo.encryptGroupMessage.bind(repo);
    repo.encryptGroupMessage = async (opts) => {
      if (opts && typeof opts === 'object' && opts.meId) {
        const nextMeId = resolveEffectiveLidIdentity(opts.meId, getCredsMe());
        if (nextMeId !== opts.meId) {
          opts = { ...opts, meId: nextMeId };
        }
      }
      try {
        return await origEncryptGroup(opts);
      } catch (err) {
        state.logError?.('Signal Group Encrypt', null, opts?.group || null, err?.message || String(err));
        throw err;
      }
    };
  }

  if (typeof repo.hasSenderKey === 'function') {
    const origHasSenderKey = repo.hasSenderKey.bind(repo);
    repo.hasSenderKey = async (opts) => {
      if (opts && typeof opts === 'object' && opts.meId) {
        const nextMeId = resolveEffectiveLidIdentity(opts.meId, getCredsMe());
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
        const nextMeId = resolveEffectiveLidIdentity(opts.meId, getCredsMe());
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
          clearCachedUserDevices(state.userDevicesCache, jid);
          const now = Date.now();
          const lastRefresh = state.refreshCooldown.get(jid) || 0;
          const assertSessions = state.sock?.assertSessions;
          if (typeof assertSessions === 'function' && now - lastRefresh >= 10_000) {
            state.refreshCooldown.set(jid, now);
            if (state.refreshCooldown.size > 200) {
              state.refreshCooldown.delete(state.refreshCooldown.keys().next().value);
            }
            let waitTimer = null;
            try {
              await Promise.race([
                Promise.resolve(assertSessions.call(state.sock, [jid], true)),
                new Promise((resolve) => {
                  waitTimer = setTimeout(resolve, 12_000);
                  waitTimer?.unref?.();
                }),
              ]);
            } catch {
              // Ignore recovery assertion failure and check retry/fallback below
            } finally {
              if (waitTimer) clearTimeout(waitTimer);
            }
            try {
              const recovered = await origEncryptMessage(opts);
              state.trackedFailures.delete(jid);
              return recovered;
            } catch {
              // Fall through to failure recording & rethrow original/recovery error
            }
          }

          state.trackedFailures.set(jid, Date.now());
          if (state.trackedFailures.size > 500) {
            state.trackedFailures.delete(state.trackedFailures.keys().next().value);
          }
          state.logError?.('Signal Encrypt Failure', null, jid, err?.message || String(err));
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
        let outErr = err;
        const msg = err?.message || String(err);

        if (isMacOrMissingSessionError(msg) && !opts?.stateless && opts?.jid) {
          await resetBrokenSessionForDecrypt(state, repo, opts, msg);
          // Baileys messages-recv.js checks `Bad MAC` / `No session found` to set
          // `isSessionError = true` + `forceIncludeKeys = true`, whereas libsignal.js throws
          // `No matching sessions found for message`. Ensure Bad MAC is present so retry #1
          // includes fresh pre-keys and triggers immediate session renegotiation.
          if (!msg.includes('Bad MAC')) {
            const wrapped = new Error(`Bad MAC: ${msg}`);
            if (err?.name) wrapped.name = err.name;
            if (err?.stack) wrapped.stack = err.stack;
            outErr = wrapped;
          }
        } else if (msg.includes('Invalid PreKey ID') && state.sock) {
          const now = Date.now();
          if (now - state.preKeyReplenishAt >= 10_000) {
            state.preKeyReplenishAt = now;
            void ensureHealthyPreKeys(state.sock, {
              authDir: state.authDir,
              logInfo: null,
              logError: null,
            });
          }
        }

        if (
          !isTransientRetryableDecryptError(msg, err) &&
          shouldEmitDecryptLog(state, 'Signal Decrypt Failure', opts?.jid, msg)
        ) {
          state.logError?.('Signal Decrypt Failure', null, opts?.jid || null, msg);
        }
        throw outErr;
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
        if (
          !isTransientRetryableDecryptError(msg, err) &&
          shouldEmitDecryptLog(state, 'Signal Group Decrypt Failure', opts?.group, msg)
        ) {
          state.logError?.('Signal Group Decrypt Failure', null, opts?.group || null, msg);
        }
        throw err;
      }
    };
  }

  return true;
}

export function createHardenedSignalRepository(
  baseFactory,
  { failedEncryptJids = null, userDevicesCache = null, logError = null } = {},
) {
  if (typeof baseFactory !== 'function') {
    throw new TypeError('baseFactory must be a function');
  }
  return (auth, logger, pnToLIDFunc) => {
    normalizeAuthCreds(auth?.creds);
    const repo = baseFactory(auth, logger, pnToLIDFunc);
    wrapSignalRepositoryObject(repo, {
      creds: auth?.creds || null,
      keys: auth?.keys || null,
      failedEncryptJids,
      userDevicesCache,
      logError,
    });
    return repo;
  };
}

export function wrapSignalAndSenderKeyGuard(
  sock,
  { failedEncryptJids = null, userDevicesCache = null, logError = null, authDir = '' } = {},
) {
  if (!sock || typeof sock !== 'object') return false;
  if (sock.__spiderSignalGuardWrapped) {
    wrapSignalRepositoryObject(sock.signalRepository, {
      sock,
      creds: sock.authState?.creds || null,
      keys: sock.authState?.keys || null,
      authDir,
      failedEncryptJids,
      userDevicesCache,
      logError,
    });
    return true;
  }
  sock.__spiderSignalGuardWrapped = true;

  normalizeAuthCreds(sock.authState?.creds);

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
      normalizeAuthCreds(sock.authState?.creds);
    });
  }

  wrapSignalRepositoryObject(sock.signalRepository, {
    sock,
    creds: sock.authState?.creds || null,
    keys: sock.authState?.keys || null,
    authDir,
    failedEncryptJids,
    userDevicesCache,
    logError,
  });

  return true;
}

export function wrapAckErrorRecovery(
  sock,
  { groupCache = null, userDevicesCache = null, logError = null, logInfo = () => {} } = {},
) {
  if (!sock?.ev || typeof sock.ev.on !== 'function') return false;
  const recentRecoveryCooldown = new Map();
  const recentStatusByKey = new Map();
  const statusLabels = {
    0: 'error',
    1: 'pending',
    2: 'server_ack',
    3: 'delivered',
    4: 'read',
    5: 'played',
  };
  const COOLDOWN_MS = 10_000;

  sock.ev.on('messages.update', (updates) => {
    if (!Array.isArray(updates)) return;
    for (const entry of updates) {
      const key = entry?.key;
      const status = entry?.update?.status;
      const remoteJid = key?.remoteJid || '';
      const msgId = key?.id || '';
      if (key?.fromMe && status !== undefined) {
        const statusKey = `${remoteJid}:${msgId}`;
        if (recentStatusByKey.get(statusKey) !== status) {
          recentStatusByKey.set(statusKey, status);
          if (recentStatusByKey.size > 500) {
            recentStatusByKey.delete(recentStatusByKey.keys().next().value);
          }
          const chatType = remoteJid.endsWith('@g.us') ? 'group' : 'direct';
          logInfo?.(`[WA-DELIVERY] ${chatType} status=${statusLabels[status] || 'unknown'}`);
        }
      }
      const stubParams = entry?.update?.messageStubParameters;
      const errorCode = Array.isArray(stubParams) && stubParams.length > 0 ? String(stubParams[0]) : '';
      const isErrorUpdate = status === 0 || (errorCode && /^(?:421|463|475|479)$/.test(errorCode));
      if (!isErrorUpdate) continue;

      const cooldownKey = `${remoteJid}:${errorCode}`;
      const now = Date.now();
      const last = recentRecoveryCooldown.get(cooldownKey) || 0;
      if (now - last < COOLDOWN_MS) continue;
      recentRecoveryCooldown.set(cooldownKey, now);
      if (recentRecoveryCooldown.size > 300) {
        recentRecoveryCooldown.delete(recentRecoveryCooldown.keys().next().value);
      }

      if (remoteJid === 'status@broadcast' && errorCode === '400') {
        const trackedTargets = statusReactionTargetsBySock.get(sock)?.get(msgId);
        if (Array.isArray(trackedTargets)) {
          for (const targetJid of trackedTargets) {
            clearCachedUserDevices(userDevicesCache, targetJid);
          }
          statusReactionTargetsBySock.get(sock)?.delete(msgId);
        }
        continue;
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
      } else if (errorCode === '475') {
        clearCachedUserDevices(userDevicesCache, remoteJid);
        if (remoteJid.endsWith('@g.us')) {
          groupCache?.delete?.(remoteJid);
          if (typeof sock.groupMetadata === 'function') {
            Promise.resolve(sock.groupMetadata(remoteJid)).catch(() => {});
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

function normalizeBroadcastUserJid(jid) {
  const cleaned = cleanUserJid(jid);
  if (!cleaned) return '';
  const lower = cleaned.toLowerCase();
  if (
    lower === 'status@broadcast' ||
    lower.endsWith('@g.us') ||
    lower.endsWith('@broadcast') ||
    lower.endsWith('@newsletter')
  ) {
    return '';
  }
  return cleaned.includes('@') ? cleaned : '';
}

function isOwnBroadcastAccount(jid, sock) {
  const target = normalizeBroadcastUserJid(jid);
  if (!target) return false;
  const targetLower = target.toLowerCase();
  const targetUser = extractUserPart(target);
  const meCandidates = [
    sock?.authState?.creds?.me?.id,
    sock?.authState?.creds?.me?.lid,
    sock?.user?.id,
    sock?.user?.lid,
  ];
  for (const rawMe of meCandidates) {
    const cleanMe = normalizeBroadcastUserJid(rawMe);
    if (!cleanMe) continue;
    if (cleanMe.toLowerCase() === targetLower) return true;
    if (targetUser && extractUserPart(cleanMe) === targetUser) return true;
  }
  return false;
}

async function resolveStatusTargetToLid(jid, sock) {
  const cleaned = normalizeBroadcastUserJid(jid);
  if (!cleaned) return '';
  if (isLidOrHostedLidJid(cleaned)) return cleaned;
  const lidMapping = sock?.signalRepository?.lidMapping;
  if (!lidMapping) return cleaned;
  try {
    if (typeof lidMapping.getLIDForPN === 'function') {
      const mapped = await lidMapping.getLIDForPN(cleaned);
      const cleanMapped = normalizeBroadcastUserJid(mapped);
      if (cleanMapped) return cleanMapped;
    }
    if (typeof lidMapping.getKnownLIDsForPNs === 'function') {
      const known = await lidMapping.getKnownLIDsForPNs([cleaned]);
      const pair = Array.isArray(known) ? known.find((p) => p?.lid) : null;
      const cleanMapped = normalizeBroadcastUserJid(pair?.lid);
      if (cleanMapped) return cleanMapped;
    }
  } catch {
    // Fallback to cleaned JID
  }
  return cleaned;
}

export async function resetGroupSenderKeyMemory(sock, groupJid) {
  if (typeof groupJid !== 'string' || !groupJid.endsWith('@g.us')) return false;
  const keyStore = sock?.authState?.keys;
  if (!keyStore || typeof keyStore.set !== 'function') return false;

  const memoryToClear = { [groupJid]: null };
  const me = sock.authState?.creds?.me || {};
  for (const identity of [me.id, me.lid]) {
    if (typeof identity === 'string' && identity.trim()) {
      memoryToClear[`${groupJid}:${identity}`] = null;
    }
  }

  await keyStore.set({ 'sender-key-memory': memoryToClear });
  return true;
}

export function wrapSendOptionsNormalization(sock, { logError = null } = {}) {
  if (!sock || typeof sock.sendMessage !== 'function') return false;
  if (sock.sendMessage.__spiderOptsNormalized) return true;

  const origSendMessage = sock.sendMessage.bind(sock);
  const wrappedSend = async (jid, content, options) => {
    const isEphemeralToggle =
      content &&
      typeof content === 'object' &&
      Object.prototype.hasOwnProperty.call(content, 'disappearingMessagesInChat');
    if (typeof jid === 'string' && jid.endsWith('@g.us') && !isEphemeralToggle) {
      try {
        const reset = await resetGroupSenderKeyMemory(sock, jid);
        if (!reset) {
          throw new Error('WhatsApp auth key store is unavailable for group sender-key refresh');
        }
      } catch (err) {
        logError?.('Group Sender-Key Refresh', null, null, err?.message || String(err));
        throw err;
      }
    }

    let nextContent = content;
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

    if (
      !isLinkPreviewAvailable() &&
      content &&
      typeof content === 'object' &&
      !Array.isArray(content) &&
      typeof content.text === 'string' &&
      content.linkPreview === undefined &&
      /(?:https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,})/i.test(content.text) &&
      (!nextOptions || !Object.prototype.hasOwnProperty.call(nextOptions, 'getUrlInfo'))
    ) {
      nextOptions = {
        ...(nextOptions && typeof nextOptions === 'object' && !Array.isArray(nextOptions) ? nextOptions : {}),
        getUrlInfo: undefined,
      };
    }

    if (jid === 'status@broadcast') {
      const hasStatusList = Array.isArray(nextOptions?.statusJidList);
      const isReaction = Boolean(content && typeof content === 'object' && content.react && typeof content.react === 'object');

      if (hasStatusList || isReaction) {
        const resolvedTargets = [];
        const seenTargets = new Set();

        const addResolvedTarget = async (rawTarget) => {
          const cleaned = normalizeBroadcastUserJid(rawTarget);
          if (!cleaned || isOwnBroadcastAccount(cleaned, sock)) return;
          const preferred = isReaction ? await resolveStatusTargetToLid(cleaned, sock) : cleaned;
          if (!preferred || isOwnBroadcastAccount(preferred, sock)) return;
          const dedupeKey = preferred.toLowerCase();
          if (!seenTargets.has(dedupeKey)) {
            seenTargets.add(dedupeKey);
            resolvedTargets.push(preferred);
          }
        };

        if (hasStatusList) {
          for (const rawTarget of nextOptions.statusJidList) {
            await addResolvedTarget(rawTarget);
          }
        }

        if (isReaction && content.react.key && typeof content.react.key === 'object') {
          const rawKey = content.react.key;
          const rawParticipant = rawKey.participant || (resolvedTargets[0] || '');
          let cleanParticipant = normalizeBroadcastUserJid(rawParticipant);
          if (cleanParticipant && !isOwnBroadcastAccount(cleanParticipant, sock)) {
            cleanParticipant = await resolveStatusTargetToLid(cleanParticipant, sock);
          }
          if (!hasStatusList && cleanParticipant && !isOwnBroadcastAccount(cleanParticipant, sock)) {
            await addResolvedTarget(cleanParticipant);
          }

          const cleanKey = {
            remoteJid: 'status@broadcast',
            fromMe: Boolean(rawKey.fromMe),
            id: String(rawKey.id || ''),
            ...(cleanParticipant ? { participant: cleanParticipant } : {}),
            ...(rawKey.isGroupStatus ? { isGroupStatus: true } : {}),
          };

          if (!cleanKey.id || resolvedTargets.length === 0) {
            return {
              key: {
                remoteJid: 'status@broadcast',
                fromMe: true,
                id: cleanKey.id || '',
              },
            };
          }

          nextContent = {
            ...content,
            react: {
              ...content.react,
              key: cleanKey,
            },
          };
          nextOptions = {
            ...(nextOptions || {}),
            statusJidList: resolvedTargets,
          };
        } else if (hasStatusList) {
          nextOptions = {
            ...(nextOptions || {}),
            statusJidList: resolvedTargets,
          };
        }
      }
    }

    const res = await origSendMessage(jid, nextContent, nextOptions);
    if (
      jid === 'status@broadcast' &&
      res?.key?.id &&
      Array.isArray(nextOptions?.statusJidList) &&
      nextOptions.statusJidList.length > 0
    ) {
      let tracked = statusReactionTargetsBySock.get(sock);
      if (!tracked) {
        tracked = new Map();
        statusReactionTargetsBySock.set(sock, tracked);
      }
      tracked.set(res.key.id, nextOptions.statusJidList);
      if (tracked.size > 200) {
        tracked.delete(tracked.keys().next().value);
      }
    }
    return res;
  };
  wrappedSend.__spiderOptsNormalized = true;
  sock.sendMessage = wrappedSend;
  return true;
}

export function wrapOnWhatsAppGuard(sock) {
  if (!sock || typeof sock.onWhatsApp !== 'function') return false;
  if (sock.onWhatsApp.__spiderLidGuarded) return true;

  const origOnWhatsApp = sock.onWhatsApp.bind(sock);
  const guardedOnWhatsApp = async (...jids) => {
    const validTargets = [];
    const lidMapping = sock?.signalRepository?.lidMapping;

    for (const raw of jids) {
      const candidate = String(raw || '').trim();
      if (!candidate) continue;
      if (isLidOrHostedLidJid(candidate)) {
        if (lidMapping && typeof lidMapping.getPNForLID === 'function') {
          try {
            const pn = await lidMapping.getPNForLID(candidate);
            const cleanPn = cleanUserJid(pn);
            if (cleanPn && !isLidOrHostedLidJid(cleanPn)) {
              validTargets.push(cleanPn);
            }
          } catch {
            // Skip unmapped LID
          }
        }
        continue;
      }
      validTargets.push(candidate);
    }

    if (validTargets.length === 0) {
      return [];
    }
    return origOnWhatsApp(...validTargets);
  };
  guardedOnWhatsApp.__spiderLidGuarded = true;
  sock.onWhatsApp = guardedOnWhatsApp;
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
    preKeyRetryDelayMs = DEFAULT_PREKEY_RETRY_DELAY_MS,
    logInfo = console.log,
    logError = null,
  } = {},
) {
  if (!sock || typeof sock !== 'object') return false;
  if (wrappedSockets.has(sock)) return true;

  installConsoleSignalSanitizer();
  wrapWebSocketTagSanitizer(sock, { userDevicesCache, logError });
  wrapLidMappingResilience(sock, { logError, userDevicesCache });
  wrapSignalAndSenderKeyGuard(sock, { failedEncryptJids, userDevicesCache, logError, authDir });
  wrapAckErrorRecovery(sock, { groupCache, userDevicesCache, logError, logInfo });
  wrapSendOptionsNormalization(sock, { logError });
  wrapOnWhatsAppGuard(sock);
  wrapPresenceResilience(sock, { defaultPushName });

  if (sock?.ev && typeof sock.ev.on === 'function') {
    let appStateFallbackTimer = null;
    let socketClosed = false;
    sock.ev.on('connection.update', ({ connection, receivedPendingNotifications }) => {
      if (connection === 'close') {
        socketClosed = true;
        clearPreKeyRetryTimer(sock);
        clearAppStateRetryTimer(sock);
        if (appStateFallbackTimer) {
          clearTimeout(appStateFallbackTimer);
          appStateFallbackTimer = null;
        }
      }
      if (connection === 'open') {
        socketClosed = false;
        normalizeAuthCreds(sock.authState?.creds);
        void ensureHealthyPreKeys(sock, {
          authDir,
          fsImpl,
          retryDelayMs: preKeyRetryDelayMs,
          isSocketActive: () => !socketClosed,
          logInfo,
          logError,
        });
        void ensureActiveOnlinePresence(sock, { defaultPushName, logError });
        if (!appStateSyncedSockets.has(sock) && !appStateFallbackTimer) {
          appStateFallbackTimer = setTimeout(() => {
            appStateFallbackTimer = null;
            void ensureAppStateSynced(sock, {
              isSocketActive: () => !socketClosed,
              logInfo,
              logError,
            });
          }, 6000);
          appStateFallbackTimer?.unref?.();
        }
      }
      if (receivedPendingNotifications) {
        if (appStateFallbackTimer) {
          clearTimeout(appStateFallbackTimer);
          appStateFallbackTimer = null;
        }
        void ensureAppStateSynced(sock, {
          isSocketActive: () => !socketClosed,
          logInfo,
          logError,
        });
      }
    });
    sock.ev.on('creds.update', (update) => {
      if (update && typeof update === 'object' && update.myAppStateKeyId) {
        appStateSyncedSockets.delete(sock);
        void ensureAppStateSynced(sock, {
          isSocketActive: () => !socketClosed,
          logInfo,
          logError,
        });
      }
    });
  }

  wrappedSockets.add(sock);
  return true;
}
