import {
  cleanJid,
  extractPhoneDigits,
} from './groupRoleResolver.js';
import { unwrapMessageContent } from './groupActionHelper.js';
import {
  DEFAULT_MAX_WARNS,
  STANDARD_SHIELD_ACTIONS,
  createJsonShieldStore,
  enforceMessageShield,
  normalizeShieldWarnMap,
  normalizeWhitelistArray,
} from './groupShieldCore.js';

export const ATTACHMENT_TYPES = Object.freeze(['sticker', 'media', 'voice', 'doc']);
export const ANTIMEDIA_ACTIONS = STANDARD_SHIELD_ACTIONS;
export const ANTIMEDIA_DEFAULT_MAX_WARNS = DEFAULT_MAX_WARNS;

export const ATTACHMENT_FILTERS = Object.freeze({
  sticker: ['all'],
  media: ['all', 'video', 'image'],
  voice: ['all', 'ptt'],
  doc: ['all', 'apk', 'vcard', 'docs'],
});

function defaultSubConfig() {
  return {
    enabled: false,
    action: 'delete',
    filter: 'all',
    maxWarns: ANTIMEDIA_DEFAULT_MAX_WARNS,
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

function normalizeSubConfig(raw, type) {
  const base = defaultSubConfig();
  if (!raw || typeof raw !== 'object') return base;
  const action = ANTIMEDIA_ACTIONS.includes(String(raw.action || '').toLowerCase())
    ? String(raw.action).toLowerCase()
    : base.action;
  const allowedFilters = ATTACHMENT_FILTERS[type] || ['all'];
  const rawFilter = String(raw.filter || 'all').toLowerCase();
  const filter = allowedFilters.includes(rawFilter) ? rawFilter : 'all';
  const maxWarnsNum = Number.parseInt(String(raw.maxWarns ?? base.maxWarns), 10);
  const maxWarns =
    Number.isInteger(maxWarnsNum) && maxWarnsNum >= 1 && maxWarnsNum <= 10
      ? maxWarnsNum
      : base.maxWarns;

  return {
    enabled: Boolean(raw.enabled),
    action,
    filter,
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

function defaultGroupConfig() {
  return {
    sticker: defaultSubConfig(),
    media: defaultSubConfig(),
    voice: defaultSubConfig(),
    doc: defaultSubConfig(),
  };
}

function normalizeGroupConfig(raw) {
  const base = defaultGroupConfig();
  if (!raw || typeof raw !== 'object') return base;
  return {
    sticker: normalizeSubConfig(raw.sticker, 'sticker'),
    media: normalizeSubConfig(raw.media, 'media'),
    voice: normalizeSubConfig(raw.voice, 'voice'),
    doc: normalizeSubConfig(raw.doc, 'doc'),
  };
}

export function createAntimediaStore(filePathOrFn = null) {
  const baseStore = createJsonShieldStore({
    fileName: 'antimedia.json',
    filePathOrFn,
    defaultGroupConfig,
    normalizeGroupConfig,
    maxWarnsFallback: ANTIMEDIA_DEFAULT_MAX_WARNS,
  });

  function forType(type) {
    if (!ATTACHMENT_TYPES.includes(type)) {
      throw new Error(`Unsupported attachment guard type: ${type}`);
    }
    return {
      getGroupConfig(groupJid) {
        return baseStore.getGroupConfig(groupJid)[type];
      },
      setGroupConfig(groupJid, patch = {}) {
        const updated = baseStore.setGroupConfig(groupJid, (prevGroup) => {
          const prevSub = normalizeSubConfig(prevGroup[type], type);
          const nextSubRaw = typeof patch === 'function' ? patch(prevSub) : { ...prevSub, ...patch };
          return { ...prevGroup, [type]: normalizeSubConfig(nextSubRaw, type) };
        });
        return updated[type];
      },
      addWarn(groupJid, targetJid, senderCandidates = []) {
        let warnResult = { count: 1, maxWarns: ANTIMEDIA_DEFAULT_MAX_WARNS };
        baseStore.setGroupConfig(groupJid, (prevGroup) => {
          const sub = normalizeSubConfig(prevGroup[type], type);
          const warns = { ...sub.warns };
          const keys = [targetJid, ...(Array.isArray(senderCandidates) ? senderCandidates : [])]
            .map((j) => cleanJid(j))
            .filter(Boolean);
          const primaryKey = cleanJid(targetJid) || keys[0] || '';
          const keySet = new Set(keys.map((k) => k.toLowerCase()));
          const phones = new Set(keys.map((k) => extractPhoneDigits(k)).filter(Boolean));
          let existing = 0;
          for (const [k, v] of Object.entries(warns)) {
            const cleaned = cleanJid(k);
            const ph = extractPhoneDigits(cleaned);
            if (keySet.has(k.toLowerCase()) || keySet.has(cleaned.toLowerCase()) || (ph && phones.has(ph))) {
              existing += Number(v) || 0;
              delete warns[k];
            }
          }
          const nextCount = existing + 1;
          if (primaryKey) warns[primaryKey] = nextCount;
          warnResult = { count: nextCount, maxWarns: sub.maxWarns };
          return { ...prevGroup, [type]: { ...sub, warns } };
        });
        return warnResult;
      },
      resetWarns(groupJid, targetJid = null, senderCandidates = []) {
        baseStore.setGroupConfig(groupJid, (prevGroup) => {
          const sub = normalizeSubConfig(prevGroup[type], type);
          if (!targetJid && (!Array.isArray(senderCandidates) || senderCandidates.length === 0)) {
            return { ...prevGroup, [type]: { ...sub, warns: {} } };
          }
          const warns = { ...sub.warns };
          const keys = [targetJid, ...(Array.isArray(senderCandidates) ? senderCandidates : [])]
            .map((j) => cleanJid(j))
            .filter(Boolean);
          const keySet = new Set(keys.map((k) => k.toLowerCase()));
          const phones = new Set(keys.map((k) => extractPhoneDigits(k)).filter(Boolean));
          for (const k of Object.keys(warns)) {
            const cleaned = cleanJid(k);
            const ph = extractPhoneDigits(cleaned);
            if (keySet.has(k.toLowerCase()) || keySet.has(cleaned.toLowerCase()) || (ph && phones.has(ph))) {
              delete warns[k];
            }
          }
          return { ...prevGroup, [type]: { ...sub, warns } };
        });
      },
      addWhitelist(groupJid, token) {
        const cleanTok = String(token || '').trim().replace(/^@/, '');
        const entry = cleanTok.includes('@')
          ? cleanJid(cleanTok).toLowerCase()
          : /^\d{5,20}$/.test(cleanTok.replace(/\D/g, ''))
            ? `${cleanTok.replace(/\D/g, '')}@s.whatsapp.net`
            : cleanTok.toLowerCase();
        if (!entry) return { added: false, entry: '', config: this.getGroupConfig(groupJid) };
        let added = false;
        const updated = this.setGroupConfig(groupJid, (prev) => {
          if (prev.whitelist.includes(entry)) return prev;
          added = true;
          return { ...prev, whitelist: [...prev.whitelist, entry] };
        });
        return { added, entry, config: updated };
      },
      removeWhitelist(groupJid, token) {
        const cleanTok = String(token || '').trim().replace(/^@/, '');
        const entry = cleanTok.includes('@')
          ? cleanJid(cleanTok).toLowerCase()
          : /^\d{5,20}$/.test(cleanTok.replace(/\D/g, ''))
            ? `${cleanTok.replace(/\D/g, '')}@s.whatsapp.net`
            : cleanTok.toLowerCase();
        if (!entry) return { removed: false, entry: '', config: this.getGroupConfig(groupJid) };
        const phone = extractPhoneDigits(entry);
        let removed = false;
        const updated = this.setGroupConfig(groupJid, (prev) => {
          const next = prev.whitelist.filter((w) => {
            if (w === entry) return false;
            if (phone && extractPhoneDigits(w) === phone) return false;
            return true;
          });
          removed = next.length !== prev.whitelist.length;
          return { ...prev, whitelist: next };
        });
        return { removed, entry, config: updated };
      },
      isWhitelisted(groupJid, candidates = []) {
        const sub = this.getGroupConfig(groupJid);
        if (!sub.whitelist.length) return false;
        const wlSet = new Set(sub.whitelist.map((w) => w.toLowerCase()));
        const wlPhones = new Set(sub.whitelist.map((w) => extractPhoneDigits(w)).filter(Boolean));
        for (const c of Array.isArray(candidates) ? candidates : [candidates]) {
          const cleaned = cleanJid(c).toLowerCase();
          if (!cleaned) continue;
          if (wlSet.has(cleaned)) return true;
          const ph = extractPhoneDigits(cleaned);
          if (ph && wlPhones.has(ph)) return true;
        }
        return false;
      },
      recordAction(groupJid, statsPatch = {}) {
        return this.setGroupConfig(groupJid, (prev) => {
          const stats = { ...prev.stats };
          for (const k of ['detected', 'deleted', 'kicked', 'warned']) {
            if (typeof statsPatch[k] === 'number') stats[k] += statsPatch[k];
          }
          return { ...prev, stats };
        });
      },
    };
  }

  return {
    clearCache: () => baseStore.clearCache(),
    getAllGroupConfig: (groupJid) => baseStore.getGroupConfig(groupJid),
    getTypeConfig: (groupJid, type) => baseStore.getGroupConfig(groupJid)[type],
    setTypeConfig: (groupJid, type, patch) => forType(type).setGroupConfig(groupJid, patch),
    forType,
    resetGroup: (groupJid) => baseStore.resetGroup(groupJid),
    resetAll: () => baseStore.resetAll(),
  };
}

export const defaultAntimediaStore = createAntimediaStore();

export function detectAttachmentMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return { type: null, subType: '', reason: '', fileName: '', mimetype: '', ptt: false };
  }

  const layers = [
    unwrapMessageContent(msg.message),
    msg.message?.documentWithCaptionMessage?.message,
    msg.message,
  ].filter((l) => l && typeof l === 'object');

  for (const layer of layers) {
    if (layer.stickerMessage || layer.lottieStickerMessage) {
      return {
        type: 'sticker',
        subType: layer.lottieStickerMessage ? 'lottie-sticker' : 'sticker',
        reason: 'Sticker Blocked',
        fileName: '',
        mimetype: String(layer.stickerMessage?.mimetype || 'image/webp'),
        ptt: false,
      };
    }

    if (layer.imageMessage) {
      return {
        type: 'media',
        subType: 'image',
        reason: 'Image Media Blocked',
        fileName: '',
        mimetype: String(layer.imageMessage.mimetype || 'image/jpeg'),
        ptt: false,
      };
    }

    if (layer.videoMessage || layer.ptvMessage) {
      const vid = layer.videoMessage || layer.ptvMessage;
      const isPtv = Boolean(layer.ptvMessage);
      const isGif = Boolean(vid?.gifPlayback);
      return {
        type: 'media',
        subType: isPtv ? 'ptv' : isGif ? 'gif' : 'video',
        reason: isPtv ? 'Video Note Blocked' : isGif ? 'GIF Media Blocked' : 'Video Media Blocked',
        fileName: '',
        mimetype: String(vid?.mimetype || 'video/mp4'),
        ptt: false,
      };
    }

    if (layer.audioMessage) {
      const isPtt = Boolean(layer.audioMessage.ptt);
      return {
        type: 'voice',
        subType: isPtt ? 'ptt' : 'audio',
        reason: isPtt ? 'Voice Note Blocked' : 'Audio Message Blocked',
        fileName: '',
        mimetype: String(layer.audioMessage.mimetype || 'audio/ogg'),
        ptt: isPtt,
      };
    }

    if (layer.documentMessage) {
      const doc = layer.documentMessage;
      const fileName = String(doc.fileName || doc.title || '').trim();
      const mimetype = String(doc.mimetype || '').trim().toLowerCase();
      const isApk =
        fileName.toLowerCase().endsWith('.apk') ||
        mimetype.includes('android.package-archive');
      return {
        type: 'doc',
        subType: isApk ? 'apk' : 'document',
        reason: isApk
          ? `APK Document Blocked${fileName ? ` (${fileName})` : ''}`
          : `Document File Blocked${fileName ? ` (${fileName})` : ''}`,
        fileName,
        mimetype,
        ptt: false,
      };
    }

    if (layer.contactMessage || layer.contactsArrayMessage) {
      return {
        type: 'doc',
        subType: 'vcard',
        reason: layer.contactsArrayMessage ? 'Contact Cards (vCard) Blocked' : 'Contact vCard Blocked',
        fileName: '',
        mimetype: 'text/vcard',
        ptt: false,
      };
    }
  }

  return { type: null, subType: '', reason: '', fileName: '', mimetype: '', ptt: false };
}

export function doesAttachmentMatchFilter(detection, filter = 'all') {
  if (!detection?.type) return false;
  const f = String(filter || 'all').toLowerCase();
  if (f === 'all') return true;

  if (detection.type === 'media') {
    if (f === 'video') return detection.subType === 'video' || detection.subType === 'ptv' || detection.subType === 'gif';
    if (f === 'image') return detection.subType === 'image';
  }
  if (detection.type === 'voice') {
    if (f === 'ptt') return detection.ptt === true;
  }
  if (detection.type === 'doc') {
    if (f === 'apk') return detection.subType === 'apk';
    if (f === 'vcard') return detection.subType === 'vcard';
    if (f === 'docs') return detection.subType === 'document' || detection.subType === 'apk';
  }
  return true;
}

const SHIELD_TITLES = {
  sticker: 'ANTISTICKER SHIELD',
  media: 'ANTIMEDIA SHIELD',
  voice: 'ANTIVOICE SHIELD',
  doc: 'ANTIDOC SHIELD',
};

const SHIELD_FOOTERS = {
  sticker: 'NO STICKERS ALLOWED // SPIDER-MAN',
  media: 'MEDIA FILTER ACTIVE // SPIDER-MAN',
  voice: 'NO VOICE / AUDIO // SPIDER-MAN',
  doc: 'DOCUMENT FILTER ACTIVE // SPIDER-MAN',
};

export async function handleAntiAttachmentMessage({
  sock,
  from,
  sender,
  msg,
  isOwner = false,
  groupMeta = null,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntimediaStore,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !from || !String(from).endsWith('@g.us') || !msg || msg.key?.fromMe) {
    return { handled: false, reason: 'not-applicable' };
  }

  const detection = detectAttachmentMessage(msg);
  if (!detection.type) {
    return { handled: false, reason: 'no-attachment' };
  }

  const typeStore = store.forType(detection.type);
  const subConfig = typeStore.getGroupConfig(from);
  if (!subConfig.enabled) {
    return { handled: false, reason: 'disabled', detection };
  }

  if (!doesAttachmentMatchFilter(detection, subConfig.filter)) {
    return { handled: false, reason: 'filter-unmatched', detection };
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
    groupConfig: subConfig,
    store: typeStore,
    botName,
    shieldTitle: SHIELD_TITLES[detection.type] || 'MEDIA SHIELD',
    shieldFooter: SHIELD_FOOTERS[detection.type] || 'GROUP PROTECTION // SPIDER-MAN',
    reason: detection.reason,
    detection,
  });
}
