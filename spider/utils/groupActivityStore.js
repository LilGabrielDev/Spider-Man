import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanJid,
  extractLid,
  extractPhoneDigits,
  isParticipantAdminEntry,
  syncLidMappingsFromMetadata,
} from './groupRoleResolver.js';

const MAX_GROUPS = 500;
const MAX_MEMBERS_PER_GROUP = 2000;
const MAX_JIDS_PER_MEMBER = 6;
const DEFAULT_FLUSH_DEBOUNCE_MS = 1500;
const DIRTY_FLUSH_THRESHOLD = 25;

function sanitizePushName(value) {
  const cleaned = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || /^unknown$/i.test(cleaned)) return '';
  return cleaned.slice(0, 48);
}

function normalizePhone(value, getPhoneFn = null, lidToPhoneMap = null) {
  const digits = extractPhoneDigits(value, getPhoneFn);
  if (digits && /^\d{5,16}$/.test(digits)) return digits;
  const lid = extractLid(value);
  if (lid && lidToPhoneMap && typeof lidToPhoneMap.get === 'function') {
    const mapped = String(lidToPhoneMap.get(lid) || '').replace(/\D/g, '');
    if (/^\d{5,16}$/.test(mapped)) return mapped;
  }
  return '';
}

function dedupeCleanJids(list = []) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const cleaned = cleanJid(item);
    if (!cleaned || cleaned.endsWith('@g.us') || cleaned.endsWith('@broadcast') || cleaned.endsWith('@newsletter')) {
      continue;
    }
    const lower = cleaned.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(cleaned);
    if (out.length >= MAX_JIDS_PER_MEMBER) break;
  }
  return out;
}

function sanitizeMemberEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = Math.max(0, Math.floor(Number(raw.count) || 0));
  const lastMessageAt = Number.isFinite(Number(raw.lastMessageAt)) ? Math.max(0, Number(raw.lastMessageAt)) : 0;
  const firstSeenAt = Number.isFinite(Number(raw.firstSeenAt))
    ? Math.max(0, Number(raw.firstSeenAt))
    : lastMessageAt;
  const phone = String(raw.phone || '').replace(/\D/g, '');
  const lid = String(raw.lid || '').replace(/\D/g, '');
  const pushName = sanitizePushName(raw.pushName);
  const jids = dedupeCleanJids([
    ...(Array.isArray(raw.jids) ? raw.jids : []),
    phone ? `${phone}@s.whatsapp.net` : '',
    lid ? `${lid}@lid` : '',
  ]);
  return {
    count,
    firstSeenAt,
    lastMessageAt,
    pushName,
    phone: /^\d{5,16}$/.test(phone) ? phone : '',
    lid: /^\d{5,20}$/.test(lid) ? lid : '',
    jids,
  };
}

function sanitizeGroupEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    const now = Date.now();
    return {
      trackingSince: now,
      totalMessages: 0,
      updatedAt: now,
      members: {},
    };
  }
  const now = Date.now();
  const trackingSince =
    Number.isFinite(Number(raw.trackingSince)) && Number(raw.trackingSince) > 0
      ? Number(raw.trackingSince)
      : now;
  const updatedAt =
    Number.isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) > 0
      ? Number(raw.updatedAt)
      : trackingSince;
  const members = {};
  let computedTotal = 0;
  if (raw.members && typeof raw.members === 'object') {
    const entries = Object.entries(raw.members).slice(0, MAX_MEMBERS_PER_GROUP);
    for (const [k, v] of entries) {
      if (!k) continue;
      const sanitized = sanitizeMemberEntry(v);
      if (!sanitized) continue;
      members[k] = sanitized;
      computedTotal += sanitized.count;
    }
  }
  const rawTotal = Number(raw.totalMessages);
  const totalMessages = Number.isFinite(rawTotal) && rawTotal >= computedTotal ? Math.floor(rawTotal) : computedTotal;
  return {
    trackingSince,
    totalMessages,
    updatedAt,
    members,
  };
}

function mergeMemberRecords(target, source) {
  const mergedJids = dedupeCleanJids([...(target.jids || []), ...(source.jids || [])]);
  const firstSeenCandidates = [target.firstSeenAt, source.firstSeenAt].filter((t) => Number.isFinite(t) && t > 0);
  return {
    count: (target.count || 0) + (source.count || 0),
    firstSeenAt: firstSeenCandidates.length ? Math.min(...firstSeenCandidates) : 0,
    lastMessageAt: Math.max(target.lastMessageAt || 0, source.lastMessageAt || 0),
    pushName:
      (source.lastMessageAt || 0) >= (target.lastMessageAt || 0)
        ? source.pushName || target.pushName || ''
        : target.pushName || source.pushName || '',
    phone: target.phone || source.phone || '',
    lid: target.lid || source.lid || '',
    jids: mergedJids,
  };
}

export function formatRelativeTime(timestampMs, nowMs = Date.now()) {
  const ts = Number(timestampMs);
  if (!Number.isFinite(ts) || ts <= 0) return 'never';
  const diffMs = Math.max(0, nowMs - ts);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function createGroupActivityStore(
  storePathOrResolver = null,
  { flushDebounceMs = DEFAULT_FLUSH_DEBOUNCE_MS, now = Date.now } = {},
) {
  const isDefault = storePathOrResolver === null || storePathOrResolver === undefined;
  let tmpFallbackPath = null;
  let cachedPath = null;
  let cachedGroups = null;
  let flushTimer = null;
  let dirtyCount = 0;

  function resolvePath() {
    if (!isDefault) {
      return typeof storePathOrResolver === 'function' ? storePathOrResolver() : storePathOrResolver;
    }
    return tmpFallbackPath || path.join(process.cwd(), 'data', 'group-activity.json');
  }

  function loadAll() {
    const filePath = resolvePath();
    if (cachedGroups && cachedPath === filePath) {
      return cachedGroups;
    }

    let parsed = {};
    let loadedFrom = filePath;
    const candidates =
      isDefault && !tmpFallbackPath
        ? [filePath, path.join(os.tmpdir(), 'spider-data', 'group-activity.json')]
        : [filePath];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          if (raw && typeof raw === 'object' && raw.groups && typeof raw.groups === 'object') {
            parsed = raw.groups;
            loadedFrom = candidate;
            if (candidate !== filePath) {
              tmpFallbackPath = candidate;
            }
            break;
          }
        }
      } catch {
        parsed = {};
      }
    }

    const next = new Map();
    for (const [gid, data] of Object.entries(parsed)) {
      if (!gid || !String(gid).endsWith('@g.us')) continue;
      next.set(gid, sanitizeGroupEntry(data));
    }

    cachedPath = loadedFrom;
    cachedGroups = next;
    return cachedGroups;
  }

  function writeTarget(filePath, serialized) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify({ groups: serialized }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {}
  }

  function saveAll(groupsMap) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    dirtyCount = 0;

    while (groupsMap.size > MAX_GROUPS) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, g] of groupsMap.entries()) {
        const ts = Number(g?.updatedAt || 0);
        if (ts < oldestTime) {
          oldestTime = ts;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      groupsMap.delete(oldestKey);
    }

    const filePath = resolvePath();
    const serialized = {};
    for (const [groupId, entry] of groupsMap.entries()) {
      serialized[groupId] = sanitizeGroupEntry(entry);
    }

    try {
      writeTarget(filePath, serialized);
      cachedPath = filePath;
    } catch {
      if (isDefault) {
        const fallback = path.join(os.tmpdir(), 'spider-data', 'group-activity.json');
        try {
          writeTarget(fallback, serialized);
          tmpFallbackPath = fallback;
          cachedPath = fallback;
        } catch {
          cachedPath = filePath;
        }
      } else {
        cachedPath = filePath;
      }
    }
    cachedGroups = groupsMap;
  }

  function scheduleFlush() {
    dirtyCount += 1;
    if (dirtyCount >= DIRTY_FLUSH_THRESHOLD || flushDebounceMs <= 0) {
      if (cachedGroups) saveAll(cachedGroups);
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (cachedGroups && dirtyCount > 0) {
          saveAll(cachedGroups);
        }
      }, flushDebounceMs);
      flushTimer?.unref?.();
    }
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (cachedGroups && dirtyCount > 0) {
      saveAll(cachedGroups);
    }
  }

  function clearCache() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    dirtyCount = 0;
    cachedPath = null;
    cachedGroups = null;
  }

  function resolveMemberIdentities({
    senderJid = '',
    senderCandidates = [],
    getPhoneFn = null,
    lidToPhoneMap = null,
  } = {}) {
    const candidates = dedupeCleanJids([
      senderJid,
      ...(Array.isArray(senderCandidates) ? senderCandidates : []),
    ]);

    let phone = '';
    let lid = '';
    for (const cand of candidates) {
      if (!lid) {
        const l = extractLid(cand);
        if (l) lid = l;
      }
      if (!phone) {
        const p = normalizePhone(cand, getPhoneFn, lidToPhoneMap);
        if (p) phone = p;
      }
    }

    if (phone && !candidates.some((c) => c.toLowerCase() === `${phone}@s.whatsapp.net`)) {
      candidates.push(`${phone}@s.whatsapp.net`);
    }
    if (lid && !candidates.some((c) => c.toLowerCase() === `${lid}@lid`)) {
      candidates.push(`${lid}@lid`);
    }

    const canonicalKey = phone
      ? `pn:${phone}`
      : lid
        ? `lid:${lid}`
        : candidates[0]
          ? `jid:${candidates[0].toLowerCase()}`
          : '';

    return {
      canonicalKey,
      phone,
      lid,
      jids: dedupeCleanJids(candidates),
    };
  }

  function findExistingMemberKeys(members, { canonicalKey, phone, lid, jids }) {
    const matched = [];
    const jidSet = new Set(jids.map((j) => j.toLowerCase()));
    for (const [key, record] of Object.entries(members)) {
      if (key === canonicalKey) {
        matched.push(key);
        continue;
      }
      if (phone && record.phone && record.phone === phone) {
        matched.push(key);
        continue;
      }
      if (lid && record.lid && record.lid === lid) {
        matched.push(key);
        continue;
      }
      if (Array.isArray(record.jids) && record.jids.some((j) => jidSet.has(j.toLowerCase()))) {
        matched.push(key);
      }
    }
    return matched;
  }

  function recordMessage({
    groupJid,
    senderJid = '',
    senderCandidates = [],
    pushName = '',
    timestampMs = null,
    getPhoneFn = null,
    lidToPhoneMap = null,
  } = {}) {
    const cleanGroup = cleanJid(groupJid);
    if (!cleanGroup || !cleanGroup.endsWith('@g.us')) return null;

    const identity = resolveMemberIdentities({
      senderJid,
      senderCandidates,
      getPhoneFn,
      lidToPhoneMap,
    });
    if (!identity.canonicalKey) return null;

    const ts = Number.isFinite(Number(timestampMs)) && Number(timestampMs) > 0 ? Number(timestampMs) : now();
    const groups = loadAll();
    let group = groups.get(cleanGroup);
    if (!group) {
      group = {
        trackingSince: ts,
        totalMessages: 0,
        updatedAt: ts,
        members: {},
      };
    }

    const matchingKeys = findExistingMemberKeys(group.members, identity);
    let targetKey = identity.canonicalKey;
    let existing = group.members[targetKey] || null;

    for (const oldKey of matchingKeys) {
      if (oldKey === targetKey) continue;
      const oldRec = group.members[oldKey];
      if (!oldRec) continue;
      if (!existing) {
        existing = oldRec;
      } else {
        existing = mergeMemberRecords(existing, oldRec);
      }
      delete group.members[oldKey];
    }

    const nextPushName = sanitizePushName(pushName);
    const updatedRecord = sanitizeMemberEntry({
      count: (existing?.count || 0) + 1,
      firstSeenAt: existing?.firstSeenAt || ts,
      lastMessageAt: Math.max(existing?.lastMessageAt || 0, ts),
      pushName: nextPushName || existing?.pushName || '',
      phone: identity.phone || existing?.phone || '',
      lid: identity.lid || existing?.lid || '',
      jids: [...(existing?.jids || []), ...identity.jids],
    });

    group.members[targetKey] = updatedRecord;
    group.totalMessages = (group.totalMessages || 0) + 1;
    group.updatedAt = ts;
    if (!group.trackingSince || ts < group.trackingSince) {
      group.trackingSince = ts;
    }

    const memberKeys = Object.keys(group.members);
    if (memberKeys.length > MAX_MEMBERS_PER_GROUP) {
      memberKeys
        .sort((a, b) => (group.members[a].lastMessageAt || 0) - (group.members[b].lastMessageAt || 0))
        .slice(0, memberKeys.length - MAX_MEMBERS_PER_GROUP)
        .forEach((k) => {
          delete group.members[k];
        });
    }

    groups.set(cleanGroup, group);
    scheduleFlush();
    return { ...updatedRecord, key: targetKey };
  }

  function reconcileMembersWithMetadata(group, metadata = null, lidToPhoneMap = null) {
    if (metadata) {
      syncLidMappingsFromMetadata(metadata, { lidToPhoneMap });
    }
    const baseMembers = {};
    for (const [k, rec] of Object.entries(group.members || {})) {
      baseMembers[k] = sanitizeMemberEntry(rec);
    }
    if (!metadata || !Array.isArray(metadata.participants)) {
      return baseMembers;
    }

    for (const p of metadata.participants) {
      if (!p || typeof p !== 'object') continue;
      const pJids = dedupeCleanJids([
        p.id,
        p.jid,
        p.phoneNumber ? (String(p.phoneNumber).includes('@') ? p.phoneNumber : `${String(p.phoneNumber).replace(/\D/g, '')}@s.whatsapp.net`) : '',
        p.pn ? (String(p.pn).includes('@') ? p.pn : `${String(p.pn).replace(/\D/g, '')}@s.whatsapp.net`) : '',
        p.lid ? (String(p.lid).includes('@') ? p.lid : `${String(p.lid).replace(/\D/g, '')}@lid`) : '',
      ]);
      const identity = resolveMemberIdentities({
        senderJid: pJids[0] || '',
        senderCandidates: pJids,
        lidToPhoneMap,
      });
      if (!identity.canonicalKey) continue;

      const matches = findExistingMemberKeys(baseMembers, identity);
      if (matches.length === 0) continue;

      let combined = baseMembers[identity.canonicalKey] || null;
      for (const mk of matches) {
        if (mk === identity.canonicalKey) continue;
        const rec = baseMembers[mk];
        if (!rec) continue;
        combined = combined ? mergeMemberRecords(combined, rec) : rec;
        delete baseMembers[mk];
      }
      if (combined) {
        baseMembers[identity.canonicalKey] = sanitizeMemberEntry({
          ...combined,
          phone: identity.phone || combined.phone,
          lid: identity.lid || combined.lid,
          pushName: combined.pushName || sanitizePushName(p.notify || p.name),
          jids: [...(combined.jids || []), ...identity.jids],
        });
      }
    }

    return baseMembers;
  }

  function getGroupActivity(groupJid) {
    const cleanGroup = cleanJid(groupJid);
    const groups = loadAll();
    const existing = groups.get(cleanGroup);
    return sanitizeGroupEntry(existing);
  }

  function getActiveRanking(
    groupJid,
    { days = null, limit = 15, metadata = null, lidToPhoneMap = null } = {},
  ) {
    const cleanGroup = cleanJid(groupJid);
    const groups = loadAll();
    const group = groups.get(cleanGroup);
    if (!group) {
      return {
        trackingSince: null,
        totalMessages: 0,
        trackedMembers: 0,
        entries: [],
      };
    }

    const merged = reconcileMembersWithMetadata(group, metadata, lidToPhoneMap);
    const nowMs = now();
    const cutoff = Number.isFinite(Number(days)) && Number(days) > 0 ? nowMs - Number(days) * 86_400_000 : 0;

    const participantByKey = new Map();
    if (Array.isArray(metadata?.participants)) {
      for (const p of metadata.participants) {
        const pIds = dedupeCleanJids([
          p.id,
          p.jid,
          p.phoneNumber ? `${String(p.phoneNumber).replace(/\D/g, '')}@s.whatsapp.net` : '',
          p.pn ? `${String(p.pn).replace(/\D/g, '')}@s.whatsapp.net` : '',
          p.lid ? `${String(p.lid).replace(/\D/g, '')}@lid` : '',
        ]);
        for (const id of pIds) {
          participantByKey.set(id.toLowerCase(), p);
        }
      }
    }

    const entries = Object.entries(merged)
      .map(([key, rec]) => {
        if (!rec || rec.count <= 0) return null;
        if (cutoff && rec.lastMessageAt < cutoff) return null;
        const primaryJid =
          (rec.phone ? `${rec.phone}@s.whatsapp.net` : '') ||
          rec.jids[0] ||
          (rec.lid ? `${rec.lid}@lid` : '');
        const displayId = rec.phone || rec.lid || (primaryJid ? primaryJid.split('@')[0] : 'member');
        const matchedMeta = rec.jids.map((j) => participantByKey.get(j.toLowerCase())).find(Boolean);
        return {
          key,
          count: rec.count,
          lastMessageAt: rec.lastMessageAt,
          firstSeenAt: rec.firstSeenAt,
          pushName: rec.pushName || sanitizePushName(matchedMeta?.notify || matchedMeta?.name) || '',
          phone: rec.phone || '',
          lid: rec.lid || '',
          jid: matchedMeta?.id || matchedMeta?.jid || primaryJid,
          mentionJid: matchedMeta?.id || matchedMeta?.jid || primaryJid,
          displayId,
          isAdmin: matchedMeta ? isParticipantAdminEntry(matchedMeta) : false,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.count - a.count || b.lastMessageAt - a.lastMessageAt);

    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 15));
    return {
      trackingSince: group.trackingSince,
      totalMessages: entries.reduce((sum, item) => sum + item.count, 0),
      trackedMembers: entries.length,
      entries: entries.slice(0, safeLimit),
    };
  }

  function getInactiveMembers(
    groupJid,
    { metadata = null, days = 7, botJids = [], lidToPhoneMap = null } = {},
  ) {
    const cleanGroup = cleanJid(groupJid);
    const groups = loadAll();
    const group = groups.get(cleanGroup) || null;
    const merged = group ? reconcileMembersWithMetadata(group, metadata, lidToPhoneMap) : {};
    const nowMs = now();
    const parsedDays = Number(days);
    const thresholdDays = Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays : 7;
    const cutoffMs = thresholdDays > 0 ? nowMs - thresholdDays * 86_400_000 : 0;

    const botPhones = new Set(botJids.map((j) => normalizePhone(j, null, lidToPhoneMap)).filter(Boolean));
    const botLids = new Set(botJids.map((j) => extractLid(j)).filter(Boolean));
    const botClean = new Set(botJids.map((j) => cleanJid(j).toLowerCase()).filter(Boolean));

    const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
    const inactive = [];
    let activeCount = 0;

    for (const p of participants) {
      if (!p || typeof p !== 'object') continue;
      const pJids = dedupeCleanJids([
        p.id,
        p.jid,
        p.phoneNumber ? `${String(p.phoneNumber).replace(/\D/g, '')}@s.whatsapp.net` : '',
        p.pn ? `${String(p.pn).replace(/\D/g, '')}@s.whatsapp.net` : '',
        p.lid ? `${String(p.lid).replace(/\D/g, '')}@lid` : '',
      ]);
      if (pJids.length === 0) continue;

      const identity = resolveMemberIdentities({
        senderJid: pJids[0],
        senderCandidates: pJids,
        lidToPhoneMap,
      });

      const isBot =
        (identity.phone && botPhones.has(identity.phone)) ||
        (identity.lid && botLids.has(identity.lid)) ||
        identity.jids.some((j) => botClean.has(j.toLowerCase()));
      if (isBot) continue;

      const matches = findExistingMemberKeys(merged, identity);
      let rec = null;
      for (const mk of matches) {
        const entry = merged[mk];
        if (!entry) continue;
        rec = rec ? mergeMemberRecords(rec, entry) : entry;
      }

      const count = rec?.count || 0;
      const lastMessageAt = rec?.lastMessageAt || 0;
      const isGhost =
        thresholdDays === 0
          ? count === 0
          : count === 0 || (lastMessageAt > 0 && lastMessageAt <= cutoffMs);

      if (isGhost) {
        const primaryJid = cleanJid(p.id || p.jid || identity.jids[0]);
        const displayId = identity.phone || identity.lid || (primaryJid ? primaryJid.split('@')[0] : 'member');
        inactive.push({
          jid: primaryJid,
          mentionJid: primaryJid,
          displayId,
          phone: identity.phone || '',
          lid: identity.lid || '',
          pushName: rec?.pushName || sanitizePushName(p.notify || p.name) || '',
          count,
          lastMessageAt,
          daysInactive: lastMessageAt > 0 ? Math.floor((nowMs - lastMessageAt) / 86_400_000) : Infinity,
          isAdmin: isParticipantAdminEntry(p),
        });
      } else {
        activeCount += 1;
      }
    }

    inactive.sort((a, b) => {
      if ((a.count === 0) !== (b.count === 0)) return a.count === 0 ? -1 : 1;
      return (a.lastMessageAt || 0) - (b.lastMessageAt || 0);
    });

    return {
      trackingSince: group?.trackingSince || null,
      totalGroupMembers: participants.length,
      totalMessages: group?.totalMessages || 0,
      activeCount,
      days: thresholdDays,
      inactive,
    };
  }

  function resetGroup(groupJid) {
    const cleanGroup = cleanJid(groupJid);
    const groups = loadAll();
    const existed = groups.delete(cleanGroup);
    saveAll(groups);
    return existed;
  }

  return {
    recordMessage,
    getGroupActivity,
    getActiveRanking,
    getInactiveMembers,
    resetGroup,
    flush,
    clearCache,
  };
}

export const defaultGroupActivityStore = createGroupActivityStore();

export function recordGroupActivity(options = {}, store = defaultGroupActivityStore) {
  try {
    return store.recordMessage(options);
  } catch {
    return null;
  }
}
