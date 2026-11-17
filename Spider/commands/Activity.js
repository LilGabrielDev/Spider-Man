import CONFIG from '../../spider/config.js';
import { spiderHeader, spiderRow, spiderDivider, spiderFooter } from '../utils/tableStyle.js';
import {
  defaultGroupActivityStore,
  formatRelativeTime,
} from '../../spider/utils/groupActivityStore.js';
import { executeGroupAdminProtectedAction } from '../../spider/utils/groupAdminProtection.js';
import { collectBotIdentities, resolveGroupRolesAsync } from '../../spider/utils/groupRoleResolver.js';
import { isFromBot } from '../../spider/utils/groupActionHelper.js';

async function fetchMetaSafe(sock, from, groupMeta = null) {
  if (groupMeta && Array.isArray(groupMeta.participants)) {
    return groupMeta;
  }
  try {
    if (typeof sock?.groupMetadata === 'function') {
      return await sock.groupMetadata(from);
    }
  } catch {}
  return null;
}

function parseLimitAndDays(tokens = [], { defaultLimit = 15, defaultDays = null } = {}) {
  let limit = defaultLimit;
  let days = defaultDays;

  for (const raw of tokens) {
    const tok = String(raw || '').trim().toLowerCase();
    if (!tok) continue;
    const dayMatch = tok.match(/^(\d+)d$/);
    if (dayMatch) {
      const parsedDays = Number.parseInt(dayMatch[1], 10);
      if (Number.isInteger(parsedDays) && parsedDays > 0) {
        days = Math.min(365, parsedDays);
      }
      continue;
    }
    if (/^\d+$/.test(tok)) {
      const num = Number.parseInt(tok, 10);
      if (Number.isInteger(num) && num >= 1) {
        limit = Math.max(1, Math.min(50, num));
      }
    }
  }

  return { limit, days };
}

function parseInactiveArgs(tokens = [], { defaultDays = 7 } = {}) {
  let kick = false;
  let days = defaultDays;

  for (const raw of tokens) {
    const tok = String(raw || '').trim().toLowerCase();
    if (!tok) continue;
    if (['kick', 'prune', 'remove'].includes(tok)) {
      kick = true;
      continue;
    }
    if (['zero', 'never', 'ghost', 'ghosts'].includes(tok)) {
      days = 0;
      continue;
    }
    const dayMatch = tok.match(/^(\d+)d?$/);
    if (dayMatch) {
      const parsed = Number.parseInt(dayMatch[1], 10);
      if (Number.isInteger(parsed) && parsed >= 0) {
        days = Math.min(365, parsed);
      }
    }
  }

  return { kick, days };
}

function makeProgressBar(ratio, width = 8) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function formatSinceLabel(ts) {
  if (!ts) return 'just started';
  return new Date(ts).toISOString().slice(0, 10);
}

export const commands = [
  {
    name: 'active',
    aliases: ['activemembers', 'mostactive'],
    description: 'Show the most active members in this group by message count.',
    category: 'Group',
    groupOnly: true,
    execute: async ({ sock, from, msg, text, args = [], config, groupMeta = null }) => {
      if (!from.endsWith('@g.us')) {
        return sock.sendMessage(
          from,
          { text: '❌ This command can only be used in a group.' },
          { quoted: msg },
        );
      }

      const botName = config?.BOT_NAME || CONFIG.BOT_NAME || 'Spider Man';
      const tokens = (Array.isArray(args) && args.length > 0
        ? args
        : String(text || '').trim().split(/\s+/)
      ).filter(Boolean);
      const { limit, days } = parseLimitAndDays(tokens, { defaultLimit: 15, defaultDays: null });

      const metadata = await fetchMetaSafe(sock, from, groupMeta);
      const lidToPhoneMap = globalThis.__spiderLidToPhoneMap || null;
      const stats = defaultGroupActivityStore.getActiveRanking(from, {
        days,
        limit,
        metadata,
        lidToPhoneMap,
      });

      const groupTitle = metadata?.subject || 'Group Activity';
      if (!stats.entries.length) {
        const emptyText = [
          spiderHeader(botName, 'ACTIVE MEMBERS'),
          spiderRow('GROUP', groupTitle, '👥'),
          spiderRow(
            'STATUS',
            days
              ? `No recorded messages in the last ${days} day(s).`
              : 'No group messages recorded yet. Activity tracking is live.',
            '📊',
          ),
          spiderFooter('USAGE: .active [count] [7d]'),
        ].join('\n');
        return sock.sendMessage(from, { text: emptyText }, { quoted: msg });
      }

      const nowMs = Date.now();
      const mentions = [];
      const rows = stats.entries.map((entry, idx) => {
        if (entry.mentionJid) mentions.push(entry.mentionJid);
        const pct = stats.totalMessages > 0
          ? ((entry.count / stats.totalMessages) * 100).toFixed(1)
          : '0.0';
        const lastAgo = formatRelativeTime(entry.lastMessageAt, nowMs);
        return `> ┃ ${idx + 1}. @${entry.displayId}  ›  *${entry.count}* msgs (${pct}%) · ${lastAgo}`;
      });

      const windowLabel = days ? `LAST ${days} DAY(S)` : 'ALL RECORDED';
      const output = [
        spiderHeader(botName, 'ACTIVE MEMBERS'),
        spiderRow('GROUP', groupTitle, '👥'),
        spiderRow('WINDOW', windowLabel, '🕒'),
        spiderRow('ACTIVE USERS', `${stats.trackedMembers} (${stats.totalMessages} msgs)`, '💬'),
        spiderDivider(`TOP ${stats.entries.length}`),
        ...rows,
        spiderFooter(`TRACKING SINCE ${formatSinceLabel(stats.trackingSince)}`),
      ].join('\n');

      return sock.sendMessage(from, { text: output, mentions }, { quoted: msg });
    },
  },
  {
    name: 'leaderboard',
    aliases: ['lb', 'topmembers', 'ranklist'],
    description: 'Display the group message leaderboard (or reset with .leaderboard reset).',
    category: 'Group',
    groupOnly: true,
    execute: async ({
      sock,
      from,
      msg,
      text,
      args = [],
      config,
      groupMeta = null,
      isGroupAdmin = false,
      isOwner = false,
    }) => {
      if (!from.endsWith('@g.us')) {
        return sock.sendMessage(
          from,
          { text: '❌ This command can only be used in a group.' },
          { quoted: msg },
        );
      }

      const botName = config?.BOT_NAME || CONFIG.BOT_NAME || 'Spider Man';
      const tokens = (Array.isArray(args) && args.length > 0
        ? args
        : String(text || '').trim().split(/\s+/)
      ).filter(Boolean);
      const firstToken = String(tokens[0] || '').toLowerCase();

      if (firstToken === 'reset' || firstToken === 'clear') {
        if (!isGroupAdmin && !isOwner) {
          return sock.sendMessage(
            from,
            { text: '❌ Only a group admin can reset the group leaderboard.' },
            { quoted: msg },
          );
        }
        defaultGroupActivityStore.resetGroup(from);
        const resetText = [
          spiderHeader(botName, 'LEADERBOARD RESET'),
          spiderRow('STATUS', 'Group message counters cleared.', '🧹'),
          spiderFooter('FRESH TRACKING STARTED'),
        ].join('\n');
        return sock.sendMessage(from, { text: resetText }, { quoted: msg });
      }

      const { limit, days } = parseLimitAndDays(tokens, { defaultLimit: 10, defaultDays: null });
      const metadata = await fetchMetaSafe(sock, from, groupMeta);
      const lidToPhoneMap = globalThis.__spiderLidToPhoneMap || null;
      const stats = defaultGroupActivityStore.getActiveRanking(from, {
        days,
        limit,
        metadata,
        lidToPhoneMap,
      });

      const groupTitle = metadata?.subject || 'Group Leaderboard';
      if (!stats.entries.length) {
        const emptyText = [
          spiderHeader(botName, 'LEADERBOARD'),
          spiderRow('GROUP', groupTitle, '🏆'),
          spiderRow('STATUS', 'No messages recorded yet. Start chatting to rank up!', '📊'),
          spiderFooter('USAGE: .leaderboard [count|7d|reset]'),
        ].join('\n');
        return sock.sendMessage(from, { text: emptyText }, { quoted: msg });
      }

      const topCount = stats.entries[0]?.count || 1;
      const mentions = [];
      const lines = stats.entries.map((entry, idx) => {
        if (entry.mentionJid) mentions.push(entry.mentionJid);
        const badge = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
        const share = stats.totalMessages > 0
          ? ((entry.count / stats.totalMessages) * 100).toFixed(1)
          : '0.0';
        const bar = makeProgressBar(entry.count / topCount, 7);
        return `> ┃ ${badge} @${entry.displayId}\n> ┃    ${bar} *${entry.count}* (${share}%)`;
      });

      const output = [
        spiderHeader(botName, 'GROUP LEADERBOARD'),
        spiderRow('GROUP', groupTitle, '🏆'),
        spiderRow('TOTAL MESSAGES', String(stats.totalMessages), '💬'),
        spiderRow('CONTRIBUTORS', String(stats.trackedMembers), '👥'),
        spiderDivider(days ? `TOP ${stats.entries.length} (${days}D)` : `TOP ${stats.entries.length}`),
        ...lines,
        spiderFooter(`TRACKING SINCE ${formatSinceLabel(stats.trackingSince)}`),
      ].join('\n');

      return sock.sendMessage(from, { text: output, mentions }, { quoted: msg });
    },
  },
  {
    name: 'inactive',
    aliases: ['ghosts', 'inactives', 'lurkers'],
    description: 'Admin-only: list inactive/ghost group members, or prune them with .inactive kick.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    execute: async ({
      sock,
      from,
      msg,
      text,
      args = [],
      config,
      groupMeta = null,
      isGroupAdmin = false,
      isBotGroupAdmin = false,
      isOwner = false,
    }) => {
      if (!from.endsWith('@g.us')) {
        return sock.sendMessage(
          from,
          { text: '❌ This command can only be used in a group.' },
          { quoted: msg },
        );
      }

      const botName = config?.BOT_NAME || CONFIG.BOT_NAME || 'Spider Man';
      const tokens = (Array.isArray(args) && args.length > 0
        ? args
        : String(text || '').trim().split(/\s+/)
      ).filter(Boolean);
      const { kick, days } = parseInactiveArgs(tokens, { defaultDays: 7 });

      const metadata = await fetchMetaSafe(sock, from, groupMeta);
      if (!metadata || !Array.isArray(metadata.participants)) {
        return sock.sendMessage(
          from,
          { text: '❌ Could not fetch group participants list right now.' },
          { quoted: msg },
        );
      }

      const lidToPhoneMap = globalThis.__spiderLidToPhoneMap || null;
      const roles = await resolveGroupRolesAsync({
        metadata,
        sock,
        senderJids: [],
        lidToPhoneMap,
      });
      const resolvedAdmin = isGroupAdmin || isOwner;
      const resolvedBotAdmin = isBotGroupAdmin || roles.isBotAdmin;

      if (!resolvedAdmin) {
        return sock.sendMessage(
          from,
          { text: '❌ Only a group admin can run this command.' },
          { quoted: msg },
        );
      }

      const botJids = collectBotIdentities(sock);
      const report = defaultGroupActivityStore.getInactiveMembers(from, {
        metadata,
        days,
        botJids,
        lidToPhoneMap,
      });

      const thresholdLabel = days === 0 ? '0 MESSAGES (GHOSTS)' : `${days} DAY(S) OR 0 MSGS`;
      if (report.inactive.length === 0) {
        const cleanText = [
          spiderHeader(botName, 'INACTIVE SCAN'),
          spiderRow('GROUP', metadata.subject || 'Group', '👥'),
          spiderRow('THRESHOLD', thresholdLabel, '⏳'),
          spiderRow('ACTIVE MEMBERS', `${report.activeCount}/${report.totalGroupMembers}`, '✅'),
          spiderRow('RESULT', 'No inactive ghost members found!', '🎉'),
          spiderFooter(`TRACKING SINCE ${formatSinceLabel(report.trackingSince)}`),
        ].join('\n');
        return sock.sendMessage(from, { text: cleanText }, { quoted: msg });
      }

      if (kick) {
        if (!resolvedBotAdmin) {
          return sock.sendMessage(
            from,
            { text: '❌ The bot needs group admin permission to kick inactive members.' },
            { quoted: msg },
          );
        }

        const kickTargets = report.inactive.filter(
          (member) => !member.isAdmin && !isFromBot([member.jid], sock),
        );

        if (kickTargets.length === 0) {
          return sock.sendMessage(
            from,
            { text: 'ℹ️ All matching inactive members are group admins or exempt.' },
            { quoted: msg },
          );
        }

        const adminProtectionEnabled = config?.ADMIN_PROTECTION ?? CONFIG.ADMIN_PROTECTION;
        let removedCount = 0;
        let failedCount = 0;
        const removedMentions = [];

        for (const member of kickTargets) {
          const res = await executeGroupAdminProtectedAction({
            enabled: adminProtectionEnabled,
            sock,
            from,
            participants: [member.jid],
            action: 'remove',
            metadata,
          });
          if (res.ok) {
            removedCount += 1;
            if (member.mentionJid) removedMentions.push(member.mentionJid);
          } else {
            failedCount += 1;
          }
        }

        if (removedCount > 0) {
          try {
            await sock?.__spiderInvalidateGroupCache?.(from);
          } catch {}
        }

        const pruneSummary = [
          spiderHeader(botName, 'INACTIVE PRUNE'),
          spiderRow('GROUP', metadata.subject || 'Group', '👥'),
          spiderRow('THRESHOLD', thresholdLabel, '⏳'),
          spiderRow('REMOVED', `${removedCount}/${kickTargets.length}`, '🧹'),
          spiderRow('FAILED', String(failedCount), '⚠️'),
          spiderFooter('INACTIVE MEMBER CLEANUP COMPLETE'),
        ].join('\n');

        return sock.sendMessage(
          from,
          { text: pruneSummary, mentions: removedMentions },
          { quoted: msg },
        );
      }

      const maxDisplay = 25;
      const visible = report.inactive.slice(0, maxDisplay);
      const mentions = [];
      const rows = visible.map((member, idx) => {
        if (member.mentionJid) mentions.push(member.mentionJid);
        const roleTag = member.isAdmin ? ' [Admin]' : '';
        const statusTag = member.count === 0
          ? '0 msgs (no activity recorded)'
          : `${member.count} msgs · ${formatRelativeTime(member.lastMessageAt)}`;
        return `> ┃ ${idx + 1}. @${member.displayId}${roleTag}  ›  ${statusTag}`;
      });

      const extraCount = report.inactive.length - visible.length;
      const output = [
        spiderHeader(botName, 'INACTIVE MEMBERS'),
        spiderRow('GROUP', metadata.subject || 'Group', '👻'),
        spiderRow('THRESHOLD', thresholdLabel, '⏳'),
        spiderRow(
          'INACTIVE / TOTAL',
          `${report.inactive.length}/${report.totalGroupMembers}`,
          '📉',
        ),
        spiderDivider(`GHOST LIST${extraCount > 0 ? ` (FIRST ${maxDisplay})` : ''}`),
        ...rows,
        ...(extraCount > 0 ? [`> ┃ ...and ${extraCount} more inactive member(s).`] : []),
        spiderDivider(),
        `> ┃ Use *.inactive ${days}d kick* to remove non-admin ghosts.`,
        spiderFooter(`TRACKING SINCE ${formatSinceLabel(report.trackingSince)}`),
      ].join('\n');

      return sock.sendMessage(from, { text: output, mentions }, { quoted: msg });
    },
  },
];
