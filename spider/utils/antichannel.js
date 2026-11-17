import { extractMessageText } from './antiscam.js';
import { unwrapMessageContent } from './groupActionHelper.js';
import {
  DEFAULT_MAX_WARNS,
  STANDARD_SHIELD_ACTIONS,
  collectAllContextInfos,
  createJsonShieldStore,
  enforceMessageShield,
  normalizeShieldWarnMap,
  normalizeWhitelistArray,
} from './groupShieldCore.js';

export const ANTICHANNEL_ACTIONS = STANDARD_SHIELD_ACTIONS;
export const ANTICHANNEL_DEFAULT_MAX_WARNS = DEFAULT_MAX_WARNS;

const CHANNEL_URL_RE = /(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]{8,})/i;

export function detectChannelMessage({ msg = null, text = '' } = {}) {
  if (!msg && !text) {
    return { isChannel: false, channelJid: '', channelName: '', reason: '', match: '' };
  }

  if (msg && typeof msg === 'object') {
    const contexts = collectAllContextInfos(msg);
    for (const ctx of contexts) {
      if (!ctx || typeof ctx !== 'object') continue;
      const newsletterInfo = ctx.forwardedNewsletterMessageInfo;
      if (
        newsletterInfo &&
        typeof newsletterInfo === 'object' &&
        (newsletterInfo.newsletterJid || newsletterInfo.newsletterName || newsletterInfo.serverMessageId != null)
      ) {
        const channelJid = String(newsletterInfo.newsletterJid || ctx.remoteJid || '').trim();
        const channelName = String(newsletterInfo.newsletterName || '').trim();
        return {
          isChannel: true,
          channelJid,
          channelName,
          reason: channelName
            ? `Forwarded Channel Card (${channelName})`
            : 'Forwarded WhatsApp Channel / Newsletter',
          match: channelName || channelJid || 'newsletter',
        };
      }
      const remoteJid = String(ctx.remoteJid || '').trim();
      if (remoteJid.toLowerCase().endsWith('@newsletter')) {
        return {
          isChannel: true,
          channelJid: remoteJid,
          channelName: '',
          reason: 'Forwarded WhatsApp Newsletter Card',
          match: remoteJid,
        };
      }
    }

    const layers = [unwrapMessageContent(msg.message), msg.message].filter(
      (l) => l && typeof l === 'object',
    );
    for (const layer of layers) {
      const invite = layer.newsletterAdminInviteMessage;
      if (invite && typeof invite === 'object') {
        const channelJid = String(invite.newsletterJid || '').trim();
        const channelName = String(invite.newsletterName || '').trim();
        return {
          isChannel: true,
          channelJid,
          channelName,
          reason: channelName
            ? `WhatsApp Channel Invite (${channelName})`
            : 'WhatsApp Channel Admin Invite',
          match: channelName || channelJid || 'newsletter-invite',
        };
      }

      const ext = layer.extendedTextMessage;
      for (const field of [ext?.matchedText, ext?.canonicalUrl, ext?.text]) {
        if (typeof field === 'string') {
          const m = field.match(CHANNEL_URL_RE);
          if (m) {
            return {
              isChannel: true,
              channelJid: '',
              channelName: '',
              reason: 'WhatsApp Channel Link / Card',
              match: m[0],
            };
          }
        }
      }
    }
  }

  const combinedText = extractMessageText(msg, text);
  if (combinedText) {
    const m = combinedText.match(CHANNEL_URL_RE);
    if (m) {
      return {
        isChannel: true,
        channelJid: '',
        channelName: '',
        reason: 'WhatsApp Channel Link / Card',
        match: m[0],
      };
    }
  }

  return { isChannel: false, channelJid: '', channelName: '', reason: '', match: '' };
}

function defaultGroupConfig() {
  return {
    enabled: false,
    action: 'delete',
    maxWarns: ANTICHANNEL_DEFAULT_MAX_WARNS,
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
  const action = ANTICHANNEL_ACTIONS.includes(String(raw.action || '').toLowerCase())
    ? String(raw.action).toLowerCase()
    : base.action;
  const maxWarnsNum = Number.parseInt(String(raw.maxWarns ?? base.maxWarns), 10);
  const maxWarns =
    Number.isInteger(maxWarnsNum) && maxWarnsNum >= 1 && maxWarnsNum <= 10
      ? maxWarnsNum
      : base.maxWarns;

  return {
    enabled: Boolean(raw.enabled),
    action,
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

export function createAntichannelStore(filePathOrFn = null) {
  return createJsonShieldStore({
    fileName: 'antichannel.json',
    filePathOrFn,
    defaultGroupConfig,
    normalizeGroupConfig,
    maxWarnsFallback: ANTICHANNEL_DEFAULT_MAX_WARNS,
  });
}

export const defaultAntichannelStore = createAntichannelStore();

export async function handleAntiChannelMessage({
  sock,
  from,
  sender,
  msg,
  text = '',
  isOwner = false,
  groupMeta = null,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntichannelStore,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !from || !String(from).endsWith('@g.us') || !msg || msg.key?.fromMe) {
    return { handled: false, reason: 'not-applicable' };
  }

  const groupConfig = store.getGroupConfig(from);
  if (!groupConfig.enabled) {
    return { handled: false, reason: 'disabled' };
  }

  const detection = detectChannelMessage({ msg, text });
  if (!detection.isChannel) {
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
    extraWhitelistCandidates: detection.channelJid ? [detection.channelJid] : [],
    botName,
    shieldTitle: 'ANTICHANNEL SHIELD',
    shieldFooter: 'NO CHANNEL FORWARDS // SPIDER-MAN',
    reason: detection.reason,
    extraRow: detection.channelName
      ? { label: 'CHANNEL', value: detection.channelName, icon: '📢' }
      : null,
    detection,
  });
}
