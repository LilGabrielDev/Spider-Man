import config from '../../spider/config.js';
import {
  ANTIAD_ACTIONS,
  defaultAntiadvertisementStore,
  detectAdvertisementMessage,
} from '../../spider/utils/antiadvertisement.js';
import { cleanJid, extractMessageText, extractPhone } from '../../spider/utils/antiscam.js';
import { spiderDivider, spiderFooter, spiderHeader, spiderRow } from '../utils/tableStyle.js';
import { extractContextInfo } from '../../spider/utils/groupActionHelper.js';

function normalizeAction(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'del') return 'delete';
  if (value === 'remove' || value === 'ban') return 'kick';
  if (value === 'warn-kick' || value === 'warn_kick' || value === 'limit' || value === 'wk') {
    return 'warnkick';
  }
  if (value === 'lock' || value === 'close') return 'mute';
  return ANTIAD_ACTIONS.includes(value) ? value : null;
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
  const { contextInfo } = extractContextInfo(msg);
  const quotedParticipant = contextInfo?.participant;
  const mentioned = contextInfo?.mentionedJid?.[0];
  return quotedParticipant || mentioned || null;
}

function getQuotedText(msg) {
  const { rawQuotedMessage } = extractContextInfo(msg);
  if (!rawQuotedMessage) return '';
  return extractMessageText({ message: rawQuotedMessage }, '');
}

function formatStatusCard(botName, prefix, groupConfig) {
  const p = prefix || '.';
  return [
    spiderHeader(botName, 'ANTI-ADVERTISEMENT SHIELD'),
    spiderRow('STATUS', groupConfig.enabled ? 'ON ✅' : 'OFF ❌', '⛨'),
    spiderRow('STRICT MODE', groupConfig.strict !== false ? 'VERY STRICT 🔥' : 'STANDARD', '☢'),
    spiderRow('ACTION', actionLabel(groupConfig.action), '⚡'),
    spiderRow('WARN LIMIT', `${groupConfig.maxWarns} warn(s)`, '▣'),
    spiderRow('ALERTS', groupConfig.notify ? 'ON' : 'OFF', '◈'),
    spiderRow('CUSTOM RULES', String(groupConfig.customPatterns.length), '❖'),
    spiderRow('WHITELIST', String(groupConfig.whitelist.length), '✦'),
    spiderRow(
      'BLOCKED STATS',
      `${groupConfig.stats.detected} caught · ${groupConfig.stats.deleted} del · ${groupConfig.stats.kicked} kicked · ${groupConfig.stats.muted || 0} muted`,
      '▤',
    ),
    spiderDivider('CONTROLS'),
    `> ┃ ▸ *${p}antiadvertisement on [delete|kick|warn|warnkick|mute]*`,
    `> ┃ ▸ *${p}antiadvertisement off* — Disable protection`,
    `> ┃ ▸ *${p}antiadvertisement strict on|off* — Toggle very strict detection`,
    `> ┃ ▸ *${p}antiadvertisement delete* — Delete ad messages`,
    `> ┃ ▸ *${p}antiadvertisement kick* — Delete & kick advertisers`,
    `> ┃ ▸ *${p}antiadvertisement warn* — Delete & warn advertisers`,
    `> ┃ ▸ *${p}antiadvertisement warnkick* — Warn, then kick at limit`,
    `> ┃ ▸ *${p}antiadvertisement mute* — Delete & lock group chat`,
    `> ┃ ▸ *${p}antiadvertisement warnlimit <1-10>* — Set warn kick limit`,
    `> ┃ ▸ *${p}antiadvertisement notify on|off* — Toggle group alerts`,
    `> ┃ ▸ *${p}antiadvertisement addword / delword <text>*`,
    `> ┃ ▸ *${p}antiadvertisement whitelist add|remove|list <item>*`,
    `> ┃ ▸ *${p}antiadvertisement resetwarns [@user]*`,
    `> ┃ ▸ *${p}antiadvertisement test <text>*`,
    spiderFooter('GROUP ANTI-AD // SPIDER-MAN'),
  ].join('\n');
}

export const commands = [
  {
    name: 'antiadvertisement',
    aliases: ['antiad', 'antiads', 'noads', 'antiadvert', 'adguard', 'antipromo'],
    description:
      'Protect the group from unsolicited advertisements, bundle/till promos, and spam sales (delete, kick, warn, warnkick, mute).',
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
      const restText = tokens.slice(1).join(' ').trim();
      const current = defaultAntiadvertisementStore.getGroupConfig(from);

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
              text: `❌ Invalid action "${tokens[1]}". Valid actions: *delete*, *kick*, *warn*, *warnkick*, *mute*.`,
            },
            { quoted: msg },
          );
        }
        const nextAction = requestedAction || current.action || 'delete';
        const updated = defaultAntiadvertisementStore.setGroupConfig(from, {
          ...current,
          enabled: true,
          action: nextAction,
        });
        const textOut = [
          spiderHeader(botName, 'ANTI-AD ENABLED'),
          spiderRow('STATUS', 'ON ✅', '⛨'),
          spiderRow('STRICT MODE', updated.strict !== false ? 'VERY STRICT 🔥' : 'STANDARD', '☢'),
          spiderRow('ACTION', actionLabel(updated.action), '⚡'),
          spiderRow('WARN LIMIT', `${updated.maxWarns} warn(s)`, '▣'),
          spiderFooter('ADVERTISEMENTS WILL BE BLOCKED'),
        ].join('\n');
        return sock.sendMessage(from, { text: textOut }, { quoted: msg });
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntiadvertisementStore.setGroupConfig(from, {
          ...current,
          enabled: false,
        });
        const textOut = [
          spiderHeader(botName, 'ANTI-AD DISABLED'),
          spiderRow('STATUS', 'OFF ❌', '⛨'),
          spiderFooter(`USE ${prefix}antiadvertisement on TO RE-ENABLE`),
        ].join('\n');
        return sock.sendMessage(from, { text: textOut }, { quoted: msg });
      }

      if (sub === 'strict' || sub === 'strictmode') {
        const toggle = String(tokens[1] || '').toLowerCase();
        if (toggle !== 'on' && toggle !== 'off') {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antiadvertisement strict on* or *${prefix}antiadvertisement strict off*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntiadvertisementStore.setGroupConfig(from, {
          ...current,
          strict: toggle === 'on',
        });
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Advertisement strict mode turned *${updated.strict ? 'ON (VERY STRICT)' : 'OFF (STANDARD)'}*.`,
          },
          { quoted: msg },
        );
      }

      const directAction = normalizeAction(sub);
      if (directAction || sub === 'action' || sub === 'mode') {
        const chosenAction = directAction || normalizeAction(tokens[1]);
        if (!chosenAction) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Usage: *${prefix}antiadvertisement action <delete|kick|warn|warnkick|mute>*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntiadvertisementStore.setGroupConfig(from, {
          ...current,
          enabled: directAction ? true : current.enabled,
          action: chosenAction,
        });
        const textOut = [
          spiderHeader(botName, 'ANTI-AD MODE UPDATED'),
          spiderRow('STATUS', updated.enabled ? 'ON ✅' : 'OFF ❌', '⛨'),
          spiderRow('STRICT MODE', updated.strict !== false ? 'VERY STRICT 🔥' : 'STANDARD', '☢'),
          spiderRow('ACTION', actionLabel(updated.action), '⚡'),
          spiderRow('WARN LIMIT', `${updated.maxWarns} warn(s)`, '▣'),
          spiderFooter('PROTECTION POLICY SAVED'),
        ].join('\n');
        return sock.sendMessage(from, { text: textOut }, { quoted: msg });
      }

      if (sub === 'warnlimit' || sub === 'maxwarns' || sub === 'limit') {
        const limitNum = Number.parseInt(String(tokens[1] || ''), 10);
        if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 10) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Please specify a warn limit between 1 and 10. Example: *${prefix}antiadvertisement warnlimit 3*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntiadvertisementStore.setGroupConfig(from, {
          ...current,
          maxWarns: limitNum,
        });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Advertisement warn limit set to *${updated.maxWarns}* warning(s) before kick.` },
          { quoted: msg },
        );
      }

      if (sub === 'notify' || sub === 'alert' || sub === 'alerts') {
        const toggle = String(tokens[1] || '').toLowerCase();
        if (toggle !== 'on' && toggle !== 'off') {
          return sock.sendMessage(
            from,
            {
              text: `❌ Usage: *${prefix}antiadvertisement notify on* or *${prefix}antiadvertisement notify off*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntiadvertisementStore.setGroupConfig(from, {
          ...current,
          notify: toggle === 'on',
        });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Advertisement group alerts turned *${updated.notify ? 'ON' : 'OFF'}*.` },
          { quoted: msg },
        );
      }

      if (sub === 'resetwarns' || sub === 'clearwarns' || sub === 'unwarn') {
        const targetJid = getQuotedOrMentionedTarget(msg);
        if (targetJid) {
          defaultAntiadvertisementStore.resetWarns(from, targetJid);
          const num = extractPhone(targetJid) || cleanJid(targetJid).split('@')[0];
          return sock.sendMessage(
            from,
            {
              text: `✅ Cleared Anti-Advertisement warnings for @${num}.`,
              mentions: [cleanJid(targetJid)],
            },
            { quoted: msg },
          );
        }
        defaultAntiadvertisementStore.resetWarns(from, null);
        return sock.sendMessage(
          from,
          { text: '✅ Cleared all Anti-Advertisement warnings for this group.' },
          { quoted: msg },
        );
      }

      if (sub === 'addword' || sub === 'addrule' || sub === 'blockword') {
        if (!restText) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Provide an ad phrase or keyword to block. Example: *${prefix}antiadvertisement addword till number*`,
            },
            { quoted: msg },
          );
        }
        const { added, config: updated } = defaultAntiadvertisementStore.addCustomPattern(from, restText);
        return sock.sendMessage(
          from,
          {
            text: added
              ? `✅ Added custom Anti-Advertisement rule: *"${restText.toLowerCase()}"* (${updated.customPatterns.length} total).`
              : `ℹ️ Rule *"${restText.toLowerCase()}"* is already in the Anti-Advertisement list.`,
          },
          { quoted: msg },
        );
      }

      if (sub === 'delword' || sub === 'delrule' || sub === 'rmword' || sub === 'removeword') {
        if (!restText) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Provide a rule to remove. Example: *${prefix}antiadvertisement delword till number*`,
            },
            { quoted: msg },
          );
        }
        const { removed } = defaultAntiadvertisementStore.removeCustomPattern(from, restText);
        return sock.sendMessage(
          from,
          {
            text: removed
              ? `✅ Removed custom Anti-Advertisement rule: *"${restText.toLowerCase()}"*.`
              : `❌ Custom rule *"${restText.toLowerCase()}"* was not found.`,
          },
          { quoted: msg },
        );
      }

      if (sub === 'words' || sub === 'rules') {
        if (!current.customPatterns.length) {
          return sock.sendMessage(
            from,
            {
              text: `ℹ️ No custom Anti-Advertisement rules set. Add one with *${prefix}antiadvertisement addword <phrase>*.`,
            },
            { quoted: msg },
          );
        }
        const listText = [
          spiderHeader(botName, 'CUSTOM AD RULES'),
          ...current.customPatterns.map((rule, idx) => spiderRow(String(idx + 1).padStart(2, '0'), rule, '▸')),
          spiderFooter('TOTAL // ' + current.customPatterns.length),
        ].join('\n');
        return sock.sendMessage(from, { text: listText }, { quoted: msg });
      }

      if (sub === 'whitelist' || sub === 'allow' || sub === 'exempt') {
        const op = String(tokens[1] || 'list').toLowerCase();
        const target = tokens.slice(2).join(' ').trim() || getQuotedOrMentionedTarget(msg) || '';

        if (op === 'list') {
          if (!current.whitelist.length) {
            return sock.sendMessage(
              from,
              {
                text: `ℹ️ Anti-Advertisement whitelist is empty. Use *${prefix}antiadvertisement whitelist add <domain|number|@user>*.`,
              },
              { quoted: msg },
            );
          }
          const listText = [
            spiderHeader(botName, 'ANTI-AD WHITELIST'),
            ...current.whitelist.map((item, idx) => spiderRow(String(idx + 1).padStart(2, '0'), item, '✦')),
            spiderFooter('TOTAL // ' + current.whitelist.length),
          ].join('\n');
          return sock.sendMessage(from, { text: listText }, { quoted: msg });
        }

        if (op === 'add') {
          if (!target) {
            return sock.sendMessage(
              from,
              { text: `❌ Usage: *${prefix}antiadvertisement whitelist add <domain|number|@user>*` },
              { quoted: msg },
            );
          }
          const { added, entry } = defaultAntiadvertisementStore.addWhitelist(from, target);
          return sock.sendMessage(
            from,
            {
              text: added
                ? `✅ Added *${entry}* to the Anti-Advertisement whitelist.`
                : `ℹ️ *${entry || target}* is already whitelisted.`,
            },
            { quoted: msg },
          );
        }

        if (op === 'remove' || op === 'del' || op === 'rm') {
          if (!target) {
            return sock.sendMessage(
              from,
              { text: `❌ Usage: *${prefix}antiadvertisement whitelist remove <domain|number|@user>*` },
              { quoted: msg },
            );
          }
          const { removed, entry } = defaultAntiadvertisementStore.removeWhitelist(from, target);
          return sock.sendMessage(
            from,
            {
              text: removed
                ? `✅ Removed *${entry}* from the Anti-Advertisement whitelist.`
                : `❌ *${entry || target}* was not found in the whitelist.`,
            },
            { quoted: msg },
          );
        }

        return sock.sendMessage(
          from,
          { text: `❌ Usage: *${prefix}antiadvertisement whitelist add|remove|list <domain|number|@user>*` },
          { quoted: msg },
        );
      }

      if (sub === 'test' || sub === 'check' || sub === 'scan') {
        const sample = restText || getQuotedText(msg);
        if (!sample) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Provide text or reply to a message to test. Example: *${prefix}antiadvertisement test ...*`,
            },
            { quoted: msg },
          );
        }
        const detection = detectAdvertisementMessage(sample, current, '');
        const scanOut = [
          spiderHeader(botName, 'ANTI-AD SCAN TEST'),
          spiderRow('VERDICT', detection.isAd ? '🚨 AD DETECTED' : '✅ CLEAN', '⛨'),
          spiderRow('RISK SCORE', `${detection.score} / ${detection.threshold}+ threshold`, '▣'),
          ...(detection.categories.length
            ? [spiderRow('FLAGS', detection.categories.join(', '), '⚠')]
            : []),
          ...(detection.matches.length
            ? [spiderRow('MATCHES', detection.matches.join(', '), '◈')]
            : []),
          spiderFooter('SIMULATION ONLY // NO ACTION TAKEN'),
        ].join('\n');
        return sock.sendMessage(from, { text: scanOut }, { quoted: msg });
      }

      return sock.sendMessage(
        from,
        {
          text: [
            `❌ Unknown option *"${sub}"*.`,
            `Use *${prefix}antiadvertisement* to view status and available options.`,
          ].join('\n'),
        },
        { quoted: msg },
      );
    },
  },
];
