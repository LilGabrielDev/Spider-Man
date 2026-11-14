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

export async function resolveLidPnAlternatesAsync(sock, targetOrTargets = []) {
  const seeds = dedupeUserJids(Array.isArray(targetOrTargets) ? targetOrTargets : [targetOrTargets]);
  if (seeds.length === 0) return [];

  const lidMapping = sock?.signalRepository?.lidMapping;
  if (!lidMapping || typeof lidMapping !== 'object') {
    return seeds;
  }

  const discovered = [];
  const pnsToLookup = [];

  for (const jid of seeds) {
    const lid = extractLid(jid);
    if (lid) {
      if (typeof lidMapping.getPNForLID === 'function') {
        try {
          const pn = await lidMapping.getPNForLID(lid);
          const normalized = normalizeParticipantField(pn);
          if (normalized) discovered.push(normalized);
        } catch {}
      }
      continue;
    }

    const phone = extractPhoneDigits(jid);
    if (phone) {
      const pnJid = `${phone}@s.whatsapp.net`;
      pnsToLookup.push(pnJid);
      if (typeof lidMapping.getLIDForPN === 'function') {
        try {
          const lidRes = await lidMapping.getLIDForPN(pnJid);
          const normalized = normalizeParticipantField(lidRes);
          if (normalized) discovered.push(normalized);
        } catch {}
      }
    }
  }

  if (pnsToLookup.length > 0 && typeof lidMapping.getKnownLIDsForPNs === 'function') {
    try {
      const known = await lidMapping.getKnownLIDsForPNs(pnsToLookup);
      if (Array.isArray(known)) {
        for (const entry of known) {
          const lidNorm = normalizeParticipantField(entry?.lid);
          const pnNorm = normalizeParticipantField(entry?.pn);
          if (lidNorm) discovered.push(lidNorm);
          if (pnNorm) discovered.push(pnNorm);
        }
      }
    } catch {}
  }

  return dedupeUserJids([...seeds, ...discovered]);
}

function inferAddressingMode(metadata, msg = null, { preferGroupParticipants = false } = {}) {
  const explicit = String(
    metadata?.addressingMode || msg?.key?.addressingMode || '',
  ).trim().toLowerCase();
  if (explicit === 'lid' || explicit === 'pn') return explicit;

  if (preferGroupParticipants && Array.isArray(metadata?.participants)) {
    let lidCount = 0;
    let pnCount = 0;
    for (const p of metadata.participants) {
      if (!p?.id) continue;
      if (extractLid(p.id)) lidCount += 1;
      else if (String(p.id).toLowerCase().endsWith('@s.whatsapp.net')) pnCount += 1;
    }
    if (lidCount > 0 && lidCount >= pnCount) return 'lid';
    if (pnCount > 0 && pnCount > lidCount) return 'pn';
  }

  return '';
}

function orderParticipantsByAddressingMode(candidates, { metadata = null, msg = null, preferGroupParticipants = false } = {}) {
  const list = dedupeUserJids(candidates);
  if (list.length <= 1) return list;

  const mode = inferAddressingMode(metadata, msg, { preferGroupParticipants });
  if (mode === 'lid') {
    const lids = list.filter((j) => Boolean(extractLid(j)));
    const others = list.filter((j) => !extractLid(j));
    return [...lids, ...others];
  }
  if (mode === 'pn') {
    const pns = list.filter((j) => String(j).toLowerCase().endsWith('@s.whatsapp.net'));
    const others = list.filter((j) => !String(j).toLowerCase().endsWith('@s.whatsapp.net'));
    return [...pns, ...others];
  }
  return list;
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
    (Number(result.status) === 0 || Number(result.status) >= 400)
  ) {
    return true;
  }
  return false;
}

function normalizeParticipantField(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return cleanJid(raw);
  const digits = raw.replace(/\D/g, '');
  if (/^\d{7,16}$/.test(digits)) {
    return `${digits}@s.whatsapp.net`;
  }
  return '';
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
        .map(normalizeParticipantField)
        .filter(Boolean)
    : [];

  const matchedAll = [];
  if (Array.isArray(metadata?.participants) && targets.length > 0) {
    const targetPhones = new Set(targets.map((t) => extractPhoneDigits(t)).filter(Boolean));
    const targetLids = new Set(targets.map((t) => extractLid(t)).filter(Boolean));
    const targetClean = new Set(targets.map((t) => cleanJid(t).toLowerCase()).filter(Boolean));

    for (const p of metadata.participants) {
      if (!p || typeof p !== 'object') continue;
      const fields = [p.id, p.jid, p.phoneNumber, p.pn, p.lid]
        .map(normalizeParticipantField)
        .filter(Boolean);
      const hits = fields.some((c) => {
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
  const candidates = orderParticipantsByAddressingMode(
    [
      rawParticipant,
      ...collectParticipantAlternates(metadata, [rawParticipant]),
    ],
    { metadata, msg, preferGroupParticipants: isGroup },
  );

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

export async function resolveQuotedDeleteTargetAsync({ from, msg, sock = null, metadata = null } = {}) {
  const { contextInfo, rawQuotedMessage } = extractContextInfo(msg);
  const stanzaId = contextInfo?.stanzaId || '';
  if (!stanzaId && !rawQuotedMessage) {
    return null;
  }

  const rawParticipant = contextInfo?.participant || contextInfo?.remoteJid || '';
  const isGroup = String(from || '').endsWith('@g.us');

  const metaAlternates = collectParticipantAlternates(metadata, [rawParticipant]);
  const signalAlternates = await resolveLidPnAlternatesAsync(sock, [
    rawParticipant,
    ...metaAlternates,
  ]);
  const fullAlternates = collectParticipantAlternates(metadata, [
    rawParticipant,
    ...metaAlternates,
    ...signalAlternates,
  ]);
  const candidates = orderParticipantsByAddressingMode(
    [rawParticipant, ...metaAlternates, ...signalAlternates, ...fullAlternates],
    { metadata, msg, preferGroupParticipants: isGroup },
  );

  let botMatch = false;
  if (candidates.length > 0) {
    botMatch = isFromBot(candidates, sock);
    if (!botMatch && sock) {
      const botIdentities = collectBotIdentities(sock);
      const botResolved = await resolveLidPnAlternatesAsync(sock, [
        ...botIdentities,
        ...collectParticipantAlternates(metadata, botIdentities),
      ]);
      const candSet = new Set(candidates.map((c) => c.toLowerCase()));
      const candLids = new Set(candidates.map((c) => extractLid(c)).filter(Boolean));
      const candPhones = new Set(candidates.map((c) => extractPhoneDigits(c)).filter(Boolean));
      botMatch = botResolved.some((b) => {
        if (candSet.has(b.toLowerCase())) return true;
        const lid = extractLid(b);
        if (lid && candLids.has(lid)) return true;
        const phone = extractPhoneDigits(b);
        if (phone && candPhones.has(phone)) return true;
        return false;
      });
    }
  }

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

function isRetryableAckError(errorCode) {
  const codeStr = String(errorCode || '').trim();
  if (!codeStr) return false;
  if (/^(406|421|479|500|503)$/i.test(codeStr)) return true;
  return /stale|addressing|sender-key|smax|group|cache/i.test(codeStr);
}

function removeEventListener(emitter, event, fn) {
  if (!emitter || !fn) return;
  try {
    if (typeof emitter.off === 'function') {
      emitter.off(event, fn);
    } else if (typeof emitter.removeListener === 'function') {
      emitter.removeListener(event, fn);
    }
  } catch {}
}

export async function sendWithAckCheck({
  sock,
  from,
  payload,
  sendOptions = undefined,
  ackTimeoutMs = null,
} = {}) {
  if (!sock || typeof sock.sendMessage !== 'function' || !from || !payload) {
    return { ok: false, error: 'invalid-send-arguments', retryableCache: false };
  }

  const hasWs = typeof sock.ws?.on === 'function';
  const hasEv = typeof sock.ev?.on === 'function';

  // Fast path for lightweight mocks without ws/ev emitters (zero delay, exact arg count)
  if (!hasWs && !hasEv) {
    try {
      const res = sendOptions
        ? await sock.sendMessage(from, payload, sendOptions)
        : await sock.sendMessage(from, payload);
      if (isSendMessageFailure(res)) {
        return {
          ok: false,
          error: res?.error || `status:${res?.status ?? 'failed'}`,
          status: res?.status,
          retryableCache: isRetryableAckError(res?.error || res?.status),
          result: res,
        };
      }
      return { ok: true, acked: false, result: res };
    } catch (err) {
      return {
        ok: false,
        blocked: isAdminProtectedError(err),
        error: err?.message || String(err),
        retryableCache: isRetryableAckError(err?.code || err?.message),
      };
    }
  }

  const bufferedAcks = [];
  const bufferedUpdates = [];
  let sentMsgId = null;
  let settled = false;
  let resolveDecision = null;
  let timer = null;

  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (resolveDecision) resolveDecision(outcome);
  };

  const evaluateAckFrame = (frame) => {
    const attrs = frame?.attrs || {};
    if (!sentMsgId || attrs.id !== sentMsgId) return false;
    if (attrs.error) {
      const code = String(attrs.error);
      finish({
        ok: false,
        acked: true,
        error: code,
        status: Number.isNaN(Number(code)) ? code : Number(code),
        retryableCache: isRetryableAckError(code),
      });
      return true;
    }
    finish({ ok: true, acked: true });
    return true;
  };

  const evaluateMsgUpdate = (updates) => {
    if (!sentMsgId || !Array.isArray(updates)) return false;
    for (const item of updates) {
      if (item?.key?.id !== sentMsgId) continue;
      const st = item?.update?.status;
      const isErr =
        st === 0 ||
        (typeof st === 'string' && st.toUpperCase() === 'ERROR');
      if (isErr) {
        const stubErr = item?.update?.messageStubParameters?.[0];
        const code = String(stubErr || 'ack-error');
        finish({
          ok: false,
          acked: true,
          error: code,
          status: Number.isNaN(Number(code)) ? 0 : Number(code),
          retryableCache: isRetryableAckError(code),
        });
        return true;
      }
      if (st != null && !Number.isNaN(Number(st)) && Number(st) >= 2) {
        finish({ ok: true, acked: true });
        return true;
      }
    }
    return false;
  };

  const onAck = (frame) => {
    if (settled) return;
    if (!sentMsgId) {
      bufferedAcks.push(frame);
      return;
    }
    evaluateAckFrame(frame);
  };

  const onUpdate = (updates) => {
    if (settled) return;
    if (!sentMsgId) {
      if (Array.isArray(updates)) bufferedUpdates.push(updates);
      return;
    }
    evaluateMsgUpdate(updates);
  };

  if (hasWs) sock.ws.on('CB:ack,class:message', onAck);
  if (hasEv) sock.ev.on('messages.update', onUpdate);

  try {
    let res;
    try {
      res = sendOptions
        ? await sock.sendMessage(from, payload, sendOptions)
        : await sock.sendMessage(from, payload);
    } catch (err) {
      return {
        ok: false,
        blocked: isAdminProtectedError(err),
        error: err?.message || String(err),
        retryableCache: isRetryableAckError(err?.code || err?.message),
      };
    }

    if (isSendMessageFailure(res)) {
      return {
        ok: false,
        error: res?.error || `status:${res?.status ?? 'failed'}`,
        status: res?.status,
        retryableCache: isRetryableAckError(res?.error || res?.status),
        result: res,
      };
    }

    sentMsgId = res?.key?.id || null;
    if (!sentMsgId) {
      return { ok: true, acked: false, result: res };
    }

    const decisionPromise = new Promise((resolve) => {
      resolveDecision = resolve;
    });

    for (const frame of bufferedAcks) {
      if (evaluateAckFrame(frame)) break;
    }
    if (!settled) {
      for (const batch of bufferedUpdates) {
        if (evaluateMsgUpdate(batch)) break;
      }
    }

    if (!settled) {
      const waitMs =
        typeof ackTimeoutMs === 'number' && ackTimeoutMs >= 0
          ? ackTimeoutMs
          : hasWs
            ? 2500
            : 400;
      timer = setTimeout(() => {
        finish({ ok: true, timedOut: true, acked: false });
      }, waitMs);
    }

    const decision = await decisionPromise;
    return { ...decision, result: res };
  } finally {
    if (timer) clearTimeout(timer);
    if (hasWs) removeEventListener(sock.ws, 'CB:ack,class:message', onAck);
    if (hasEv) removeEventListener(sock.ev, 'messages.update', onUpdate);
  }
}

function selectDistinctFormatAlternates(winningKey, allCandidates) {
  const list = dedupeUserJids(allCandidates);
  if (list.length <= 1) return [];

  const winningParticipant = cleanJid(winningKey?.participant || '');
  const winLower = winningParticipant.toLowerCase();
  const winIsLid = Boolean(extractLid(winningParticipant));
  const winIsPn = winningParticipant.toLowerCase().endsWith('@s.whatsapp.net');

  const alternates = [];
  if (!winIsLid) {
    const lidAlt = list.find((c) => Boolean(extractLid(c)) && c.toLowerCase() !== winLower);
    if (lidAlt) alternates.push(lidAlt);
  }
  if (!winIsPn) {
    const pnAlt = list.find(
      (c) => c.toLowerCase().endsWith('@s.whatsapp.net') && c.toLowerCase() !== winLower,
    );
    if (pnAlt) alternates.push(pnAlt);
  }
  return alternates;
}

export async function deleteMessageSafely({
  sock,
  from,
  msg,
  targetJid = '',
  senderCandidates = [],
  metadata = null,
  allowFromMeFallback = false,
  broadcastAlternates = false,
  ackTimeoutMs = null,
} = {}) {
  if (!sock || typeof sock.sendMessage !== 'function' || (!from && !msg?.key?.remoteJid) || !msg?.key?.id) {
    return { ok: false, key: null, attempts: 0, error: 'missing-delete-key' };
  }

  from = String(msg.key.remoteJid || from);
  const isGroup = String(from).endsWith('@g.us');
  const fromMe = Boolean(msg.key.fromMe);
  const seedCandidates = dedupeUserJids([
    msg.key.participant,
    msg.key.participantAlt,
    msg.key.participantPn,
    msg.key.senderPn,
    msg.key.senderLid,
    msg.participant,
    targetJid,
    ...(Array.isArray(senderCandidates) ? senderCandidates : []),
  ]);
  const metaAlternates = collectParticipantAlternates(metadata, seedCandidates);
  const signalAlternates = isGroup
    ? await resolveLidPnAlternatesAsync(sock, [...seedCandidates, ...metaAlternates])
    : [];
  const postMetaAlternates =
    signalAlternates.length > 0
      ? collectParticipantAlternates(metadata, [...seedCandidates, ...metaAlternates, ...signalAlternates])
      : [];

  const orderedParticipantCandidates = orderParticipantsByAddressingMode(
    [...seedCandidates, ...metaAlternates, ...signalAlternates, ...postMetaAlternates],
    { metadata, msg },
  );
  const originalParticipantRaw = String(msg.key.participant || '').trim();
  const originalParticipant = cleanJid(originalParticipantRaw);
  const rawParticipantCandidates = originalParticipantRaw
    ? [
        originalParticipantRaw,
        ...orderedParticipantCandidates.filter(
          (candidate) => cleanJid(candidate).toLowerCase() !== originalParticipant.toLowerCase(),
        ),
      ]
    : orderedParticipantCandidates;

  if (isGroup && !fromMe && rawParticipantCandidates.length === 0 && !allowFromMeFallback) {
    return { ok: false, key: null, attempts: 0, error: 'missing-group-participant' };
  }

  const keysToTry = [];
  if (rawParticipantCandidates.length > 0) {
    if (!(isGroup && !fromMe && rawParticipantCandidates.length === 0)) {
      for (const participant of rawParticipantCandidates) {
        keysToTry.push({
          remoteJid: from,
          fromMe,
          id: msg.key.id,
          participant,
        });
      }
    }
    if (allowFromMeFallback) {
      keysToTry.push({
        remoteJid: from,
        fromMe: !fromMe,
        id: msg.key.id,
        participant: rawParticipantCandidates[0],
      });
      const fallbackAlts = selectDistinctFormatAlternates(
        { participant: rawParticipantCandidates[0] },
        rawParticipantCandidates,
      );
      for (const altParticipant of fallbackAlts) {
        keysToTry.push({
          remoteJid: from,
          fromMe: !fromMe,
          id: msg.key.id,
          participant: altParticipant,
        });
      }
    }
  } else {
    if (!(isGroup && !fromMe)) {
      keysToTry.push({
        remoteJid: from,
        fromMe,
        id: msg.key.id,
      });
    }
    if (allowFromMeFallback) {
      keysToTry.push({
        remoteJid: from,
        fromMe: !fromMe,
        id: msg.key.id,
      });
    }
  }

  if (keysToTry.length === 0) {
    return { ok: false, key: null, attempts: 0, error: 'missing-group-participant' };
  }

  let attempts = 0;
  let lastError = null;
  let cacheInvalidated = false;

  if (isGroup && broadcastAlternates) {
    try {
      await sock.__spiderInvalidateGroupCache?.(from);
    } catch {}
  }

  for (let idx = 0; idx < keysToTry.length; idx += 1) {
    const key = keysToTry[idx];
    attempts += 1;
    const forceFreshGroupSend = isGroup && (cacheInvalidated || broadcastAlternates);
    const initialSendOptions = forceFreshGroupSend
      ? { useCachedGroupMetadata: false, useUserDevicesCache: false }
      : undefined;

    const firstTry = await sendWithAckCheck({
      sock,
      from,
      payload: { delete: key },
      sendOptions: initialSendOptions,
      ackTimeoutMs,
    });

    let winningResult = null;
    let winningAcked = false;
    let retriedWithoutCache = false;

    if (firstTry.ok && !firstTry.timedOut && !firstTry.acked) {
      return { ok: false, key, attempts, error: 'delete-unconfirmed', result: firstTry.result };
    }

    if (firstTry.ok && !firstTry.timedOut && firstTry.acked) {
      winningResult = firstTry.result;
      winningAcked = true;
    } else {
      lastError = firstTry.error || (firstTry.timedOut ? 'delete-ack-timeout' : 'delete-failed');
      if (firstTry.blocked) {
        return { ok: false, blocked: true, key, attempts, error: lastError };
      }

      if (isGroup && !cacheInvalidated) {
        cacheInvalidated = true;
        try {
          await sock.__spiderInvalidateGroupCache?.(from);
        } catch {}

        if (firstTry.retryableCache && !forceFreshGroupSend) {
          attempts += 1;
          const freshTry = await sendWithAckCheck({
            sock,
            from,
            payload: { delete: key },
            sendOptions: { useCachedGroupMetadata: false, useUserDevicesCache: false },
            ackTimeoutMs,
          });
          if (freshTry.ok && !freshTry.timedOut && freshTry.acked) {
            winningResult = freshTry.result;
            winningAcked = true;
            retriedWithoutCache = true;
          } else {
            lastError =
              freshTry.error ||
              (freshTry.timedOut
                ? 'delete-ack-timeout'
                : freshTry.ok
                  ? 'delete-unconfirmed'
                  : lastError);
            if (freshTry.blocked) {
              return { ok: false, blocked: true, key, attempts, error: lastError };
            }
          }
        }
      }
    }

    if (winningResult !== null || (firstTry.ok && !firstTry.timedOut && firstTry.acked)) {
      let alternateKeysSent = 0;
      if (isGroup && broadcastAlternates && rawParticipantCandidates.length > 1) {
        const distinctAlternates = selectDistinctFormatAlternates(key, rawParticipantCandidates);
        for (const altParticipant of distinctAlternates) {
          attempts += 1;
          try {
            const altKey = {
              remoteJid: from,
              fromMe: Boolean(key.fromMe),
              id: msg.key.id,
              participant: altParticipant,
            };
            const altTry = await sendWithAckCheck({
              sock,
              from,
              payload: { delete: altKey },
              sendOptions: { useCachedGroupMetadata: false, useUserDevicesCache: false },
              ackTimeoutMs,
            });
            if (altTry.ok && !altTry.timedOut && altTry.acked) alternateKeysSent += 1;
          } catch {}
        }
      }

      return {
        ok: true,
        key,
        attempts,
        alternateKeysSent,
        result: winningResult,
        acked: winningAcked,
        ...(retriedWithoutCache ? { retriedWithoutCache: true } : {}),
      };
    }
  }

  return { ok: false, key: keysToTry[0] || null, attempts, error: lastError || 'delete-failed' };
}

export async function pinMessageSafely({
  sock,
  from,
  key,
  type = 1,
  time = 86400,
  ackTimeoutMs = null,
} = {}) {
  if (!sock || typeof sock.sendMessage !== 'function' || !from || !key?.id) {
    return { ok: false, error: 'missing-pin-key' };
  }

  const payload = { pin: key, type, time };
  const firstTry = await sendWithAckCheck({
    sock,
    from,
    payload,
    ackTimeoutMs,
  });
  if (firstTry.ok) {
    return { ok: true, result: firstTry.result, acked: Boolean(firstTry.acked) };
  }

  if (String(from).endsWith('@g.us')) {
    try {
      await sock.__spiderInvalidateGroupCache?.(from);
    } catch {}
    if (firstTry.retryableCache) {
      const retryTry = await sendWithAckCheck({
        sock,
        from,
        payload,
        sendOptions: { useCachedGroupMetadata: false, useUserDevicesCache: false },
        ackTimeoutMs,
      });
      if (retryTry.ok) {
        return { ok: true, result: retryTry.result, acked: Boolean(retryTry.acked), retriedWithoutCache: true };
      }
      return { ok: false, error: retryTry.error || firstTry.error || 'pin-failed' };
    }
  }

  return { ok: false, error: firstTry.error || 'pin-failed' };
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
    const reported = new Set();
    for (const [index, item] of result.entries()) {
      const statusRaw = item?.status;
      const statusStr = statusRaw != null ? String(statusRaw) : '';
      if (statusStr) statusCodes.push(statusStr);
      const hasAttrError = Boolean(item?.content?.attrs?.error);
      const responseJid = cleanJid(item?.jid || '');
      const fallbackJid = cleanJid(targetList[index] || '');
      const statusNumber = Number(statusStr);
      const isSuccess =
        !hasAttrError &&
        Boolean(responseJid) &&
        statusStr !== '' &&
        Number.isInteger(statusNumber) &&
        statusNumber >= 200 &&
        statusNumber < 300;
      const resultJid = responseJid || fallbackJid;
      if (resultJid) reported.add(resultJid.toLowerCase());
      if (isSuccess) {
        succeeded.push(responseJid);
      } else {
        failed.push({
          jid: resultJid,
          status: statusStr || (responseJid ? 'missing-status' : 'missing-jid'),
        });
      }
    }
    for (const target of targetList) {
      const jid = cleanJid(target || '');
      if (jid && !reported.has(jid.toLowerCase())) {
        failed.push({ jid, status: 'missing-result' });
      }
    }
    return {
      ok: targetList.length > 0 && succeeded.length === targetList.length && failed.length === 0,
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
    ok: false,
    succeeded: [],
    failed: targetList.map((jid) => ({ jid: cleanJid(jid || ''), status: 'unexpected-result' })),
    statusCodes: [],
    error: 'unexpected-result',
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
        const combinedFailed = [
          ...parsed.failed.filter((f) => String(f.status) !== '404'),
          ...retryParsed.failed,
        ];
        return {
          ok: false,
          succeeded: combinedSucceeded,
          failed: combinedFailed,
          statusCodes: [...parsed.statusCodes, ...retryParsed.statusCodes],
          retried: true,
          error: combinedFailed[0]?.status || retryParsed.error || 'participant-update-failed',
        };
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
