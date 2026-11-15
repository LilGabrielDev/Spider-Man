import fs from 'fs';
import os from 'os';
import path from 'path';
import { spiderFooter, spiderHeader, spiderRow } from '../../Spider/utils/tableStyle.js';
import { extractMessageText } from './antiscam.js';
import {
  cleanJid,
  collectBotIdentities,
  collectSenderIdentities,
  resolveGroupRolesAsync,
} from './groupRoleResolver.js';
import {
  deleteMessageSafely,
  executeParticipantsAction,
  resolveSenderDisplayAndMention,
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
];

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
  let cache = { groups: {} };

  function ensureLoaded() {
    const filePath = resolvePath();
    if (loadedPath === filePath) return;
    loadedPath = filePath;
    cache = { groups: {} };
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
          if (candidate !== filePath) {
            tmpFallbackPath = candidate;
            loadedPath = candidate;
          }
          break;
        }
      } catch {
        cache = { groups: {} };
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
      cache = { groups: {} };
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
    addWarn(groupJid, targetJid) {
      ensureLoaded();
      const current = cache.groups[groupJid] || defaultGroupConfig();
      const key = cleanJid(targetJid);
      const nextCount = (current.warns[key] || 0) + 1;
      current.warns[key] = nextCount;
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

  const groupConfig = store.getGroupConfig(from);
  if (!groupConfig.enabled) {
    return { handled: false, reason: 'disabled' };
  }

  if (isOwner) {
    return { handled: false, reason: 'owner-exempt' };
  }

  const combinedText = extractMessageText(msg, text);
  if (!combinedText) {
    return { handled: false, reason: 'empty-text' };
  }

  const detection = detectLinkMessage(combinedText);
  if (!detection.hasLink) {
    return { handled: false, reason: 'clean', detection };
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
    const warnResult = store.addWarn(from, targetJid || resolvedCandidates[0]);
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
