import fs from 'fs';
import os from 'os';
import path from 'path';
import { spiderFooter, spiderHeader, spiderRow } from '../../Spider/utils/tableStyle.js';
import {
  cleanJid,
  collectBotIdentities,
  extractPhoneDigits,
  resolveGroupRolesAsync,
} from './groupRoleResolver.js';
import {
  executeParticipantsAction,
  resolveSenderDisplayAndMention,
} from './groupActionHelper.js';

export const ANTIDEMOTE_ACTIONS = ['revert', 'revertkick', 'kick'];

function resolveWritableStorePath(fileName = 'antidemote.json') {
  const candidates = [
    path.join(process.cwd(), 'data', fileName),
    path.join(os.tmpdir(), 'spider-man-data', fileName),
  ];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.accessSync(path.dirname(candidate), fs.constants.W_OK);
      return candidate;
    } catch {}
  }
  return candidates[1];
}

function defaultGroupConfig() {
  return {
    enabled: false,
    action: 'revertkick',
    notify: true,
    stats: {
      detected: 0,
      reverted: 0,
      kicked: 0,
    },
  };
}

function normalizeGroupConfig(raw) {
  const base = defaultGroupConfig();
  if (!raw || typeof raw !== 'object') return base;
  return {
    enabled: Boolean(raw.enabled),
    action: ANTIDEMOTE_ACTIONS.includes(raw.action) ? raw.action : base.action,
    notify: raw.notify !== false,
    stats: {
      detected: Number(raw.stats?.detected || 0),
      reverted: Number(raw.stats?.reverted || 0),
      kicked: Number(raw.stats?.kicked || 0),
    },
  };
}

export function createAntidemoteStore({ filePath = '' } = {}) {
  let cache = null;

  function load() {
    if (cache) return cache;
    const target = filePath || resolveWritableStorePath();
    try {
      if (fs.existsSync(target)) {
        const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
        cache = parsed && typeof parsed === 'object' ? { groups: parsed.groups || {} } : { groups: {} };
        return cache;
      }
    } catch {}
    cache = { groups: {} };
    return cache;
  }

  function save() {
    const target = filePath || resolveWritableStorePath();
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(load(), null, 2));
    } catch {}
  }

  return {
    getGroupConfig(groupJid) {
      return normalizeGroupConfig(load().groups[groupJid]);
    },
    setGroupConfig(groupJid, patch = {}) {
      const data = load();
      const merged = normalizeGroupConfig({ ...normalizeGroupConfig(data.groups[groupJid]), ...patch });
      data.groups[groupJid] = merged;
      save();
      return merged;
    },
    recordAction(groupJid, statsPatch = {}) {
      const data = load();
      const cur = normalizeGroupConfig(data.groups[groupJid]);
      for (const k of ['detected', 'reverted', 'kicked']) {
        if (typeof statsPatch[k] === 'number') cur.stats[k] += statsPatch[k];
      }
      data.groups[groupJid] = cur;
      save();
      return cur;
    },
    resetAll() {
      cache = { groups: {} };
      const target = filePath || resolveWritableStorePath();
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch {}
    },
  };
}

export const defaultAntidemoteStore = createAntidemoteStore();

function extractParticipantJid(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return cleanJid(entry);
  if (typeof entry === 'object') {
    return cleanJid(entry.id || entry.jid || entry.phoneNumber || entry.pn || '');
  }
  return '';
}

export async function handleAntiDemoteEvent({
  sock,
  update,
  fetchGroupMetadata = null,
  getPhoneFromJid = null,
  isOwnerJid = null,
  store = defaultAntidemoteStore,
  botName = 'Spider Man',
} = {}) {
  if (!sock || !update || update.action !== 'demote') return { handled: false };
  const from = String(update.id || '');
  if (!from.endsWith('@g.us')) return { handled: false };

  const groupConfig = store.getGroupConfig(from);
  if (!groupConfig.enabled) return { handled: false };

  const actor = cleanJid(update.author || update.participant || '');
  const demotedTargets = (Array.isArray(update.participants) ? update.participants : [])
    .map(extractParticipantJid)
    .filter(Boolean);
  if (demotedTargets.length === 0) return { handled: false };

  const botIdentities = collectBotIdentities(sock).map((b) => cleanJid(b).toLowerCase());
  const botPhones = new Set(botIdentities.map((b) => extractPhoneDigits(b)).filter(Boolean));
  if (actor) {
    const actorClean = actor.toLowerCase();
    const actorPhone = extractPhoneDigits(actor, getPhoneFromJid);
    if (
      botIdentities.includes(actorClean) ||
      (actorPhone && botPhones.has(actorPhone)) ||
      (typeof isOwnerJid === 'function' && (isOwnerJid(actor) || (actorPhone && isOwnerJid(`${actorPhone}@s.whatsapp.net`))))
    ) {
      return { handled: false, skipped: 'privileged-actor' };
    }
  }

  let metadata = null;
  if (typeof fetchGroupMetadata === 'function') {
    try {
      metadata = await fetchGroupMetadata(from);
    } catch {}
  } else if (typeof sock.groupMetadata === 'function') {
    try {
      metadata = await sock.groupMetadata(from);
    } catch {}
  }

  const botCandidates = collectBotIdentities(sock);
  const { senderRole, botRole } = await resolveGroupRolesAsync({
    metadata,
    sock,
    senderJids: actor ? [actor] : [],
    getPhoneFn: getPhoneFromJid,
  });

  if (metadata && botCandidates.length > 0 && !botRole.isAdmin) {
    return { handled: false, skipped: 'bot-not-admin' };
  }

  const action = groupConfig.action || 'revertkick';
  let revertedCount = 0;
  let kickedActor = false;

  if (action === 'revert' || action === 'revertkick') {
    for (const victim of demotedTargets) {
      const promoteRes = await executeParticipantsAction({
        sock,
        from,
        participants: [victim],
        action: 'promote',
        metadata,
      });
      if (promoteRes.ok) revertedCount += 1;
    }
  }

  if ((action === 'kick' || action === 'revertkick') && actor) {
    const isSelfDemote = demotedTargets.some((t) => cleanJid(t).toLowerCase() === actor.toLowerCase());
    if (!isSelfDemote) {
      const actorTargets = [actor, senderRole?.targetJid].filter(Boolean);
      const kickRes = await executeParticipantsAction({
        sock,
        from,
        participants: actorTargets,
        action: 'remove',
        metadata,
      });
      kickedActor = kickRes.ok;
    }
  }

  store.recordAction(from, {
    detected: 1,
    reverted: revertedCount > 0 ? 1 : 0,
    kicked: kickedActor ? 1 : 0,
  });

  if (groupConfig.notify !== false) {
    const actorDisplay = actor
      ? resolveSenderDisplayAndMention({
          senderRole,
          senderJid: actor,
          senderCandidates: [actor, senderRole?.targetJid].filter(Boolean),
          metadata,
          getPhoneFn: getPhoneFromJid,
        })
      : { targetUser: 'Unknown', mentionJid: '' };

    const victimMentions = demotedTargets.map((v) => {
      const d = extractPhoneDigits(v, getPhoneFromJid) || v.split('@')[0];
      return `@${d}`;
    });

    const alertText = [
      spiderHeader(botName, 'ANTI-DEMOTE SHIELD'),
      ...(actor ? [spiderRow('ACTOR', `@${actorDisplay.targetUser}`, '👤')] : []),
      spiderRow('PROTECTED ADMIN', victimMentions.join(', '), '🛡️'),
      spiderRow(
        'ENFORCEMENT',
        [
          revertedCount > 0 ? 'Admin Role Restored' : null,
          kickedActor ? 'Demoter Removed' : null,
        ].filter(Boolean).join(' · ') || 'Alert Logged',
        '⚡',
      ),
      spiderFooter('ANTIDEMOTE // SPIDER-MAN'),
    ].join('\n');

    const mentions = Array.from(
      new Set([actorDisplay.mentionJid, ...demotedTargets].filter(Boolean)),
    );
    await sock.sendMessage(from, { text: alertText, mentions });
  }

  return { handled: true, revertedCount, kickedActor, actor, demotedTargets };
}
