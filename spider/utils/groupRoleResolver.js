function toList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function cleanJid(jid) {
  const raw = String(jid || '').trim();
  if (!raw) return '';
  const atIdx = raw.indexOf('@');
  if (atIdx <= 0) {
    const colonIdx = raw.indexOf(':');
    return colonIdx > 0 ? raw.slice(0, colonIdx) : raw;
  }
  let userPart = raw.slice(0, atIdx);
  const colonIdx = userPart.indexOf(':');
  if (colonIdx > 0) {
    userPart = userPart.slice(0, colonIdx);
  }
  let domain = raw.slice(atIdx + 1).trim().toLowerCase();
  if (domain === 'c.us' || domain === 'hosted') {
    domain = 's.whatsapp.net';
  } else if (domain === 'hosted.lid') {
    domain = 'lid';
  }
  return `${userPart}@${domain}`;
}

export function extractLid(jid) {
  const cleaned = cleanJid(jid);
  if (!cleaned) return '';
  const match = cleaned.match(/^([^@]+)@(?:lid|hosted\.lid)$/i);
  return match ? `${match[1]}@lid`.toLowerCase() : '';
}

function mapLookup(map, key) {
  if (!map || typeof map.get !== 'function' || !key) return '';
  return String(map.get(key) || map.get(String(key).toLowerCase()) || '').trim();
}

export function extractPhoneDigits(jid, optionsOrFn = {}) {
  const opts =
    typeof optionsOrFn === 'function' ? { getPhoneFn: optionsOrFn } : optionsOrFn || {};
  const { getPhoneFn = null, lidToPhoneMap = null } = opts;

  const cleaned = cleanJid(jid);
  if (!cleaned) return '';

  const lid = extractLid(cleaned);
  if (lid) {
    const mapped = mapLookup(lidToPhoneMap, lid) || mapLookup(lidToPhoneMap, cleaned);
    if (mapped) {
      const mappedDigits = normalizeDigits(mapped.split('@')[0]);
      if (mappedDigits) return mappedDigits;
    }
    if (typeof getPhoneFn === 'function') {
      const resolved = String(getPhoneFn(cleaned) || '').trim();
      const resolvedDigits = normalizeDigits(resolved.split('@')[0]);
      const lidUser = lid.split('@')[0];
      if (resolvedDigits && resolvedDigits !== lidUser) {
        return resolvedDigits;
      }
    }
    return '';
  }

  if (cleaned.includes('@')) {
    const lower = cleaned.toLowerCase();
    if (lower.endsWith('@g.us') || lower.endsWith('@broadcast') || lower.endsWith('@newsletter')) {
      return '';
    }
    const userPart = cleaned.split('@')[0];
    if (/^\d{5,16}$/.test(userPart)) {
      return userPart;
    }
    if (typeof getPhoneFn === 'function') {
      const resolved = String(getPhoneFn(cleaned) || '').trim();
      const resolvedDigits = normalizeDigits(resolved.split('@')[0]);
      if (/^\d{5,16}$/.test(resolvedDigits)) return resolvedDigits;
    }
    return '';
  }

  const digits = normalizeDigits(cleaned);
  if (/^\d{5,16}$/.test(digits)) return digits;

  if (typeof getPhoneFn === 'function') {
    const resolved = String(getPhoneFn(cleaned) || '').trim();
    const resolvedDigits = normalizeDigits(resolved.split('@')[0]);
    if (/^\d{5,16}$/.test(resolvedDigits)) return resolvedDigits;
  }

  return '';
}

function recordPair(lid, phone, lidToPhoneMap, phoneToLidMap) {
  if (!lid || !phone) return;
  if (lidToPhoneMap && typeof lidToPhoneMap.set === 'function') {
    lidToPhoneMap.set(lid, phone);
  }
  if (phoneToLidMap && typeof phoneToLidMap.set === 'function') {
    phoneToLidMap.set(phone, lid);
  }
}

export function syncLidMappingsFromMetadata(metadata, { lidToPhoneMap = null, phoneToLidMap = null } = {}) {
  const l2p = lidToPhoneMap || new Map();
  const p2l = phoneToLidMap || new Map();

  if (!metadata || typeof metadata !== 'object') {
    return { lidToPhoneMap: l2p, phoneToLidMap: p2l };
  }

  const participants = Array.isArray(metadata.participants) ? metadata.participants : [];
  for (const participant of participants) {
    if (!participant || typeof participant !== 'object') continue;
    const fields = [
      participant.id,
      participant.lid,
      participant.jid,
      participant.pn,
      participant.phoneNumber,
    ].filter(Boolean);

    const lids = fields.map((f) => extractLid(f)).filter(Boolean);
    const phones = fields
      .filter((f) => !extractLid(f))
      .map((f) => extractPhoneDigits(f))
      .filter(Boolean);

    if (lids.length > 0 && phones.length > 0) {
      for (const lid of lids) {
        for (const phone of phones) {
          recordPair(lid, phone, l2p, p2l);
        }
      }
    }
  }

  const metaPairs = [
    [metadata.owner, metadata.ownerPn],
    [metadata.subjectOwner, metadata.subjectOwnerPn],
    [metadata.author, metadata.authorPn],
  ];
  for (const [primary, pn] of metaPairs) {
    const lid = extractLid(primary);
    const phone = extractPhoneDigits(pn);
    if (lid && phone) {
      recordPair(lid, phone, l2p, p2l);
    }
  }

  return { lidToPhoneMap: l2p, phoneToLidMap: p2l };
}

export function collectBotIdentities(sock, extraIds = []) {
  const raw = [
    sock?.user?.id,
    sock?.user?.jid,
    sock?.user?.lid,
    sock?.authState?.creds?.me?.id,
    sock?.authState?.creds?.me?.jid,
    sock?.authState?.creds?.me?.lid,
    ...toList(extraIds),
  ];

  const seen = new Set();
  const result = [];
  for (const entry of raw) {
    const cleaned = cleanJid(entry);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(cleaned);
    }
  }
  return result;
}

export function collectSenderIdentities(msg, extraIds = []) {
  const raw = [
    ...toList(extraIds),
    msg?.key?.participant,
    msg?.key?.participantAlt,
    msg?.key?.participantPn,
    msg?.key?.senderPn,
    msg?.key?.senderLid,
    msg?.participant,
    msg?.key?.remoteJidAlt,
  ];

  const seen = new Set();
  const result = [];
  for (const entry of raw) {
    const cleaned = cleanJid(entry);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(cleaned);
    }
  }
  return result;
}

export function isParticipantAdminEntry(participant) {
  if (!participant || typeof participant !== 'object') return false;
  const adminRole = String(participant.admin || '').toLowerCase();
  return (
    adminRole === 'admin' ||
    adminRole === 'superadmin' ||
    participant.isAdmin === true ||
    participant.isSuperAdmin === true
  );
}

function buildTargetMatcher(targets, { getPhoneFn = null, lidToPhoneMap = null, phoneToLidMap = null } = {}) {
  const cleanSet = new Set();
  const lidSet = new Set();
  const phoneSet = new Set();

  function addIdentity(raw) {
    const cleaned = cleanJid(raw);
    if (!cleaned) return;
    cleanSet.add(cleaned.toLowerCase());

    const lid = extractLid(cleaned);
    if (lid) {
      lidSet.add(lid);
      const mappedPhone = mapLookup(lidToPhoneMap, lid) || mapLookup(lidToPhoneMap, cleaned);
      if (mappedPhone) {
        const digits = normalizeDigits(mappedPhone.split('@')[0]);
        if (digits) {
          phoneSet.add(digits);
          cleanSet.add(`${digits}@s.whatsapp.net`);
        }
      }
    }

    const phone = extractPhoneDigits(cleaned, { getPhoneFn, lidToPhoneMap });
    if (phone) {
      phoneSet.add(phone);
      cleanSet.add(`${phone}@s.whatsapp.net`);
      const mappedLid = mapLookup(phoneToLidMap, phone);
      if (mappedLid) {
        const normLid = extractLid(mappedLid) || mappedLid.toLowerCase();
        lidSet.add(normLid);
        cleanSet.add(normLid);
      }
    }
  }

  for (const t of toList(targets)) {
    addIdentity(t);
  }

  return function matchesCandidate(candidate) {
    const cleaned = cleanJid(candidate);
    if (!cleaned) return false;
    if (cleanSet.has(cleaned.toLowerCase())) return true;

    const lid = extractLid(cleaned);
    if (lid && lidSet.has(lid)) return true;

    const phone = extractPhoneDigits(cleaned, { getPhoneFn, lidToPhoneMap });
    if (phone && phoneSet.has(phone)) return true;

    return false;
  };
}

export function resolveParticipantRole(metadata, targetOrTargets, optionsOrFn = {}) {
  const opts =
    typeof optionsOrFn === 'function' ? { getPhoneFn: optionsOrFn } : optionsOrFn || {};
  const { getPhoneFn = null } = opts;

  const { lidToPhoneMap, phoneToLidMap } = syncLidMappingsFromMetadata(metadata, {
    lidToPhoneMap: opts.lidToPhoneMap || null,
    phoneToLidMap: opts.phoneToLidMap || null,
  });

  const targets = toList(targetOrTargets);
  const primaryClean = cleanJid(targets[0] || '');

  if (targets.length === 0) {
    return {
      participant: null,
      isAdmin: false,
      isOwner: false,
      targetJid: '',
    };
  }

  const matchesCandidate = buildTargetMatcher(targets, {
    getPhoneFn,
    lidToPhoneMap,
    phoneToLidMap,
  });

  const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
  const matchedEntries = participants.filter((participant) => {
    if (!participant || typeof participant !== 'object') return false;
    const fields = [
      participant.id,
      participant.lid,
      participant.jid,
      participant.pn,
      participant.phoneNumber,
    ].filter(Boolean);
    return fields.some((field) => matchesCandidate(field));
  });

  const entry = matchedEntries.find((p) => isParticipantAdminEntry(p)) || matchedEntries[0] || null;
  const isOwner = [metadata?.owner, metadata?.ownerPn]
    .filter(Boolean)
    .some((ownerJid) => matchesCandidate(ownerJid));

  return {
    participant: entry,
    isAdmin: isParticipantAdminEntry(entry) || isOwner,
    isOwner,
    targetJid:
      entry?.id ||
      entry?.jid ||
      entry?.phoneNumber ||
      entry?.pn ||
      primaryClean ||
      String(targets[0] || ''),
  };
}

export function resolveGroupRoles({
  metadata,
  sock = null,
  senderJids = [],
  botExtraIds = [],
  getPhoneFn = null,
  lidToPhoneMap = null,
  phoneToLidMap = null,
} = {}) {
  const maps = syncLidMappingsFromMetadata(metadata, { lidToPhoneMap, phoneToLidMap });
  const resolverOpts = {
    getPhoneFn,
    lidToPhoneMap: maps.lidToPhoneMap,
    phoneToLidMap: maps.phoneToLidMap,
  };

  const senderList = toList(senderJids);
  const botList = collectBotIdentities(sock, botExtraIds);

  const senderRole = resolveParticipantRole(metadata, senderList, resolverOpts);
  const botRole =
    botList.length > 0
      ? resolveParticipantRole(metadata, botList, resolverOpts)
      : { participant: null, isAdmin: false, isOwner: false, targetJid: '' };

  return {
    isSenderAdmin: senderRole.isAdmin,
    isBotAdmin: botRole.isAdmin,
    senderRole,
    botRole,
  };
}

async function enrichFromSignalLidStore(sock, identities, lidToPhoneMap, phoneToLidMap) {
  const lidMapping = sock?.signalRepository?.lidMapping;
  if (!lidMapping || typeof lidMapping !== 'object') return;

  const list = toList(identities);
  const pnsToResolve = [];
  const lidsToResolve = [];

  for (const id of list) {
    const cleaned = cleanJid(id);
    if (!cleaned) continue;
    const lid = extractLid(cleaned);
    if (lid) {
      if (!mapLookup(lidToPhoneMap, lid)) lidsToResolve.push(lid);
    } else {
      const phone = extractPhoneDigits(cleaned);
      if (phone && !mapLookup(phoneToLidMap, phone)) {
        pnsToResolve.push(`${phone}@s.whatsapp.net`);
      }
    }
  }

  if (pnsToResolve.length > 0 && typeof lidMapping.getKnownLIDsForPNs === 'function') {
    try {
      const mappings = await lidMapping.getKnownLIDsForPNs(pnsToResolve);
      if (Array.isArray(mappings)) {
        for (const item of mappings) {
          const lid = extractLid(item?.lid);
          const phone = extractPhoneDigits(item?.pn);
          if (lid && phone) recordPair(lid, phone, lidToPhoneMap, phoneToLidMap);
        }
      }
    } catch {}
  }

  if (lidsToResolve.length > 0 && typeof lidMapping.getPNForLID === 'function') {
    for (const lid of lidsToResolve) {
      try {
        const pn = await lidMapping.getPNForLID(lid);
        const phone = extractPhoneDigits(pn);
        if (lid && phone) recordPair(lid, phone, lidToPhoneMap, phoneToLidMap);
      } catch {}
    }
  }
}

export async function resolveGroupRolesAsync({
  metadata,
  sock = null,
  senderJids = [],
  botExtraIds = [],
  getPhoneFn = null,
  lidToPhoneMap = null,
  phoneToLidMap = null,
} = {}) {
  const maps = syncLidMappingsFromMetadata(metadata, { lidToPhoneMap, phoneToLidMap });
  const initial = resolveGroupRoles({
    metadata,
    sock,
    senderJids,
    botExtraIds,
    getPhoneFn,
    lidToPhoneMap: maps.lidToPhoneMap,
    phoneToLidMap: maps.phoneToLidMap,
  });

  if (!metadata || !sock?.signalRepository?.lidMapping) {
    return initial;
  }

  const botList = collectBotIdentities(sock, botExtraIds);
  const senderList = toList(senderJids);

  const needsSenderLookup = senderList.length > 0 && !initial.senderRole.participant && !initial.senderRole.isOwner;
  const needsBotLookup = botList.length > 0 && !initial.botRole.participant && !initial.botRole.isOwner;

  if (!needsSenderLookup && !needsBotLookup) {
    return initial;
  }

  const toEnrich = [
    ...(needsSenderLookup ? senderList : []),
    ...(needsBotLookup ? botList : []),
  ];
  await enrichFromSignalLidStore(sock, toEnrich, maps.lidToPhoneMap, maps.phoneToLidMap);

  return resolveGroupRoles({
    metadata,
    sock,
    senderJids: senderList,
    botExtraIds,
    getPhoneFn,
    lidToPhoneMap: maps.lidToPhoneMap,
    phoneToLidMap: maps.phoneToLidMap,
  });
}
