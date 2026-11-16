import config from '../../spider/config.js';
import {
  ANTISCAM_ACTIONS,
  cleanJid,
  defaultAntiscamStore,
  detectScamMessage,
  extractMessageText,
  extractPhone,
} from '../../spider/utils/antiscam.js';
import { spiderDivider, spiderFooter, spiderHeader, spiderRow } from '../utils/tableStyle.js';
import { extractContextInfo } from '../../spider/utils/groupActionHelper.js';

function normalizeAction(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'del' || value === 'delete-only') return 'delete';
  if (value === 'delete+warn' || value === 'delete-warn' || value === 'deletewarn') return 'warn';
  if (value === 'delete+kick' || value === 'delete-kick' || value === 'deletekick' || value === 'remove' || value === 'ban') return 'kick';
  if (value === 'warn-kick' || value === 'warn_kick' || value === 'limit') return 'warnkick';
  if (value === 'lock' || value === 'close') return 'mute';
  return ANTISCAM_ACTIONS.includes(value) ? value : null;
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
    spiderHeader(botName, 'ANTISCAM SHIELD'),
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
    `> ┃ ▸ *${p}antiscam on [delete|kick|warn|warnkick|mute]*`,
    `> ┃ ▸ *${p}antiscam off* — Disable protection`,
    `> ┃ ▸ *${p}antiscam strict on|off* — Toggle very strict detection`,
    `> ┃ ▸ *${p}antiscam delete* — Delete scam messages`,
    `> ┃ ▸ *${p}antiscam kick* — Delete & kick scammers`,
    `> ┃ ▸ *${p}antiscam warn* — Delete & warn scammers`,
    `> ┃ ▸ *${p}antiscam warnkick* — Warn, then kick at limit`,
    `> ┃ ▸ *${p}antiscam mute* — Delete & lock group chat`,
    `> ┃ ▸ *${p}antiscam warnlimit <1-10>* — Set warn kick limit`,
    `> ┃ ▸ *${p}antiscam notify on|off* — Toggle group alerts`,
    `> ┃ ▸ *${p}antiscam addword / delword <text>*`,
    `> ┃ ▸ *${p}antiscam whitelist add|remove|list <item>*`,
    `> ┃ ▸ *${p}antiscam resetwarns [@user]*`,
    `> ┃ ▸ *${p}antiscam test <text>*`,
    spiderFooter('GROUP ANTISCAM // SPIDER-MAN'),
  ].join('\n');
}

export const commands = [
  {
    name: 'antiscam',
    aliases: ['noscams', 'scamguard', 'antiphish'],
    description: 'Protect the group from scam, phishing, and fraud messages (delete, kick, warn, warnkick, mute).',
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
      const current = defaultAntiscamStore.getGroupConfig(from);

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
              text: `❌ Invalid action "${tokens[1]}". Valid actions: *delete*, *kick*, *warn*, *warnkick*, *mute*.`,
            },
            { quoted: msg },
          );
        }
        const nextAction = requestedAction || current.action || 'delete';
        const updated = defaultAntiscamStore.setGroupConfig(from, {
          ...current,
          enabled: true,
          action: nextAction,
        });
        const textOut = [
          spiderHeader(botName, 'ANTISCAM ENABLED'),
          spiderRow('STATUS', 'ON ✅', '⛨'),
          spiderRow('STRICT MODE', updated.strict !== false ? 'VERY STRICT 🔥' : 'STANDARD', '☢'),
          spiderRow('ACTION', actionLabel(updated.action), '⚡'),
          spiderRow('WARN LIMIT', `${updated.maxWarns} warn(s)`, '▣'),
          spiderFooter('SCAMMERS WILL BE BLOCKED'),
        ].join('\n');
        return sock.sendMessage(from, { text: textOut }, { quoted: msg });
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntiscamStore.setGroupConfig(from, {
          ...current,
          enabled: false,
        });
        const textOut = [
          spiderHeader(botName, 'ANTISCAM DISABLED'),
          spiderRow('STATUS', 'OFF ❌', '⛨'),
          spiderFooter(`USE ${prefix}antiscam on TO RE-ENABLE`),
        ].join('\n');
        return sock.sendMessage(from, { text: textOut }, { quoted: msg });
      }

      if (sub === 'strict' || sub === 'strictmode') {
        const toggle = String(tokens[1] || '').toLowerCase();
        if (toggle !== 'on' && toggle !== 'off') {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antiscam strict on* or *${prefix}antiscam strict off*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntiscamStore.setGroupConfig(from, {
          ...current,
          strict: toggle === 'on',
        });
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Scam strict mode turned *${updated.strict ? 'ON (VERY STRICT)' : 'OFF (STANDARD)'}*.`,
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
              text: `❌ Usage: *${prefix}antiscam action <delete|kick|warn|warnkick|mute>*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntiscamStore.setGroupConfig(from, {
          ...current,
          enabled: directAction ? true : current.enabled,
          action: chosenAction,
        });
        const textOut = [
          spiderHeader(botName, 'ANTISCAM MODE UPDATED'),
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
            { text: `❌ Please specify a warn limit between 1 and 10. Example: *${prefix}antiscam warnlimit 3*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntiscamStore.setGroupConfig(from, {
          ...current,
          maxWarns: limitNum,
        });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Scam warn limit set to *${updated.maxWarns}* warning(s) before kick.` },
          { quoted: msg },
        );
      }

      if (sub === 'notify' || sub === 'alert' || sub === 'alerts') {
        const toggle = String(tokens[1] || '').toLowerCase();
        if (toggle !== 'on' && toggle !== 'off') {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antiscam notify on* or *${prefix}antiscam notify off*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntiscamStore.setGroupConfig(from, {
          ...current,
          notify: toggle === 'on',
        });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Scam group alerts turned *${updated.notify ? 'ON' : 'OFF'}*.` },
          { quoted: msg },
        );
      }

      if (sub === 'resetwarns' || sub === 'clearwarns' || sub === 'unwarn') {
        const targetJid = getQuotedOrMentionedTarget(msg);
        if (targetJid) {
          defaultAntiscamStore.resetWarns(from, targetJid);
          const num = extractPhone(targetJid) || cleanJid(targetJid).split('@')[0];
          return sock.sendMessage(
            from,
            {
              text: `✅ Cleared Anti-Scam warnings for @${num}.`,
              mentions: [cleanJid(targetJid)],
            },
            { quoted: msg },
          );
        }
        defaultAntiscamStore.resetWarns(from, null);
        return sock.sendMessage(
          from,
          { text: '✅ Cleared all Anti-Scam warnings for this group.' },
          { quoted: msg },
        );
      }

      if (sub === 'addword' || sub === 'addrule' || sub === 'blockword') {
        if (!restText) {
          return sock.sendMessage(
            from,
            { text: `❌ Provide a scam phrase or domain to block. Example: *${prefix}antiscam addword free airdrop*` },
            { quoted: msg },
          );
        }
        const { added, config: updated } = defaultAntiscamStore.addCustomPattern(from, restText);
        return sock.sendMessage(
          from,
          {
            text: added
              ? `✅ Added custom Anti-Scam rule: *"${restText.toLowerCase()}"* (${updated.customPatterns.length} total).`
              : `ℹ️ Rule *"${restText.toLowerCase()}"* is already in the Anti-Scam list.`,
          },
          { quoted: msg },
        );
      }

      if (sub === 'delword' || sub === 'delrule' || sub === 'rmword' || sub === 'removeword') {
        if (!restText) {
          return sock.sendMessage(
            from,
            { text: `❌ Provide a rule to remove. Example: *${prefix}antiscam delword free airdrop*` },
            { quoted: msg },
          );
        }
        const { removed } = defaultAntiscamStore.removeCustomPattern(from, restText);
        return sock.sendMessage(
          from,
          {
            text: removed
              ? `✅ Removed custom Anti-Scam rule: *"${restText.toLowerCase()}"*.`
              : `❌ Custom rule *"${restText.toLowerCase()}"* was not found.`,
          },
          { quoted: msg },
        );
      }

      if (sub === 'words' || sub === 'rules') {
        if (!current.customPatterns.length) {
          return sock.sendMessage(
            from,
            { text: `ℹ️ No custom Anti-Scam rules set. Add one with *${prefix}antiscam addword <phrase>*.` },
            { quoted: msg },
          );
        }
        const listText = [
          spiderHeader(botName, 'CUSTOM SCAM RULES'),
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
              { text: `ℹ️ Anti-Scam whitelist is empty. Use *${prefix}antiscam whitelist add <domain|number>*.` },
              { quoted: msg },
            );
          }
          const listText = [
            spiderHeader(botName, 'ANTISCAM WHITELIST'),
            ...current.whitelist.map((item, idx) => spiderRow(String(idx + 1).padStart(2, '0'), item, '✦')),
            spiderFooter('TOTAL // ' + current.whitelist.length),
          ].join('\n');
          return sock.sendMessage(from, { text: listText }, { quoted: msg });
        }

        if (op === 'add') {
          if (!target) {
            return sock.sendMessage(
              from,
              { text: `❌ Usage: *${prefix}antiscam whitelist add <domain|number|@user>*` },
              { quoted: msg },
            );
          }
          const { added, entry } = defaultAntiscamStore.addWhitelist(from, target);
          return sock.sendMessage(
            from,
            {
              text: added
                ? `✅ Added *${entry}* to the Anti-Scam whitelist.`
                : `ℹ️ *${entry || target}* is already whitelisted.`,
            },
            { quoted: msg },
          );
        }

        if (op === 'remove' || op === 'del' || op === 'rm') {
          if (!target) {
            return sock.sendMessage(
              from,
              { text: `❌ Usage: *${prefix}antiscam whitelist remove <domain|number|@user>*` },
              { quoted: msg },
            );
          }
          const { removed, entry } = defaultAntiscamStore.removeWhitelist(from, target);
          return sock.sendMessage(
            from,
            {
              text: removed
                ? `✅ Removed *${entry}* from the Anti-Scam whitelist.`
                : `❌ *${entry || target}* was not found in the whitelist.`,
            },
            { quoted: msg },
          );
        }

        return sock.sendMessage(
          from,
          { text: `❌ Usage: *${prefix}antiscam whitelist add|remove|list <domain|number>*` },
          { quoted: msg },
        );
      }

      if (sub === 'test' || sub === 'check' || sub === 'scan') {
        const sample = restText || getQuotedText(msg);
        if (!sample) {
          return sock.sendMessage(
            from,
            { text: `❌ Provide text or reply to a message to test. Example: *${prefix}antiscam test ...*` },
            { quoted: msg },
          );
        }
        const detection = detectScamMessage(sample, current, '');
        const scanOut = [
          spiderHeader(botName, 'ANTISCAM SCAN TEST'),
          spiderRow('VERDICT', detection.isScam ? '🚨 SCAM DETECTED' : '✅ CLEAN', '⛨'),
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
            `Use *${prefix}antiscam* to view status and available options.`,
          ].join('\n'),
        },
        { quoted: msg },
      );
    },
  },
];
