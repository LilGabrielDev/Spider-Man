import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spiderFooter, spiderHeader, spiderRow } from '../../Spider/utils/tableStyle.js';
import {
  cleanJid,
  collectBotIdentities,
  extractLid,
  extractPhoneDigits,
  resolveGroupRolesAsync,
} from './groupRoleResolver.js';
import {
  collectParticipantAlternates,
  executeParticipantsAction,
  isFromBot,
  resolveLidPnAlternatesAsync,
} from './groupActionHelper.js';

function defaultGroupConfig() {
  return {
    enabled: false,
    autobanOnKick: true,
    notify: true,
    banned: [],
    stats: {
      bannedCount: 0,
      blockedRejoins: 0,
    },
  };
}

function normalizeBanEntry(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const cleaned = cleanJid(raw);
    if (!cleaned) return null;
    const phone = extractPhoneDigits(cleaned);
    const lid = extractLid(cleaned);
    return {
      key: phone ? `${phone}@s.whatsapp.net` : cleaned.toLowerCase(),
      jid: cleaned,
      phone: phone || '',
      lid: lid || '',
      bannedBy: '',
      reason: 'Kicked from group',
      bannedAt: Date.now(),
    };
  }
  if (typeof raw !== 'object') return null;
  const jid = cleanJid(raw.jid || raw.key || '');
  const phone = String(raw.phone || extractPhoneDigits(jid) || '').replace(/\D/g, '');
  const lid = String(raw.lid || extractLid(jid) || '').replace(/\D/g, '');
  const key = (phone ? `${phone}@s.whatsapp.net` : jid || (lid ? `${lid}@lid` : '')).toLowerCase();
  if (!key) return null;
  return {
    key,
    jid: jid || key,
    phone,
    lid,
    bannedBy: cleanJid(raw.bannedBy || ''),
    reason: String(raw.reason || 'Kicked from group').slice(0, 120),
    bannedAt: Number(raw.bannedAt) || Date.now(),
  };
}

function normalizeGroupConfig(raw) {
  const base = defaultGroupConfig();
  if (!raw || typeof raw !== 'object') return base;
  const banned = [];
  const seenKeys = new Set();
  if (Array.isArray(raw.banned)) {
    for (const item of raw.banned) {
      const norm = normalizeBanEntry(item);
      if (!norm || seenKeys.has(norm.key)) continue;
      seenKeys.add(norm.key);
      banned.push(norm);
    }
  }
  return {
    enabled: Boolean(raw.enabled),
    autobanOnKick: raw.autobanOnKick !== false,
    notify: raw.notify !== false,
    banned,
    stats: {
      bannedCount: Math.max(Number(raw.stats?.bannedCount || 0), banned.length),
      blockedRejoins: Number(raw.stats?.blockedRejoins || 0),
    },
  };
}

function entryMatchesCandidates(entry, candidateSet, phoneSet, lidSet) {
  if (!entry) return false;
  if (candidateSet.has(String(entry.key || '').toLowerCase())) return true;
  if (candidateSet.has(String(entry.jid || '').toLowerCase())) return true;
  if (entry.phone && phoneSet.has(entry.phone)) return true;
  if (entry.lid && lidSet.has(entry.lid)) return true;
  return false;
}

function buildIdentitySets(candidates = []) {
  const cleaned = (Array.isArray(candidates) ? candidates : [candidates])
    .map((c) => cleanJid(c))
    .filter(Boolean);
  const candidateSet = new Set(cleaned.map((c) => c.toLowerCase()));
  const phoneSet = new Set(cleaned.map((c) => extractPhoneDigits(c)).filter(Boolean));
  const lidSet = new Set(cleaned.map((c) => extractLid(c)).filter(Boolean));
  return { cleaned, candidateSet, phoneSet, lidSet };
}

export function createAntirejoinStore(filePathOrFn = null) {
  const isDefault = filePathOrFn === null || filePathOrFn === undefined;
  let tmpFallbackPath = null;

  const resolvePath = () => {
    if (!isDefault) {
      return typeof filePathOrFn === 'function' ? filePathOrFn() : String(filePathOrFn);
    }
    return tmpFallbackPath || path.join(process.cwd(), 'data', 'antirejoin.json');
  };

  let loadedPath = null;
  let cache = { groups: {} };

  function ensureLoaded() {
    const filePath = resolvePath();
    if (loadedPath === filePath) return;
    loadedPath = filePath;
    cache = { groups: {} };
    const candidates = isDefault && !tmpFallbackPath
      ? [filePath, path.join(os.tmpdir(), 'spider-data', 'antirejoin.json')]
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
        const fallback = path.join(os.tmpdir(), 'spider-data', 'antirejoin.json');
        try {
          writeTarget(fallback);
          tmpFallbackPath = fallback;
          loadedPath = fallback;
        } catch {}
      }
    }
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
      return normalized;
    },
    banUser(groupJid, { jid = '', candidates = [], phone = '', lid = '', bannedBy = '', reason = 'Kicked from group' } = {}) {
      ensureLoaded();
      const cfg = normalizeGroupConfig(cache.groups[groupJid] || defaultGroupConfig());
      const all = [jid, ...candidates, phone ? `${phone}@s.whatsapp.net` : '', lid ? `${lid}@lid` : ''].filter(Boolean);
      const { cleaned, candidateSet, phoneSet, lidSet } = buildIdentitySets(all);
      const resolvedPhone = phone || [...phoneSet][0] || '';
      const resolvedLid = lid || [...lidSet][0] || '';
      const primaryJid = cleanJid(jid) || cleaned[0] || (resolvedPhone ? `${resolvedPhone}@s.whatsapp.net` : '');
      if (!primaryJid && !resolvedPhone && !resolvedLid) {
        return { added: false, entry: null, config: cfg };
      }

      const existingIdx = cfg.banned.findIndex((item) =>
        entryMatchesCandidates(item, candidateSet, phoneSet, lidSet),
      );
      const nextEntry = normalizeBanEntry({
        key: (resolvedPhone ? `${resolvedPhone}@s.whatsapp.net` : primaryJid).toLowerCase(),
        jid: primaryJid,
        phone: resolvedPhone,
        lid: resolvedLid,
        bannedBy,
        reason,
        bannedAt: Date.now(),
      });

      let added = false;
      if (existingIdx !== -1) {
        const prev = cfg.banned[existingIdx];
        cfg.banned[existingIdx] = normalizeBanEntry({
          ...prev,
          phone: prev.phone || nextEntry.phone,
          lid: prev.lid || nextEntry.lid,
          reason: nextEntry.reason || prev.reason,
          bannedBy: nextEntry.bannedBy || prev.bannedBy,
        });
      } else {
        cfg.banned.push(nextEntry);
        cfg.stats.bannedCount += 1;
        added = true;
      }

      cache.groups[groupJid] = normalizeGroupConfig(cfg);
      save();
      return { added, entry: nextEntry, config: cache.groups[groupJid] };
    },
    unbanUser(groupJid, targetOrCandidates = []) {
      ensureLoaded();
      const cfg = normalizeGroupConfig(cache.groups[groupJid] || defaultGroupConfig());
      const { candidateSet, phoneSet, lidSet } = buildIdentitySets(targetOrCandidates);
      const before = cfg.banned.length;
      cfg.banned = cfg.banned.filter((item) => !entryMatchesCandidates(item, candidateSet, phoneSet, lidSet));
      const removed = cfg.banned.length !== before;
      if (removed) {
        cache.groups[groupJid] = normalizeGroupConfig(cfg);
        save();
      }
      return { removed, removedCount: before - cfg.banned.length, config: cache.groups[groupJid] || cfg };
    },
    clearBans(groupJid) {
      ensureLoaded();
      const cfg = normalizeGroupConfig(cache.groups[groupJid] || defaultGroupConfig());
      const clearedCount = cfg.banned.length;
      cfg.banned = [];
      cache.groups[groupJid] = cfg;
      save();
      return { clearedCount, config: cfg };
    },
    isBanned(groupJid, candidates = []) {
      const cfg = this.getGroupConfig(groupJid);
      if (!cfg.banned.length) return null;
      const { candidateSet, phoneSet, lidSet } = buildIdentitySets(candidates);
      return cfg.banned.find((item) => entryMatchesCandidates(item, candidateSet, phoneSet, lidSet)) || null;
    },
    recordAction(groupJid, statsPatch = {}) {
      ensureLoaded();
      const cfg = normalizeGroupConfig(cache.groups[groupJid] || defaultGroupConfig());
      for (const k of ['bannedCount', 'blockedRejoins']) {
        if (typeof statsPatch[k] === 'number') cfg.stats[k] += statsPatch[k];
      }
      cache.groups[groupJid] = cfg;
      save();
      return cfg;
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

export const defaultAntirejoinStore = createAntirejoinStore();

function extractParticipantJid(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return cleanJid(entry);
  if (typeof entry === 'object') {
    return cleanJid(entry.id || entry.jid || entry.phoneNumber || entry.pn || '');
  }
  return '';
}

function identitiesOverlap(aList = [], bList = []) {
  const a = buildIdentitySets(aList);
  const b = buildIdentitySets(bList);
  for (const c of b.candidateSet) if (a.candidateSet.has(c)) return true;
  for (const p of b.phoneSet) if (a.phoneSet.has(p)) return true;
  for (const l of b.lidSet) if (a.lidSet.has(l)) return true;
  return false;
}

export async function recordRemoveForAntiRejoin({
  sock = null,
  update = null,
  getPhoneFromJid = null,
  isOwnerJid = null,
  store = defaultAntirejoinStore,
} = {}) {
  if (!update || update.action !== 'remove') return { recorded: 0 };
  const from = String(update.id || '');
  if (!from.endsWith('@g.us')) return { recorded: 0 };

  const cfg = store.getGroupConfig(from);
  if (!cfg.enabled || !cfg.autobanOnKick) return { recorded: 0 };

  const author = cleanJid(update.author || '');
  if (!author) {
    // Self-leave in Baileys typically has no external author
    return { recorded: 0, reason: 'no-author' };
  }

  const authorPhone = extractPhoneDigits(author, getPhoneFromJid);
  const authorCandidates = [author, authorPhone ? `${authorPhone}@s.whatsapp.net` : ''].filter(Boolean);

  const participants = (Array.isArray(update.participants) ? update.participants : [])
    .map(extractParticipantJid)
    .filter(Boolean);

  let recorded = 0;
  for (const participant of participants) {
    const pPhone = extractPhoneDigits(participant, getPhoneFromJid);
    const pCandidates = [participant, pPhone ? `${pPhone}@s.whatsapp.net` : ''].filter(Boolean);
    if (sock && isFromBot(pCandidates, sock)) continue;
    if (typeof isOwnerJid === 'function' && pCandidates.some((c) => isOwnerJid(c))) continue;
    // If participant removed themselves (left voluntarily), do not auto-ban
    if (identitiesOverlap(authorCandidates, pCandidates)) continue;

    const signalAlts = sock ? await resolveLidPnAlternatesAsync(sock, pCandidates) : pCandidates;
    const allCands = [...new Set([...pCandidates, ...signalAlts])];
    const phone = pPhone || allCands.map((c) => extractPhoneDigits(c)).find(Boolean) || '';
    const lid = extractLid(participant) || allCands.map((c) => extractLid(c)).find(Boolean) || '';

    const res = store.banUser(from, {
      jid: participant,
      candidates: allCands,
      phone,
      lid,
      bannedBy: author,
      reason: 'Kicked from group',
    });
    if (res.added) recorded += 1;
  }

  return { recorded };
}

export async function handleAntiRejoinUpdate({
  sock,
  update,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  isOwnerJid = null,
  store = defaultAntirejoinStore,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !update || update.action !== 'add') {
    return { handled: false, removedParticipants: [] };
  }
  const from = String(update.id || '');
  if (!from.endsWith('@g.us')) {
    return { handled: false, removedParticipants: [] };
  }

  const cfg = store.getGroupConfig(from);
  if (!cfg.enabled || cfg.banned.length === 0) {
    return { handled: false, removedParticipants: [] };
  }

  const joined = (Array.isArray(update.participants) ? update.participants : [])
    .map(extractParticipantJid)
    .filter(Boolean);
  if (joined.length === 0) {
    return { handled: false, removedParticipants: [] };
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

  const author = cleanJid(update.author || '');
  const authorPhone = author ? extractPhoneDigits(author, getPhoneFromJid) : '';
  const authorIsOwner =
    Boolean(author) &&
    typeof isOwnerJid === 'function' &&
    (isOwnerJid(author) || (authorPhone && isOwnerJid(`${authorPhone}@s.whatsapp.net`)));

  // If the bot owner explicitly re-added someone, do not fight owner's manual add
  if (author && authorIsOwner && !joined.some((j) => cleanJid(j).toLowerCase() === author.toLowerCase())) {
    return { handled: false, skipped: 'owner-readd', removedParticipants: [] };
  }

  const matchedTargets = [];
  for (const jid of joined) {
    const pPhone = extractPhoneDigits(jid, getPhoneFromJid);
    const seed = [jid, pPhone ? `${pPhone}@s.whatsapp.net` : ''].filter(Boolean);
    const metaAlts = collectParticipantAlternates(metadata, seed);
    const signalAlts = await resolveLidPnAlternatesAsync(sock, [...seed, ...metaAlts]);
    const candidates = [...new Set([...seed, ...metaAlts, ...signalAlts])];

    if (isFromBot(candidates, sock)) continue;
    if (typeof isOwnerJid === 'function' && candidates.some((c) => isOwnerJid(c))) continue;

    if (store.isBanned(from, candidates)) {
      matchedTargets.push({ jid, candidates });
    }
  }

  if (matchedTargets.length === 0) {
    return { handled: false, removedParticipants: [] };
  }

  const botCandidates = collectBotIdentities(sock);
  const { botRole } = await resolveGroupRolesAsync({
    metadata,
    sock,
    senderJids: [],
    getPhoneFn: getPhoneFromJid,
  });

  if (metadata && botCandidates.length > 0 && !botRole.isAdmin) {
    return { handled: false, skipped: 'bot-not-admin', removedParticipants: [] };
  }

  const participantJids = matchedTargets.map((t) => t.jid);
  const removeRes = await executeParticipantsAction({
    sock,
    from,
    participants: participantJids,
    action: 'remove',
    metadata,
  });

  const removedParticipants = removeRes.succeeded?.length ? removeRes.succeeded : removeRes.ok ? participantJids : [];
  if (removedParticipants.length > 0) {
    store.recordAction(from, { blockedRejoins: removedParticipants.length });
  }

  if (cfg.notify !== false && removedParticipants.length > 0) {
    const mentions = [...new Set(participantJids)];
    const userTags = participantJids.map((j) => `@${extractPhoneDigits(j, getPhoneFromJid) || j.split('@')[0]}`);
    const alertText = [
      spiderHeader(botName || 'Spider Man', 'ANTIREJOIN // AUTOBAN'),
      spiderRow('BANNED USER(S)', userTags.join(', '), '🚫'),
      spiderRow('ACTION', 'AUTO-REMOVED ON REJOIN', '⚡'),
      spiderRow('REASON', 'User is banned from this group (use antirejoin unban)', '◈'),
      spiderFooter('ANTI-REJOIN PROTECTION // SPIDER-MAN'),
    ].join('\n');
    try {
      await sock.sendMessage(from, { text: alertText, mentions });
    } catch {}
  }

  return {
    handled: removedParticipants.length > 0,
    removedParticipants,
    matchedTargets: participantJids,
    removeRes,
  };
}
