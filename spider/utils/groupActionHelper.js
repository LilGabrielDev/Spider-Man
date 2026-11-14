import {
  cleanJid,
  collectBotIdentities,
  collectSenderIdentities,
  extractLid,
  extractPhoneDigits,
  resolveParticipantRole,
} from './groupRoleResolver.js';

const WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'groupStatusMessageV2',
  'associatedChildMessage',
  'botInvokeMessage',
];

const CONTEXT_CARRIER_KEYS = [
  'extendedTextMessage',
  'imageMessage',
  'videoMessage',
  'ptvMessage',
  'documentMessage',
  'audioMessage',
  'stickerMessage',
  'buttonsResponseMessage',
  'templateButtonReplyMessage',
  'listResponseMessage',
  'interactiveMessage',
  'interactiveResponseMessage',
  'contactMessage',
  'contactsArrayMessage',
  'locationMessage',
  'liveLocationMessage',
  'pollCreationMessage',
  'pollCreationMessageV2',
  'pollCreationMessageV3',
  'buttonsMessage',
  'templateMessage',
  'orderMessage',
  'productMessage',
  'eventMessage',
];

export function unwrapMessageContent(message) {
  let current = message;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    let next = null;
    for (const key of WRAPPER_KEYS) {
      if (!current[key] || typeof current[key] !== 'object') continue;
      if (key === 'editedMessage') {
        next =
          current[key].message?.protocolMessage?.editedMessage ||
          current[key].message ||
          null;
      } else {
        next = current[key].message || null;
      }
      if (next && typeof next === 'object') break;
    }
    if (!next || next === current) break;
    current = next;
  }
  return current || null;
}

export function isViewOnceMessage(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'object') return false;
  let cursor = rawMessage;
  for (let depth = 0; depth < 8 && cursor && typeof cursor === 'object'; depth += 1) {
    if (
      cursor.viewOnceMessage ||
      cursor.viewOnceMessageV2 ||
      cursor.viewOnceMessageV2Extension ||
      cursor.viewOnce === true
    ) {
      return true;
    }
    if (
      cursor.imageMessage?.viewOnce ||
      cursor.videoMessage?.viewOnce ||
      cursor.ptvMessage?.viewOnce ||
      cursor.audioMessage?.viewOnce
    ) {
      return true;
    }
    let next = null;
    for (const key of WRAPPER_KEYS) {
      if (cursor[key]?.message) {
        next = cursor[key].message;
        break;
      }
    }
    if (!next || next === cursor) break;
    cursor = next;
  }
  return false;
}

export function extractContextInfo(msg) {
  const rawMessage = msg?.message || null;
  const unwrapped = unwrapMessageContent(rawMessage);
  let contextInfo = null;

  const inspectLayer = (layer) => {
    if (!layer || typeof layer !== 'object') return null;
    for (const key of CONTEXT_CARRIER_KEYS) {
      if (layer[key]?.contextInfo && typeof layer[key].contextInfo === 'object') {
        return layer[key].contextInfo;
      }
    }
    for (const value of Object.values(layer)) {
      if (value && typeof value === 'object' && value.contextInfo && typeof value.contextInfo === 'object') {
        return value.contextInfo;
      }
    }
    if (layer.messageContextInfo && typeof layer.messageContextInfo === 'object') {
      return layer.messageContextInfo;
    }
    return null;
  };

  contextInfo = inspectLayer(unwrapped) || inspectLayer(rawMessage) || null;
  const rawQuotedMessage = contextInfo?.quotedMessage || null;
  const quotedMessage = rawQuotedMessage ? unwrapMessageContent(rawQuotedMessage) : null;

  return {
    contextInfo,
    rawQuotedMessage,
    quotedMessage,
  };
}

export function isNonUserJid(jid) {
  const lower = String(jid || '').trim().toLowerCase();
  return (
    !lower ||
    lower.endsWith('@g.us') ||
    lower.endsWith('@broadcast') ||
    lower.endsWith('@newsletter')
  );
}

export function normalizeTargetJidInput(rawToken) {
  const raw = String(rawToken || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) {
    const cleaned = cleanJid(raw);
    return isNonUserJid(cleaned) ? '' : cleaned;
  }
  const stripped = raw.replace(/^@/, '').trim();
  const digits = stripped.replace(/\D/g, '');
  if (/^\d{7,16}$/.test(digits)) {
    return `${digits}@s.whatsapp.net`;
  }
  return '';
}

export function isFromBot(candidateOrList, sock) {
  const candidates = (Array.isArray(candidateOrList) ? candidateOrList : [candidateOrList])
    .map((item) => cleanJid(item))
    .filter(Boolean);
  if (candidates.length === 0) return false;

  const botIdentities = collectBotIdentities(sock);
  if (botIdentities.length === 0) return false;

  const botCleanSet = new Set(botIdentities.map((id) => id.toLowerCase()));
  const botPhones = new Set(
    botIdentities.map((id) => extractPhoneDigits(id)).filter(Boolean),
  );
  const botLids = new Set(botIdentities.map((id) => extractLid(id)).filter(Boolean));

  for (const candidate of candidates) {
    if (botCleanSet.has(candidate.toLowerCase())) return true;
    const lid = extractLid(candidate);
    if (lid && botLids.has(lid)) return true;
    const phone = extractPhoneDigits(candidate);
    if (phone && botPhones.has(phone)) return true;
  }
  return false;
}

export function isAdminProtectedError(err) {
  const code = String(err?.code || '').toUpperCase();
  const message = String(err?.message || '');
  return (
    code === 'ADMIN_PROTECTED' ||
    code === 'ADMIN_PROTECTION_CHECK_FAILED' ||
    code === 'GROUP_ADMIN_PROTECTED' ||
    code === 'GROUP_METADATA_UNAVAILABLE' ||
    /admin protection blocked/i.test(message)
  );
}

export function isSendMessageFailure(result) {
  if (result === false) return true;
  if (!result || typeof result !== 'object') return false;
  if (result.error) return true;
  if (typeof result.status === 'string' && result.status.toUpperCase() === 'ERROR') {
    return true;
  }
  if (
    result.status != null &&
    result.status !== '' &&
    !Number.isNaN(Number(result.status)) &&
    Number(result.status) >= 400
  ) {
    return true;
  }
  return false;
}

function dedupeUserJids(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const cleaned = cleanJid(item);
    if (!cleaned || isNonUserJid(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(cleaned);
    }
  }
  return out;
}

export function collectParticipantAlternates(metadata, targetOrTargets = []) {
  const targets = (Array.isArray(targetOrTargets) ? targetOrTargets : [targetOrTargets]).filter(Boolean);
  const resolved = resolveParticipantRole(metadata, targets);
  const entry = resolved?.participant;
  const entryFields = entry
    ? [entry.id, entry.jid, entry.phoneNumber, entry.pn, entry.lid]
    : [];

  const matchedAll = [];
  if (Array.isArray(metadata?.participants) && targets.length > 0) {
    const targetPhones = new Set(targets.map((t) => extractPhoneDigits(t)).filter(Boolean));
    const targetLids = new Set(targets.map((t) => extractLid(t)).filter(Boolean));
    const targetClean = new Set(targets.map((t) => cleanJid(t).toLowerCase()).filter(Boolean));

    for (const p of metadata.participants) {
      if (!p || typeof p !== 'object') continue;
      const fields = [p.id, p.jid, p.phoneNumber, p.pn, p.lid].filter(Boolean);
      const hits = fields.some((f) => {
        const c = cleanJid(f);
        if (targetClean.has(c.toLowerCase())) return true;
        const lid = extractLid(c);
        if (lid && targetLids.has(lid)) return true;
        const ph = extractPhoneDigits(c);
        if (ph && targetPhones.has(ph)) return true;
        return false;
      });
      if (hits) {
        matchedAll.push(...fields);
      }
    }
  }

  return dedupeUserJids([...targets, ...entryFields, ...matchedAll]);
}

export function resolveSenderDisplayAndMention({
  senderRole = null,
  senderJid = '',
  senderCandidates = [],
  metadata = null,
  getPhoneFn = null,
} = {}) {
  const ordered = dedupeUserJids([
    senderRole?.targetJid,
    senderJid,
    ...(Array.isArray(senderCandidates) ? senderCandidates : []),
    ...collectParticipantAlternates(metadata, [senderRole?.targetJid, senderJid, ...(senderCandidates || [])]),
  ]);

  const targetJid = ordered[0] || '';
  const mentionJid = targetJid;
  const mentionUser = mentionJid ? mentionJid.split('@')[0] : '';
  const phone =
    extractPhoneDigits(mentionJid, getPhoneFn) ||
    ordered.map((c) => extractPhoneDigits(c, getPhoneFn)).find(Boolean) ||
    '';
  const targetUser = mentionUser || phone || 'user';

  return {
    targetJid,
    mentionJid,
    targetUser,
    phone: phone || mentionUser,
    candidates: ordered,
  };
}

export function resolveTargetFromMessage({
  sock = null,
  from = '',
  msg = null,
  text = '',
  args = [],
  metadata = null,
  allowSenderFallback = false,
} = {}) {
  const { contextInfo } = extractContextInfo(msg);
  const quotedParticipant = cleanJid(contextInfo?.participant || '');
  const mentionedJid = cleanJid(contextInfo?.mentionedJid?.[0] || '');

  let parsedTokenJid = '';
  const tokenCandidates = [
    ...(Array.isArray(args) ? args : []),
    ...String(text || '').trim().split(/\s+/),
  ].filter(Boolean);
  for (const token of tokenCandidates) {
    const normalized = normalizeTargetJidInput(token);
    if (normalized) {
      parsedTokenJid = normalized;
      break;
    }
  }

  let rawTarget = quotedParticipant || mentionedJid || parsedTokenJid || '';
  if (!rawTarget && allowSenderFallback) {
    const senderIds = collectSenderIdentities(msg, [from]);
    rawTarget = senderIds.find((id) => !isNonUserJid(id)) || '';
  }

  if (!rawTarget) {
    return {
      targetJid: '',
      alternateJids: [],
      mentionJid: '',
      displayUser: '',
      phone: '',
      role: null,
    };
  }

  const role = metadata ? resolveParticipantRole(metadata, rawTarget) : null;
  const alternates = collectParticipantAlternates(metadata, [rawTarget, role?.targetJid]);
  const primary = cleanJid(role?.targetJid || alternates[0] || rawTarget);
  const mentionJid = primary;
  const phone =
    extractPhoneDigits(primary) ||
    alternates.map((j) => extractPhoneDigits(j)).find(Boolean) ||
    '';
  const displayUser = (mentionJid ? mentionJid.split('@')[0] : '') || phone || 'user';

  return {
    targetJid: primary,
    alternateJids: alternates,
    mentionJid,
    displayUser,
    phone,
    role,
  };
}

export function resolveQuotedDeleteTarget({ from, msg, sock = null, metadata = null } = {}) {
  const { contextInfo, rawQuotedMessage } = extractContextInfo(msg);
  const stanzaId = contextInfo?.stanzaId || '';
  if (!stanzaId && !rawQuotedMessage) {
    return null;
  }

  const rawParticipant = contextInfo?.participant || contextInfo?.remoteJid || '';
  const isGroup = String(from || '').endsWith('@g.us');
  const candidates = dedupeUserJids([
    rawParticipant,
    ...collectParticipantAlternates(metadata, [rawParticipant]),
  ]);

  const botMatch = rawParticipant ? isFromBot([rawParticipant, ...candidates], sock) : false;
  const fromMe = isGroup ? botMatch : botMatch || !rawParticipant;

  return {
    stanzaId,
    fromMe,
    participant: candidates[0] || '',
    candidates,
    allowFromMeFallback: true,
    msg: {
      key: {
        remoteJid: from,
        fromMe,
        id: stanzaId,
        ...(candidates[0] ? { participant: candidates[0] } : {}),
      },
    },
  };
}

export async function deleteMessageSafely({
  sock,
  from,
  msg,
  targetJid = '',
  senderCandidates = [],
  metadata = null,
  allowFromMeFallback = false,
} = {}) {
  if (!sock || typeof sock.sendMessage !== 'function' || !from || !msg?.key?.id) {
    return { ok: false, key: null, attempts: 0, error: 'missing-delete-key' };
  }

  const isGroup = String(from).endsWith('@g.us');
  const fromMe = Boolean(msg.key.fromMe);
  const rawParticipantCandidates = dedupeUserJids([
    msg.key.participant,
    msg.key.participantAlt,
    msg.key.participantPn,
    msg.key.senderPn,
    msg.key.senderLid,
    msg.participant,
    targetJid,
    ...(Array.isArray(senderCandidates) ? senderCandidates : []),
    ...collectParticipantAlternates(metadata, [
      msg.key.participant,
      msg.key.participantAlt,
      msg.key.participantPn,
      targetJid,
      ...(Array.isArray(senderCandidates) ? senderCandidates : []),
    ]),
  ]);

  if (isGroup && !fromMe && rawParticipantCandidates.length === 0) {
    return { ok: false, key: null, attempts: 0, error: 'missing-group-participant' };
  }

  const keysToTry = [];
  if (rawParticipantCandidates.length > 0) {
    for (const participant of rawParticipantCandidates) {
      keysToTry.push({
        remoteJid: from,
        fromMe,
        id: msg.key.id,
        participant,
      });
    }
    if (allowFromMeFallback) {
      keysToTry.push({
        remoteJid: from,
        fromMe: !fromMe,
        id: msg.key.id,
        participant: rawParticipantCandidates[0],
      });
    }
  } else {
    keysToTry.push({
      remoteJid: from,
      fromMe,
      id: msg.key.id,
    });
    if (allowFromMeFallback) {
      keysToTry.push({
        remoteJid: from,
        fromMe: !fromMe,
        id: msg.key.id,
      });
    }
  }

  let attempts = 0;
  let lastError = null;
  for (const key of keysToTry) {
    attempts += 1;
    try {
      const res = await sock.sendMessage(from, { delete: key });
      if (!isSendMessageFailure(res)) {
        return { ok: true, key, attempts, result: res };
      }
      lastError = res?.error || `status:${res?.status ?? 'failed'}`;
    } catch (err) {
      lastError = err?.message || String(err);
      if (isAdminProtectedError(err)) {
        return { ok: false, blocked: true, key, attempts, error: lastError };
      }
    }
  }

  return { ok: false, key: keysToTry[0] || null, attempts, error: lastError || 'delete-failed' };
}

export async function safeDeleteTempMessage(sock, from, tempMsg) {
  if (!sock || typeof sock.sendMessage !== 'function' || !from || !tempMsg?.key?.id) {
    return false;
  }
  const res = await deleteMessageSafely({
    sock,
    from,
    msg: {
      key: {
        remoteJid: tempMsg.key.remoteJid || from,
        fromMe: tempMsg.key.fromMe ?? true,
        id: tempMsg.key.id,
        ...(tempMsg.key.participant ? { participant: tempMsg.key.participant } : {}),
      },
    },
  });
  return res.ok;
}

export function parseParticipantsUpdateResult(result, targets = []) {
  const targetList = Array.isArray(targets) ? targets : [targets];
  if (Array.isArray(result)) {
    if (result.length === 0) {
      return {
        ok: false,
        succeeded: [],
        failed: targetList.map((jid) => ({ jid, status: 'empty' })),
        statusCodes: ['empty'],
        error: 'empty-result',
      };
    }
    const succeeded = [];
    const failed = [];
    const statusCodes = [];
    for (const item of result) {
      const statusRaw = item?.status;
      const statusStr = statusRaw != null ? String(statusRaw) : '';
      if (statusStr) statusCodes.push(statusStr);
      const hasAttrError = Boolean(item?.content?.attrs?.error);
      const isFailure =
        hasAttrError ||
        (statusStr !== '' && !Number.isNaN(Number(statusStr)) && Number(statusStr) >= 400);
      if (isFailure) {
        failed.push({
          jid: cleanJid(item?.jid || ''),
          status: statusStr || 'error',
        });
      } else {
        succeeded.push(cleanJid(item?.jid || '') || targetList[0] || '');
      }
    }
    return {
      ok: succeeded.length > 0 && failed.length === 0,
      succeeded: succeeded.filter(Boolean),
      failed,
      statusCodes,
      error: failed[0]?.status || null,
    };
  }

  if (isSendMessageFailure(result)) {
    return {
      ok: false,
      succeeded: [],
      failed: targetList.map((jid) => ({ jid, status: String(result?.status || 'error') })),
      statusCodes: [String(result?.status || 'error')],
      error: result?.error || `status:${result?.status ?? 'failed'}`,
    };
  }

  return {
    ok: true,
    succeeded: targetList.filter(Boolean),
    failed: [],
    statusCodes: [],
    error: null,
  };
}

export async function executeParticipantsAction({
  sock,
  from,
  participants = [],
  action,
  metadata = null,
} = {}) {
  const targets = dedupeUserJids(Array.isArray(participants) ? participants : [participants]);
  if (!sock || typeof sock.groupParticipantsUpdate !== 'function' || !from || targets.length === 0) {
    return {
      ok: false,
      succeeded: [],
      failed: targets.map((jid) => ({ jid, status: 'invalid' })),
      statusCodes: [],
      error: 'invalid-arguments',
    };
  }

  let parsed;
  try {
    const rawResult = await sock.groupParticipantsUpdate(from, targets, action);
    parsed = parseParticipantsUpdateResult(rawResult, targets);
  } catch (err) {
    return {
      ok: false,
      blocked: isAdminProtectedError(err),
      succeeded: [],
      failed: targets.map((jid) => ({ jid, status: 'exception' })),
      statusCodes: [],
      error: err?.message || String(err),
    };
  }

  const has404 = parsed.failed.some((f) => String(f.status) === '404');
  if (!parsed.ok && has404 && metadata) {
    const retryTargets = [];
    for (const failedItem of parsed.failed) {
      if (String(failedItem.status) !== '404') continue;
      const alternates = collectParticipantAlternates(metadata, [failedItem.jid, ...targets]);
      const alt = alternates.find(
        (cand) => !targets.some((t) => t.toLowerCase() === cand.toLowerCase()),
      );
      if (alt) retryTargets.push(alt);
    }

    if (retryTargets.length > 0) {
      try {
        const retryResult = await sock.groupParticipantsUpdate(from, retryTargets, action);
        const retryParsed = parseParticipantsUpdateResult(retryResult, retryTargets);
        const combinedSucceeded = [...parsed.succeeded, ...retryParsed.succeeded];
        const stillFailed = parsed.failed.filter(
          (f) => String(f.status) !== '404',
        );
        if (retryParsed.ok) {
          return {
            ok: stillFailed.length === 0,
            succeeded: combinedSucceeded,
            failed: stillFailed,
            statusCodes: [...parsed.statusCodes, ...retryParsed.statusCodes],
            retried: true,
            error: stillFailed[0]?.status || null,
          };
        }
        return retryParsed;
      } catch (retryErr) {
        return {
          ok: false,
          blocked: isAdminProtectedError(retryErr),
          succeeded: parsed.succeeded,
          failed: parsed.failed,
          statusCodes: parsed.statusCodes,
          error: retryErr?.message || String(retryErr),
        };
      }
    }
  }

  return parsed;
}

export async function executeRequestParticipantsAction({
  sock,
  from,
  jids = [],
  action,
} = {}) {
  const targets = dedupeUserJids(Array.isArray(jids) ? jids : [jids]);
  if (!sock || typeof sock.groupRequestParticipantsUpdate !== 'function' || !from || targets.length === 0) {
    return {
      ok: false,
      succeeded: [],
      failed: targets.map((jid) => ({ jid, status: 'invalid' })),
      statusCodes: [],
      error: 'invalid-arguments',
    };
  }

  try {
    const rawResult = await sock.groupRequestParticipantsUpdate(from, targets, action);
    return parseParticipantsUpdateResult(rawResult, targets);
  } catch (err) {
    return {
      ok: false,
      succeeded: [],
      failed: targets.map((jid) => ({ jid, status: 'exception' })),
      statusCodes: [],
      error: err?.message || String(err),
    };
  }
}

export async function executeGroupSettingUpdate({ sock, from, setting } = {}) {
  if (!sock || typeof sock.groupSettingUpdate !== 'function' || !from || !setting) {
    return { ok: false, error: 'invalid-arguments' };
  }
  try {
    const result = await sock.groupSettingUpdate(from, setting);
    if (isSendMessageFailure(result)) {
      return { ok: false, error: result?.error || `status:${result?.status ?? 'failed'}` };
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
