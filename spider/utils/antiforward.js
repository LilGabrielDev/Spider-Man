import {
  DEFAULT_MAX_WARNS,
  STANDARD_SHIELD_ACTIONS,
  collectAllContextInfos,
  createJsonShieldStore,
  enforceMessageShield,
  normalizeShieldWarnMap,
  normalizeWhitelistArray,
} from './groupShieldCore.js';

export const ANTIFORWARD_ACTIONS = STANDARD_SHIELD_ACTIONS;
export const ANTIFORWARD_MODES = Object.freeze(['all', 'many']);
export const ANTIFORWARD_DEFAULT_MAX_WARNS = DEFAULT_MAX_WARNS;

export function detectForwardedMessage({ msg = null, mode = 'all' } = {}) {
  if (!msg || typeof msg !== 'object') {
    return { isForwarded: false, isManyTimes: false, forwardingScore: 0, reason: '' };
  }

  const contexts = collectAllContextInfos(msg);
  let maxScore = 0;
  let flaggedForwarded = false;
  let hasNewsletter = false;

  for (const ctx of contexts) {
    if (!ctx || typeof ctx !== 'object') continue;
    const score = Number(ctx.forwardingScore || 0);
    if (Number.isFinite(score) && score > maxScore) {
      maxScore = score;
    }
    if (ctx.isForwarded === true || score >= 1) {
      flaggedForwarded = true;
    }
    if (
      ctx.forwardedNewsletterMessageInfo ||
      String(ctx.remoteJid || '').toLowerCase().endsWith('@newsletter')
    ) {
      hasNewsletter = true;
    }
  }

  const isManyTimes = maxScore >= 5;
  const effectiveMode = String(mode || 'all').toLowerCase() === 'many' ? 'many' : 'all';
  const matched = effectiveMode === 'many' ? isManyTimes : flaggedForwarded;

  if (!matched) {
    return {
      isForwarded: false,
      isManyTimes,
      forwardingScore: maxScore,
      hasNewsletter,
      reason: '',
    };
  }

  const reason = isManyTimes
    ? `Forwarded Many Times (Score: ${maxScore})`
    : hasNewsletter
      ? 'Forwarded Channel / Broadcast Message'
      : maxScore > 1
        ? `Forwarded Message (Score: ${maxScore})`
        : 'Forwarded Message Blocked';

  return {
    isForwarded: true,
    isManyTimes,
    forwardingScore: maxScore,
    hasNewsletter,
    reason,
  };
}

function defaultGroupConfig() {
  return {
    enabled: false,
    action: 'delete',
    mode: 'all',
    maxWarns: ANTIFORWARD_DEFAULT_MAX_WARNS,
    notify: true,
    whitelist: [],
    warns: {},
    stats: {
      detected: 0,
      deleted: 0,
      kicked: 0,
      warned: 0,
    },
  };
}

function normalizeGroupConfig(raw) {
  const base = defaultGroupConfig();
  if (!raw || typeof raw !== 'object') return base;
  const action = ANTIFORWARD_ACTIONS.includes(String(raw.action || '').toLowerCase())
    ? String(raw.action).toLowerCase()
    : base.action;
  const mode = ANTIFORWARD_MODES.includes(String(raw.mode || '').toLowerCase())
    ? String(raw.mode).toLowerCase()
    : base.mode;
  const maxWarnsNum = Number.parseInt(String(raw.maxWarns ?? base.maxWarns), 10);
  const maxWarns =
    Number.isInteger(maxWarnsNum) && maxWarnsNum >= 1 && maxWarnsNum <= 10
      ? maxWarnsNum
      : base.maxWarns;

  return {
    enabled: Boolean(raw.enabled),
    action,
    mode,
    maxWarns,
    notify: raw.notify !== false,
    whitelist: normalizeWhitelistArray(raw.whitelist),
    warns: normalizeShieldWarnMap(raw.warns),
    stats: {
      detected: Number(raw.stats?.detected || 0),
      deleted: Number(raw.stats?.deleted || 0),
      kicked: Number(raw.stats?.kicked || 0),
      warned: Number(raw.stats?.warned || 0),
    },
  };
}

export function createAntiforwardStore(filePathOrFn = null) {
  return createJsonShieldStore({
    fileName: 'antiforward.json',
    filePathOrFn,
    defaultGroupConfig,
    normalizeGroupConfig,
    maxWarnsFallback: ANTIFORWARD_DEFAULT_MAX_WARNS,
  });
}

export const defaultAntiforwardStore = createAntiforwardStore();

export async function handleAntiForwardMessage({
  sock,
  from,
  sender,
  msg,
  isOwner = false,
  groupMeta = null,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntiforwardStore,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !from || !String(from).endsWith('@g.us') || !msg || msg.key?.fromMe) {
    return { handled: false, reason: 'not-applicable' };
  }

  const groupConfig = store.getGroupConfig(from);
  if (!groupConfig.enabled) {
    return { handled: false, reason: 'disabled' };
  }

  const detection = detectForwardedMessage({ msg, mode: groupConfig.mode });
  if (!detection.isForwarded) {
    return { handled: false, reason: 'clean', detection };
  }

  return enforceMessageShield({
    sock,
    from,
    sender,
    msg,
    isOwner,
    groupMeta,
    fetchGroupMetadata,
    getPhoneFromJid,
    groupConfig,
    store,
    botName,
    shieldTitle: 'ANTIFORWARD SHIELD',
    shieldFooter: 'NO FORWARDED SPAM // SPIDER-MAN',
    reason: detection.reason,
    detection,
  });
}
