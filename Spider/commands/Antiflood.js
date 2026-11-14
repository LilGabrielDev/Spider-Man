import config from '../../spider/config.js';
import {
  ANTIFLOOD_ACTIONS,
  ANTIFLOOD_MAX_LIMIT,
  ANTIFLOOD_MAX_WINDOW_SEC,
  ANTIFLOOD_MIN_LIMIT,
  ANTIFLOOD_MIN_WINDOW_SEC,
  defaultAntifloodStore,
  defaultFloodTracker,
} from '../../spider/utils/antiflood.js';
import { cleanJid, extractPhone } from '../../spider/utils/antiscam.js';
import { spiderDivider, spiderFooter, spiderHeader, spiderRow } from '../utils/tableStyle.js';

function normalizeAction(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'del') return 'delete';
  if (value === 'remove' || value === 'ban') return 'kick';
  if (value === 'warn-kick' || value === 'warn_kick' || value === 'wk') return 'warnkick';
  if (value === 'lock' || value === 'close') return 'mute';
  return ANTIFLOOD_ACTIONS.includes(value) ? value : null;
}

function actionLabel(action) {
  switch (action) {
    case 'kick':
      return 'DELETE & KICK';
    case 'warn':
      return 'DELETE & WARN';
    case 'warnkick':
      return 'DELETE · WARN TO KICK';
    case 'mute':
      return 'DELETE & MUTE GROUP';
    case 'delete':
    default:
      return 'DELETE MESSAGE';
  }
}

function getQuotedOrMentionedTarget(msg) {
  const ext = msg?.message?.extendedTextMessage?.contextInfo;
  const quotedParticipant = ext?.participant;
  const mentioned = ext?.mentionedJid?.[0];
  return quotedParticipant || mentioned || null;
}

function formatStatusCard(botName, prefix, groupConfig) {
  const p = prefix || '.';
  return [
    spiderHeader(botName, 'ANTIFLOOD SHIELD'),
    spiderRow('STATUS', groupConfig.enabled ? 'ON ✅' : 'OFF ❌', '⛨'),
    spiderRow('ACTION', actionLabel(groupConfig.action), '⚡'),
    spiderRow('THRESHOLD', `${groupConfig.limit} msgs / ${groupConfig.windowSec}s`, '◷'),
    spiderRow('WARN LIMIT', `${groupConfig.maxWarns} warn(s)`, '▣'),
    spiderRow('ALERTS', groupConfig.notify ? 'ON' : 'OFF', '◈'),
    spiderRow('WHITELIST', String(groupConfig.whitelist.length), '✦'),
    spiderRow(
      'BLOCKED STATS',
      `${groupConfig.stats.detected} caught · ${groupConfig.stats.deleted} del · ${groupConfig.stats.kicked} kicked`,
      '▤',
    ),
    spiderDivider('CONTROLS'),
    `> ┃ ▸ *${p}antiflood on [delete|warn|kick|warnkick|mute]*`,
    `> ┃ ▸ *${p}antiflood off* — Disable protection`,
    `> ┃ ▸ *${p}antiflood limit <${ANTIFLOOD_MIN_LIMIT}-${ANTIFLOOD_MAX_LIMIT}>* — Max msgs per window`,
    `> ┃ ▸ *${p}antiflood window <${ANTIFLOOD_MIN_WINDOW_SEC}-${ANTIFLOOD_MAX_WINDOW_SEC}>* — Window in seconds`,
    `> ┃ ▸ *${p}antiflood set <limit> <seconds>* — Set rate threshold`,
    `> ┃ ▸ *${p}antiflood delete|warn|kick|warnkick|mute*`,
    `> ┃ ▸ *${p}antiflood warnlimit <1-10>* — Set warn kick limit`,
    `> ┃ ▸ *${p}antiflood notify on|off* — Toggle group alerts`,
    `> ┃ ▸ *${p}antiflood whitelist add|remove|list <@user|number>*`,
    `> ┃ ▸ *${p}antiflood resetwarns [@user]*`,
    spiderFooter('GROUP ANTIFLOOD // SPIDER-MAN'),
  ].join('\n');
}

export const commands = [
  {
    name: 'antiflood',
    aliases: ['noflood', 'floodguard', 'floodprotect'],
    description: 'Protect the group from message flooding and spam bursts (delete, warn, kick, warnkick, mute).',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({
      sock,
      from,
      msg,
      text,
      args = [],
      config: ctxConfig,
      isGroupAdmin,
      isBotGroupAdmin,
      isOwner,
    }) => {
      if (!from || !String(from).endsWith('@g.us')) {
        return sock.sendMessage(
          from,
          { text: 'This command can only be used in a group.' },
          { quoted: msg },
        );
      }

      if (isGroupAdmin === false && !isOwner) {
        return sock.sendMessage(
          from,
          { text: 'Only a group admin can run this command.' },
          { quoted: msg },
        );
      }

      if (isBotGroupAdmin === false) {
        return sock.sendMessage(
          from,
          { text: 'The bot needs group admin permission to run this command.' },
          { quoted: msg },
        );
      }

      const activeConfig = ctxConfig || config;
      const botName = activeConfig?.BOT_NAME || 'Spider Man';
      const prefix = activeConfig?.PREFIXES?.[0] || '.';
      const rawText = String(text || '').trim();
      const tokens =
        Array.isArray(args) && args.length > 0
          ? args.map((item) => String(item || ''))
          : rawText
            ? rawText.split(/\s+/)
            : [];

      const sub = String(tokens[0] || '').toLowerCase();
      const current = defaultAntifloodStore.getGroupConfig(from);

      if (!sub || sub === 'status' || sub === 'info') {
        return sock.sendMessage(
          from,
          { text: formatStatusCard(botName, prefix, current) },
          { quoted: msg },
        );
      }

      if (sub === 'on' || sub === 'enable') {
        const requestedAction = normalizeAction(tokens[1]);
        if (tokens[1] && !requestedAction) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Invalid action "${tokens[1]}". Valid actions: *delete*, *warn*, *kick*, *warnkick*, *mute*.`,
            },
            { quoted: msg },
          );
        }
        const nextAction = requestedAction || current.action || 'delete';
        const updated = defaultAntifloodStore.setGroupConfig(from, {
          ...current,
          enabled: true,
          action: nextAction,
        });
        defaultFloodTracker.resetGroup(from);
        const textOut = [
          spiderHeader(botName, 'ANTIFLOOD ENABLED'),
          spiderRow('STATUS', 'ON ✅', '⛨'),
          spiderRow('ACTION', actionLabel(updated.action), '⚡'),
          spiderRow('THRESHOLD', `${updated.limit} msgs / ${updated.windowSec}s`, '◷'),
          spiderRow('WARN LIMIT', `${updated.maxWarns} warn(s)`, '▣'),
          spiderFooter('FLOODERS WILL BE BLOCKED'),
        ].join('\n');
        return sock.sendMessage(from, { text: textOut }, { quoted: msg });
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntifloodStore.setGroupConfig(from, {
          ...current,
          enabled: false,
        });
        defaultFloodTracker.resetGroup(from);
        const textOut = [
          spiderHeader(botName, 'ANTIFLOOD DISABLED'),
          spiderRow('STATUS', 'OFF ❌', '⛨'),
          spiderFooter(`USE ${prefix}antiflood on TO RE-ENABLE`),
        ].join('\n');
        return sock.sendMessage(from, { text: textOut }, { quoted: msg });
      }

      const directAction = normalizeAction(sub);
      if (directAction || sub === 'action' || sub === 'mode') {
        const chosenAction = directAction || normalizeAction(tokens[1]);
        if (!chosenAction) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Usage: *${prefix}antiflood action <delete|warn|kick|warnkick|mute>*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntifloodStore.setGroupConfig(from, {
          ...current,
          enabled: directAction ? true : current.enabled,
          action: chosenAction,
        });
        const textOut = [
          spiderHeader(botName, 'ANTIFLOOD MODE UPDATED'),
          spiderRow('STATUS', updated.enabled ? 'ON ✅' : 'OFF ❌', '⛨'),
          spiderRow('ACTION', actionLabel(updated.action), '⚡'),
          spiderRow('THRESHOLD', `${updated.limit} msgs / ${updated.windowSec}s`, '◷'),
          spiderRow('WARN LIMIT', `${updated.maxWarns} warn(s)`, '▣'),
          spiderFooter('PROTECTION POLICY SAVED'),
        ].join('\n');
        return sock.sendMessage(from, { text: textOut }, { quoted: msg });
      }

      if (sub === 'limit' || sub === 'max' || sub === 'count' || sub === 'msgs') {
        const limitNum = Number.parseInt(String(tokens[1] || ''), 10);
        if (
          !Number.isInteger(limitNum) ||
          limitNum < ANTIFLOOD_MIN_LIMIT ||
          limitNum > ANTIFLOOD_MAX_LIMIT
        ) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Please specify a message limit between ${ANTIFLOOD_MIN_LIMIT} and ${ANTIFLOOD_MAX_LIMIT}. Example: *${prefix}antiflood limit 5*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntifloodStore.setGroupConfig(from, {
          ...current,
          limit: limitNum,
        });
        defaultFloodTracker.resetGroup(from);
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Flood threshold set to *${updated.limit} messages* per *${updated.windowSec}s*.`,
          },
          { quoted: msg },
        );
      }

      if (sub === 'window' || sub === 'time' || sub === 'sec' || sub === 'seconds') {
        const windowNum = Number.parseInt(String(tokens[1] || ''), 10);
        if (
          !Number.isInteger(windowNum) ||
          windowNum < ANTIFLOOD_MIN_WINDOW_SEC ||
          windowNum > ANTIFLOOD_MAX_WINDOW_SEC
        ) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Please specify a time window between ${ANTIFLOOD_MIN_WINDOW_SEC} and ${ANTIFLOOD_MAX_WINDOW_SEC} seconds. Example: *${prefix}antiflood window 10*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntifloodStore.setGroupConfig(from, {
          ...current,
          windowSec: windowNum,
        });
        defaultFloodTracker.resetGroup(from);
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Flood window set to *${updated.windowSec} seconds* (limit: *${updated.limit} messages*).`,
          },
          { quoted: msg },
        );
      }

      if (sub === 'set' || sub === 'rate') {
        const limitNum = Number.parseInt(String(tokens[1] || ''), 10);
        const windowNum = Number.parseInt(String(tokens[2] || ''), 10);
        if (
          !Number.isInteger(limitNum) ||
          limitNum < ANTIFLOOD_MIN_LIMIT ||
          limitNum > ANTIFLOOD_MAX_LIMIT ||
          !Number.isInteger(windowNum) ||
          windowNum < ANTIFLOOD_MIN_WINDOW_SEC ||
          windowNum > ANTIFLOOD_MAX_WINDOW_SEC
        ) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Usage: *${prefix}antiflood set <limit ${ANTIFLOOD_MIN_LIMIT}-${ANTIFLOOD_MAX_LIMIT}> <seconds ${ANTIFLOOD_MIN_WINDOW_SEC}-${ANTIFLOOD_MAX_WINDOW_SEC}>*\nExample: *${prefix}antiflood set 6 10*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntifloodStore.setGroupConfig(from, {
          ...current,
          limit: limitNum,
          windowSec: windowNum,
        });
        defaultFloodTracker.resetGroup(from);
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Flood rate set to *${updated.limit} messages / ${updated.windowSec} seconds*.`,
          },
          { quoted: msg },
        );
      }

      if (sub === 'warnlimit' || sub === 'maxwarns') {
        const limitNum = Number.parseInt(String(tokens[1] || ''), 10);
        if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 10) {
          return sock.sendMessage(
            from,
            { text: `❌ Please specify a warn limit between 1 and 10. Example: *${prefix}antiflood warnlimit 3*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntifloodStore.setGroupConfig(from, {
          ...current,
          maxWarns: limitNum,
        });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Flood warn limit set to *${updated.maxWarns}* warning(s) before kick.` },
          { quoted: msg },
        );
      }

      if (sub === 'notify' || sub === 'alert' || sub === 'alerts') {
        const toggle = String(tokens[1] || '').toLowerCase();
        if (toggle !== 'on' && toggle !== 'off') {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antiflood notify on* or *${prefix}antiflood notify off*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntifloodStore.setGroupConfig(from, {
          ...current,
          notify: toggle === 'on',
        });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Flood group alerts turned *${updated.notify ? 'ON' : 'OFF'}*.` },
          { quoted: msg },
        );
      }

      if (sub === 'resetwarns' || sub === 'clearwarns' || sub === 'unwarn') {
        const targetJid = getQuotedOrMentionedTarget(msg);
        if (targetJid) {
          defaultAntifloodStore.resetWarns(from, targetJid);
          const num = extractPhone(targetJid) || cleanJid(targetJid).split('@')[0];
          return sock.sendMessage(
            from,
            {
              text: `✅ Cleared Anti-Flood warnings for @${num}.`,
              mentions: [cleanJid(targetJid)],
            },
            { quoted: msg },
          );
        }
        defaultAntifloodStore.resetWarns(from, null);
        return sock.sendMessage(
          from,
          { text: '✅ Cleared all Anti-Flood warnings for this group.' },
          { quoted: msg },
        );
      }

      if (sub === 'whitelist' || sub === 'allow' || sub === 'exempt') {
        const op = String(tokens[1] || 'list').toLowerCase();
        const target = tokens.slice(2).join(' ').trim() || getQuotedOrMentionedTarget(msg) || '';

        if (op === 'list') {
          if (!current.whitelist.length) {
            return sock.sendMessage(
              from,
              { text: `ℹ️ Anti-Flood whitelist is empty. Use *${prefix}antiflood whitelist add <@user|number>*.` },
              { quoted: msg },
            );
          }
          const listText = [
            spiderHeader(botName, 'ANTIFLOOD WHITELIST'),
            ...current.whitelist.map((item, idx) => spiderRow(String(idx + 1).padStart(2, '0'), item, '✦')),
            spiderFooter('TOTAL // ' + current.whitelist.length),
          ].join('\n');
          return sock.sendMessage(from, { text: listText }, { quoted: msg });
        }

        if (op === 'add') {
          if (!target) {
            return sock.sendMessage(
              from,
              { text: `❌ Usage: *${prefix}antiflood whitelist add <@user|number>*` },
              { quoted: msg },
            );
          }
          const { added, entry } = defaultAntifloodStore.addWhitelist(from, target);
          return sock.sendMessage(
            from,
            {
              text: added
                ? `✅ Added *${entry}* to the Anti-Flood whitelist.`
                : `ℹ️ *${entry || target}* is already whitelisted.`,
            },
            { quoted: msg },
          );
        }

        if (op === 'remove' || op === 'del' || op === 'rm') {
          if (!target) {
            return sock.sendMessage(
              from,
              { text: `❌ Usage: *${prefix}antiflood whitelist remove <@user|number>*` },
              { quoted: msg },
            );
          }
          const { removed, entry } = defaultAntifloodStore.removeWhitelist(from, target);
          return sock.sendMessage(
            from,
            {
              text: removed
                ? `✅ Removed *${entry}* from the Anti-Flood whitelist.`
                : `❌ *${entry || target}* was not found in the whitelist.`,
            },
            { quoted: msg },
          );
        }

        return sock.sendMessage(
          from,
          { text: `❌ Usage: *${prefix}antiflood whitelist add|remove|list <@user|number>*` },
          { quoted: msg },
        );
      }

      return sock.sendMessage(
        from,
        {
          text: [
            `❌ Unknown option *"${sub}"*.`,
            `Use *${prefix}antiflood* to view status and available options.`,
          ].join('\n'),
        },
        { quoted: msg },
      );
    },
  },
];
