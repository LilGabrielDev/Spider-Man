import { cleanUserJid } from '../../spider/utils/userJid.js';

const ONLINE_STATES = new Set(['available', 'composing', 'recording']);
const PRESENCE_FRESH_MS = 120_000;

async function collectParticipantCandidates(sock, participant) {
  const candidates = [];
  const add = (val) => {
    const raw = String(val || '').trim();
    if (!raw) return;
    if (!candidates.includes(raw)) candidates.push(raw);
    const cleaned = cleanUserJid(raw);
    if (cleaned && !candidates.includes(cleaned)) candidates.push(cleaned);
  };

  add(participant?.phoneNumber);
  add(participant?.pn);
  add(participant?.id);
  add(participant?.jid);

  const primary = participant?.id || participant?.jid || '';
  if (primary.endsWith('@lid') || primary.endsWith('@hosted.lid')) {
    const cleanedLid = cleanUserJid(primary);
    const cachePhone =
      (typeof globalThis.resolvePhoneFromLid === 'function'
        ? globalThis.resolvePhoneFromLid(cleanedLid)
        : '') ||
      globalThis.lidPhoneCache?.get?.(cleanedLid) ||
      '';
    if (cachePhone) {
      const digits = String(cachePhone).replace(/\D/g, '');
      if (digits) add(`${digits}@s.whatsapp.net`);
    }
    const getPNForLID = sock?.signalRepository?.lidMapping?.getPNForLID;
    if (typeof getPNForLID === 'function') {
      try {
        const pn = await getPNForLID.call(sock.signalRepository.lidMapping, cleanedLid);
        if (pn) add(pn);
      } catch {}
    }
  }

  return candidates;
}

function isEntryOnline(entry, now) {
  if (!entry || typeof entry !== 'object') return false;
  if (!ONLINE_STATES.has(entry.lastKnownPresence)) return false;
  if (entry.timestamp && now - entry.timestamp >= PRESENCE_FRESH_MS) return false;
  return true;
}

export async function getOnlineMembers(sock, groupJid) {
  try {
    if (!sock || typeof sock.groupMetadata !== 'function') return [];
    const metadata = await sock.groupMetadata(groupJid);
    const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
    if (participants.length === 0) return [];

    const candidateLists = [];
    for (const p of participants.slice(0, 40)) {
      const candidates = await collectParticipantCandidates(sock, p);
      if (candidates.length === 0) continue;
      const preferred =
        candidates.find((c) => !c.endsWith('@lid') && !c.endsWith('@hosted.lid')) ||
        candidates[0];
      candidateLists.push({ preferred, candidates });
    }

    if (typeof sock.presenceSubscribe === 'function') {
      for (const { preferred } of candidateLists) {
        try {
          await sock.presenceSubscribe(preferred);
        } catch {}
      }
    }

    const map = globalThis._spiderPresenceMap instanceof Map ? globalThis._spiderPresenceMap : null;
    const hasImmediateData =
      Boolean(sock.userPresence && Object.keys(sock.userPresence).length > 0) ||
      Boolean(map && map.size > 0);
    await new Promise((resolve) => setTimeout(resolve, hasImmediateData ? 50 : 750));

    const now = Date.now();
    const online = [];
    const seen = new Set();

    for (const { preferred, candidates } of candidateLists) {
      let foundOnline = false;
      for (const cand of candidates) {
        const fromSock = sock.userPresence?.[cand];
        const fromMap = map?.get(cand);
        if (isEntryOnline(fromSock, now) || isEntryOnline(fromMap, now)) {
          foundOnline = true;
          break;
        }
      }
      if (foundOnline && !seen.has(preferred)) {
        seen.add(preferred);
        online.push(preferred);
      }
    }

    return online;
  } catch (err) {
    console.error('Error getting online members:', err);
    return [];
  }
}