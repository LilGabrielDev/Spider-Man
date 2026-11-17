import config from '../../spider/config.js';
import {
  ANTIDUPLICATE_ACTIONS,
  ANTIDUPLICATE_MAX_WINDOW_SEC,
  ANTIDUPLICATE_MIN_WINDOW_SEC,
  ANTIDUPLICATE_SCOPES,
  ANTIDUPLICATE_SENSITIVITIES,
  defaultAntiduplicateStore,
  defaultDuplicateTracker,
  normalizeScope,
  normalizeSensitivity,
} from '../../spider/utils/antiduplicate.js';
import { cleanJid, extractPhone } from '../../spider/utils/antiscam.js';
import { extractContextInfo } from '../../spider/utils/groupActionHelper.js';
import { spiderDivider, spiderFooter, spiderHeader, spiderRow } from '../utils/tableStyle.js';

function normalizeAction(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'del' || value === 'delete-only' || value === 'deleteonly') return 'delete';
  if (value === 'delete+warn' || value === 'delete-warn' || value === 'deletewarn') return 'warn';
  if (value === 'delete+kick' || value === 'delete-kick' || value === 'deletekick' || value === 'remove' || value === 'ban') return 'kick';
  if (value === 'warn-kick' || value === 'warn_kick' || value === 'wk') return 'warnkick';
  if (value === 'lock' || value === 'close') return 'mute';
  return ANTIDUPLICATE_ACTIONS.includes(value) ? value : null;
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
      return 'DELETE DUPLICATE';
  }
}

function sensitivityLabel(level) {
  switch (level) {
    case 'strict':
      return 'STRICT (ULTRA SENSITIVE 🔥)';
    case 'normal':
      return 'NORMAL (EXACT / NEAR-EXACT)';
    case 'sensitive':
    default:
      return 'SENSITIVE (HIGH 🛡️)';
  }
}

function scopeLabel(scope) {
  return scope === 'group' ? 'WHOLE GROUP (ANY SENDER)' : 'PER USER (SAME SENDER)';
}

function formatWindowLabel(seconds) {
  const sec = Number(seconds) || 86400;
  if (sec % 3600 === 0) {
    return `${sec / 3600}h (${sec}s)`;
  }
  if (sec % 60 === 0 && sec >= 60) {
    return `${sec / 60}m (${sec}s)`;
  }
  return `${sec}s`;
}

function parseWindowSeconds(raw) {
  const str = String(raw || '').trim().toLowerCase();
  if (!str) return null;
  const match = str.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/i);
  if (!match) return null;
  const num = Number.parseInt(match[1], 10);
  if (!Number.isInteger(num)) return null;
  const unit = (match[2] || 's').toLowerCase();
  if (unit.startsWith('d')) return num * 86400;
  if (unit.startsWith('h')) return num * 3600;
  if (unit.startsWith('m')) return num * 60;
  return num;
}

function getQuotedOrMentionedTarget(msg) {
  const { contextInfo } = extractContextInfo(msg);
  const quotedParticipant = contextInfo?.participant;
  const mentioned = contextInfo?.mentionedJid?.[0];
  return quotedParticipant || mentioned || null;
}

function formatStatusCard(botName, prefix, groupConfig) {
  const p = prefix || '.';
  return [
    spiderHeader(botName, 'ANTIDUPLICATE SHIELD'),
    spiderRow('STATUS', groupConfig.enabled ? 'ON ✅' : 'OFF ❌', '⛨'),
    spiderRow('ACTION', actionLabel(groupConfig.action), '⚡'),
    spiderRow('SENSITIVITY', sensitivityLabel(groupConfig.sensitivity), '☢'),
    spiderRow('SCOPE', scopeLabel(groupConfig.scope), '◎'),
    spiderRow('WINDOW', formatWindowLabel(groupConfig.windowSec), '◷'),
    spiderRow('MEDIA CHECK', groupConfig.includeMedia ? 'ON (Stickers/Media/Files)' : 'TEXT ONLY', '❖'),
    spiderRow('WARN LIMIT', `${groupConfig.maxWarns} warn(s)`, '▣'),
    spiderRow('ALERTS', groupConfig.notify ? 'ON' : 'OFF', '◈'),
    spiderRow('WHITELIST', String(groupConfig.whitelist.length), '✦'),
    spiderRow(
      'BLOCKED STATS',
      `${groupConfig.stats.detected} caught · ${groupConfig.stats.deleted} del · ${groupConfig.stats.kicked} kicked`,
      '▤',
    ),
    spiderDivider('CONTROLS'),
    `> ┃ ▸ *${p}antiduplicate on [delete|warn|kick|warnkick|mute]*`,
    `> ┃ ▸ *${p}antiduplicate off* — Disable protection`,
    `> ┃ ▸ *${p}antiduplicate sensitivity <sensitive|strict|normal>*`,
    `> ┃ ▸ *${p}antiduplicate scope <user|group>* — Same user vs whole group`,
    `> ┃ ▸ *${p}antiduplicate window <10s-24h>* — Window up to 24h (86400s)`,
    `> ┃ ▸ *${p}antiduplicate media on|off* — Toggle duplicate media/stickers`,
    `> ┃ ▸ *${p}antiduplicate delete|warn|kick|warnkick|mute*`,
    `> ┃ ▸ *${p}antiduplicate warnlimit <1-10>* — Set warn kick limit`,
    `> ┃ ▸ *${p}antiduplicate notify on|off* — Toggle group alerts`,
    `> ┃ ▸ *${p}antiduplicate whitelist add|remove|list <@user|number>*`,
    `> ┃ ▸ *${p}antiduplicate resetwarns [@user]* | *clear*`,
    spiderFooter('24H ANTI-DUPLICATE // SPIDER-MAN'),
  ].join('\n');
}

export const commands = [
  {
    name: 'antiduplicate',
    aliases: ['antidup', 'nodup', 'noduplicate', 'dupguard'],
    description:
      'Prevent users from sending duplicate or near-duplicate messages sent within 24 hours (including obfuscated text, emojis, stickers, and media) in the same group.',
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
      const current = defaultAntiduplicateStore.getGroupConfig(from);

      if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
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
        const updated = defaultAntiduplicateStore.setGroupConfig(from, {
          ...current,
          enabled: true,
          action: nextAction,
        });
        defaultDuplicateTracker.resetGroup(from);
        const textOut = [
          spiderHeader(botName, 'ANTIDUPLICATE ENABLED'),
          spiderRow('STATUS', 'ON ✅', '⛨'),
          spiderRow('ACTION', actionLabel(updated.action), '⚡'),
          spiderRow('SENSITIVITY', sensitivityLabel(updated.sensitivity), '☢'),
          spiderRow('SCOPE', scopeLabel(updated.scope), '◎'),
          spiderRow('WINDOW', formatWindowLabel(updated.windowSec), '◷'),
          spiderFooter('DUPLICATES BLOCKED WITHIN 24H'),
        ].join('\n');
        return sock.sendMessage(from, { text: textOut }, { quoted: msg });
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntiduplicateStore.setGroupConfig(from, {
          ...current,
          enabled: false,
        });
        defaultDuplicateTracker.resetGroup(from);
        const textOut = [
          spiderHeader(botName, 'ANTIDUPLICATE DISABLED'),
          spiderRow('STATUS', 'OFF ❌', '⛨'),
          spiderFooter(`USE ${prefix}antiduplicate on TO RE-ENABLE`),
        ].join('\n');
        return sock.sendMessage(from, { text: textOut }, { quoted: msg });
      }

      const directSensitivity = normalizeSensitivity(sub);
      if (sub === 'sensitivity' || sub === 'level' || sub === 'sens' || directSensitivity) {
        const chosen = directSensitivity || normalizeSensitivity(tokens[1]);
        if (!chosen) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Usage: *${prefix}antiduplicate sensitivity <${ANTIDUPLICATE_SENSITIVITIES.join('|')}>*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntiduplicateStore.setGroupConfig(from, {
          ...current,
          enabled: directSensitivity ? true : current.enabled,
          sensitivity: chosen,
        });
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Duplicate sensitivity set to *${sensitivityLabel(updated.sensitivity)}*.`,
          },
          { quoted: msg },
        );
      }

      if (sub === 'scope' || sub === 'target') {
        const chosen = normalizeScope(tokens[1]);
        if (!chosen) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Usage: *${prefix}antiduplicate scope <${ANTIDUPLICATE_SCOPES.join('|')}>*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntiduplicateStore.setGroupConfig(from, {
          ...current,
          scope: chosen,
        });
        defaultDuplicateTracker.resetGroup(from);
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Duplicate scope set to *${scopeLabel(updated.scope)}*.`,
          },
          { quoted: msg },
        );
      }

      if (sub === 'window' || sub === 'time' || sub === 'sec' || sub === 'seconds') {
        const windowNum = parseWindowSeconds(tokens[1]);
        if (
          !Number.isInteger(windowNum) ||
          windowNum < ANTIDUPLICATE_MIN_WINDOW_SEC ||
          windowNum > ANTIDUPLICATE_MAX_WINDOW_SEC
        ) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Please specify a time window between ${ANTIDUPLICATE_MIN_WINDOW_SEC} and ${ANTIDUPLICATE_MAX_WINDOW_SEC} seconds (max 24h). Example: *${prefix}antiduplicate window 24h* or *${prefix}antiduplicate window 86400*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntiduplicateStore.setGroupConfig(from, {
          ...current,
          windowSec: windowNum,
        });
        defaultDuplicateTracker.resetGroup(from);
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Duplicate window set to *${formatWindowLabel(updated.windowSec)}*.`,
          },
          { quoted: msg },
        );
      }

      if (sub === 'media' || sub === 'stickers' || sub === 'attachments') {
        const toggle = String(tokens[1] || '').toLowerCase();
        if (toggle !== 'on' && toggle !== 'off') {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antiduplicate media on* or *${prefix}antiduplicate media off*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntiduplicateStore.setGroupConfig(from, {
          ...current,
          includeMedia: toggle === 'on',
        });
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Duplicate media/sticker detection turned *${updated.includeMedia ? 'ON' : 'OFF'}*.`,
          },
          { quoted: msg },
        );
      }

      const directAction = normalizeAction(sub);
      if (directAction || sub === 'action' || sub === 'mode' || sub === 'set') {
        const chosenAction = directAction || normalizeAction(tokens[1]);
        if (!chosenAction) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Usage: *${prefix}antiduplicate action <delete|warn|kick|warnkick|mute>*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntiduplicateStore.setGroupConfig(from, {
          ...current,
          enabled: directAction ? true : current.enabled,
          action: chosenAction,
        });
        const textOut = [
          spiderHeader(botName, 'ANTIDUPLICATE MODE UPDATED'),
          spiderRow('STATUS', updated.enabled ? 'ON ✅' : 'OFF ❌', '⛨'),
          spiderRow('ACTION', actionLabel(updated.action), '⚡'),
          spiderRow('SENSITIVITY', sensitivityLabel(updated.sensitivity), '☢'),
          spiderRow('SCOPE', scopeLabel(updated.scope), '◎'),
          spiderRow('WARN LIMIT', `${updated.maxWarns} warn(s)`, '▣'),
          spiderFooter('PROTECTION POLICY SAVED'),
        ].join('\n');
        return sock.sendMessage(from, { text: textOut }, { quoted: msg });
      }

      if (sub === 'warnlimit' || sub === 'maxwarns') {
        const limitNum = Number.parseInt(String(tokens[1] || ''), 10);
        if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 10) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Please specify a warn limit between 1 and 10. Example: *${prefix}antiduplicate warnlimit 3*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntiduplicateStore.setGroupConfig(from, {
          ...current,
          maxWarns: limitNum,
        });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Duplicate warn limit set to *${updated.maxWarns}* warning(s) before kick.` },
          { quoted: msg },
        );
      }

      if (sub === 'notify' || sub === 'alert' || sub === 'alerts') {
        const toggle = String(tokens[1] || '').toLowerCase();
        if (toggle !== 'on' && toggle !== 'off') {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antiduplicate notify on* or *${prefix}antiduplicate notify off*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntiduplicateStore.setGroupConfig(from, {
          ...current,
          notify: toggle === 'on',
        });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Duplicate group alerts turned *${updated.notify ? 'ON' : 'OFF'}*.` },
          { quoted: msg },
        );
      }

      if (sub === 'clear' || sub === 'reset' || sub === 'flush') {
        defaultDuplicateTracker.resetGroup(from);
        return sock.sendMessage(
          from,
          { text: '✅ Cleared tracked duplicate message history for this group.' },
          { quoted: msg },
        );
      }

      if (sub === 'resetwarns' || sub === 'clearwarns' || sub === 'unwarn') {
        const targetJid = getQuotedOrMentionedTarget(msg);
        if (targetJid) {
          defaultAntiduplicateStore.resetWarns(from, targetJid);
          const num = extractPhone(targetJid) || cleanJid(targetJid).split('@')[0];
          return sock.sendMessage(
            from,
            {
              text: `✅ Cleared Anti-Duplicate warnings for @${num}.`,
              mentions: [cleanJid(targetJid)],
            },
            { quoted: msg },
          );
        }
        defaultAntiduplicateStore.resetWarns(from, null);
        return sock.sendMessage(
          from,
          { text: '✅ Cleared all Anti-Duplicate warnings for this group.' },
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
              {
                text: `ℹ️ Anti-Duplicate whitelist is empty. Use *${prefix}antiduplicate whitelist add <@user|number>*.`,
              },
              { quoted: msg },
            );
          }
          const listText = [
            spiderHeader(botName, 'ANTIDUPLICATE WHITELIST'),
            ...current.whitelist.map((item, idx) => spiderRow(String(idx + 1).padStart(2, '0'), item, '✦')),
            spiderFooter(`TOTAL // ${current.whitelist.length}`),
          ].join('\n');
          return sock.sendMessage(from, { text: listText }, { quoted: msg });
        }

        if (op === 'add') {
          if (!target) {
            return sock.sendMessage(
              from,
              { text: `❌ Usage: *${prefix}antiduplicate whitelist add <@user|number>*` },
              { quoted: msg },
            );
          }
          const { added, entry } = defaultAntiduplicateStore.addWhitelist(from, target);
          return sock.sendMessage(
            from,
            {
              text: added
                ? `✅ Added *${entry}* to the Anti-Duplicate whitelist.`
                : `ℹ️ *${entry || target}* is already whitelisted.`,
            },
            { quoted: msg },
          );
        }

        if (op === 'remove' || op === 'del' || op === 'rm') {
          if (!target) {
            return sock.sendMessage(
              from,
              { text: `❌ Usage: *${prefix}antiduplicate whitelist remove <@user|number>*` },
              { quoted: msg },
            );
          }
          const { removed, entry } = defaultAntiduplicateStore.removeWhitelist(from, target);
          return sock.sendMessage(
            from,
            {
              text: removed
                ? `✅ Removed *${entry}* from the Anti-Duplicate whitelist.`
                : `❌ *${entry || target}* was not found in the whitelist.`,
            },
            { quoted: msg },
          );
        }

        return sock.sendMessage(
          from,
          { text: `❌ Usage: *${prefix}antiduplicate whitelist add|remove|list <@user|number>*` },
          { quoted: msg },
        );
      }

      return sock.sendMessage(
        from,
        {
          text: [
            `❌ Unknown option *"${sub}"*.`,
            `Use *${prefix}antiduplicate* to view status and available options.`,
          ].join('\n'),
        },
        { quoted: msg },
      );
    },
  },
];
