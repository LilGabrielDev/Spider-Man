import { getOnlineMembers } from '../france/Presence.js';
import { MESSAGES } from '../france/config.js';
import { t } from '../france/translator.js';
import { defaultAntilinkStore, ANTILINK_ACTIONS } from '../../spider/utils/antilink.js';
import {
  cleanJid,
  extractPhoneDigits,
  isParticipantAdminEntry,
} from '../../spider/utils/groupRoleResolver.js';
import {
  executeGroupSettingUpdate,
  executeParticipantsAction,
  executeRequestParticipantsAction,
  extractContextInfo,
  isFromBot,
  isSendMessageFailure,
  normalizeTargetJidInput,
  resolveTargetFromMessage,
  safeDeleteTempMessage,
  sendWithAckCheck,
} from '../../spider/utils/groupActionHelper.js';

async function fetchMetaSafe(sock, from) {
  try {
    if (typeof sock?.groupMetadata === 'function') {
      return await sock.groupMetadata(from);
    }
  } catch {}
  return null;
}

async function invalidateGroupCacheSafe(sock, from) {
  try {
    await sock?.__spiderInvalidateGroupCache?.(from);
  } catch {}
}

export const commands = [
  {
    name: 'online',
    aliases: ['listonline', 'active', 'activeusers'],
    description: 'List currently online group members.',
    category: 'Group',
    groupOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      const checkingMsg = await t(from, 'online', 'checking');
      const tempMsg = await sock.sendMessage(from, { text: checkingMsg }, { quoted: msg });
      try {
        const onlineMembers = await getOnlineMembers(sock, from);
        await safeDeleteTempMessage(sock, from, tempMsg);
        if (!onlineMembers.length) {
          const noMembersMsg = await t(from, 'online', 'noMembers');
          const poweredMsg = await t(from, 'online', 'powered');
          return sock.sendMessage(from, { text: `${noMembersMsg}\n\n${poweredMsg}` }, { quoted: msg });
        }
        const memberLines = onlineMembers
          .map((jid, idx) => `${idx + 1}. 🟢 ${jid.split('@')[0]}`)
          .join('\n');
        const onlineCount = onlineMembers.length;
        const metadata = await sock.groupMetadata(from);
        const totalMembers = metadata.participants.length;
        const pct = ((onlineCount / totalMembers) * 100).toFixed(1);
        const header = await t(from, 'online', 'header');
        const onlineLabel = await t(from, 'online', 'onlineLabel');
        const powered = await t(from, 'online', 'powered');
        await sock.sendMessage(
          from,
          {
            text: `${header}\n\n${onlineLabel} ${onlineCount}/${totalMembers} (${pct}%)\n\n${memberLines}\n\n${powered}`,
            mentions: onlineMembers,
          },
          { quoted: msg },
        );
      } catch (err) {
        await safeDeleteTempMessage(sock, from, tempMsg);
        const errMsg = await t(from, 'online', 'error');
        const powered = await t(from, 'online', 'powered');
        await sock.sendMessage(from, { text: `${errMsg} ${err.message}\n\n${powered}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'info',
    aliases: ['ginfo', 'ginf'],
    category: 'Group',
    groupOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      try {
        const metadata = await sock.groupMetadata(from);
        const groupName = metadata.subject;
        const groupId = metadata.id;
        const participants = metadata.participants || [];
        const totalMembers = participants.length;
        const admins = participants.filter((p) => isParticipantAdminEntry(p));
        const ownerJid =
          metadata.ownerPn ||
          metadata.owner ||
          admins.find((p) => String(p.admin || '').toLowerCase() === 'superadmin')?.id;
        const ownerDisplay = ownerJid
          ? extractPhoneDigits(ownerJid) || cleanJid(ownerJid).split('@')[0]
          : 'Unknown';
        const adminList = admins
          .map((p, idx) => {
            const pId = p.phoneNumber || p.pn || p.id || p.jid || '';
            const num = extractPhoneDigits(pId) || cleanJid(pId).split('@')[0];
            return `${idx + 1}. @${num}`;
          })
          .join('\n');
        const template = await t(from, 'info', 'result');
        const output = template
          .replace('{groupName}', groupName)
          .replace('{groupId}', groupId)
          .replace('{ownerNumber}', ownerDisplay)
          .replace('{totalMembers}', totalMembers)
          .replace('{adminCount}', admins.length)
          .replace('{adminList}', adminList);
        await sock.sendMessage(
          from,
          {
            text: output,
            mentions: [
              ...(ownerJid ? [ownerJid] : []),
              ...admins.map((p) => p.id || p.jid).filter(Boolean),
            ],
          },
          { quoted: msg },
        );
      } catch {
        const errMsg = await t(from, 'info', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'antilink',
    description: 'Enable/disable antilink and set action (warn/kick/delete)',
    category: 'Group',
    adminOnly: true,
    botAdminOnly: true,
    ownerOnly: true,
    groupOnly: true,
    execute: async ({ sock, from, text, args = [], msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }

      const tokens = (Array.isArray(args) && args.length > 0
        ? args.map((item) => String(item || '').trim())
        : String(text || '').trim().split(/\s+/)
      ).filter(Boolean);

      const current = defaultAntilinkStore.getGroupConfig(from);
      const sub = String(tokens[0] || '').toLowerCase();

      if (!sub || sub === 'status' || sub === 'info') {
        const usage = await t(from, 'antilink', 'usage');
        const warnCount = Object.keys(current.warns || {}).length;
        const statusText = [
          `🔗 *Antilink Status:* ${current.enabled ? '*ON*' : '*OFF*'}`,
          `⚡ *Action:* ${String(current.action || 'warn').toUpperCase()}`,
          `⚠️ *Warn Limit:* ${current.maxWarns || 3} (${warnCount} user(s) warned)`,
          '',
          usage,
          'Extra: .antilink warnlimit <1-10> | .antilink resetwarns [@user]',
        ].join('\n');
        return sock.sendMessage(from, { text: statusText }, { quoted: msg });
      }

      if (sub === 'warnlimit' || sub === 'maxwarns' || sub === 'limit') {
        const limitNum = Number.parseInt(String(tokens[1] || ''), 10);
        if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 10) {
          return sock.sendMessage(
            from,
            { text: '❌ Please specify a warn limit between 1 and 10.' },
            { quoted: msg },
          );
        }
        const updated = defaultAntilinkStore.setGroupConfig(from, {
          ...current,
          maxWarns: limitNum,
        });
        return sock.sendMessage(
          from,
          { text: `✅ Antilink warn limit set to *${updated.maxWarns}*.` },
          { quoted: msg },
        );
      }

      if (sub === 'resetwarns' || sub === 'clearwarns' || sub === 'unwarn') {
        const rest = tokens.slice(1).join(' ');
        const metadata = await fetchMetaSafe(sock, from);
        const resolved =
          rest.toLowerCase() === 'all'
            ? { targetJid: '', alternateJids: [] }
            : resolveTargetFromMessage({ sock, from, msg, text: rest, metadata });
        if (resolved.targetJid) {
          defaultAntilinkStore.resetWarns(from, resolved.targetJid, resolved.alternateJids);
          return sock.sendMessage(
            from,
            {
              text: `✅ Cleared antilink warnings for @${resolved.displayUser}.`,
              mentions: resolved.mentionJid ? [resolved.mentionJid] : [],
            },
            { quoted: msg },
          );
        }
        defaultAntilinkStore.resetWarns(from, null);
        return sock.sendMessage(
          from,
          { text: '✅ Cleared all antilink warnings for this group.' },
          { quoted: msg },
        );
      }

      if (ANTILINK_ACTIONS.includes(sub)) {
        const updated = defaultAntilinkStore.setGroupConfig(from, {
          ...current,
          enabled: true,
          action: sub,
        });
        const template = await t(from, 'antilink', 'success');
        return sock.sendMessage(
          from,
          {
            text: template
              .replace('{option}', updated.enabled ? 'ON' : 'OFF')
              .replace('{action}', updated.action.toUpperCase()),
          },
          { quoted: msg },
        );
      }

      const option = sub === 'enable' ? 'on' : sub === 'disable' ? 'off' : sub;
      const requestedAction = String(tokens[1] || current.action || 'warn').toLowerCase();
      if (!['on', 'off'].includes(option) || !ANTILINK_ACTIONS.includes(requestedAction)) {
        const usage = await t(from, 'antilink', 'usage');
        return sock.sendMessage(from, { text: usage }, { quoted: msg });
      }

      const updated = defaultAntilinkStore.setGroupConfig(from, {
        ...current,
        enabled: option === 'on',
        action: requestedAction,
      });
      const template = await t(from, 'antilink', 'success');
      return sock.sendMessage(
        from,
        {
          text: template
            .replace('{option}', updated.enabled ? 'ON' : 'OFF')
            .replace('{action}', updated.action.toUpperCase()),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'hidetag',
    aliases: ['tag'],
    description: 'Mentions all members in the group using a message or media.',
    category: 'Group',
    groupOnly: true,
    execute: async ({ sock, from, text, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      const metadata = await sock.groupMetadata(from);
      const participants = (metadata.participants || []).map((p) => p.id || p.jid).filter(Boolean);
      const { quotedMessage } = extractContextInfo(msg);
      const defaultText = await t(from, 'hidetag', 'default');
      const noMessage = await t(from, 'hidetag', 'noMessage');

      let payload;
      if (quotedMessage) {
        const quotedText =
          quotedMessage.conversation ||
          quotedMessage.extendedTextMessage?.text ||
          quotedMessage.imageMessage?.caption ||
          quotedMessage.videoMessage?.caption ||
          quotedMessage.documentMessage?.caption ||
          defaultText;
        payload = { text: quotedText, mentions: participants };
      } else {
        if (!text) {
          return sock.sendMessage(from, { text: noMessage }, { quoted: msg });
        }
        payload = { text, mentions: participants };
      }
      await sock.sendMessage(from, payload);
    },
  },
  {
    name: 'tagall',
    aliases: ['mentionall'],
    description: 'Mentions all members of the current group.',
    category: 'Group',
    groupOnly: true,
    execute: async ({ sock, from, text, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      try {
        const metadata = await sock.groupMetadata(from);
        const participants = metadata.participants || [];
        if (!participants.length) {
          const noPartMsg = await t(from, 'tagall', 'noParticipants');
          return await sock.sendMessage(from, { text: noPartMsg }, { quoted: msg });
        }
        const defText = await t(from, 'tagall', 'defaultText');
        const label = text || defText;
        const headerTemplate = await t(from, 'tagall', 'header');
        let messageText = headerTemplate.replace('{text}', label);
        const mentionIds = [];
        participants.forEach((p, idx) => {
          const jid = p.id || p.jid || '';
          const num = jid.split('@')[0];
          messageText += `${idx + 1}. @${num}\n`;
          if (jid) mentionIds.push(jid);
        });
        await sock.sendMessage(from, { text: messageText, mentions: mentionIds }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'tagall', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'rename',
    aliases: ['gname'],
    description: 'Change the group subject (name).',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    ownerOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, text, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      const newName = String(text || '').trim();
      if (!newName) {
        const noNameMsg = await t(from, 'rename', 'noName');
        return sock.sendMessage(from, { text: noNameMsg }, { quoted: msg });
      }
      try {
        const res = await sock.groupUpdateSubject(from, newName);
        if (isSendMessageFailure(res)) {
          throw new Error('rename-failed');
        }
        await invalidateGroupCacheSafe(sock, from);
        const successMsg = await t(from, 'rename', 'success');
        await sock.sendMessage(from, { text: successMsg.replace('{name}', newName) }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'rename', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'kick',
    aliases: ['remove'],
    description: 'Remove a user from the group.',
    category: 'Group',
    ownerOnly: true,
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, text, args = [], msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      const metadata = await fetchMetaSafe(sock, from);
      const target = resolveTargetFromMessage({ sock, from, msg, text, args, metadata });
      if (!target.targetJid) {
        const noTargetMsg = await t(from, 'kick', 'noTarget');
        return sock.sendMessage(from, { text: noTargetMsg }, { quoted: msg });
      }
      if (isFromBot([target.targetJid, ...target.alternateJids], sock)) {
        const errMsg = await t(from, 'kick', 'error');
        return sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
      const res = await executeParticipantsAction({
        sock,
        from,
        participants: [target.targetJid],
        action: 'remove',
        metadata,
      });
      if (!res.ok) {
        const errMsg = await t(from, 'kick', 'error');
        return sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
      await invalidateGroupCacheSafe(sock, from);
      const successMsg = await t(from, 'kick', 'success');
      await sock.sendMessage(
        from,
        {
          text: successMsg.replace('{user}', target.displayUser),
          mentions: target.mentionJid ? [target.mentionJid] : [],
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'add',
    aliases: [],
    description: 'Add a user to the group.',
    category: 'Group',
    ownerOnly: true,
    groupOnly: true,
    adminOnly: true,
    execute: async ({ sock, from, text, args = [], msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      const firstToken =
        (Array.isArray(args) && args[0] ? String(args[0]).trim() : '') ||
        String(text || '').trim().split(/\s+/)[0] ||
        '';
      if (!firstToken) {
        const noNumMsg = await t(from, 'add', 'noNumber');
        return sock.sendMessage(from, { text: noNumMsg }, { quoted: msg });
      }
      const digits = firstToken.replace(/\D/g, '');
      const targetJid = normalizeTargetJidInput(firstToken) || (digits ? `${digits}@s.whatsapp.net` : '');
      if (!targetJid) {
        const noNumMsg = await t(from, 'add', 'noNumber');
        return sock.sendMessage(from, { text: noNumMsg }, { quoted: msg });
      }
      const metadata = await fetchMetaSafe(sock, from);
      const res = await executeParticipantsAction({
        sock,
        from,
        participants: [targetJid],
        action: 'add',
        metadata,
      });
      if (!res.ok) {
        const errMsg = await t(from, 'add', 'error');
        return sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
      await invalidateGroupCacheSafe(sock, from);
      const successMsg = await t(from, 'add', 'success');
      await sock.sendMessage(
        from,
        { text: successMsg.replace('{number}', digits || targetJid.split('@')[0]) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'kickall',
    aliases: [],
    description: 'Remove all non-admin members.',
    category: 'Group',
    ownerOnly: true,
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }

      const metadata = await fetchMetaSafe(sock, from);
      if (!Array.isArray(metadata?.participants)) {
        return sock.sendMessage(
          from,
          { text: '❌ Could not fetch group members. No one was removed.' },
          { quoted: msg },
        );
      }
      const nonAdmins = (metadata?.participants || [])
        .filter((p) => {
          if (isParticipantAdminEntry(p)) return false;
          const pIds = [p.id, p.jid, p.phoneNumber, p.pn, p.lid].filter(Boolean);
          return !isFromBot(pIds, sock);
        })
        .map((p) => p.id || p.jid || p.phoneNumber || p.pn)
        .filter(Boolean);

      if (nonAdmins.length === 0) {
        return sock.sendMessage(
          from,
          { text: 'ℹ️ There are no non-admin members to remove.' },
          { quoted: msg },
        );
      }

      const warnMsg = await t(from, 'kickall', 'warning');
      await sock.sendMessage(from, { text: warnMsg }, { quoted: msg });
      await new Promise((resolve) => setTimeout(resolve, 5000));

      let removedCount = 0;
      let failedCount = 0;
      for (const participantJid of nonAdmins) {
        const res = await executeParticipantsAction({
          sock,
          from,
          participants: [participantJid],
          action: 'remove',
          metadata,
        });
        if (res.ok) removedCount += 1;
        else failedCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (removedCount > 0) {
        await invalidateGroupCacheSafe(sock, from);
      }
      await sock.sendMessage(
        from,
        {
          text: `✅ *KICK ALL COMPLETE*\nRemoved: ${removedCount}/${nonAdmins.length}\nFailed: ${failedCount}`,
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'promote',
    aliases: [],
    description: 'Promote a member to admin.',
    category: 'Group',
    ownerOnly: true,
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, text, args = [], msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      const metadata = await fetchMetaSafe(sock, from);
      const target = resolveTargetFromMessage({ sock, from, msg, text, args, metadata });
      if (!target.targetJid) {
        const noTargetMsg = await t(from, 'promote', 'noTarget');
        return sock.sendMessage(from, { text: noTargetMsg }, { quoted: msg });
      }
      if (isFromBot([target.targetJid, ...target.alternateJids], sock)) {
        const errMsg = await t(from, 'promote', 'error');
        return sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
      const res = await executeParticipantsAction({
        sock,
        from,
        participants: [target.targetJid],
        action: 'promote',
        metadata,
      });
      if (!res.ok) {
        const errMsg = await t(from, 'promote', 'error');
        return sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
      await invalidateGroupCacheSafe(sock, from);
      const successMsg = await t(from, 'promote', 'success');
      await sock.sendMessage(
        from,
        {
          text: successMsg.replace('{user}', target.displayUser),
          mentions: target.mentionJid ? [target.mentionJid] : [],
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'demote',
    aliases: [],
    description: 'Demote a group admin.',
    category: 'Group',
    ownerOnly: true,
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, text, args = [], msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      const metadata = await fetchMetaSafe(sock, from);
      const target = resolveTargetFromMessage({ sock, from, msg, text, args, metadata });
      if (!target.targetJid) {
        const noTargetMsg = await t(from, 'demote', 'noTarget');
        return sock.sendMessage(from, { text: noTargetMsg }, { quoted: msg });
      }
      if (isFromBot([target.targetJid, ...target.alternateJids], sock)) {
        const errMsg = await t(from, 'demote', 'error');
        return sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
      const res = await executeParticipantsAction({
        sock,
        from,
        participants: [target.targetJid],
        action: 'demote',
        metadata,
      });
      if (!res.ok) {
        const errMsg = await t(from, 'demote', 'error');
        return sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
      await invalidateGroupCacheSafe(sock, from);
      const successMsg = await t(from, 'demote', 'success');
      await sock.sendMessage(
        from,
        {
          text: successMsg.replace('{user}', target.displayUser),
          mentions: target.mentionJid ? [target.mentionJid] : [],
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'approve',
    aliases: ['approve-all', 'accept'],
    description: 'Approve all pending join requests.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    ownerOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      try {
        const requests = await sock.groupRequestParticipantsList(from);
        const jids = (Array.isArray(requests) ? requests : [])
          .map((item) => item?.jid || item?.id || item)
          .filter(Boolean);
        if (jids.length === 0) {
          const noReqMsg = await t(from, 'approve', 'noRequests');
          return sock.sendMessage(from, { text: noReqMsg }, { quoted: msg });
        }
        const res = await executeRequestParticipantsAction({
          sock,
          from,
          jids,
          action: 'approve',
        });
        if (!res.ok) {
          const errMsg = await t(from, 'approve', 'error');
          return sock.sendMessage(from, { text: errMsg }, { quoted: msg });
        }
        await invalidateGroupCacheSafe(sock, from);
        const successMsg = await t(from, 'approve', 'success');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'approve', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'reject',
    aliases: ['rejectall', 'rej', 'reject-all'],
    description: 'Reject all pending join requests.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      try {
        const requests = await sock.groupRequestParticipantsList(from);
        const jids = (Array.isArray(requests) ? requests : [])
          .map((item) => item?.jid || item?.id || item)
          .filter(Boolean);
        if (jids.length === 0) {
          const noReqMsg = await t(from, 'reject', 'noRequests');
          return sock.sendMessage(from, { text: noReqMsg }, { quoted: msg });
        }
        const res = await executeRequestParticipantsAction({
          sock,
          from,
          jids,
          action: 'reject',
        });
        if (!res.ok) {
          const errMsg = await t(from, 'reject', 'error');
          return sock.sendMessage(from, { text: errMsg }, { quoted: msg });
        }
        await invalidateGroupCacheSafe(sock, from);
        const successMsg = await t(from, 'reject', 'success');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'reject', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'req',
    description: 'List pending join requests.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      try {
        const requests = await sock.groupRequestParticipantsList(from);
        if (!Array.isArray(requests) || !requests.length) {
          const noReqMsg = await t(from, 'req', 'noRequests');
          return sock.sendMessage(from, { text: noReqMsg }, { quoted: msg });
        }
        const formattedList = requests
          .map((item) => `+${String(item?.jid || item?.id || item).split('@')[0]}`)
          .join('\n');
        const listMsg = await t(from, 'req', 'list');
        await sock.sendMessage(from, { text: listMsg.replace('{list}', formattedList) }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'req', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'disap1',
    description: 'Set disappearing messages to 24 hours.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      try {
        const res = await sock.groupToggleEphemeral(from, 86400);
        if (isSendMessageFailure(res)) throw new Error('ephemeral-failed');
        await invalidateGroupCacheSafe(sock, from);
        const successMsg = await t(from, 'disap', 'success24');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'disap', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'disap7',
    description: 'Set disappearing messages to 7 days.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      try {
        const res = await sock.groupToggleEphemeral(from, 7 * 24 * 3600);
        if (isSendMessageFailure(res)) throw new Error('ephemeral-failed');
        await invalidateGroupCacheSafe(sock, from);
        const successMsg = await t(from, 'disap', 'success7');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'disap', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'disap90',
    description: 'Set disappearing messages to 90 days.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      try {
        const res = await sock.groupToggleEphemeral(from, 90 * 24 * 3600);
        if (isSendMessageFailure(res)) throw new Error('ephemeral-failed');
        await invalidateGroupCacheSafe(sock, from);
        const successMsg = await t(from, 'disap', 'success90');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'disap', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'disap-off',
    description: 'Turn off disappearing messages.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      try {
        const res = await sock.groupToggleEphemeral(from, 0);
        if (isSendMessageFailure(res)) throw new Error('ephemeral-failed');
        await invalidateGroupCacheSafe(sock, from);
        const offMsg = await t(from, 'disap', 'off');
        await sock.sendMessage(from, { text: offMsg }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'disap', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'disap',
    description: 'Instructions for disappearing messages.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      const helpMsg = await t(from, 'disap', 'help');
      await sock.sendMessage(from, { text: helpMsg }, { quoted: msg });
    },
  },
  {
    name: 'desc',
    aliases: ['gdesc'],
    description: 'Change the group description.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, text, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      const newDesc = String(text || '').trim();
      if (!newDesc) {
        const noDescMsg = await t(from, 'desc', 'noDesc');
        return sock.sendMessage(from, { text: noDescMsg }, { quoted: msg });
      }
      try {
        const res = await sock.groupUpdateDescription(from, newDesc);
        if (isSendMessageFailure(res)) throw new Error('desc-failed');
        await invalidateGroupCacheSafe(sock, from);
        const successMsg = await t(from, 'desc', 'success');
        await sock.sendMessage(from, { text: successMsg.replace('{desc}', newDesc) }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'desc', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'lock',
    aliases: ['close'],
    description: 'Only admins can send messages.',
    category: 'Group',
    ownerOnly: true,
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      const res = await executeGroupSettingUpdate({ sock, from, setting: 'announcement' });
      if (!res.ok) {
        const errMsg = await t(from, 'lock', 'error');
        return sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
      await invalidateGroupCacheSafe(sock, from);
      const successMsg = await t(from, 'lock', 'success');
      await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
    },
  },
  {
    name: 'unlock',
    aliases: ['open'],
    description: 'Allow all members to send messages.',
    category: 'Group',
    groupOnly: true,
    ownerOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      const res = await executeGroupSettingUpdate({ sock, from, setting: 'not_announcement' });
      if (!res.ok) {
        const errMsg = await t(from, 'unlock', 'error');
        return sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
      await invalidateGroupCacheSafe(sock, from);
      const successMsg = await t(from, 'unlock', 'success');
      await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
    },
  },
  {
    name: 'invite',
    aliases: ['link'],
    description: 'Get the group invite link.',
    category: 'Group',
    groupOnly: true,
    ownerOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      try {
        const code = await sock.groupInviteCode(from);
        if (!code || typeof code !== 'string') throw new Error('missing-invite-code');
        const successMsg = await t(from, 'invite', 'success');
        await sock.sendMessage(from, { text: successMsg.replace('{code}', code) }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'invite', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'revoke',
    aliases: ['reset'],
    description: 'Revoke current invite link and generate new one.',
    category: 'Group',
    groupOnly: true,
    ownerOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      try {
        const code = await sock.groupRevokeInvite(from);
        if (!code || typeof code !== 'string') throw new Error('missing-invite-code');
        const successMsg = await t(from, 'revoke', 'success');
        await sock.sendMessage(from, { text: successMsg.replace('{code}', code) }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'revoke', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'broadcast',
    aliases: ['bc', 'cast'],
    description: 'Send a broadcast message to all groups.',
    category: 'General',
    execute: async ({ sock, from, text, msg }) => {
      if (!text) {
        const noMsg = await t(from, 'broadcast', 'noMessage');
        return sock.sendMessage(from, { text: noMsg }, { quoted: msg });
      }
      try {
        const groups = await sock.groupFetchAllParticipating();
        const groupIds = Object.keys(groups || {});
        const startMsg = await t(from, 'broadcast', 'start');
        await sock.sendMessage(from, { text: startMsg }, { quoted: msg });
        const template = await t(from, 'broadcast', 'message');
        let delivered = 0;
        for (const gid of groupIds) {
          const sendRes = await sendWithAckCheck({
            sock,
            from: gid,
            payload: { text: template.replace('{message}', text) },
          });
          if (sendRes.ok) delivered += 1;
        }
        if (groupIds.length > 0 && delivered === 0) {
          throw new Error('broadcast-all-failed');
        }
      } catch {
        const errMsg = await t(from, 'broadcast', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'left',
    aliases: ['leave'],
    description: 'Force the bot to leave the group.',
    category: 'Group',
    groupOnly: true,
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!from.endsWith('@g.us')) {
        const groupOnlyMsg = await t(from, 'group', 'groupOnly');
        return sock.sendMessage(from, { text: groupOnlyMsg }, { quoted: msg });
      }
      try {
        const res = await sock.groupLeave(from);
        if (isSendMessageFailure(res)) throw new Error('leave-failed');
        await invalidateGroupCacheSafe(sock, from);
      } catch {
        const errMsg = await t(from, 'leave', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'create',
    aliases: ['newgroup', 'newgc'],
    description: 'Create a new group with users.',
    category: 'General',
    execute: async ({ sock, from, text, msg }) => {
      const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) {
        const usageMsg = await t(from, 'create', 'usage');
        return sock.sendMessage(from, { text: usageMsg }, { quoted: msg });
      }
      const { contextInfo } = extractContextInfo(msg);
      const mentioned = contextInfo?.mentionedJid || [];
      const quotedParticipant = contextInfo?.participant;
      const [groupName, ...restTokens] = tokens;
      const numberJids = restTokens
        .filter((tok) => /^\d+$/.test(tok))
        .map((num) => normalizeTargetJidInput(num) || `${num}@s.whatsapp.net`)
        .filter(Boolean);
      const participants = [
        ...new Set([
          ...mentioned,
          ...(quotedParticipant ? [quotedParticipant] : []),
          ...numberJids,
        ]),
      ];
      if (!groupName || participants.length === 0) {
        const usageMsg = await t(from, 'create', 'usage');
        return sock.sendMessage(from, { text: usageMsg }, { quoted: msg });
      }
      try {
        const created = await sock.groupCreate(groupName, participants);
        if (!created?.id || isSendMessageFailure(created)) {
          throw new Error('create-failed');
        }
        const welcomeMsg = await t(from, 'create', 'welcome');
        await sock.sendMessage(created.id, { text: welcomeMsg });
      } catch {
        const errMsg = await t(from, 'create', 'error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
];

export { MESSAGES };
