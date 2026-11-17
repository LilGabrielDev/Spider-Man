import config from '../../spider/config.js';
import { spiderDivider, spiderFooter, spiderHeader, spiderRow } from '../utils/tableStyle.js';
import { cleanJid, extractPhoneDigits } from '../../spider/utils/groupRoleResolver.js';
import { extractContextInfo, resolveTargetFromMessage } from '../../spider/utils/groupActionHelper.js';
import { ANTILINK_ACTIONS, defaultAntilinkStore } from '../../spider/utils/antilink.js';
import {
  ANTIBADWORD_ACTIONS,
  defaultAntibadwordStore,
  detectBadword,
} from '../../spider/utils/antibadword.js';
import { ANTITAG_ACTIONS, defaultAntitagStore } from '../../spider/utils/antitag.js';
import { ANTIMENTION_ACTIONS, defaultAntimentionStore } from '../../spider/utils/antimention.js';
import { ANTIBOT_ACTIONS, defaultAntibotStore } from '../../spider/utils/antibot.js';
import {
  ANTISPAM_ACTIONS,
  defaultAntispamStore,
  defaultSpamTracker,
} from '../../spider/utils/antispam.js';
import { ANTIDEMOTE_ACTIONS, defaultAntidemoteStore } from '../../spider/utils/antidemote.js';
import { defaultAnticallStore, resetAnticallCooldowns } from '../../spider/utils/anticall.js';
import { defaultAntivvStore } from '../../spider/viewOnceAutoSave.js';

function getTokens(text, args) {
  return (Array.isArray(args) && args.length > 0
    ? args.map((item) => String(item || '').trim())
    : String(text || '').trim().split(/\s+/)
  ).filter(Boolean);
}

function getQuotedOrMentionedTarget(msg) {
  const { contextInfo } = extractContextInfo(msg);
  return contextInfo?.participant || contextInfo?.mentionedJid?.[0] || null;
}

async function fetchMetaSafe(sock, from) {
  try {
    if (typeof sock?.groupMetadata === 'function') {
      return await sock.groupMetadata(from);
    }
  } catch {}
  return null;
}

function guardGroupAndAdmins({ sock, from, msg, isGroupAdmin, isBotGroupAdmin, isOwner }) {
  if (!from || !String(from).endsWith('@g.us')) {
    sock.sendMessage(from, { text: 'This command can only be used in a group.' }, { quoted: msg });
    return false;
  }
  if (isGroupAdmin === false && !isOwner) {
    sock.sendMessage(from, { text: 'Only a group admin can run this command.' }, { quoted: msg });
    return false;
  }
  if (isBotGroupAdmin === false) {
    sock.sendMessage(
      from,
      { text: 'The bot needs group admin permission to run this command.' },
      { quoted: msg },
    );
    return false;
  }
  return true;
}

function normalizeCompositeAction(raw, allowed) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'del' || v === 'delete-only' || v === 'deleteonly') return 'delete';
  if (v === 'delete-warn' || v === 'delete+warn' || v === 'deletewarn') {
    return allowed.includes('warn') ? 'warn' : null;
  }
  if (v === 'delete-kick' || v === 'delete+kick' || v === 'deletekick' || v === 'remove' || v === 'ban') {
    return allowed.includes('kick') ? 'kick' : null;
  }
  if (v === 'warn-kick' || v === 'warn_kick' || v === 'wk') {
    return allowed.includes('warnkick') ? 'warnkick' : null;
  }
  if (v === 'lock' || v === 'close') {
    return allowed.includes('mute') ? 'mute' : null;
  }
  return allowed.includes(v) ? v : null;
}

export const commands = [
  {
    name: 'globalantilink',
    aliases: ['gantilink', 'globalantilinks'],
    description: 'Owner-only: enable or configure global anti-link protection across all groups.',
    category: 'Group',
    ownerOnly: true,
    execute: async ({ sock, from, msg, text, args = [], isOwner, config: ctxConfig }) => {
      if (!isOwner) {
        return sock.sendMessage(from, { text: '❌ This command is restricted to the bot owner.' }, { quoted: msg });
      }
      const activeConfig = ctxConfig || config;
      const botName = activeConfig?.BOT_NAME || 'Spider Man';
      const prefix = activeConfig?.PREFIXES?.[0] || '.';
      const tokens = getTokens(text, args);
      const sub = String(tokens[0] || '').toLowerCase();
      const cur = defaultAntilinkStore.getGlobalConfig();

      if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
        const out = [
          spiderHeader(botName, 'GLOBAL ANTILINK SHIELD'),
          spiderRow('STATUS', cur.enabled ? 'ON ✅' : 'OFF ❌', '⛨'),
          spiderRow('DEFAULT ACTION', cur.action.toUpperCase(), '⚡'),
          spiderDivider('CONTROLS'),
          `> ┃ ▸ *${prefix}globalantilink on [delete|kick|warn]*`,
          `> ┃ ▸ *${prefix}globalantilink set <delete|kick|warn>*`,
          `> ┃ ▸ *${prefix}globalantilink off*`,
          spiderFooter('GLOBAL ANTILINK // SPIDER-MAN'),
        ].join('\n');
        return sock.sendMessage(from, { text: out }, { quoted: msg });
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntilinkStore.setGlobalConfig({ enabled: false });
        return sock.sendMessage(
          from,
          { text: [spiderHeader(botName, 'GLOBAL ANTILINK'), spiderRow('STATUS', 'OFF ❌', '⛨'), spiderFooter('SPIDER-MAN')].join('\n') },
          { quoted: msg },
        );
      }

      if (sub === 'on' || sub === 'enable') {
        const chosen = tokens[1] ? normalizeCompositeAction(tokens[1], ANTILINK_ACTIONS) : cur.action;
        if (tokens[1] && !chosen) {
          return sock.sendMessage(from, { text: `❌ Valid actions: *${ANTILINK_ACTIONS.join(', ')}*` }, { quoted: msg });
        }
        const updated = defaultAntilinkStore.setGlobalConfig({ enabled: true, action: chosen || 'delete' });
        return sock.sendMessage(
          from,
          {
            text: [
              spiderHeader(botName, 'GLOBAL ANTILINK ENABLED'),
              spiderRow('STATUS', 'ON ✅', '⛨'),
              spiderRow('ACTION', updated.action.toUpperCase(), '⚡'),
              spiderFooter('ALL GROUPS PROTECTED'),
            ].join('\n'),
          },
          { quoted: msg },
        );
      }

      const direct = normalizeCompositeAction(sub, ANTILINK_ACTIONS);
      if (direct || sub === 'set' || sub === 'action' || sub === 'mode') {
        const chosen = direct || normalizeCompositeAction(tokens[1], ANTILINK_ACTIONS);
        if (!chosen) {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}globalantilink set <delete|kick|warn>*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntilinkStore.setGlobalConfig({ enabled: true, action: chosen });
        return sock.sendMessage(
          from,
          { text: `✅ Global Anti-Link set to *ON* with action *${updated.action.toUpperCase()}*.` },
          { quoted: msg },
        );
      }

      return sock.sendMessage(
        from,
        { text: `❌ Usage: *${prefix}globalantilink on|off|status|set <delete|kick|warn>*` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'antibadword',
    aliases: ['badword', 'badwords', 'antibad'],
    description: 'Strict profanity & custom bad-word filter (delete, warn, kick, warnkick, mute).',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg, text, args = [], config: ctxConfig, isGroupAdmin, isBotGroupAdmin, isOwner }) => {
      if (!guardGroupAndAdmins({ sock, from, msg, isGroupAdmin, isBotGroupAdmin, isOwner })) return;
      const activeConfig = ctxConfig || config;
      const botName = activeConfig?.BOT_NAME || 'Spider Man';
      const prefix = activeConfig?.PREFIXES?.[0] || '.';
      const tokens = getTokens(text, args);
      const sub = String(tokens[0] || '').toLowerCase();
      const rest = tokens.slice(1).join(' ').trim();
      const cur = defaultAntibadwordStore.getGroupConfig(from);

      if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
        const out = [
          spiderHeader(botName, 'ANTIBADWORD SHIELD'),
          spiderRow('STATUS', cur.enabled ? 'ON ✅' : 'OFF ❌', '⛨'),
          spiderRow('STRICT MODE', cur.strict !== false ? 'VERY STRICT 🔥' : 'STANDARD', '☢'),
          spiderRow('ACTION', cur.action.toUpperCase(), '⚡'),
          spiderRow('WARN LIMIT', `${cur.maxWarns} warn(s)`, '▣'),
          spiderRow('ALERTS', cur.notify ? 'ON' : 'OFF', '◈'),
          spiderRow('CUSTOM WORDS', String(cur.customWords.length), '❖'),
          spiderRow('WHITELIST', String((cur.whitelist || []).length), '✦'),
          spiderRow(
            'STATS',
            `${cur.stats.detected} caught · ${cur.stats.deleted} del · ${cur.stats.kicked} kicked · ${cur.stats.muted || 0} muted`,
            '▤',
          ),
          spiderDivider('CONTROLS'),
          `> ┃ ▸ *${prefix}antibadword on [delete|warn|kick|warnkick|mute]*`,
          `> ┃ ▸ *${prefix}antibadword off*`,
          `> ┃ ▸ *${prefix}antibadword strict [on|off]*`,
          `> ┃ ▸ *${prefix}antibadword set <delete|warn|kick|warnkick|mute>*`,
          `> ┃ ▸ *${prefix}antibadword warnlimit <1-10>*`,
          `> ┃ ▸ *${prefix}antibadword notify on|off*`,
          `> ┃ ▸ *${prefix}antibadword addword / delword <word>*`,
          `> ┃ ▸ *${prefix}antibadword whitelist add|remove|list <word>*`,
          `> ┃ ▸ *${prefix}antibadword check <text>*`,
          spiderFooter('ANTIBADWORD // SPIDER-MAN'),
        ].join('\n');
        return sock.sendMessage(from, { text: out }, { quoted: msg });
      }

      if (sub === 'on' || sub === 'enable') {
        const chosen = tokens[1] ? normalizeCompositeAction(tokens[1], ANTIBADWORD_ACTIONS) : cur.action;
        if (tokens[1] && !chosen) {
          return sock.sendMessage(from, { text: `❌ Valid actions: *${ANTIBADWORD_ACTIONS.join(', ')}*` }, { quoted: msg });
        }
        const updated = defaultAntibadwordStore.setGroupConfig(from, {
          enabled: true,
          action: chosen || 'warnkick',
        });
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Badword turned *ON* (Mode: *${updated.strict ? 'VERY STRICT' : 'STANDARD'}* · Action: *${updated.action.toUpperCase()}* · Limit: *${updated.maxWarns}*).`,
          },
          { quoted: msg },
        );
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntibadwordStore.setGroupConfig(from, { enabled: false });
        return sock.sendMessage(from, { text: '🛑 Anti-Badword turned *OFF*.' }, { quoted: msg });
      }

      if (sub === 'strict' || sub === 'strictmode') {
        const toggle = String(tokens[1] || '').toLowerCase();
        if (!toggle) {
          const updated = defaultAntibadwordStore.setGroupConfig(from, {
            enabled: true,
            strict: true,
            action: 'kick',
            maxWarns: 1,
          });
          return sock.sendMessage(
            from,
            {
              text: [
                spiderHeader(botName, 'ANTIBADWORD STRICT PRESET'),
                spiderRow('STATUS', 'ON ✅', '⛨'),
                spiderRow('STRICT MODE', 'VERY STRICT 🔥', '☢'),
                spiderRow('ACTION', updated.action.toUpperCase(), '⚡'),
                spiderRow('WARN LIMIT', `${updated.maxWarns} warn(s)`, '▣'),
                spiderFooter('ZERO-TOLERANCE PROFANITY SHIELD'),
              ].join('\n'),
            },
            { quoted: msg },
          );
        }
        if (toggle !== 'on' && toggle !== 'off') {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antibadword strict [on|off]*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntibadwordStore.setGroupConfig(from, { strict: toggle === 'on' });
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Badword strict detection turned *${updated.strict ? 'ON (VERY STRICT)' : 'OFF (STANDARD)'}*.`,
          },
          { quoted: msg },
        );
      }

      if (sub === 'notify' || sub === 'alert' || sub === 'alerts') {
        const toggle = String(tokens[1] || '').toLowerCase();
        if (toggle !== 'on' && toggle !== 'off') {
          return sock.sendMessage(from, { text: `❌ Usage: *${prefix}antibadword notify on|off*` }, { quoted: msg });
        }
        const updated = defaultAntibadwordStore.setGroupConfig(from, { notify: toggle === 'on' });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Badword group alerts turned *${updated.notify ? 'ON' : 'OFF'}*.` },
          { quoted: msg },
        );
      }

      const direct = normalizeCompositeAction(sub, ANTIBADWORD_ACTIONS);
      if (direct || sub === 'action' || sub === 'mode' || sub === 'set') {
        const chosen = direct || normalizeCompositeAction(tokens[1], ANTIBADWORD_ACTIONS);
        if (!chosen) {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antibadword set <delete|warn|kick|warnkick|mute>*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntibadwordStore.setGroupConfig(from, { enabled: true, action: chosen });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Badword action set to *${updated.action.toUpperCase()}*.` },
          { quoted: msg },
        );
      }

      if (sub === 'addword' || sub === 'add') {
        if (!rest) {
          return sock.sendMessage(from, { text: `❌ Usage: *${prefix}antibadword addword <word>*` }, { quoted: msg });
        }
        const { added, config: updated } = defaultAntibadwordStore.addCustomWord(from, rest);
        return sock.sendMessage(
          from,
          { text: added ? `✅ Added *"${rest.toLowerCase()}"* (${updated.customWords.length} custom words).` : 'ℹ️ Word already blocked.' },
          { quoted: msg },
        );
      }

      if (sub === 'delword' || sub === 'rmword' || sub === 'remove' || sub === 'del') {
        if (!rest) {
          return sock.sendMessage(from, { text: `❌ Usage: *${prefix}antibadword delword <word>*` }, { quoted: msg });
        }
        const { removed } = defaultAntibadwordStore.removeCustomWord(from, rest);
        return sock.sendMessage(
          from,
          { text: removed ? `✅ Removed *"${rest.toLowerCase()}"* from custom badwords.` : '❌ Word not found.' },
          { quoted: msg },
        );
      }

      if (sub === 'whitelist' || sub === 'wl' || sub === 'allow') {
        const wlAction = sub === 'allow' ? 'add' : String(tokens[1] || 'list').toLowerCase();
        const wlWord = sub === 'allow' ? rest : tokens.slice(2).join(' ').trim();
        if (wlAction === 'list' || wlAction === 'show') {
          const list = cur.whitelist || [];
          return sock.sendMessage(
            from,
            {
              text: list.length
                ? `✦ *Whitelisted Words (${list.length}):*\n${list.map((w, i) => `${i + 1}. ${w}`).join('\n')}`
                : 'ℹ️ No whitelisted words configured.',
            },
            { quoted: msg },
          );
        }
        if ((wlAction === 'add' || wlAction === 'allow') && wlWord) {
          const { added, config: updated } = defaultAntibadwordStore.addWhitelistWord(from, wlWord);
          return sock.sendMessage(
            from,
            { text: added ? `✅ Whitelisted *"${wlWord.toLowerCase()}"* (${updated.whitelist.length} entries).` : 'ℹ️ Already whitelisted.' },
            { quoted: msg },
          );
        }
        if ((wlAction === 'remove' || wlAction === 'del' || wlAction === 'rm') && wlWord) {
          const { removed } = defaultAntibadwordStore.removeWhitelistWord(from, wlWord);
          return sock.sendMessage(
            from,
            { text: removed ? `✅ Removed *"${wlWord.toLowerCase()}"* from whitelist.` : '❌ Word not found in whitelist.' },
            { quoted: msg },
          );
        }
        return sock.sendMessage(
          from,
          { text: `❌ Usage: *${prefix}antibadword whitelist add|remove|list <word>*` },
          { quoted: msg },
        );
      }

      if (sub === 'words' || sub === 'list') {
        return sock.sendMessage(
          from,
          {
            text: cur.customWords.length
              ? `📋 *Custom Badwords (${cur.customWords.length}):*\n${cur.customWords.map((w, i) => `${i + 1}. ${w}`).join('\n')}`
              : 'ℹ️ No custom badwords configured (strict default profanity filter active).',
          },
          { quoted: msg },
        );
      }

      if (sub === 'warnlimit' || sub === 'maxwarns') {
        const limitNum = Number.parseInt(String(tokens[1] || ''), 10);
        if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 10) {
          return sock.sendMessage(from, { text: '❌ Specify warn limit 1–10.' }, { quoted: msg });
        }
        const updated = defaultAntibadwordStore.setGroupConfig(from, { maxWarns: limitNum });
        return sock.sendMessage(from, { text: `✅ Anti-Badword warn limit set to *${updated.maxWarns}*.` }, { quoted: msg });
      }

      if (sub === 'resetwarns' || sub === 'clearwarns' || sub === 'unwarn') {
        const metadata = await fetchMetaSafe(sock, from);
        const resolved = resolveTargetFromMessage({ sock, from, msg, text: rest, metadata });
        if (resolved.targetJid) {
          defaultAntibadwordStore.resetWarns(from, resolved.targetJid, resolved.alternateJids);
          return sock.sendMessage(
            from,
            { text: `✅ Cleared Anti-Badword warnings for @${resolved.displayUser}.`, mentions: resolved.mentionJid ? [resolved.mentionJid] : [] },
            { quoted: msg },
          );
        }
        defaultAntibadwordStore.resetWarns(from, null);
        return sock.sendMessage(from, { text: '✅ Cleared all Anti-Badword warnings for this group.' }, { quoted: msg });
      }

      if (sub === 'check' || sub === 'test' || sub === 'scan') {
        if (!rest) {
          return sock.sendMessage(from, { text: `❌ Usage: *${prefix}antibadword check <text>*` }, { quoted: msg });
        }
        const res = detectBadword(rest, cur);
        return sock.sendMessage(
          from,
          {
            text: res.matched
              ? `🚨 Badword detected: *"${res.word}"*${res.reason ? ` (${res.reason})` : ''}`
              : '✅ No blocked badwords detected.',
          },
          { quoted: msg },
        );
      }

      return sock.sendMessage(
        from,
        { text: `❌ Unknown option *"${sub}"*. Use *${prefix}antibadword* to view options.` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'antitag',
    aliases: ['antitagall'],
    description: 'Block mass @tagall and hidetag spam in groups (delete, warn, kick, warnkick).',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg, text, args = [], config: ctxConfig, isGroupAdmin, isBotGroupAdmin, isOwner }) => {
      if (!guardGroupAndAdmins({ sock, from, msg, isGroupAdmin, isBotGroupAdmin, isOwner })) return;
      const activeConfig = ctxConfig || config;
      const botName = activeConfig?.BOT_NAME || 'Spider Man';
      const prefix = activeConfig?.PREFIXES?.[0] || '.';
      const tokens = getTokens(text, args);
      const sub = String(tokens[0] || '').toLowerCase();
      const cur = defaultAntitagStore.getGroupConfig(from);

      if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
        const out = [
          spiderHeader(botName, 'ANTITAG SHIELD'),
          spiderRow('STATUS', cur.enabled ? 'ON ✅' : 'OFF ❌', '⛨'),
          spiderRow('ACTION', cur.action.toUpperCase(), '⚡'),
          spiderRow('WARN LIMIT', `${cur.maxWarns} warn(s)`, '▣'),
          spiderRow('STATS', `${cur.stats.detected} caught · ${cur.stats.deleted} del · ${cur.stats.kicked} kicked`, '▤'),
          spiderDivider('CONTROLS'),
          `> ┃ ▸ *${prefix}antitag on [delete|kick|warn|warnkick]*`,
          `> ┃ ▸ *${prefix}antitag off*`,
          `> ┃ ▸ *${prefix}antitag set <delete|kick|warn|warnkick>*`,
          spiderFooter('ANTITAG // SPIDER-MAN'),
        ].join('\n');
        return sock.sendMessage(from, { text: out }, { quoted: msg });
      }

      if (sub === 'on' || sub === 'enable') {
        const chosen = tokens[1] ? normalizeCompositeAction(tokens[1], ANTITAG_ACTIONS) : cur.action;
        if (tokens[1] && !chosen) {
          return sock.sendMessage(from, { text: `❌ Valid actions: *${ANTITAG_ACTIONS.join(', ')}*` }, { quoted: msg });
        }
        const updated = defaultAntitagStore.setGroupConfig(from, { enabled: true, action: chosen || 'delete' });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Tag turned *ON* (Action: *${updated.action.toUpperCase()}*).` },
          { quoted: msg },
        );
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntitagStore.setGroupConfig(from, { enabled: false });
        return sock.sendMessage(from, { text: '🛑 Anti-Tag turned *OFF*.' }, { quoted: msg });
      }

      const direct = normalizeCompositeAction(sub, ANTITAG_ACTIONS);
      if (direct || sub === 'set' || sub === 'action' || sub === 'mode') {
        const chosen = direct || normalizeCompositeAction(tokens[1], ANTITAG_ACTIONS);
        if (!chosen) {
          return sock.sendMessage(from, { text: `❌ Usage: *${prefix}antitag set <delete|kick|warn|warnkick>*` }, { quoted: msg });
        }
        const updated = defaultAntitagStore.setGroupConfig(from, { enabled: true, action: chosen });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Tag set to *ON* with action *${updated.action.toUpperCase()}*.` },
          { quoted: msg },
        );
      }

      if (sub === 'resetwarns' || sub === 'clearwarns') {
        const target = getQuotedOrMentionedTarget(msg);
        defaultAntitagStore.resetWarns(from, target || null);
        return sock.sendMessage(from, { text: '✅ Cleared Anti-Tag warnings.' }, { quoted: msg });
      }

      return sock.sendMessage(
        from,
        { text: `❌ Unknown option *"${sub}"*. Use *${prefix}antitag* for usage.` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'antimention',
    aliases: ['antigm', 'antigroupmention', 'antistatusmention'],
    description: 'Block group-mention and status-mention spam in groups (delete, warn, warnkick, kick).',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg, text, args = [], config: ctxConfig, isGroupAdmin, isBotGroupAdmin, isOwner }) => {
      if (!guardGroupAndAdmins({ sock, from, msg, isGroupAdmin, isBotGroupAdmin, isOwner })) return;
      const activeConfig = ctxConfig || config;
      const botName = activeConfig?.BOT_NAME || 'Spider Man';
      const prefix = activeConfig?.PREFIXES?.[0] || '.';
      const tokens = getTokens(text, args);
      const sub = String(tokens[0] || '').toLowerCase();
      const cur = defaultAntimentionStore.getGroupConfig(from);

      if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
        const out = [
          spiderHeader(botName, 'ANTIMENTION SHIELD'),
          spiderRow('STATUS', cur.enabled ? 'ON ✅' : 'OFF ❌', '⛨'),
          spiderRow('ACTION', cur.action.toUpperCase(), '⚡'),
          spiderRow('WARN LIMIT', `${cur.maxWarns} warn(s)`, '▣'),
          spiderRow('STATS', `${cur.stats.detected} caught · ${cur.stats.deleted} del · ${cur.stats.kicked} kicked`, '▤'),
          spiderDivider('CONTROLS'),
          `> ┃ ▸ *${prefix}antimention on [delete|warn|warnkick|kick]*`,
          `> ┃ ▸ *${prefix}antimention off*`,
          `> ┃ ▸ *${prefix}antimention set <delete|warn|warnkick|kick>*`,
          spiderFooter('ANTIMENTION // SPIDER-MAN'),
        ].join('\n');
        return sock.sendMessage(from, { text: out }, { quoted: msg });
      }

      if (sub === 'on' || sub === 'enable') {
        const chosen = tokens[1] ? normalizeCompositeAction(tokens[1], ANTIMENTION_ACTIONS) : cur.action;
        if (tokens[1] && !chosen) {
          return sock.sendMessage(from, { text: `❌ Valid actions: *${ANTIMENTION_ACTIONS.join(', ')}*` }, { quoted: msg });
        }
        const updated = defaultAntimentionStore.setGroupConfig(from, { enabled: true, action: chosen || 'delete' });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Mention turned *ON* (Action: *${updated.action.toUpperCase()}*).` },
          { quoted: msg },
        );
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntimentionStore.setGroupConfig(from, { enabled: false });
        return sock.sendMessage(from, { text: '🛑 Anti-Mention turned *OFF*.' }, { quoted: msg });
      }

      const direct = normalizeCompositeAction(sub, ANTIMENTION_ACTIONS);
      if (direct || sub === 'set' || sub === 'action' || sub === 'mode') {
        const chosen = direct || normalizeCompositeAction(tokens[1], ANTIMENTION_ACTIONS);
        if (!chosen) {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antimention set <delete|warn|warnkick|kick>*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntimentionStore.setGroupConfig(from, { enabled: true, action: chosen });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Mention action set to *${updated.action.toUpperCase()}*.` },
          { quoted: msg },
        );
      }

      if (sub === 'resetwarns' || sub === 'clearwarns') {
        const target = getQuotedOrMentionedTarget(msg);
        defaultAntimentionStore.resetWarns(from, target || null);
        return sock.sendMessage(from, { text: '✅ Cleared Anti-Mention warnings.' }, { quoted: msg });
      }

      return sock.sendMessage(
        from,
        { text: `❌ Unknown option *"${sub}"*. Use *${prefix}antimention* for usage.` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'globalantimention',
    aliases: ['gantimention', 'globalantigm'],
    description: 'Owner-only: enable or configure global anti-group-mention protection.',
    category: 'Group',
    ownerOnly: true,
    execute: async ({ sock, from, msg, text, args = [], isOwner, config: ctxConfig }) => {
      if (!isOwner) {
        return sock.sendMessage(from, { text: '❌ This command is restricted to the bot owner.' }, { quoted: msg });
      }
      const activeConfig = ctxConfig || config;
      const botName = activeConfig?.BOT_NAME || 'Spider Man';
      const prefix = activeConfig?.PREFIXES?.[0] || '.';
      const tokens = getTokens(text, args);
      const sub = String(tokens[0] || '').toLowerCase();
      const cur = defaultAntimentionStore.getGlobalConfig();

      if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
        const out = [
          spiderHeader(botName, 'GLOBAL ANTIMENTION'),
          spiderRow('STATUS', cur.enabled ? 'ON ✅' : 'OFF ❌', '⛨'),
          spiderRow('ACTION', cur.action.toUpperCase(), '⚡'),
          spiderDivider('CONTROLS'),
          `> ┃ ▸ *${prefix}globalantimention on [delete|warn|warnkick|kick]*`,
          `> ┃ ▸ *${prefix}globalantimention off*`,
          spiderFooter('GLOBAL ANTIMENTION // SPIDER-MAN'),
        ].join('\n');
        return sock.sendMessage(from, { text: out }, { quoted: msg });
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntimentionStore.setGlobalConfig({ enabled: false });
        return sock.sendMessage(from, { text: '🛑 Global Anti-Mention turned *OFF*.' }, { quoted: msg });
      }

      if (sub === 'on' || sub === 'enable') {
        const chosen = tokens[1] ? normalizeCompositeAction(tokens[1], ANTIMENTION_ACTIONS) : cur.action;
        if (tokens[1] && !chosen) {
          return sock.sendMessage(from, { text: `❌ Valid actions: *${ANTIMENTION_ACTIONS.join(', ')}*` }, { quoted: msg });
        }
        const updated = defaultAntimentionStore.setGlobalConfig({ enabled: true, action: chosen || 'delete' });
        return sock.sendMessage(
          from,
          { text: `✅ Global Anti-Mention turned *ON* (Action: *${updated.action.toUpperCase()}*).` },
          { quoted: msg },
        );
      }

      const direct = normalizeCompositeAction(sub, ANTIMENTION_ACTIONS);
      if (direct || sub === 'set' || sub === 'action' || sub === 'mode') {
        const chosen = direct || normalizeCompositeAction(tokens[1], ANTIMENTION_ACTIONS);
        if (!chosen) {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}globalantimention set <delete|warn|warnkick|kick>*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntimentionStore.setGlobalConfig({ enabled: true, action: chosen });
        return sock.sendMessage(
          from,
          { text: `✅ Global Anti-Mention set to *ON* with action *${updated.action.toUpperCase()}*.` },
          { quoted: msg },
        );
      }

      return sock.sendMessage(
        from,
        { text: `❌ Usage: *${prefix}globalantimention on|off|status|set <delete|warn|warnkick|kick>*` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'antibot',
    aliases: ['antibotcmd', 'nobot'],
    description: 'Block unauthorized bot commands and automated bot payloads in the group.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg, text, args = [], config: ctxConfig, isGroupAdmin, isBotGroupAdmin, isOwner }) => {
      if (!guardGroupAndAdmins({ sock, from, msg, isGroupAdmin, isBotGroupAdmin, isOwner })) return;
      const activeConfig = ctxConfig || config;
      const botName = activeConfig?.BOT_NAME || 'Spider Man';
      const prefix = activeConfig?.PREFIXES?.[0] || '.';
      const tokens = getTokens(text, args);
      const sub = String(tokens[0] || '').toLowerCase();
      const cur = defaultAntibotStore.getGroupConfig(from);

      if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
        const out = [
          spiderHeader(botName, 'ANTIBOT SHIELD'),
          spiderRow('STATUS', cur.enabled ? 'ON ✅' : 'OFF ❌', '🤖'),
          spiderRow('ACTION', cur.action.toUpperCase(), '⚡'),
          spiderRow('WARN LIMIT', `${cur.maxWarns} warn(s)`, '▣'),
          spiderRow('STATS', `${cur.stats.detected} caught · ${cur.stats.deleted} del · ${cur.stats.kicked} kicked`, '▤'),
          spiderDivider('CONTROLS'),
          `> ┃ ▸ *${prefix}antibot on [delete|warn|kick]*`,
          `> ┃ ▸ *${prefix}antibot off*`,
          `> ┃ ▸ *${prefix}antibot set <delete|warn|kick>*`,
          spiderFooter('ANTIBOT // SPIDER-MAN'),
        ].join('\n');
        return sock.sendMessage(from, { text: out }, { quoted: msg });
      }

      if (sub === 'on' || sub === 'enable') {
        const chosen = tokens[1] ? normalizeCompositeAction(tokens[1], ANTIBOT_ACTIONS) : cur.action;
        if (tokens[1] && !chosen) {
          return sock.sendMessage(from, { text: `❌ Valid actions: *${ANTIBOT_ACTIONS.join(', ')}*` }, { quoted: msg });
        }
        const updated = defaultAntibotStore.setGroupConfig(from, { enabled: true, action: chosen || 'kick' });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Bot turned *ON* (Action: *${updated.action.toUpperCase()}*).` },
          { quoted: msg },
        );
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntibotStore.setGroupConfig(from, { enabled: false });
        return sock.sendMessage(from, { text: '🛑 Anti-Bot turned *OFF*.' }, { quoted: msg });
      }

      const direct = normalizeCompositeAction(sub, ANTIBOT_ACTIONS);
      if (direct || sub === 'set' || sub === 'action' || sub === 'mode') {
        const chosen = direct || normalizeCompositeAction(tokens[1], ANTIBOT_ACTIONS);
        if (!chosen) {
          return sock.sendMessage(from, { text: `❌ Usage: *${prefix}antibot set <delete|warn|kick>*` }, { quoted: msg });
        }
        const updated = defaultAntibotStore.setGroupConfig(from, { enabled: true, action: chosen });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Bot action set to *${updated.action.toUpperCase()}*.` },
          { quoted: msg },
        );
      }

      return sock.sendMessage(
        from,
        { text: `❌ Unknown option *"${sub}"*. Use *${prefix}antibot* for usage.` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'antispam',
    aliases: ['nospam', 'spamguard'],
    description: 'Detect and block repeated text/sticker/media spam bursts in groups.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg, text, args = [], config: ctxConfig, isGroupAdmin, isBotGroupAdmin, isOwner }) => {
      if (!guardGroupAndAdmins({ sock, from, msg, isGroupAdmin, isBotGroupAdmin, isOwner })) return;
      const activeConfig = ctxConfig || config;
      const botName = activeConfig?.BOT_NAME || 'Spider Man';
      const prefix = activeConfig?.PREFIXES?.[0] || '.';
      const tokens = getTokens(text, args);
      const sub = String(tokens[0] || '').toLowerCase();
      const cur = defaultAntispamStore.getGroupConfig(from);

      if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
        const out = [
          spiderHeader(botName, 'ANTISPAM SHIELD'),
          spiderRow('STATUS', cur.enabled ? 'ON ✅' : 'OFF ❌', '⛨'),
          spiderRow('ACTION', cur.action.toUpperCase(), '⚡'),
          spiderRow('THRESHOLD', `${cur.repeatLimit} repeats / ${cur.windowSec}s`, '◷'),
          spiderRow('WARN LIMIT', `${cur.maxWarns} warn(s)`, '▣'),
          spiderRow('STATS', `${cur.stats.detected} caught · ${cur.stats.deleted} del · ${cur.stats.kicked} kicked`, '▤'),
          spiderDivider('CONTROLS'),
          `> ┃ ▸ *${prefix}antispam on [delete|warn|kick|warnkick|mute]*`,
          `> ┃ ▸ *${prefix}antispam off*`,
          `> ┃ ▸ *${prefix}antispam set <delete|warn|kick|warnkick|mute>*`,
          `> ┃ ▸ *${prefix}antispam limit <2-20>* | *window <3-120>*`,
          spiderFooter('ANTISPAM // SPIDER-MAN'),
        ].join('\n');
        return sock.sendMessage(from, { text: out }, { quoted: msg });
      }

      if (sub === 'on' || sub === 'enable') {
        const chosen = tokens[1] ? normalizeCompositeAction(tokens[1], ANTISPAM_ACTIONS) : cur.action;
        if (tokens[1] && !chosen) {
          return sock.sendMessage(from, { text: `❌ Valid actions: *${ANTISPAM_ACTIONS.join(', ')}*` }, { quoted: msg });
        }
        defaultSpamTracker.resetGroup(from);
        const updated = defaultAntispamStore.setGroupConfig(from, { enabled: true, action: chosen || 'delete' });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Spam turned *ON* (Action: *${updated.action.toUpperCase()}*).` },
          { quoted: msg },
        );
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntispamStore.setGroupConfig(from, { enabled: false });
        defaultSpamTracker.resetGroup(from);
        return sock.sendMessage(from, { text: '🛑 Anti-Spam turned *OFF*.' }, { quoted: msg });
      }

      if (sub === 'limit' || sub === 'repeats') {
        const num = Number.parseInt(String(tokens[1] || ''), 10);
        if (!Number.isInteger(num) || num < 2 || num > 20) {
          return sock.sendMessage(from, { text: '❌ Specify repeat limit between 2 and 20.' }, { quoted: msg });
        }
        const updated = defaultAntispamStore.setGroupConfig(from, { repeatLimit: num });
        return sock.sendMessage(from, { text: `✅ Anti-Spam repeat threshold set to *${updated.repeatLimit}*.` }, { quoted: msg });
      }

      if (sub === 'window' || sub === 'seconds') {
        const num = Number.parseInt(String(tokens[1] || ''), 10);
        if (!Number.isInteger(num) || num < 3 || num > 120) {
          return sock.sendMessage(from, { text: '❌ Specify time window between 3 and 120 seconds.' }, { quoted: msg });
        }
        const updated = defaultAntispamStore.setGroupConfig(from, { windowSec: num });
        return sock.sendMessage(from, { text: `✅ Anti-Spam window set to *${updated.windowSec}s*.` }, { quoted: msg });
      }

      const direct = normalizeCompositeAction(sub, ANTISPAM_ACTIONS);
      if (direct || sub === 'set' || sub === 'action' || sub === 'mode') {
        const chosen = direct || normalizeCompositeAction(tokens[1], ANTISPAM_ACTIONS);
        if (!chosen) {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antispam set <delete|warn|kick|warnkick|mute>*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntispamStore.setGroupConfig(from, { enabled: true, action: chosen });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Spam action set to *${updated.action.toUpperCase()}*.` },
          { quoted: msg },
        );
      }

      return sock.sendMessage(
        from,
        { text: `❌ Unknown option *"${sub}"*. Use *${prefix}antispam* for usage.` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'antidemote',
    aliases: ['antidem'],
    description: 'Protect group admins against unauthorized demotions (revert, revertkick, kick).',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg, text, args = [], config: ctxConfig, isGroupAdmin, isBotGroupAdmin, isOwner }) => {
      if (!guardGroupAndAdmins({ sock, from, msg, isGroupAdmin, isBotGroupAdmin, isOwner })) return;
      const activeConfig = ctxConfig || config;
      const botName = activeConfig?.BOT_NAME || 'Spider Man';
      const prefix = activeConfig?.PREFIXES?.[0] || '.';
      const tokens = getTokens(text, args);
      const sub = String(tokens[0] || '').toLowerCase();
      const cur = defaultAntidemoteStore.getGroupConfig(from);

      if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
        const out = [
          spiderHeader(botName, 'ANTI-DEMOTE SHIELD'),
          spiderRow('STATUS', cur.enabled ? 'ON ✅' : 'OFF ❌', '🛡️'),
          spiderRow('ACTION', cur.action.toUpperCase(), '⚡'),
          spiderRow('STATS', `${cur.stats.detected} caught · ${cur.stats.reverted} reverted · ${cur.stats.kicked} kicked`, '▤'),
          spiderDivider('CONTROLS'),
          `> ┃ ▸ *${prefix}antidemote on [revert|revertkick|kick]*`,
          `> ┃ ▸ *${prefix}antidemote off*`,
          `> ┃ ▸ *${prefix}antidemote set <revert|revertkick|kick>*`,
          spiderFooter('ANTIDEMOTE // SPIDER-MAN'),
        ].join('\n');
        return sock.sendMessage(from, { text: out }, { quoted: msg });
      }

      if (sub === 'on' || sub === 'enable') {
        const chosen = tokens[1] ? String(tokens[1]).toLowerCase() : cur.action;
        if (tokens[1] && !ANTIDEMOTE_ACTIONS.includes(chosen)) {
          return sock.sendMessage(from, { text: `❌ Valid actions: *${ANTIDEMOTE_ACTIONS.join(', ')}*` }, { quoted: msg });
        }
        const updated = defaultAntidemoteStore.setGroupConfig(from, { enabled: true, action: chosen || 'revertkick' });
        return sock.sendMessage(
          from,
          { text: `🛡️ Anti-Demote turned *ON* (Action: *${updated.action.toUpperCase()}*).` },
          { quoted: msg },
        );
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntidemoteStore.setGroupConfig(from, { enabled: false });
        return sock.sendMessage(from, { text: '🛑 Anti-Demote turned *OFF*.' }, { quoted: msg });
      }

      const direct = ANTIDEMOTE_ACTIONS.includes(sub) ? sub : null;
      if (direct || sub === 'set' || sub === 'action' || sub === 'mode') {
        const chosen = direct || String(tokens[1] || '').toLowerCase();
        if (!ANTIDEMOTE_ACTIONS.includes(chosen)) {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antidemote set <revert|revertkick|kick>*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntidemoteStore.setGroupConfig(from, { enabled: true, action: chosen });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Demote action set to *${updated.action.toUpperCase()}*.` },
          { quoted: msg },
        );
      }

      return sock.sendMessage(
        from,
        { text: `❌ Unknown option *"${sub}"*. Use *${prefix}antidemote* for usage.` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'anticall',
    aliases: ['nocall', 'blockcall'],
    description: 'Owner-only: reject or auto-block incoming WhatsApp calls.',
    category: 'Settings',
    ownerOnly: true,
    execute: async ({ sock, from, msg, text, args = [], isOwner, config: ctxConfig }) => {
      if (!isOwner) {
        return sock.sendMessage(from, { text: '❌ This command is restricted to the bot owner.' }, { quoted: msg });
      }
      const activeConfig = ctxConfig || config;
      const botName = activeConfig?.BOT_NAME || 'Spider Man';
      const prefix = activeConfig?.PREFIXES?.[0] || '.';
      const tokens = getTokens(text, args);
      const sub = String(tokens[0] || '').toLowerCase();
      const state = defaultAnticallStore.getState();

      if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
        const out = [
          spiderHeader(botName, 'ANTI-CALL SHIELD'),
          spiderRow('STATUS', state.enabled || activeConfig.ANTICALL ? 'ON ✅' : 'OFF ❌', '📵'),
          spiderRow('MODE', state.mode === 'block' ? 'REJECT & AUTO-BLOCK' : 'REJECTION ONLY', '⚡'),
          spiderDivider('CONTROLS'),
          `> ┃ ▸ *${prefix}anticall on* — Reject & auto-block callers`,
          `> ┃ ▸ *${prefix}anticall reject* — Reject calls only (no block)`,
          `> ┃ ▸ *${prefix}anticall off* — Disable anti-call`,
          spiderFooter('ANTICALL // SPIDER-MAN'),
        ].join('\n');
        return sock.sendMessage(from, { text: out }, { quoted: msg });
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAnticallStore.setState({ enabled: false });
        activeConfig.ANTICALL = false;
        config.ANTICALL = false;
        resetAnticallCooldowns();
        return sock.sendMessage(from, { text: '🛑 Anti-Call is now *DISABLED*.' }, { quoted: msg });
      }

      if (sub === 'on' || sub === 'enable' || sub === 'block' || sub === 'reject') {
        const mode = sub === 'reject' ? 'reject' : 'block';
        defaultAnticallStore.setState({ enabled: true, mode });
        activeConfig.ANTICALL = true;
        config.ANTICALL = true;
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Call *ENABLED* (Mode: *${mode === 'block' ? 'Reject & Auto-Block' : 'Rejection Only'}*).`,
          },
          { quoted: msg },
        );
      }

      return sock.sendMessage(
        from,
        { text: `❌ Usage: *${prefix}anticall on|reject|off|status*` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'antivv',
    aliases: ['avv', 'autovv'],
    description: 'Owner-only: automatically reveal and forward view-once media to the owner DM.',
    category: 'Settings',
    ownerOnly: true,
    execute: async ({ sock, from, msg, text, args = [], isOwner, config: ctxConfig }) => {
      if (!isOwner) {
        return sock.sendMessage(from, { text: '❌ This command is restricted to the bot owner.' }, { quoted: msg });
      }
      const activeConfig = ctxConfig || config;
      const botName = activeConfig?.BOT_NAME || 'Spider Man';
      const prefix = activeConfig?.PREFIXES?.[0] || '.';
      const tokens = getTokens(text, args);
      const sub = String(tokens[0] || '').toLowerCase();
      const state = defaultAntivvStore.getState();

      if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
        const out = [
          spiderHeader(botName, 'ANTI-VIEWONCE SHIELD'),
          spiderRow('STATUS', state.enabled ? 'ON ✅' : 'OFF ❌', '👁️'),
          spiderDivider('CONTROLS'),
          `> ┃ ▸ *${prefix}antivv on* — Auto-forward view-once media`,
          `> ┃ ▸ *${prefix}antivv off* — Disable auto-forward`,
          `> ┃ ▸ *${prefix}antivv toggle* — Flip state`,
          spiderFooter('ANTIVV // SPIDER-MAN'),
        ].join('\n');
        return sock.sendMessage(from, { text: out }, { quoted: msg });
      }

      if (sub === 'on' || sub === 'enable') {
        defaultAntivvStore.setEnabled(true);
        return sock.sendMessage(
          from,
          { text: '👁️ *Anti-ViewOnce ENABLED.* All view-once media will be forwarded to the owner DM.' },
          { quoted: msg },
        );
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntivvStore.setEnabled(false);
        return sock.sendMessage(
          from,
          { text: '🙈 *Anti-ViewOnce DISABLED.*' },
          { quoted: msg },
        );
      }

      if (sub === 'toggle') {
        const next = defaultAntivvStore.toggle();
        return sock.sendMessage(
          from,
          { text: next.enabled ? '👁️ *Anti-ViewOnce ENABLED.*' : '🙈 *Anti-ViewOnce DISABLED.*' },
          { quoted: msg },
        );
      }

      return sock.sendMessage(
        from,
        { text: `❌ Usage: *${prefix}antivv on|off|toggle|status*` },
        { quoted: msg },
      );
    },
  },
];
