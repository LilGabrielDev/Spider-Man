import { extractMessageText } from './antiscam.js';
import { unwrapMessageContent } from './groupActionHelper.js';
import {
  DEFAULT_MAX_WARNS,
  STANDARD_SHIELD_ACTIONS,
  createJsonShieldStore,
  enforceMessageShield,
  normalizeShieldWarnMap,
  normalizeWhitelistArray,
} from './groupShieldCore.js';

export const ANTIBUG_ACTIONS = STANDARD_SHIELD_ACTIONS;
export const ANTIBUG_DEFAULT_MAX_WARNS = DEFAULT_MAX_WARNS;
export const ANTIBUG_DEFAULT_MAX_LENGTH = 3000;
export const ANTIBUG_MIN_LENGTH = 500;
export const ANTIBUG_MAX_LENGTH = 25000;
export const ANTIBUG_DEFAULT_MAX_COMBINING = 150;
export const ANTIBUG_DEFAULT_MAX_CLUSTER = 25;
export const ANTIBUG_DEFAULT_MAX_ZERO_WIDTH = 40;

function isCombiningCode(code) {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x0483 && code <= 0x0489) ||
    (code >= 0x0591 && code <= 0x05bd) ||
    code === 0x05bf ||
    (code >= 0x05c1 && code <= 0x05c7) ||
    (code >= 0x0610 && code <= 0x061a) ||
    (code >= 0x064b && code <= 0x065f) ||
    code === 0x0670 ||
    (code >= 0x06d6 && code <= 0x06ed) ||
    code === 0x0711 ||
    (code >= 0x0730 && code <= 0x074a) ||
    (code >= 0x0900 && code <= 0x0903) ||
    (code >= 0x093a && code <= 0x094f) ||
    (code >= 0x0951 && code <= 0x0957) ||
    code === 0x0e31 ||
    (code >= 0x0e34 && code <= 0x0e3a) ||
    (code >= 0x0e47 && code <= 0x0e4e) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

function isZeroWidthOrFormatCode(code) {
  return (
    code === 0x034f ||
    code === 0x061c ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff ||
    code === 0xfff9 ||
    code === 0xfffa ||
    code === 0xfffb
  );
}

function isBidiOverrideCode(code) {
  return (
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function collectPayloadStrings(msg, text = '') {
  const parts = [];
  const pushStr = (val) => {
    if (typeof val === 'string' && val.length > 0) {
      parts.push(val);
    }
  };

  pushStr(text);
  const extracted = extractMessageText(msg, text);
  if (extracted && extracted !== text) pushStr(extracted);

  const layers = [msg?.message, unwrapMessageContent(msg?.message)].filter(
    (l) => l && typeof l === 'object',
  );

  let contactCount = 0;
  let maxVcardLen = 0;

  for (const layer of layers) {
    pushStr(layer.conversation);
    pushStr(layer.extendedTextMessage?.text);
    pushStr(layer.extendedTextMessage?.title);
    pushStr(layer.extendedTextMessage?.description);
    pushStr(layer.imageMessage?.caption);
    pushStr(layer.videoMessage?.caption);
    pushStr(layer.ptvMessage?.caption);
    pushStr(layer.documentMessage?.caption);
    pushStr(layer.documentMessage?.fileName);
    pushStr(layer.locationMessage?.name);
    pushStr(layer.locationMessage?.address);
    pushStr(layer.liveLocationMessage?.caption);
    pushStr(layer.buttonsMessage?.contentText);
    pushStr(layer.buttonsMessage?.footerText);
    pushStr(layer.listMessage?.description);
    pushStr(layer.listMessage?.title);
    pushStr(layer.interactiveMessage?.body?.text);
    pushStr(layer.interactiveMessage?.header?.title);
    pushStr(layer.interactiveMessage?.footer?.text);

    if (layer.contactMessage?.vcard) {
      contactCount = Math.max(contactCount, 1);
      maxVcardLen = Math.max(maxVcardLen, String(layer.contactMessage.vcard).length);
      pushStr(layer.contactMessage.displayName);
    }
    if (Array.isArray(layer.contactsArrayMessage?.contacts)) {
      const contacts = layer.contactsArrayMessage.contacts;
      contactCount = Math.max(contactCount, contacts.length);
      for (const c of contacts.slice(0, 60)) {
        if (c?.vcard) {
          maxVcardLen = Math.max(maxVcardLen, String(c.vcard).length);
        }
      }
    }
  }

  return { parts, contactCount, maxVcardLen };
}

export function detectBugPayload({
  msg = null,
  text = '',
  maxLength = ANTIBUG_DEFAULT_MAX_LENGTH,
  maxCombining = ANTIBUG_DEFAULT_MAX_COMBINING,
  maxCluster = ANTIBUG_DEFAULT_MAX_CLUSTER,
  maxZeroWidth = ANTIBUG_DEFAULT_MAX_ZERO_WIDTH,
} = {}) {
  const effectiveMaxLen = Math.max(
    ANTIBUG_MIN_LENGTH,
    Math.min(ANTIBUG_MAX_LENGTH, Number(maxLength) || ANTIBUG_DEFAULT_MAX_LENGTH),
  );
  const { parts, contactCount, maxVcardLen } = collectPayloadStrings(msg, text);

  if (contactCount > 35 || maxVcardLen > 8000) {
    return {
      isBug: true,
      type: 'vcard-bomb',
      reason: contactCount > 35
        ? `Virtex Contact Bomb (${contactCount} vCards)`
        : `Oversized vCard Payload (${maxVcardLen} chars)`,
      metrics: {
        length: maxVcardLen,
        combiningCount: 0,
        maxCluster: 0,
        zeroWidthCount: 0,
        bidiCount: 0,
        contactCount,
      },
    };
  }

  let peakLength = 0;
  let totalCombining = 0;
  let peakCluster = 0;
  let totalZeroWidth = 0;
  let totalBidi = 0;

  // Deduplicate exact identical strings so text + conversation aren't double counted
  const uniqueParts = [...new Set(parts)];
  for (const str of uniqueParts) {
    if (str.length > peakLength) peakLength = str.length;
    if (str.length > effectiveMaxLen) {
      return {
        isBug: true,
        type: 'oversized-text',
        reason: `Oversized Crash/Virtex Text (${str.length} chars > ${effectiveMaxLen})`,
        metrics: {
          length: str.length,
          combiningCount: totalCombining,
          maxCluster: peakCluster,
          zeroWidthCount: totalZeroWidth,
          bidiCount: totalBidi,
          contactCount,
        },
      };
    }

    let currentCluster = 0;
    let strCombining = 0;
    let strZeroWidth = 0;
    let strBidi = 0;
    const len = str.length;

    for (let i = 0; i < len; i += 1) {
      const code = str.charCodeAt(i);
      if (code < 0x0300) {
        currentCluster = 0;
        continue;
      }
      if (isCombiningCode(code)) {
        strCombining += 1;
        currentCluster += 1;
        if (currentCluster > peakCluster) peakCluster = currentCluster;
      } else {
        currentCluster = 0;
      }
      if (isZeroWidthOrFormatCode(code)) {
        strZeroWidth += 1;
      }
      if (isBidiOverrideCode(code)) {
        strBidi += 1;
      }
    }

    totalCombining = Math.max(totalCombining, strCombining);
    totalZeroWidth = Math.max(totalZeroWidth, strZeroWidth);
    totalBidi = Math.max(totalBidi, strBidi);
  }

  const metrics = {
    length: peakLength,
    combiningCount: totalCombining,
    maxCluster: peakCluster,
    zeroWidthCount: totalZeroWidth,
    bidiCount: totalBidi,
    contactCount,
  };

  if (peakCluster >= maxCluster || totalCombining >= maxCombining) {
    return {
      isBug: true,
      type: 'combining-spam',
      reason: `Zalgo / Combining Marks Flood (${totalCombining} marks, max cluster ${peakCluster})`,
      metrics,
    };
  }

  if (totalZeroWidth >= maxZeroWidth || totalBidi >= 10) {
    return {
      isBug: true,
      type: 'zero-width-spam',
      reason: totalBidi >= 10
        ? `Bidi Override Crash Payload (${totalBidi} controls)`
        : `Zero-Width Character Bomb (${totalZeroWidth} hidden chars)`,
      metrics,
    };
  }

  return {
    isBug: false,
    type: '',
    reason: '',
    metrics,
  };
}

function defaultGroupConfig() {
  return {
    enabled: false,
    action: 'kick',
    maxLength: ANTIBUG_DEFAULT_MAX_LENGTH,
    maxWarns: ANTIBUG_DEFAULT_MAX_WARNS,
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
  const action = ANTIBUG_ACTIONS.includes(String(raw.action || '').toLowerCase())
    ? String(raw.action).toLowerCase()
    : base.action;
  const maxLengthNum = Number.parseInt(String(raw.maxLength ?? base.maxLength), 10);
  const maxLength =
    Number.isInteger(maxLengthNum) && maxLengthNum >= ANTIBUG_MIN_LENGTH && maxLengthNum <= ANTIBUG_MAX_LENGTH
      ? maxLengthNum
      : base.maxLength;
  const maxWarnsNum = Number.parseInt(String(raw.maxWarns ?? base.maxWarns), 10);
  const maxWarns =
    Number.isInteger(maxWarnsNum) && maxWarnsNum >= 1 && maxWarnsNum <= 10
      ? maxWarnsNum
      : base.maxWarns;

  return {
    enabled: Boolean(raw.enabled),
    action,
    maxLength,
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

export function createAntibugStore(filePathOrFn = null) {
  return createJsonShieldStore({
    fileName: 'antibug.json',
    filePathOrFn,
    defaultGroupConfig,
    normalizeGroupConfig,
    maxWarnsFallback: ANTIBUG_DEFAULT_MAX_WARNS,
  });
}

export const defaultAntibugStore = createAntibugStore();

export async function handleAntiBugMessage({
  sock,
  from,
  sender,
  msg,
  text = '',
  isOwner = false,
  groupMeta = null,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntibugStore,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !from || !String(from).endsWith('@g.us') || !msg || msg.key?.fromMe) {
    return { handled: false, reason: 'not-applicable' };
  }

  const groupConfig = store.getGroupConfig(from);
  if (!groupConfig.enabled) {
    return { handled: false, reason: 'disabled' };
  }

  const detection = detectBugPayload({
    msg,
    text,
    maxLength: groupConfig.maxLength,
  });

  if (!detection.isBug) {
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
    shieldTitle: 'ANTIBUG / VIRTEX SHIELD',
    shieldFooter: 'ANTI-CRASH PROTECTION // SPIDER-MAN',
    reason: detection.reason,
    detection,
  });
}
