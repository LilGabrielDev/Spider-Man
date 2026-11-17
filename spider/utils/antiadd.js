import { spiderFooter, spiderHeader, spiderRow } from '../../Spider/utils/tableStyle.js';
import {
  cleanJid,
  collectBotIdentities,
  extractPhoneDigits,
  resolveGroupRolesAsync,
} from './groupRoleResolver.js';
import {
  collectParticipantAlternates,
  executeParticipantsAction,
  isFromBot,
  resolveLidPnAlternatesAsync,
  resolveSenderDisplayAndMention,
} from './groupActionHelper.js';
import { executeGroupAdminProtectedAction } from './groupAdminProtection.js';
import {
  createJsonShieldStore,
  normalizeWhitelistArray,
} from './groupShieldCore.js';

export const ANTIADD_ACTIONS = Object.freeze(['remove', 'removekick']);

function defaultGroupConfig() {
  return {
    enabled: false,
    action: 'remove',
    allowAdmins: false,
    notify: true,
    whitelist: [],
    stats: {
      detected: 0,
      removedTargets: 0,
      kickedActors: 0,
    },
  };
}

function normalizeGroupConfig(raw) {
  const base = defaultGroupConfig();
  if (!raw || typeof raw !== 'object') return base;
  const action = ANTIADD_ACTIONS.includes(String(raw.action || '').toLowerCase())
    ? String(raw.action).toLowerCase()
    : base.action;
  return {
    enabled: Boolean(raw.enabled),
    action,
    allowAdmins: Boolean(raw.allowAdmins),
    notify: raw.notify !== false,
    whitelist: normalizeWhitelistArray(raw.whitelist),
    stats: {
      detected: Number(raw.stats?.detected || 0),
      removedTargets: Number(raw.stats?.removedTargets || 0),
      kickedActors: Number(raw.stats?.kickedActors || 0),
    },
  };
}

export function createAntiaddStore(filePathOrFn = null) {
  return createJsonShieldStore({
    fileName: 'antiadd.json',
    filePathOrFn,
    defaultGroupConfig,
    normalizeGroupConfig,
  });
}

export const defaultAntiaddStore = createAntiaddStore();

function extractParticipantJid(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return cleanJid(entry);
  if (typeof entry === 'object') {
    return cleanJid(entry.id || entry.jid || entry.phoneNumber || entry.pn || '');
  }
  return '';
}

function sameIdentitySet(aList = [], bList = []) {
  const aClean = new Set(aList.map((x) => cleanJid(x).toLowerCase()).filter(Boolean));
  const aPhones = new Set(aList.map((x) => extractPhoneDigits(x)).filter(Boolean));
  for (const b of bList) {
    const cleanB = cleanJid(b).toLowerCase();
    if (cleanB && aClean.has(cleanB)) return true;
    const ph = extractPhoneDigits(cleanB);
    if (ph && aPhones.has(ph)) return true;
  }
  return false;
}

export async function handleAntiAddUpdate({
  sock,
  update,
  alreadyRemoved = [],
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  isOwnerJid = null,
  isAdminProtectionEnabled = true,
  store = defaultAntiaddStore,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !update || update.action !== 'add') {
    return { handled: false, reason: 'not-applicable' };
  }
  const from = String(update.id || '');
  if (!from.endsWith('@g.us')) {
    return { handled: false, reason: 'not-group' };
  }

  const cfg = store.getGroupConfig(from);
  if (!cfg.enabled) {
    return { handled: false, reason: 'disabled' };
  }

  const author = cleanJid(update.author || '');
  if (!author) {
    // No external adder -> invite-link or auto-approved self-join
    return { handled: false, reason: 'no-author-self-join' };
  }

  const rawParticipants = (Array.isArray(update.participants) ? update.participants : [])
    .map(extractParticipantJid)
    .filter(Boolean);
  if (rawParticipants.length === 0) {
    return { handled: false, reason: 'no-participants' };
  }

  let metadata = null;
  try {
    metadata =
      typeof fetchGroupMetadata === 'function'
        ? await fetchGroupMetadata(from)
        : typeof sock.groupMetadata === 'function'
          ? await sock.groupMetadata(from)
          : null;
  } catch {
    metadata = null;
  }

  const authorPhone = extractPhoneDigits(author, getPhoneFromJid);
  const authorSeed = [author, authorPhone ? `${authorPhone}@s.whatsapp.net` : ''].filter(Boolean);
  const authorMetaAlts = collectParticipantAlternates(metadata, authorSeed);
  const authorSigAlts = await resolveLidPnAlternatesAsync(sock, [...authorSeed, ...authorMetaAlts]);
  const authorCandidates = [...new Set([...authorSeed, ...authorMetaAlts, ...authorSigAlts])];

  if (isFromBot(authorCandidates, sock)) {
    return { handled: false, reason: 'added-by-bot' };
  }
  if (typeof isOwnerJid === 'function' && authorCandidates.some((c) => isOwnerJid(c))) {
    return { handled: false, reason: 'added-by-owner' };
  }
  if (store.isWhitelisted(from, authorCandidates)) {
    return { handled: false, reason: 'added-by-whitelisted' };
  }

  const botCandidates = collectBotIdentities(sock);
  const { senderRole: authorRole, botRole } = await resolveGroupRolesAsync({
    metadata,
    sock,
    senderJids: authorCandidates,
    getPhoneFn: getPhoneFromJid,
  });

  if (cfg.allowAdmins && authorRole.isAdmin) {
    return { handled: false, reason: 'added-by-allowed-admin' };
  }

  if (metadata && botCandidates.length > 0 && !botRole.isAdmin) {
    return { handled: false, reason: 'bot-not-admin' };
  }

  const targetsToRemove = [];
  for (const p of rawParticipants) {
    const pPhone = extractPhoneDigits(p, getPhoneFromJid);
    const pCands = [p, pPhone ? `${pPhone}@s.whatsapp.net` : ''].filter(Boolean);
    if (alreadyRemoved.length > 0 && sameIdentitySet(alreadyRemoved, pCands)) continue;
    if (sameIdentitySet(authorCandidates, pCands)) continue; // self-join
    if (isFromBot(pCands, sock)) continue;
    if (typeof isOwnerJid === 'function' && pCands.some((c) => isOwnerJid(c))) continue;
    targetsToRemove.push(p);
  }

  if (targetsToRemove.length === 0) {
    return { handled: false, reason: 'self-or-exempt-join' };
  }

  const removeRes = await executeParticipantsAction({
    sock,
    from,
    participants: targetsToRemove,
    action: 'remove',
    metadata,
  });
  const removedTargets = removeRes.succeeded?.length
    ? removeRes.succeeded
    : removeRes.ok
      ? targetsToRemove
      : [];

  let kickedActor = false;
  if (cfg.action === 'removekick' && !authorRole.isOwner) {
    const actorTargets = [authorRole.targetJid, author, ...authorCandidates].filter(Boolean);
    const kickActorRes = await executeGroupAdminProtectedAction({
      enabled: Boolean(isAdminProtectionEnabled),
      sock,
      from,
      participants: actorTargets,
      action: 'remove',
      metadata,
    });
    kickedActor = Boolean(kickActorRes.ok);
  }

  store.recordAction(from, {
    detected: 1,
    removedTargets: removedTargets.length,
    kickedActors: kickedActor ? 1 : 0,
  });

  if (cfg.notify !== false) {
    const actorDisplay = resolveSenderDisplayAndMention({
      senderRole: authorRole,
      senderJid: author,
      senderCandidates: authorCandidates,
      metadata,
      getPhoneFn: getPhoneFromJid,
    });
    const addedTags = targetsToRemove.map((t) => `@${extractPhoneDigits(t, getPhoneFromJid) || t.split('@')[0]}`);
    const mentions = [...new Set([actorDisplay.mentionJid, ...targetsToRemove].filter(Boolean))];
    const enforcement = [
      removedTargets.length > 0 ? `Removed Added Account(s)` : 'Remove Failed',
      kickedActor ? 'Adder Kicked' : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const alertText = [
      spiderHeader(botName || 'Spider Man', 'ANTIADD SHIELD'),
      spiderRow('UNAUTHORIZED ADDER', `@${actorDisplay.targetUser}`, '👤'),
      spiderRow('ADDED ACCOUNT(S)', addedTags.join(', '), '➕'),
      spiderRow('ENFORCEMENT', enforcement, '⚡'),
      spiderFooter('UNAUTHORIZED MEMBER ADD BLOCKED // SPIDER-MAN'),
    ].join('\n');

    try {
      await sock.sendMessage(from, { text: alertText, mentions });
    } catch {}
  }

  return {
    handled: true,
    removedTargets,
    kickedActor,
    author,
    removeRes,
  };
}
