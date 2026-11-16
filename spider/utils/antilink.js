import fs from 'fs';
import os from 'os';
import path from 'path';
import { spiderFooter, spiderHeader, spiderRow } from '../../Spider/utils/tableStyle.js';
import { extractMessageText } from './antiscam.js';
import {
  cleanJid,
  collectBotIdentities,
  collectSenderIdentities,
  extractPhoneDigits,
  resolveGroupRolesAsync,
} from './groupRoleResolver.js';
import {
  deleteMessageSafely,
  executeParticipantsAction,
  extractContextInfo,
  resolveSenderDisplayAndMention,
  unwrapMessageContent,
} from './groupActionHelper.js';

export const ANTILINK_ACTIONS = ['warn', 'kick', 'delete'];
export const ANTILINK_DEFAULT_MAX_WARNS = 3;

const LINK_PATTERNS = [
  {
    name: 'WhatsApp Group / Channel Invite Link',
    regex: /\b(?:https?:\/\/)?(?:www\.)?(?:chat\.whatsapp\.com\/[A-Za-z0-9_-]{8,}|whatsapp\.com\/channel\/[A-Za-z0-9_-]{8,})/i,
  },
  {
    name: 'WhatsApp / Telegram External Link',
    regex: /\b(?:https?:\/\/)?(?:www\.)?(?:wa\.me\/[+\dA-Za-z_-]+|t\.me\/[A-Za-z0-9_+]{3,}|telegram\.me\/[A-Za-z0-9_+]{3,}|discord\.gg\/[A-Za-z0-9_-]{4,}|discord\.com\/invite\/[A-Za-z0-9_-]{4,})/i,
  },
  {
    name: 'External URL',
    regex: /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/i,
  },
  {
    name: 'External Shortener / Bare Domain Link',
    regex: /(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|me|gg|ly|to|be|tv|in|ke|ng|za|uk|us|de|fr|br|ru|dev|app|ai|xyz|site|online|info|link|club|shop|vip|click|top|live|fun|pro|edu|gov|biz|cc|ws|fm|im|vc|gd|gy|gl|sh|at|ch|nl|es|it|pl|se|no|ca|au|nz|jp|kr|cn|tw|hk|sg|my|id|ph|th|vn|tr|ae|sa|eg|ma)(?::\d{2,5})?(?:\/[^\s<>"'`]*|(?=$|[\s.,!?;:)\]"'`>]))/i,
  },
];

function collectLayerContextInfos(layer, out = []) {
  if (!layer || typeof layer !== 'object') return out;
  for (const val of Object.values(layer)) {
    if (val && typeof val === 'object' && val.contextInfo && typeof val.contextInfo === 'object') {
      out.push(val.contextInfo);
    }
  }
  if (layer.contextInfo && typeof layer.contextInfo === 'object') {
    out.push(layer.contextInfo);
  }
  if (layer.messageContextInfo && typeof layer.messageContextInfo === 'object') {
    out.push(layer.messageContextInfo);
  }
  return out;
}

export function detectChannelForward(msg) {
  if (!msg || typeof msg !== 'object') {
    return { isChannelForward: false, reason: '', match: '' };
  }
  const { contextInfo } = extractContextInfo(msg);
  const unwrapped = unwrapMessageContent(msg?.message);
  const contexts = [
    ...(contextInfo ? [contextInfo] : []),
    ...collectLayerContextInfos(unwrapped),
    ...collectLayerContextInfos(msg?.message),
  ];

  for (const ctx of contexts) {
    if (!ctx || typeof ctx !== 'object') continue;
    const newsletterInfo = ctx.forwardedNewsletterMessageInfo;
    if (newsletterInfo && (newsletterInfo.newsletterJid || newsletterInfo.newsletterName)) {
      return {
        isChannelForward: true,
        reason: 'Forwarded Channel / Newsletter Message',
        match: String(newsletterInfo.newsletterName || newsletterInfo.newsletterJid || 'newsletter'),
      };
    }
    const remoteJid = String(ctx.remoteJid || '').toLowerCase();
    const forwardingScore = Number(ctx.forwardingScore || 0);
    if (ctx.isForwarded === true && (forwardingScore >= 1 || remoteJid.endsWith('@newsletter'))) {
      return {
        isChannelForward: true,
        reason: remoteJid.endsWith('@newsletter')
          ? 'Forwarded Channel / Newsletter Message'
          : 'Forwarded Channel / Broadcast Message',
        match: String(ctx.remoteJid || 'forwarded'),
      };
    }
  }

  return { isChannelForward: false, reason: '', match: '' };
}

function extractAntilinkText(msg, text = '') {
  const parts = [];
  const baseText = extractMessageText(msg, text);
  if (baseText) parts.push(baseText);

  const layers = [unwrapMessageContent(msg?.message), msg?.message].filter(
    (layer) => layer && typeof layer === 'object',
  );
  for (const layer of layers) {
    const ext = layer.extendedTextMessage;
    const candidates = [
      ext?.text,
      ext?.matchedText,
      ext?.canonicalUrl,
      layer.ptvMessage?.caption,
      layer.editedMessage?.message?.conversation,
      layer.editedMessage?.message?.extendedTextMessage?.text,
      layer.editedMessage?.message?.extendedTextMessage?.matchedText,
      layer.editedMessage?.message?.extendedTextMessage?.canonicalUrl,
    ];
    for (const item of candidates) {
      if (typeof item === 'string' && item.trim()) {
        parts.push(item.trim());
      }
    }
  }

  return [...new Set(parts)].join(' ').trim();
}

export function detectLinkMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return { hasLink: false, reason: '', match: '' };
  }
  for (const pattern of LINK_PATTERNS) {
    const m = raw.match(pattern.regex);
    if (m) {
      return {
        hasLink: true,
        reason: pattern.name,
        match: m[0].slice(0, 80),
      };
    }
  }
  return { hasLink: false, reason: '', match: '' };
}

function defaultGroupConfig() {
  return {
    enabled: false,
    action: 'warn',
    maxWarns: ANTILINK_DEFAULT_MAX_WARNS,
    warns: {},
  };
}

function normalizeGroupConfig(raw) {
  const base = defaultGroupConfig();
  if (!raw || typeof raw !== 'object') return base;
  const action = ANTILINK_ACTIONS.includes(String(raw.action || '').toLowerCase())
    ? String(raw.action).toLowerCase()
    : base.action;
  const maxWarnsRaw = Number(raw.maxWarns);
  const maxWarns =
    Number.isFinite(maxWarnsRaw) && maxWarnsRaw >= 1 && maxWarnsRaw <= 10
      ? Math.floor(maxWarnsRaw)
      : base.maxWarns;
  const warns = {};
  if (raw.warns && typeof raw.warns === 'object') {
    for (const [k, v] of Object.entries(raw.warns)) {
      const count = Number(v);
      if (k && Number.isFinite(count) && count > 0) {
        warns[cleanJid(k)] = Math.floor(count);
      }
    }
  }
  return {
    enabled: Boolean(raw.enabled),
    action,
    maxWarns,
    warns,
  };
}

export function createAntilinkStore(filePathOrFn = null) {
  const isDefault = filePathOrFn === null || filePathOrFn === undefined;
  let tmpFallbackPath = null;
  const resolvePath = () => {
    if (!isDefault) {
      return typeof filePathOrFn === 'function' ? filePathOrFn() : String(filePathOrFn);
    }
    return tmpFallbackPath || path.join(process.cwd(), 'data', 'antilink.json');
  };
  let loadedPath = null;
  let cache = { groups: {}, global: { enabled: false, action: 'delete' } };

  function normalizeGlobalConfig(raw) {
    const enabled = Boolean(raw?.enabled);
    const action = ANTILINK_ACTIONS.includes(String(raw?.action || '').toLowerCase())
      ? String(raw.action).toLowerCase()
      : 'delete';
    return { enabled, action };
  }

  function ensureLoaded() {
    const filePath = resolvePath();
    if (loadedPath === filePath) return;
    loadedPath = filePath;
    cache = { groups: {}, global: { enabled: false, action: 'delete' } };
    const candidates = isDefault && !tmpFallbackPath
      ? [filePath, path.join(os.tmpdir(), 'spider-data', 'antilink.json')]
      : [filePath];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          if (parsed && typeof parsed === 'object' && parsed.groups && typeof parsed.groups === 'object') {
            for (const [jid, cfg] of Object.entries(parsed.groups)) {
              cache.groups[jid] = normalizeGroupConfig(cfg);
            }
          }
          if (parsed && typeof parsed === 'object' && parsed.global && typeof parsed.global === 'object') {
            cache.global = normalizeGlobalConfig(parsed.global);
          }
          if (candidate !== filePath) {
            tmpFallbackPath = candidate;
            loadedPath = candidate;
          }
          break;
        }
      } catch {
        cache = { groups: {}, global: { enabled: false, action: 'delete' } };
      }
    }
  }

  function writeTarget(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2));
  }

  function save() {
    const filePath = resolvePath();
    try {
      writeTarget(filePath);
    } catch {
      if (isDefault) {
        const fallback = path.join(os.tmpdir(), 'spider-data', 'antilink.json');
        try {
          writeTarget(fallback);
          tmpFallbackPath = fallback;
          loadedPath = fallback;
        } catch {
          // Best-effort persistence on read-only hosts
        }
      }
    }
  }

  return {
    clearCache() {
      loadedPath = null;
      cache = { groups: {}, global: { enabled: false, action: 'delete' } };
    },
    getGlobalConfig() {
      ensureLoaded();
      return { ...normalizeGlobalConfig(cache.global) };
    },
    setGlobalConfig(next) {
      ensureLoaded();
      const prev = normalizeGlobalConfig(cache.global);
      const merged = typeof next === 'function' ? next(prev) : { ...prev, ...next };
      cache.global = normalizeGlobalConfig(merged);
      save();
      return { ...cache.global };
    },
    getGroupConfig(groupJid) {
      ensureLoaded();
      const cfg = cache.groups[groupJid] || defaultGroupConfig();
      return { ...cfg, warns: { ...cfg.warns } };
    },
    setGroupConfig(groupJid, next) {
      ensureLoaded();
      const normalized = normalizeGroupConfig(next);
      cache.groups[groupJid] = normalized;
      save();
      return { ...normalized, warns: { ...normalized.warns } };
    },
    addWarn(groupJid, targetJid, senderCandidates = []) {
      ensureLoaded();
      const current = cache.groups[groupJid] || defaultGroupConfig();
      const aliasKeys = [
        targetJid,
        ...(Array.isArray(senderCandidates) ? senderCandidates : []),
      ]
        .filter(Boolean)
        .map((j) => cleanJid(j))
        .filter(Boolean);
      const primaryKey = cleanJid(targetJid) || aliasKeys[0] || '';
      const aliasSet = new Set(aliasKeys.map((k) => k.toLowerCase()));
      const phones = new Set(
        aliasKeys.map((k) => extractPhoneDigits(k)).filter(Boolean),
      );

      let existingCount = 0;
      for (const [existingKey, existingVal] of Object.entries(current.warns || {})) {
        const cleanExisting = cleanJid(existingKey);
        const existingPhone = extractPhoneDigits(cleanExisting);
        const matchesAlias =
          aliasSet.has(existingKey.toLowerCase()) ||
          aliasSet.has(cleanExisting.toLowerCase()) ||
          (existingPhone && phones.has(existingPhone));
        if (matchesAlias) {
          existingCount += Number(existingVal) || 0;
          delete current.warns[existingKey];
        }
      }

      const nextCount = existingCount + 1;
      if (primaryKey) {
        current.warns[primaryKey] = nextCount;
      }
      cache.groups[groupJid] = current;
      save();
      return { count: nextCount, maxWarns: current.maxWarns };
    },
    resetWarns(groupJid, targetJid = null, senderCandidates = []) {
      ensureLoaded();
      const current = cache.groups[groupJid];
      if (!current) return;
      if (targetJid || (Array.isArray(senderCandidates) && senderCandidates.length > 0)) {
        const keys = [targetJid, ...(Array.isArray(senderCandidates) ? senderCandidates : [])]
          .filter(Boolean)
          .map((j) => cleanJid(j));
        const phones = new Set(
          keys
            .filter((k) => k.endsWith('@s.whatsapp.net'))
            .map((k) => k.split('@')[0]),
        );
        for (const k of keys) {
          delete current.warns[k];
        }
        if (phones.size > 0) {
          for (const existing of Object.keys(current.warns)) {
            if (existing.endsWith('@s.whatsapp.net') && phones.has(existing.split('@')[0])) {
              delete current.warns[existing];
            }
          }
        }
      } else {
        current.warns = {};
      }
      cache.groups[groupJid] = current;
      save();
    },
  };
}

export const defaultAntilinkStore = createAntilinkStore();

function formatAntilinkAlert({
  botName,
  actionLabel,
  targetUser,
  reason,
  warnText = '',
  warningMessage = '',
}) {
  const lines = [
    spiderHeader(botName || 'Spider Man', 'ANTILINK SHIELD'),
    spiderRow('USER', `@${targetUser}`, '⚠'),
    spiderRow('ACTION', actionLabel, '⛨'),
    spiderRow('REASON', reason || 'Unauthorized Link Shared', '◈'),
  ];
  if (warnText) {
    lines.push(spiderRow('WARNINGS', warnText, '▣'));
  }
  if (warningMessage) {
    lines.push(spiderRow('WARNING', warningMessage, '⚠'));
  }
  lines.push(spiderFooter('GROUP LINK PROTECTION ACTIVE'));
  return lines.join('\n');
}

export async function handleAntiLinkMessage({
  sock,
  from,
  sender,
  msg,
  text = '',
  isOwner = false,
  groupMeta = null,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  store = defaultAntilinkStore,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !from || !String(from).endsWith('@g.us') || !msg || msg.key?.fromMe) {
    return { handled: false, reason: 'not-applicable' };
  }

  const rawGroupConfig = store.getGroupConfig(from);
  const globalConfig = typeof store.getGlobalConfig === 'function'
    ? store.getGlobalConfig()
    : { enabled: false, action: 'delete' };
  const usingGlobal = !rawGroupConfig.enabled && Boolean(globalConfig.enabled);
  const groupConfig = usingGlobal
    ? { ...rawGroupConfig, enabled: true, action: globalConfig.action || 'delete' }
    : rawGroupConfig;

  if (!groupConfig.enabled) {
    return { handled: false, reason: 'disabled' };
  }

  if (isOwner) {
    return { handled: false, reason: 'owner-exempt' };
  }

  const combinedText = extractAntilinkText(msg, text);
  const channelForward = detectChannelForward(msg);
  const textDetection = combinedText
    ? detectLinkMessage(combinedText)
    : { hasLink: false, reason: '', match: '' };
  const detection = textDetection.hasLink
    ? textDetection
    : channelForward.isChannelForward
      ? { hasLink: true, reason: channelForward.reason, match: channelForward.match }
      : textDetection;

  if (!detection.hasLink) {
    return {
      handled: false,
      reason: combinedText ? 'clean' : 'empty-text',
      detection,
    };
  }

  let metadata = groupMeta;
  if (!metadata) {
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
  }

  const senderCandidates = collectSenderIdentities(msg, [sender]);
  const botCandidates = collectBotIdentities(sock);
  const { senderRole, botRole } = await resolveGroupRolesAsync({
    metadata,
    sock,
    senderJids: senderCandidates,
    getPhoneFn: getPhoneFromJid,
  });

  if (senderRole.isAdmin) {
    return { handled: false, reason: 'sender-is-admin', detection };
  }

  if (metadata && botCandidates.length > 0 && !botRole.isAdmin) {
    return { handled: false, reason: 'bot-not-admin', detection };
  }

  const {
    targetJid,
    mentionJid,
    targetUser,
    candidates: resolvedCandidates,
  } = resolveSenderDisplayAndMention({
    senderRole,
    senderJid: sender || msg.key?.participant || msg.key?.participantAlt || '',
    senderCandidates,
    metadata,
    getPhoneFn: getPhoneFromJid,
  });

  const delRes = await deleteMessageSafely({
    sock,
    from,
    msg,
    targetJid,
    senderCandidates: resolvedCandidates,
    metadata,
    getPhoneFn: getPhoneFromJid,
    broadcastAlternates: true,
  });
  const deleted = delRes.ok;

  let kicked = false;
  let warned = false;
  let warnCount = 0;
  const maxWarns = groupConfig.maxWarns || ANTILINK_DEFAULT_MAX_WARNS;
  let actionLabel = deleted ? 'MESSAGE DELETED' : 'DELETE FAILED';
  let warnText = '';
  let warningMessage = '';

  const mode = groupConfig.action;
  if (mode === 'kick') {
    const kickRes = await executeParticipantsAction({
      sock,
      from,
      participants: targetJid ? [targetJid] : resolvedCandidates,
      action: 'remove',
      metadata,
    });
    kicked = kickRes.ok;
    actionLabel = kicked
      ? deleted
        ? 'DELETED & KICKED'
        : 'KICKED (DELETE FAILED)'
      : deleted
        ? 'DELETED (KICK FAILED)'
        : 'KICK & DELETE FAILED';
  } else if (mode === 'warn') {
    const warnResult = store.addWarn(
      from,
      targetJid || resolvedCandidates[0],
      resolvedCandidates,
    );
    warned = true;
    warnCount = warnResult.count;
    warnText = `${warnCount}/${warnResult.maxWarns}`;
    if (warnCount >= warnResult.maxWarns) {
      const kickRes = await executeParticipantsAction({
        sock,
        from,
        participants: targetJid ? [targetJid] : resolvedCandidates,
        action: 'remove',
        metadata,
      });
      kicked = kickRes.ok;
      if (kicked) {
        store.resetWarns(from, targetJid || resolvedCandidates[0], resolvedCandidates);
      }
      actionLabel = kicked
        ? deleted
          ? 'DELETED · MAX WARNS · KICKED'
          : 'MAX WARNS · KICKED (DELETE FAILED)'
        : deleted
          ? 'DELETED · MAX WARNS (KICK FAILED)'
          : 'MAX WARNS (KICK & DELETE FAILED)';
    } else {
      actionLabel = deleted ? 'DELETED & WARNED' : 'WARNED (DELETE FAILED)';
    }
  } else if (mode === 'delete') {
    actionLabel = deleted ? 'MESSAGE DELETED' : 'DELETE FAILED';
    warningMessage = 'No links allowed in this group!';
  }

  try {
    await sock.sendMessage(from, {
      text: formatAntilinkAlert({
        botName,
        actionLabel,
        targetUser,
        reason: detection.reason,
        warnText,
        warningMessage,
      }),
      mentions: mentionJid ? [mentionJid] : [],
    });
  } catch {}

  return {
    handled: true,
    action: mode,
    deleted,
    kicked,
    warned,
    warnCount,
    maxWarns,
    targetJid,
    warningMessage,
    detection,
  };
}
