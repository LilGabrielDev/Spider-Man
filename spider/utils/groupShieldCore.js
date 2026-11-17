import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spiderFooter, spiderHeader, spiderRow } from '../../Spider/utils/tableStyle.js';
import {
  cleanJid,
  collectBotIdentities,
  collectSenderIdentities,
  extractLid,
  extractPhoneDigits,
  resolveGroupRolesAsync,
} from './groupRoleResolver.js';
import {
  collectParticipantAlternates,
  deleteMessageSafely,
  executeParticipantsAction,
  extractContextInfo,
  resolveSenderDisplayAndMention,
  unwrapMessageContent,
} from './groupActionHelper.js';

export const STANDARD_SHIELD_ACTIONS = Object.freeze(['delete', 'warn', 'kick', 'warnkick']);
export const DEFAULT_MAX_WARNS = 3;

export function normalizeWhitelistToken(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.includes('@')) {
    const cleaned = cleanJid(s);
    return cleaned.toLowerCase();
  }
  const digits = s.replace(/^@/, '').replace(/\D/g, '');
  if (/^\d{5,20}$/.test(digits)) {
    return `${digits}@s.whatsapp.net`;
  }
  return s.toLowerCase();
}

export function normalizeShieldWarnMap(rawWarns) {
  const warns = {};
  if (rawWarns && typeof rawWarns === 'object') {
    for (const [k, v] of Object.entries(rawWarns)) {
      const count = Number(v);
      if (k && Number.isFinite(count) && count > 0) {
        warns[cleanJid(k)] = Math.floor(count);
      }
    }
  }
  return warns;
}

export function normalizeWhitelistArray(rawList, maxEntries = 100) {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set();
  const out = [];
  for (const item of rawList) {
    const norm = normalizeWhitelistToken(item);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= maxEntries) break;
  }
  return out;
}

export function createJsonShieldStore({
  fileName,
  filePathOrFn = null,
  defaultGroupConfig,
  normalizeGroupConfig,
  maxWarnsFallback = DEFAULT_MAX_WARNS,
} = {}) {
  const isDefault = filePathOrFn === null || filePathOrFn === undefined;
  let tmpFallbackPath = null;

  const resolvePath = () => {
    if (!isDefault) {
      return typeof filePathOrFn === 'function' ? filePathOrFn() : String(filePathOrFn);
    }
    return tmpFallbackPath || path.join(process.cwd(), 'data', fileName);
  };

  let loadedPath = null;
  let cache = { groups: {} };

  function ensureLoaded() {
    const filePath = resolvePath();
    if (loadedPath === filePath) return;
    loadedPath = filePath;
    cache = { groups: {} };
    const candidates = isDefault && !tmpFallbackPath
      ? [filePath, path.join(os.tmpdir(), 'spider-data', fileName)]
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
    const tmpFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(cache, null, 2));
    fs.renameSync(tmpFile, filePath);
  }

  function save() {
    const filePath = resolvePath();
    try {
      writeTarget(filePath);
    } catch {
      if (isDefault) {
        const fallback = path.join(os.tmpdir(), 'spider-data', fileName);
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

  function getMutableGroup(groupJid) {
    ensureLoaded();
    if (!cache.groups[groupJid]) {
      cache.groups[groupJid] = normalizeGroupConfig(defaultGroupConfig());
    } else {
      cache.groups[groupJid] = normalizeGroupConfig(cache.groups[groupJid]);
    }
    return cache.groups[groupJid];
  }

  return {
    clearCache() {
      loadedPath = null;
      tmpFallbackPath = null;
      cache = { groups: {} };
    },
    getGroupConfig(groupJid) {
      ensureLoaded();
      return normalizeGroupConfig(cache.groups[groupJid] || defaultGroupConfig());
    },
    setGroupConfig(groupJid, patch = {}) {
      ensureLoaded();
      const prev = normalizeGroupConfig(cache.groups[groupJid] || defaultGroupConfig());
      const nextRaw = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
      const normalized = normalizeGroupConfig(nextRaw);
      cache.groups[groupJid] = normalized;
      save();
      return normalizeGroupConfig(normalized);
    },
    addWarn(groupJid, targetJid, senderCandidates = []) {
      const current = getMutableGroup(groupJid);
      const warns = { ...(current.warns || {}) };
      const aliasKeys = [targetJid, ...(Array.isArray(senderCandidates) ? senderCandidates : [])]
        .map((j) => cleanJid(j))
        .filter(Boolean);
      const primaryKey = cleanJid(targetJid) || aliasKeys[0] || '';
      const aliasSet = new Set(aliasKeys.map((k) => k.toLowerCase()));
      const phones = new Set(aliasKeys.map((k) => extractPhoneDigits(k)).filter(Boolean));
      const lids = new Set(aliasKeys.map((k) => extractLid(k)).filter(Boolean));

      let existingCount = 0;
      for (const [existingKey, existingVal] of Object.entries(warns)) {
        const cleanExisting = cleanJid(existingKey);
        const existingPhone = extractPhoneDigits(cleanExisting);
        const existingLid = extractLid(cleanExisting);
        const matches =
          aliasSet.has(existingKey.toLowerCase()) ||
          aliasSet.has(cleanExisting.toLowerCase()) ||
          (existingPhone && phones.has(existingPhone)) ||
          (existingLid && lids.has(existingLid));
        if (matches) {
          existingCount += Number(existingVal) || 0;
          delete warns[existingKey];
        }
      }

      const nextCount = existingCount + 1;
      if (primaryKey) {
        warns[primaryKey] = nextCount;
      }
      current.warns = warns;
      cache.groups[groupJid] = current;
      save();
      return {
        count: nextCount,
        maxWarns: current.maxWarns || maxWarnsFallback,
      };
    },
    resetWarns(groupJid, targetJid = null, senderCandidates = []) {
      ensureLoaded();
      if (!cache.groups[groupJid]) return;
      const current = normalizeGroupConfig(cache.groups[groupJid]);
      if (!targetJid && (!Array.isArray(senderCandidates) || senderCandidates.length === 0)) {
        current.warns = {};
      } else {
        const warns = { ...(current.warns || {}) };
        const keys = [targetJid, ...(Array.isArray(senderCandidates) ? senderCandidates : [])]
          .map((j) => cleanJid(j))
          .filter(Boolean);
        const keySet = new Set(keys.map((k) => k.toLowerCase()));
        const phones = new Set(keys.map((k) => extractPhoneDigits(k)).filter(Boolean));
        const lids = new Set(keys.map((k) => extractLid(k)).filter(Boolean));
        for (const existingKey of Object.keys(warns)) {
          const cleanExisting = cleanJid(existingKey);
          const existingPhone = extractPhoneDigits(cleanExisting);
          const existingLid = extractLid(cleanExisting);
          if (
            keySet.has(existingKey.toLowerCase()) ||
            keySet.has(cleanExisting.toLowerCase()) ||
            (existingPhone && phones.has(existingPhone)) ||
            (existingLid && lids.has(existingLid))
          ) {
            delete warns[existingKey];
          }
        }
        current.warns = warns;
      }
      cache.groups[groupJid] = current;
      save();
    },
    addWhitelist(groupJid, token) {
      const entry = normalizeWhitelistToken(token);
      if (!entry) return { added: false, entry: '', config: this.getGroupConfig(groupJid) };
      const current = getMutableGroup(groupJid);
      const list = Array.isArray(current.whitelist) ? [...current.whitelist] : [];
      if (list.includes(entry)) {
        return { added: false, entry, config: normalizeGroupConfig(current) };
      }
      list.push(entry);
      current.whitelist = list;
      cache.groups[groupJid] = current;
      save();
      return { added: true, entry, config: normalizeGroupConfig(current) };
    },
    removeWhitelist(groupJid, token) {
      const entry = normalizeWhitelistToken(token);
      if (!entry) return { removed: false, entry: '', config: this.getGroupConfig(groupJid) };
      const current = getMutableGroup(groupJid);
      const targetPhone = extractPhoneDigits(entry);
      const before = Array.isArray(current.whitelist) ? [...current.whitelist] : [];
      const after = before.filter((item) => {
        if (item === entry) return false;
        if (targetPhone && extractPhoneDigits(item) === targetPhone) return false;
        return true;
      });
      const removed = after.length !== before.length;
      if (removed) {
        current.whitelist = after;
        cache.groups[groupJid] = current;
        save();
      }
      return { removed, entry, config: normalizeGroupConfig(current) };
    },
    isWhitelisted(groupJid, candidates = []) {
      const current = this.getGroupConfig(groupJid);
      const list = Array.isArray(current.whitelist) ? current.whitelist : [];
      if (list.length === 0) return false;
      const wlSet = new Set(list.map((w) => String(w || '').toLowerCase()));
      const wlPhones = new Set(list.map((w) => extractPhoneDigits(w)).filter(Boolean));
      const wlLids = new Set(list.map((w) => extractLid(w)).filter(Boolean));
      for (const cand of Array.isArray(candidates) ? candidates : [candidates]) {
        const cleaned = cleanJid(cand).toLowerCase();
        if (!cleaned) continue;
        if (wlSet.has(cleaned)) return true;
        const lid = extractLid(cleaned);
        if (lid && wlLids.has(lid)) return true;
        const phone = extractPhoneDigits(cleaned);
        if (phone && wlPhones.has(phone)) return true;
      }
      return false;
    },
    recordAction(groupJid, statsPatch = {}) {
      const current = getMutableGroup(groupJid);
      const nextStats = { ...(current.stats || {}) };
      for (const [k, v] of Object.entries(statsPatch)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          nextStats[k] = Number(nextStats[k] || 0) + v;
        }
      }
      current.stats = nextStats;
      cache.groups[groupJid] = current;
      save();
      return normalizeGroupConfig(current);
    },
    resetGroup(groupJid) {
      ensureLoaded();
      delete cache.groups[groupJid];
      save();
    },
    resetAll() {
      loadedPath = null;
      cache = { groups: {} };
      const target = resolvePath();
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch {}
    },
  };
}

export function collectAllContextInfos(msg) {
  const { contextInfo } = extractContextInfo(msg);
  const unwrapped = unwrapMessageContent(msg?.message);
  const out = [];
  const push = (ctx) => {
    if (ctx && typeof ctx === 'object' && !out.includes(ctx)) {
      out.push(ctx);
    }
  };
  push(contextInfo);
  for (const layer of [unwrapped, msg?.message]) {
    if (!layer || typeof layer !== 'object') continue;
    push(layer.contextInfo);
    push(layer.messageContextInfo);
    for (const val of Object.values(layer)) {
      if (val && typeof val === 'object') {
        push(val.contextInfo);
      }
    }
  }
  return out;
}

export function formatShieldAlert({
  botName = 'Spider Man',
  shieldTitle = 'SHIELD ALERT',
  targetUser = 'user',
  actionLabel = 'MESSAGE DELETED',
  reason = 'Policy Violation',
  warnText = '',
  extraRow = null,
  footer = 'GROUP PROTECTION ACTIVE',
}) {
  const lines = [
    spiderHeader(botName || 'Spider Man', shieldTitle),
    spiderRow('USER', `@${targetUser}`, '⚠'),
    spiderRow('ACTION', actionLabel, '⛨'),
    spiderRow('REASON', reason, '◈'),
  ];
  if (extraRow && extraRow.label && extraRow.value) {
    lines.push(spiderRow(extraRow.label, extraRow.value, extraRow.icon || '❖'));
  }
  if (warnText) {
    lines.push(spiderRow('WARNINGS', warnText, '▣'));
  }
  lines.push(spiderFooter(footer));
  return lines.join('\n');
}

export async function enforceMessageShield({
  sock,
  from,
  sender,
  msg,
  isOwner = false,
  groupMeta = null,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  groupConfig,
  store = null,
  onWarnAdd = null,
  onWarnReset = null,
  onRecordStats = null,
  extraWhitelistCandidates = [],
  botName = 'Spider Man',
  shieldTitle = 'GROUP SHIELD',
  shieldFooter = 'GROUP PROTECTION ACTIVE',
  reason = 'Policy Violation',
  extraRow = null,
  detection = null,
} = {}) {
  if (!sock || !from || !String(from).endsWith('@g.us') || !msg || msg.key?.fromMe) {
    return { handled: false, reason: 'not-applicable' };
  }
  if (!groupConfig?.enabled) {
    return { handled: false, reason: 'disabled' };
  }
  if (isOwner) {
    return { handled: false, reason: 'owner-exempt' };
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

  if (senderRole.isAdmin || senderRole.isOwner) {
    return { handled: false, reason: 'sender-is-admin', detection };
  }

  const whitelistCheckList = [
    ...senderCandidates,
    ...(senderRole?.targetJid ? [senderRole.targetJid] : []),
    ...collectParticipantAlternates(metadata, senderCandidates),
    ...(Array.isArray(extraWhitelistCandidates) ? extraWhitelistCandidates : []),
  ];
  if (store && typeof store.isWhitelisted === 'function' && store.isWhitelisted(from, whitelistCheckList)) {
    return { handled: false, reason: 'whitelisted', detection };
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

  const mode = STANDARD_SHIELD_ACTIONS.includes(groupConfig.action) ? groupConfig.action : 'delete';
  const maxWarns = Number(groupConfig.maxWarns) || DEFAULT_MAX_WARNS;
  let kicked = false;
  let warned = false;
  let warnCount = 0;
  let warnText = '';
  let actionLabel = deleted ? 'MESSAGE DELETED' : 'DELETE FAILED';

  if (mode === 'kick') {
    const kickRes = await executeParticipantsAction({
      sock,
      from,
      participants: targetJid ? [targetJid, ...resolvedCandidates] : resolvedCandidates,
      action: 'remove',
      metadata,
    });
    kicked = kickRes.ok;
    if (kicked) {
      if (onWarnReset) onWarnReset(from, targetJid || resolvedCandidates[0], resolvedCandidates);
      else store?.resetWarns?.(from, targetJid || resolvedCandidates[0], resolvedCandidates);
    }
    actionLabel = kicked
      ? deleted
        ? 'DELETED & KICKED'
        : 'KICKED (DELETE FAILED)'
      : deleted
        ? 'DELETED (KICK FAILED)'
        : 'KICK & DELETE FAILED';
  } else if (mode === 'warn' || mode === 'warnkick') {
    const warnResult = onWarnAdd
      ? onWarnAdd(from, targetJid || resolvedCandidates[0], resolvedCandidates)
      : store?.addWarn?.(from, targetJid || resolvedCandidates[0], resolvedCandidates) || { count: 1, maxWarns };
    warned = true;
    warnCount = warnResult.count;
    warnText = `${warnCount}/${warnResult.maxWarns || maxWarns}`;
    if (warnCount >= (warnResult.maxWarns || maxWarns)) {
      const kickRes = await executeParticipantsAction({
        sock,
        from,
        participants: targetJid ? [targetJid, ...resolvedCandidates] : resolvedCandidates,
        action: 'remove',
        metadata,
      });
      kicked = kickRes.ok;
      if (kicked) {
        if (onWarnReset) onWarnReset(from, targetJid || resolvedCandidates[0], resolvedCandidates);
        else store?.resetWarns?.(from, targetJid || resolvedCandidates[0], resolvedCandidates);
      }
      actionLabel = kicked
        ? deleted
          ? 'DELETED · MAX WARNS · KICKED'
          : 'MAX WARNS · KICKED'
        : deleted
          ? 'DELETED · MAX WARNS (KICK FAILED)'
          : 'MAX WARNS (KICK & DELETE FAILED)';
    } else {
      actionLabel = deleted ? 'DELETED & WARNED' : 'WARNED (DELETE FAILED)';
    }
  }

  const statsPatch = {
    detected: 1,
    deleted: deleted ? 1 : 0,
    warned: warned ? 1 : 0,
    kicked: kicked ? 1 : 0,
  };
  if (onRecordStats) onRecordStats(from, statsPatch);
  else store?.recordAction?.(from, statsPatch);

  if (groupConfig.notify !== false) {
    try {
      await sock.sendMessage(from, {
        text: formatShieldAlert({
          botName,
          shieldTitle,
          targetUser,
          actionLabel,
          reason,
          warnText,
          extraRow,
          footer: shieldFooter,
        }),
        mentions: mentionJid ? [mentionJid] : [],
      });
    } catch {}
  }

  return {
    handled: true,
    action: mode,
    deleted,
    kicked,
    warned,
    warnCount,
    maxWarns,
    targetJid,
    detection,
  };
}
