function toList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isNonUserDomain(lowerJid) {
  return (
    lowerJid.endsWith('@g.us') ||
    lowerJid.endsWith('@broadcast') ||
    lowerJid.endsWith('@newsletter')
  );
}

export function cleanUserJid(jid) {
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

export function getLidFromJid(jid) {
  const cleaned = cleanUserJid(jid);
  if (!cleaned) return null;
  const match = cleaned.match(/^([^@]+)@lid$/i);
  return match ? `${match[1]}@lid`.toLowerCase() : null;
}

export function getPhoneFromJid(jid) {
  const cleaned = cleanUserJid(jid);
  if (!cleaned) return null;

  if (cleaned.includes('@')) {
    const lower = cleaned.toLowerCase();
    if (!lower.endsWith('@s.whatsapp.net')) {
      return null;
    }
    const userPart = cleaned.slice(0, cleaned.indexOf('@'));
    return /^\d{5,16}$/.test(userPart) ? userPart : null;
  }

  const stripped = cleaned.replace(/^\+/, '');
  return /^\d{5,16}$/.test(stripped) ? stripped : null;
}

function mapGet(map, key) {
  if (!map || typeof map.get !== 'function' || !key) return '';
  return String(map.get(key) || map.get(String(key).toLowerCase()) || '').trim();
}

export function getSenderPhone(jid, lidToPhoneMap = null) {
  const cleaned = cleanUserJid(jid);
  if (!cleaned) return null;

  const directPhone = getPhoneFromJid(cleaned);
  if (directPhone) return directPhone;

  const lid = getLidFromJid(cleaned);
  if (lid && lidToPhoneMap) {
    const mapped = mapGet(lidToPhoneMap, lid) || mapGet(lidToPhoneMap, cleaned);
    if (mapped) {
      const mappedClean = cleanUserJid(mapped);
      if (!getLidFromJid(mappedClean)) {
        const mappedPhone = getPhoneFromJid(mappedClean) || normalizeDigits(mappedClean.split('@')[0]);
        const lidUser = lid.split('@')[0];
        if (mappedPhone && /^\d{5,16}$/.test(mappedPhone) && mappedPhone !== lidUser) {
          return mappedPhone;
        }
      }
    }
  }

  return null;
}

export function getRealSenderJidFromMsg(msg, sock = null) {
  const key = msg?.key || {};

  if (key.fromMe) {
    const selfCandidates = [
      sock?.user?.id,
      sock?.user?.jid,
      sock?.authState?.creds?.me?.id,
      sock?.authState?.creds?.me?.jid,
      globalThis.BOT_JID,
      sock?.user?.lid,
      sock?.authState?.creds?.me?.lid,
      globalThis.BOT_LID,
      key.participantPn,
      key.senderPn,
      key.participantAlt,
      key.participant,
      key.remoteJidAlt,
    ];

    let firstNonGroup = null;
    for (const raw of selfCandidates) {
      const cleaned = cleanUserJid(raw);
      if (!cleaned) continue;
      if (isNonUserDomain(cleaned.toLowerCase())) continue;
      if (getPhoneFromJid(cleaned)) return cleaned;
      if (!firstNonGroup) firstNonGroup = cleaned;
    }
    if (firstNonGroup) return firstNonGroup;

    const remoteClean = cleanUserJid(key.remoteJid);
    if (remoteClean && !isNonUserDomain(remoteClean.toLowerCase())) {
      return remoteClean;
    }
    return null;
  }

  const peerCandidates = [
    key.participant,
    key.participantAlt,
    key.participantPn,
    key.senderPn,
    key.senderLid,
    msg?.participant,
    key.remoteJidAlt,
    key.remoteJid,
  ];

  for (const raw of peerCandidates) {
    const cleaned = cleanUserJid(raw);
    if (!cleaned) continue;
    if (!isNonUserDomain(cleaned.toLowerCase())) {
      return cleaned;
    }
  }

  const fallback = cleanUserJid(key.remoteJid);
  return fallback || null;
}

export function normalizeSudoTarget(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const cleaned = cleanUserJid(raw);
  const lid = getLidFromJid(cleaned);
  if (lid) return lid;
  if (cleaned.includes('@')) {
    const phone = getPhoneFromJid(cleaned);
    return phone || '';
  }
  const digits = normalizeDigits(raw);
  return digits.length >= 5 ? digits : '';
}

export function collectRuntimeUserSources({ sock = null, creds = null, me = null, config = null } = {}) {
  return [
    me,
    sock?.user,
    sock?.authState?.creds?.me,
    creds?.me,
    config ? { id: config.OWNER_NUMBER ? `${normalizeDigits(config.OWNER_NUMBER)}@s.whatsapp.net` : '', lid: config.USER_LID } : null,
  ].filter(Boolean);
}

export function captureBotUserIdentities({
  sock = null,
  creds = null,
  me = null,
  config = null,
  phoneToLidMap = null,
  lidToPhoneMap = null,
  registerChatAlias = null,
} = {}) {
  const sources = collectRuntimeUserSources({ sock, creds, me, config });
  const phones = [];
  const lids = [];

  const addPhone = (candidate) => {
    const phone = getPhoneFromJid(candidate);
    if (phone && !phones.includes(phone)) phones.push(phone);
  };
  const addLid = (candidate) => {
    const lid = getLidFromJid(candidate);
    if (lid && !lids.includes(lid)) lids.push(lid);
  };

  for (const src of sources) {
    addPhone(src?.id);
    addPhone(src?.jid);
    addPhone(src?.pn);
    addPhone(src?.phoneNumber);

    addLid(src?.lid);
    addLid(src?.id);
    addLid(src?.jid);

    for (const extraLid of toList(src?.lids)) {
      addLid(extraLid);
    }
  }

  if (Array.isArray(globalThis.BOT_LIDS)) {
    for (const existingLid of globalThis.BOT_LIDS) {
      addLid(existingLid);
    }
  }
  if (globalThis.BOT_LID) addLid(globalThis.BOT_LID);
  if (globalThis.BOT_NUMBER) addPhone(globalThis.BOT_NUMBER);
  if (globalThis.BOT_JID) {
    addPhone(globalThis.BOT_JID);
    addLid(globalThis.BOT_JID);
  }

  if (phones.length === 0 && lidToPhoneMap) {
    for (const lid of lids) {
      const mapped = getSenderPhone(lid, lidToPhoneMap);
      if (mapped) addPhone(mapped);
    }
  }

  const ownerNumber = phones[0] || null;
  const ownerFullJid = ownerNumber
    ? `${ownerNumber}@s.whatsapp.net`
    : lids[0] || null;

  if (ownerNumber && phoneToLidMap && lidToPhoneMap) {
    const pnJid = `${ownerNumber}@s.whatsapp.net`;
    for (const lid of lids) {
      phoneToLidMap.set(ownerNumber, lid);
      lidToPhoneMap.set(lid, ownerNumber);
      if (typeof registerChatAlias === 'function') {
        registerChatAlias(pnJid, lid);
      }
    }
  }

  if (ownerNumber) {
    globalThis.BOT_NUMBER = ownerNumber;
    globalThis.BOT_JID = `${ownerNumber}@s.whatsapp.net`;
    if (config && typeof config === 'object' && !config.OWNER_NUMBER) {
      config.OWNER_NUMBER = ownerNumber;
    }
  } else if (ownerFullJid && !globalThis.BOT_JID) {
    globalThis.BOT_JID = ownerFullJid;
  }

  if (lids.length > 0) {
    globalThis.BOT_LID = lids[0];
    globalThis.BOT_LIDS = [...lids];
    if (config && typeof config === 'object') {
      const current = Array.isArray(config.USER_LID) ? config.USER_LID.map((v) => getLidFromJid(v)).filter(Boolean) : [];
      const merged = Array.from(new Set([...current, ...lids]));
      config.USER_LID = merged;
    }
  }

  return {
    ownerNumber,
    ownerFullJid,
    ownerLids: lids,
  };
}

export async function resolveBotPhoneFromLidAsync(
  sock,
  { lids = [], lidToPhoneMap = null, phoneToLidMap = null, registerChatAlias = null, config = null } = {},
) {
  const lidMapping = sock?.signalRepository?.lidMapping;
  if (!lidMapping || typeof lidMapping.getPNForLID !== 'function') {
    return null;
  }

  const candidateLids = Array.from(
    new Set(
      [
        ...toList(lids),
        sock?.user?.lid,
        sock?.user?.id,
        sock?.authState?.creds?.me?.lid,
        sock?.authState?.creds?.me?.id,
        globalThis.BOT_LID,
        ...(Array.isArray(globalThis.BOT_LIDS) ? globalThis.BOT_LIDS : []),
      ]
        .map((entry) => getLidFromJid(entry))
        .filter(Boolean),
    ),
  );

  for (const lid of candidateLids) {
    try {
      const pnRaw = await lidMapping.getPNForLID(lid);
      const phone = getPhoneFromJid(pnRaw);
      if (!phone) continue;

      const pnJid = `${phone}@s.whatsapp.net`;
      lidToPhoneMap?.set?.(lid, phone);
      phoneToLidMap?.set?.(phone, lid);
      if (typeof registerChatAlias === 'function') {
        registerChatAlias(pnJid, lid);
      }

      globalThis.BOT_NUMBER = phone;
      globalThis.BOT_JID = pnJid;
      if (config && typeof config === 'object' && !config.OWNER_NUMBER) {
        config.OWNER_NUMBER = phone;
      }

      return { phone, jid: pnJid, lid };
    } catch {
      // Try next LID candidate
    }
  }

  return null;
}

export function resolveRuntimeOwnerJid({
  sock = null,
  config = null,
  ownerNumber = null,
  ownerFullJid = null,
  ownerLids = [],
  lidToPhoneMap = null,
} = {}) {
  const pnCandidates = [
    config?.OWNER_NUMBER,
    ownerNumber,
    sock?.user?.id,
    sock?.user?.jid,
    sock?.authState?.creds?.me?.id,
    sock?.authState?.creds?.me?.jid,
    ownerFullJid,
    globalThis.BOT_NUMBER,
    globalThis.BOT_JID,
  ];

  for (const candidate of pnCandidates) {
    const phone = getPhoneFromJid(candidate);
    if (phone) {
      return `${phone}@s.whatsapp.net`;
    }
  }

  const lidCandidates = [
    ownerFullJid,
    globalThis.BOT_JID,
    sock?.user?.id,
    sock?.user?.lid,
    sock?.authState?.creds?.me?.id,
    sock?.authState?.creds?.me?.lid,
    globalThis.BOT_LID,
    ...(Array.isArray(globalThis.BOT_LIDS) ? globalThis.BOT_LIDS : []),
    ...(Array.isArray(ownerLids) ? ownerLids : []),
    ...(Array.isArray(config?.USER_LID) ? config.USER_LID : []),
  ];

  if (lidToPhoneMap) {
    for (const candidate of lidCandidates) {
      const lid = getLidFromJid(candidate);
      if (!lid) continue;
      const mappedPhone = getSenderPhone(lid, lidToPhoneMap);
      if (mappedPhone) {
        return `${mappedPhone}@s.whatsapp.net`;
      }
    }
  }

  for (const candidate of lidCandidates) {
    const lid = getLidFromJid(candidate);
    if (lid) return lid;
  }

  return null;
}

export function resolveRuntimeOwnerPhone({
  sock = null,
  config = null,
  ownerNumber = null,
  ownerLids = [],
  lidToPhoneMap = null,
} = {}) {
  const jid = resolveRuntimeOwnerJid({
    sock,
    config,
    ownerNumber,
    ownerLids,
    lidToPhoneMap,
  });
  return getPhoneFromJid(jid) || '';
}

export function isOwnerIdentity({
  jid,
  ownerNumber = null,
  ownerFullJid = null,
  ownerLids = [],
  config = null,
  sock = null,
  lidToPhoneMap = null,
} = {}) {
  const cleaned = cleanUserJid(jid);
  if (!cleaned) return false;

  const ownerPhones = new Set(
    [
      config?.OWNER_NUMBER,
      ownerNumber,
      globalThis.BOT_NUMBER,
      getPhoneFromJid(ownerFullJid),
      getPhoneFromJid(globalThis.BOT_JID),
      getPhoneFromJid(sock?.user?.id),
      getPhoneFromJid(sock?.user?.jid),
      getPhoneFromJid(sock?.authState?.creds?.me?.id),
      getPhoneFromJid(sock?.authState?.creds?.me?.jid),
    ]
      .map((val) => getPhoneFromJid(val))
      .filter(Boolean),
  );

  const ownerLidSet = new Set(
    [
      ...(Array.isArray(config?.USER_LID) ? config.USER_LID : []),
      ...(Array.isArray(ownerLids) ? ownerLids : []),
      ...(Array.isArray(globalThis.BOT_LIDS) ? globalThis.BOT_LIDS : []),
      globalThis.BOT_LID,
      ownerFullJid,
      globalThis.BOT_JID,
      sock?.user?.id,
      sock?.user?.lid,
      sock?.authState?.creds?.me?.id,
      sock?.authState?.creds?.me?.lid,
    ]
      .map((val) => getLidFromJid(val))
      .filter(Boolean),
  );

  const candidatePhone = getPhoneFromJid(cleaned);
  if (candidatePhone && ownerPhones.has(candidatePhone)) {
    return true;
  }

  const candidateLid = getLidFromJid(cleaned);
  if (candidateLid) {
    if (ownerLidSet.has(candidateLid)) return true;
    const mappedPhone = getSenderPhone(candidateLid, lidToPhoneMap);
    if (mappedPhone && ownerPhones.has(mappedPhone)) return true;
  }

  const ownerFullClean = cleanUserJid(ownerFullJid);
  const botJidClean = cleanUserJid(globalThis.BOT_JID);
  if (ownerFullClean && cleaned.toLowerCase() === ownerFullClean.toLowerCase()) return true;
  if (botJidClean && cleaned.toLowerCase() === botJidClean.toLowerCase()) return true;

  return false;
}
