import config from '../../spider/config.js';
import { spiderDivider, spiderFooter, spiderHeader, spiderRow } from '../utils/tableStyle.js';
import { cleanJid, extractLid, extractPhoneDigits, resolveParticipantRole } from '../../spider/utils/groupRoleResolver.js';
import {
  collectParticipantAlternates,
  executeParticipantsAction,
  extractContextInfo,
  isFromBot,
  resolveTargetFromMessage,
} from '../../spider/utils/groupActionHelper.js';
import {
  ANTIBUG_ACTIONS,
  ANTIBUG_MAX_LENGTH,
  ANTIBUG_MIN_LENGTH,
  defaultAntibugStore,
  detectBugPayload,
} from '../../spider/utils/antibug.js';
import {
  ANTIFORWARD_ACTIONS,
  ANTIFORWARD_MODES,
  defaultAntiforwardStore,
} from '../../spider/utils/antiforward.js';
import {
  ANTICHANNEL_ACTIONS,
  defaultAntichannelStore,
} from '../../spider/utils/antichannel.js';
import {
  ANTIMEDIA_ACTIONS,
  ATTACHMENT_FILTERS,
  defaultAntimediaStore,
} from '../../spider/utils/antimedia.js';
import { defaultAntirejoinStore } from '../../spider/utils/antirejoin.js';
import { ANTIADD_ACTIONS, defaultAntiaddStore } from '../../spider/utils/antiadd.js';

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
  if (v === 'del' || v === 'delete-only' || v === 'deleteonly') return allowed.includes('delete') ? 'delete' : null;
  if (v === 'delete-warn' || v === 'delete+warn' || v === 'deletewarn') return allowed.includes('warn') ? 'warn' : null;
  if (v === 'delete-kick' || v === 'delete+kick' || v === 'deletekick' || v === 'ban') {
    return allowed.includes('kick') ? 'kick' : null;
  }
  if (v === 'warn-kick' || v === 'warn_kick' || v === 'wk') return allowed.includes('warnkick') ? 'warnkick' : null;
  return allowed.includes(v) ? v : null;
}

function handleStandardShieldSubcommands({
  sub,
  tokens,
  prefix,
  cmdName,
  label,
  title,
  footer,
  botName,
  allowedActions,
  defaultAction = 'delete',
  store,
  from,
  msg,
  sock,
  extraRows = () => [],
  extraControls = [],
}) {
  const cur = store.getGroupConfig(from);

  if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
    const resolvedExtraRows = typeof extraRows === 'function'
      ? extraRows(cur)
      : Array.isArray(extraRows)
        ? extraRows
        : [];
    const out = [
      spiderHeader(botName, title),
      spiderRow('STATUS', cur.enabled ? 'ON ✅' : 'OFF ❌', '⛨'),
      spiderRow('ACTION', cur.action.toUpperCase(), '⚡'),
      ...resolvedExtraRows,
      spiderRow('WARN LIMIT', `${cur.maxWarns} warn(s)`, '▣'),
      spiderRow('ALERTS', cur.notify ? 'ON' : 'OFF', '◈'),
      spiderRow('WHITELIST', String(cur.whitelist.length), '✦'),
      spiderRow(
        'STATS',
        `${cur.stats.detected} caught · ${cur.stats.deleted} del · ${cur.stats.kicked} kicked`,
        '▤',
      ),
      spiderDivider('CONTROLS'),
      `> ┃ ▸ *${prefix}${cmdName} on [${allowedActions.join('|')}]*`,
      `> ┃ ▸ *${prefix}${cmdName} off*`,
      `> ┃ ▸ *${prefix}${cmdName} set <${allowedActions.join('|')}>*`,
      ...extraControls,
      `> ┃ ▸ *${prefix}${cmdName} warnlimit <1-10>*`,
      `> ┃ ▸ *${prefix}${cmdName} notify on|off*`,
      `> ┃ ▸ *${prefix}${cmdName} whitelist add|remove|list <@user|number>*`,
      `> ┃ ▸ *${prefix}${cmdName} resetwarns [@user]*`,
      spiderFooter(footer),
    ].join('\n');
    return sock.sendMessage(from, { text: out }, { quoted: msg });
  }

  if (sub === 'on' || sub === 'enable') {
    const chosen = tokens[1] ? normalizeCompositeAction(tokens[1], allowedActions) : cur.action;
    if (tokens[1] && !chosen) {
      return sock.sendMessage(
        from,
        { text: `❌ Valid actions: *${allowedActions.join(', ')}*` },
        { quoted: msg },
      );
    }
    const updated = store.setGroupConfig(from, {
      enabled: true,
      action: chosen || cur.action || defaultAction,
    });
    return sock.sendMessage(
      from,
      { text: `✅ ${label} turned *ON* (Action: *${updated.action.toUpperCase()}*).` },
      { quoted: msg },
    );
  }

  if (sub === 'off' || sub === 'disable') {
    store.setGroupConfig(from, { enabled: false });
    return sock.sendMessage(from, { text: `🛑 ${label} turned *OFF*.` }, { quoted: msg });
  }

  const direct = normalizeCompositeAction(sub, allowedActions);
  if (direct || sub === 'set' || sub === 'action' || sub === 'mode') {
    const chosen = direct || normalizeCompositeAction(tokens[1], allowedActions);
    if (!chosen) {
      return sock.sendMessage(
        from,
        { text: `❌ Usage: *${prefix}${cmdName} set <${allowedActions.join('|')}>*` },
        { quoted: msg },
      );
    }
    const updated = store.setGroupConfig(from, { enabled: true, action: chosen });
    return sock.sendMessage(
      from,
      { text: `✅ ${label} action set to *${updated.action.toUpperCase()}* (Enabled).` },
      { quoted: msg },
    );
  }

  if (sub === 'warnlimit' || sub === 'maxwarns') {
    const num = Number.parseInt(String(tokens[1] || ''), 10);
    if (!Number.isInteger(num) || num < 1 || num > 10) {
      return sock.sendMessage(
        from,
        { text: `❌ Specify a warn limit between 1 and 10. Example: *${prefix}${cmdName} warnlimit 3*` },
        { quoted: msg },
      );
    }
    const updated = store.setGroupConfig(from, { maxWarns: num });
    return sock.sendMessage(
      from,
      { text: `✅ ${label} warn limit set to *${updated.maxWarns}* warning(s) before kick.` },
      { quoted: msg },
    );
  }

  if (sub === 'notify' || sub === 'alert' || sub === 'alerts') {
    const toggle = String(tokens[1] || '').toLowerCase();
    if (toggle !== 'on' && toggle !== 'off') {
      return sock.sendMessage(
        from,
        { text: `❌ Usage: *${prefix}${cmdName} notify on|off*` },
        { quoted: msg },
      );
    }
    const updated = store.setGroupConfig(from, { notify: toggle === 'on' });
    return sock.sendMessage(
      from,
      { text: `✅ ${label} alerts turned *${updated.notify ? 'ON' : 'OFF'}*.` },
      { quoted: msg },
    );
  }

  if (sub === 'resetwarns' || sub === 'clearwarns' || sub === 'unwarn') {
    const targetJid = getQuotedOrMentionedTarget(msg);
    if (targetJid) {
      store.resetWarns(from, targetJid);
      const num = extractPhoneDigits(targetJid) || cleanJid(targetJid).split('@')[0];
      return sock.sendMessage(
        from,
        {
          text: `✅ Cleared ${label} warnings for @${num}.`,
          mentions: [cleanJid(targetJid)],
        },
        { quoted: msg },
      );
    }
    store.resetWarns(from, null);
    return sock.sendMessage(
      from,
      { text: `✅ Cleared all ${label} warnings for this group.` },
      { quoted: msg },
    );
  }

  if (sub === 'whitelist' || sub === 'allow' || sub === 'exempt') {
    const op = String(tokens[1] || 'list').toLowerCase();
    const target = tokens.slice(2).join(' ').trim() || getQuotedOrMentionedTarget(msg) || '';

    if (op === 'list') {
      if (!cur.whitelist.length) {
        return sock.sendMessage(
          from,
          { text: `ℹ️ ${label} whitelist is empty. Use *${prefix}${cmdName} whitelist add <@user|number>*.` },
          { quoted: msg },
        );
      }
      const listText = [
        spiderHeader(botName, `${cmdName.toUpperCase()} WHITELIST`),
        ...cur.whitelist.map((item, idx) => spiderRow(String(idx + 1).padStart(2, '0'), item, '✦')),
        spiderFooter(`TOTAL // ${cur.whitelist.length}`),
      ].join('\n');
      return sock.sendMessage(from, { text: listText }, { quoted: msg });
    }

    if (op === 'add') {
      if (!target) {
        return sock.sendMessage(
          from,
          { text: `❌ Usage: *${prefix}${cmdName} whitelist add <@user|number>*` },
          { quoted: msg },
        );
      }
      const { added, entry } = store.addWhitelist(from, target);
      return sock.sendMessage(
        from,
        {
          text: added
            ? `✅ Added *${entry}* to the ${label} whitelist.`
            : `ℹ️ *${entry || target}* is already whitelisted.`,
        },
        { quoted: msg },
      );
    }

    if (op === 'remove' || op === 'del' || op === 'rm') {
      if (!target) {
        return sock.sendMessage(
          from,
          { text: `❌ Usage: *${prefix}${cmdName} whitelist remove <@user|number>*` },
          { quoted: msg },
        );
      }
      const { removed, entry } = store.removeWhitelist(from, target);
      return sock.sendMessage(
        from,
        {
          text: removed
            ? `✅ Removed *${entry}* from the ${label} whitelist.`
            : `❌ *${entry || target}* was not found in the whitelist.`,
        },
        { quoted: msg },
      );
    }

    return sock.sendMessage(
      from,
      { text: `❌ Usage: *${prefix}${cmdName} whitelist add|remove|list <@user|number>*` },
      { quoted: msg },
    );
  }

  return null;
}

function buildMediaAttachmentCommand({
  name,
  aliases,
  description,
  label,
  title,
  footer,
  type,
}) {
  const allowedFilters = ATTACHMENT_FILTERS[type] || ['all'];
  return {
    name,
    aliases,
    description,
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
      const typeStore = defaultAntimediaStore.forType(type);

      if (allowedFilters.length > 1 && (sub === 'filter' || sub === 'type' || sub === 'only')) {
        const chosenFilter = String(tokens[1] || '').toLowerCase();
        if (!allowedFilters.includes(chosenFilter)) {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}${name} filter <${allowedFilters.join('|')}>*` },
            { quoted: msg },
          );
        }
        const updated = typeStore.setGroupConfig(from, { filter: chosenFilter });
        return sock.sendMessage(
          from,
          { text: `✅ ${label} filter set to *${updated.filter.toUpperCase()}*.` },
          { quoted: msg },
        );
      }

      const handled = await handleStandardShieldSubcommands({
        sub,
        tokens,
        prefix,
        cmdName: name,
        label,
        title,
        footer,
        botName,
        allowedActions: ANTIMEDIA_ACTIONS,
        defaultAction: 'delete',
        store: typeStore,
        from,
        msg,
        sock,
        extraRows: (cur) =>
          allowedFilters.length > 1
            ? [spiderRow('FILTER', `${cur.filter.toUpperCase()} (${allowedFilters.join('/')})`, '❖')]
            : [],
        extraControls:
          allowedFilters.length > 1
            ? [`> ┃ ▸ *${prefix}${name} filter <${allowedFilters.join('|')}>*`]
            : [],
      });
      if (handled !== null) return handled;

      return sock.sendMessage(
        from,
        { text: `❌ Unknown option *"${sub}"*. Use *${prefix}${name}* for usage.` },
        { quoted: msg },
      );
    },
  };
}

export const commands = [
  {
    name: 'antibug',
    aliases: ['antivirtex', 'anticrash'],
    description: 'Detect and block lag/crash virtex payloads, Zalgo combining floods, zero-width bombs, and oversized messages.',
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

      if (sub === 'limit' || sub === 'maxlen' || sub === 'length') {
        const lenNum = Number.parseInt(String(tokens[1] || ''), 10);
        if (!Number.isInteger(lenNum) || lenNum < ANTIBUG_MIN_LENGTH || lenNum > ANTIBUG_MAX_LENGTH) {
          return sock.sendMessage(
            from,
            {
              text: `❌ Specify max message length between ${ANTIBUG_MIN_LENGTH} and ${ANTIBUG_MAX_LENGTH} chars. Example: *${prefix}antibug limit 3000*`,
            },
            { quoted: msg },
          );
        }
        const updated = defaultAntibugStore.setGroupConfig(from, { maxLength: lenNum });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Bug max length threshold set to *${updated.maxLength}* characters.` },
          { quoted: msg },
        );
      }

      if (sub === 'check' || sub === 'test') {
        const sample = tokens.slice(1).join(' ').trim();
        if (!sample) {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antibug check <sample text>*` },
            { quoted: msg },
          );
        }
        const cur = defaultAntibugStore.getGroupConfig(from);
        const res = detectBugPayload({ text: sample, maxLength: cur.maxLength });
        return sock.sendMessage(
          from,
          {
            text: res.isBug
              ? `⚠️ *BUG PAYLOAD DETECTED*\n• Type: *${res.type}*\n• Reason: *${res.reason}*`
              : `✅ Clean (${res.metrics.length} chars, ${res.metrics.combiningCount} combining marks, ${res.metrics.zeroWidthCount} zero-width chars).`,
          },
          { quoted: msg },
        );
      }

      const handled = await handleStandardShieldSubcommands({
        sub,
        tokens,
        prefix,
        cmdName: 'antibug',
        label: 'Anti-Bug / Virtex',
        title: 'ANTIBUG / VIRTEX SHIELD',
        footer: 'ANTIBUG // SPIDER-MAN',
        botName,
        allowedActions: ANTIBUG_ACTIONS,
        defaultAction: 'kick',
        store: defaultAntibugStore,
        from,
        msg,
        sock,
        extraRows: (cur) => [spiderRow('MAX LENGTH', `${cur.maxLength} chars`, '📏')],
        extraControls: [
          `> ┃ ▸ *${prefix}antibug limit <${ANTIBUG_MIN_LENGTH}-${ANTIBUG_MAX_LENGTH}>*`,
          `> ┃ ▸ *${prefix}antibug check <text>*`,
        ],
      });
      if (handled !== null) return handled;

      return sock.sendMessage(
        from,
        { text: `❌ Unknown option *"${sub}"*. Use *${prefix}antibug* for usage.` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'antiforward',
    aliases: ['noforward', 'antifwd'],
    description: 'Block forwarded messages or chain/viral broadcasts (Forwarded many times) in groups.',
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

      if (sub === 'many' || sub === 'viral' || sub === 'all') {
        const chosenMode = sub === 'all' ? 'all' : 'many';
        const updated = defaultAntiforwardStore.setGroupConfig(from, { enabled: true, mode: chosenMode });
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Forward enabled in *${updated.mode === 'many' ? 'MANY TIMES ONLY (score ≥ 5)' : 'ALL FORWARDS'}* mode (Action: *${updated.action.toUpperCase()}*).`,
          },
          { quoted: msg },
        );
      }

      if (sub === 'filter' || sub === 'scope') {
        const rawScope = String(tokens[1] || '').toLowerCase();
        const chosenMode = rawScope === 'viral' || rawScope === 'many' ? 'many' : rawScope === 'all' ? 'all' : null;
        if (!chosenMode || !ANTIFORWARD_MODES.includes(chosenMode)) {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antiforward filter <all|many>*` },
            { quoted: msg },
          );
        }
        const updated = defaultAntiforwardStore.setGroupConfig(from, { mode: chosenMode });
        return sock.sendMessage(
          from,
          {
            text: `✅ Anti-Forward filter set to *${updated.mode === 'many' ? 'MANY TIMES (score ≥ 5)' : 'ALL FORWARDS'}*.`,
          },
          { quoted: msg },
        );
      }

      const handled = await handleStandardShieldSubcommands({
        sub,
        tokens,
        prefix,
        cmdName: 'antiforward',
        label: 'Anti-Forward',
        title: 'ANTIFORWARD SHIELD',
        footer: 'ANTIFORWARD // SPIDER-MAN',
        botName,
        allowedActions: ANTIFORWARD_ACTIONS,
        defaultAction: 'delete',
        store: defaultAntiforwardStore,
        from,
        msg,
        sock,
        extraRows: (cur) => [
          spiderRow('SCOPE', cur.mode === 'many' ? 'MANY TIMES (score ≥ 5)' : 'ALL FORWARDS', '↪'),
        ],
        extraControls: [`> ┃ ▸ *${prefix}antiforward filter <all|many>*`],
      });
      if (handled !== null) return handled;

      return sock.sendMessage(
        from,
        { text: `❌ Unknown option *"${sub}"*. Use *${prefix}antiforward* for usage.` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'antichannel',
    aliases: ['antinewsletter', 'nochannel'],
    description: 'Block forwarded WhatsApp Channel / Newsletter cards and channel invites in groups.',
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

      const handled = await handleStandardShieldSubcommands({
        sub,
        tokens,
        prefix,
        cmdName: 'antichannel',
        label: 'Anti-Channel / Newsletter',
        title: 'ANTICHANNEL SHIELD',
        footer: 'ANTICHANNEL // SPIDER-MAN',
        botName,
        allowedActions: ANTICHANNEL_ACTIONS,
        defaultAction: 'delete',
        store: defaultAntichannelStore,
        from,
        msg,
        sock,
      });
      if (handled !== null) return handled;

      return sock.sendMessage(
        from,
        { text: `❌ Unknown option *"${sub}"*. Use *${prefix}antichannel* for usage.` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'antirejoin',
    aliases: ['autoban', 'norejoin'],
    description: 'Remember kicked members per group and auto-remove them if they rejoin via invite link until unbanned.',
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
      const cur = defaultAntirejoinStore.getGroupConfig(from);

      if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
        const out = [
          spiderHeader(botName, 'ANTIREJOIN // AUTOBAN'),
          spiderRow('STATUS', cur.enabled ? 'ON ✅' : 'OFF ❌', '🚫'),
          spiderRow('AUTO-BAN KICKED', cur.autobanOnKick ? 'ON' : 'OFF', '⚡'),
          spiderRow('BANNED COUNT', String(cur.banned.length), '📋'),
          spiderRow('REJOINS BLOCKED', String(cur.stats.blockedRejoins), '🛡'),
          spiderRow('ALERTS', cur.notify ? 'ON' : 'OFF', '◈'),
          spiderDivider('CONTROLS'),
          `> ┃ ▸ *${prefix}antirejoin on* / *off*`,
          `> ┃ ▸ *${prefix}antirejoin ban @user|number* — Ban & remove`,
          `> ┃ ▸ *${prefix}antirejoin unban @user|number* — Allow rejoin`,
          `> ┃ ▸ *${prefix}antirejoin list* — View banned users`,
          `> ┃ ▸ *${prefix}antirejoin clear* — Clear group ban list`,
          `> ┃ ▸ *${prefix}antirejoin autoban on|off* — Auto-ban on kick`,
          `> ┃ ▸ *${prefix}antirejoin notify on|off*`,
          spiderFooter('ANTIREJOIN // SPIDER-MAN'),
        ].join('\n');
        return sock.sendMessage(from, { text: out }, { quoted: msg });
      }

      if (sub === 'on' || sub === 'enable') {
        defaultAntirejoinStore.setGroupConfig(from, { enabled: true });
        return sock.sendMessage(
          from,
          { text: '✅ *Anti-Rejoin (Autoban) ENABLED.* Kicked members will be remembered and auto-removed if they rejoin.' },
          { quoted: msg },
        );
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntirejoinStore.setGroupConfig(from, { enabled: false });
        return sock.sendMessage(
          from,
          { text: '🛑 *Anti-Rejoin (Autoban) DISABLED.*' },
          { quoted: msg },
        );
      }

      if (sub === 'autoban') {
        const toggle = String(tokens[1] || '').toLowerCase();
        if (toggle !== 'on' && toggle !== 'off') {
          return sock.sendMessage(from, { text: `❌ Usage: *${prefix}antirejoin autoban on|off*` }, { quoted: msg });
        }
        const updated = defaultAntirejoinStore.setGroupConfig(from, { autobanOnKick: toggle === 'on' });
        return sock.sendMessage(
          from,
          { text: `✅ Auto-ban on member kick turned *${updated.autobanOnKick ? 'ON' : 'OFF'}*.` },
          { quoted: msg },
        );
      }

      if (sub === 'notify' || sub === 'alert' || sub === 'alerts') {
        const toggle = String(tokens[1] || '').toLowerCase();
        if (toggle !== 'on' && toggle !== 'off') {
          return sock.sendMessage(from, { text: `❌ Usage: *${prefix}antirejoin notify on|off*` }, { quoted: msg });
        }
        const updated = defaultAntirejoinStore.setGroupConfig(from, { notify: toggle === 'on' });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Rejoin alerts turned *${updated.notify ? 'ON' : 'OFF'}*.` },
          { quoted: msg },
        );
      }

      if (sub === 'list') {
        if (!cur.banned.length) {
          return sock.sendMessage(
            from,
            { text: `ℹ️ No banned users recorded in this group. Use *${prefix}antirejoin ban @user|number*.` },
            { quoted: msg },
          );
        }
        const out = [
          spiderHeader(botName, 'GROUP BAN LIST'),
          ...cur.banned.slice(0, 50).map((b, i) => {
            const disp = b.phone || b.lid || b.jid || b.key;
            return spiderRow(String(i + 1).padStart(2, '0'), `${disp} (${b.reason || 'Banned'})`, '🚫');
          }),
          spiderFooter(`TOTAL BANNED // ${cur.banned.length}`),
        ].join('\n');
        return sock.sendMessage(from, { text: out }, { quoted: msg });
      }

      if (sub === 'clear' || sub === 'reset') {
        const { clearedCount } = defaultAntirejoinStore.clearBans(from);
        return sock.sendMessage(
          from,
          { text: `✅ Cleared *${clearedCount}* ban record(s) for this group.` },
          { quoted: msg },
        );
      }

      if (sub === 'ban' || sub === 'add') {
        const metadata = await fetchMetaSafe(sock, from);
        const resolved = resolveTargetFromMessage({
          sock,
          from,
          msg,
          text: tokens.slice(1).join(' '),
          args: tokens.slice(1),
          metadata,
          allowSenderFallback: false,
        });
        if (!resolved.targetJid) {
          return sock.sendMessage(
            from,
            { text: `❌ Reply to, tag, or pass a phone number. Example: *${prefix}antirejoin ban @user*` },
            { quoted: msg },
          );
        }
        const alts = [resolved.targetJid, ...resolved.alternateJids];
        if (isFromBot(alts, sock)) {
          return sock.sendMessage(from, { text: '❌ Cannot ban the bot itself.' }, { quoted: msg });
        }
        const role = metadata ? resolveParticipantRole(metadata, resolved.targetJid) : null;
        if (role?.isAdmin || role?.isOwner) {
          return sock.sendMessage(from, { text: '❌ Cannot ban a group admin or group owner.' }, { quoted: msg });
        }

        const phone = resolved.phone || extractPhoneDigits(resolved.targetJid);
        const lid = extractLid(resolved.targetJid) || alts.map((a) => extractLid(a)).find(Boolean) || '';
        const senderJid = cleanJid(msg?.key?.participant || msg?.key?.participantAlt || '');
        const banRes = defaultAntirejoinStore.banUser(from, {
          jid: resolved.targetJid,
          candidates: alts,
          phone,
          lid,
          bannedBy: senderJid,
          reason: 'Manually banned by admin',
        });
        defaultAntirejoinStore.setGroupConfig(from, { enabled: true });

        let kickedNow = false;
        if (role?.participant) {
          const kickRes = await executeParticipantsAction({
            sock,
            from,
            participants: [resolved.targetJid, ...alts],
            action: 'remove',
            metadata,
          });
          kickedNow = kickRes.ok;
        }

        return sock.sendMessage(
          from,
          {
            text: `🚫 Banned *@${resolved.displayUser}* from rejoining this group${kickedNow ? ' and removed them' : ''}. (${banRes.config.banned.length} total banned)`,
            mentions: resolved.mentionJid ? [resolved.mentionJid] : [],
          },
          { quoted: msg },
        );
      }

      if (sub === 'unban' || sub === 'remove' || sub === 'del' || sub === 'allow') {
        const metadata = await fetchMetaSafe(sock, from);
        const rawRest = tokens.slice(1).join(' ').trim();
        const resolved = resolveTargetFromMessage({
          sock,
          from,
          msg,
          text: rawRest,
          args: tokens.slice(1),
          metadata,
          allowSenderFallback: false,
        });
        const candidates = [
          resolved.targetJid,
          ...resolved.alternateJids,
          rawRest,
        ].filter(Boolean);
        if (candidates.length === 0) {
          return sock.sendMessage(
            from,
            { text: `❌ Usage: *${prefix}antirejoin unban <@user|number>*` },
            { quoted: msg },
          );
        }
        const { removed } = defaultAntirejoinStore.unbanUser(from, candidates);
        const display = resolved.displayUser || rawRest.replace(/^@/, '');
        return sock.sendMessage(
          from,
          {
            text: removed
              ? `✅ Unbanned *${display}*. They may now rejoin this group.`
              : `❌ *${display}* was not found in the group ban list.`,
            ...(resolved.mentionJid ? { mentions: [resolved.mentionJid] } : {}),
          },
          { quoted: msg },
        );
      }

      return sock.sendMessage(
        from,
        { text: `❌ Unknown option *"${sub}"*. Use *${prefix}antirejoin* for usage.` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'antiadd',
    aliases: ['noadd', 'antiinviteadd'],
    description: 'Block unauthorized users or rogue co-admins from adding members by auto-removing added accounts.',
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
      const cur = defaultAntiaddStore.getGroupConfig(from);

      if (!sub || sub === 'status' || sub === 'info' || sub === 'get') {
        const out = [
          spiderHeader(botName, 'ANTIADD SHIELD'),
          spiderRow('STATUS', cur.enabled ? 'ON ✅' : 'OFF ❌', '➕'),
          spiderRow('ACTION', cur.action === 'removekick' ? 'REMOVE ADDED + KICK ADDER' : 'REMOVE ADDED ACCOUNT', '⚡'),
          spiderRow('ALLOW ADMINS', cur.allowAdmins ? 'YES (Admins can add)' : 'NO (Rogue co-admins blocked)', '🛡'),
          spiderRow('ALERTS', cur.notify ? 'ON' : 'OFF', '◈'),
          spiderRow('WHITELIST', String(cur.whitelist.length), '✦'),
          spiderRow('STATS', `${cur.stats.detected} blocked · ${cur.stats.removedTargets} removed`, '▤'),
          spiderDivider('CONTROLS'),
          `> ┃ ▸ *${prefix}antiadd on [remove|removekick]*`,
          `> ┃ ▸ *${prefix}antiadd off*`,
          `> ┃ ▸ *${prefix}antiadd set <remove|removekick>*`,
          `> ┃ ▸ *${prefix}antiadd allowadmins on|off*`,
          `> ┃ ▸ *${prefix}antiadd notify on|off*`,
          `> ┃ ▸ *${prefix}antiadd whitelist add|remove|list <@user|number>*`,
          spiderFooter('ANTIADD // SPIDER-MAN'),
        ].join('\n');
        return sock.sendMessage(from, { text: out }, { quoted: msg });
      }

      if (sub === 'on' || sub === 'enable') {
        const actRaw = String(tokens[1] || '').toLowerCase();
        const chosen = actRaw
          ? (ANTIADD_ACTIONS.includes(actRaw) ? actRaw : actRaw === 'kick' ? 'removekick' : null)
          : cur.action;
        if (actRaw && !chosen) {
          return sock.sendMessage(from, { text: `❌ Valid actions: *${ANTIADD_ACTIONS.join(', ')}*` }, { quoted: msg });
        }
        const updated = defaultAntiaddStore.setGroupConfig(from, { enabled: true, action: chosen || 'remove' });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Add turned *ON* (Action: *${updated.action.toUpperCase()}*).` },
          { quoted: msg },
        );
      }

      if (sub === 'off' || sub === 'disable') {
        defaultAntiaddStore.setGroupConfig(from, { enabled: false });
        return sock.sendMessage(from, { text: '🛑 Anti-Add turned *OFF*.' }, { quoted: msg });
      }

      if (sub === 'remove' || sub === 'removekick' || sub === 'set' || sub === 'action' || sub === 'mode') {
        const rawAct = sub === 'remove' || sub === 'removekick' ? sub : String(tokens[1] || '').toLowerCase();
        const chosen = ANTIADD_ACTIONS.includes(rawAct) ? rawAct : rawAct === 'kick' ? 'removekick' : null;
        if (!chosen) {
          return sock.sendMessage(from, { text: `❌ Usage: *${prefix}antiadd set <remove|removekick>*` }, { quoted: msg });
        }
        const updated = defaultAntiaddStore.setGroupConfig(from, { enabled: true, action: chosen });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Add action set to *${updated.action.toUpperCase()}* (Enabled).` },
          { quoted: msg },
        );
      }

      if (sub === 'allowadmins' || sub === 'admins') {
        const toggle = String(tokens[1] || '').toLowerCase();
        if (toggle !== 'on' && toggle !== 'off') {
          return sock.sendMessage(from, { text: `❌ Usage: *${prefix}antiadd allowadmins on|off*` }, { quoted: msg });
        }
        const updated = defaultAntiaddStore.setGroupConfig(from, { allowAdmins: toggle === 'on' });
        return sock.sendMessage(
          from,
          {
            text: updated.allowAdmins
              ? '✅ Group admins are now *ALLOWED* to add members.'
              : '🛡️ *Strict Anti-Add:* Co-admins are now also *BLOCKED* from adding members unless whitelisted/owner.',
          },
          { quoted: msg },
        );
      }

      if (sub === 'notify' || sub === 'alert' || sub === 'alerts') {
        const toggle = String(tokens[1] || '').toLowerCase();
        if (toggle !== 'on' && toggle !== 'off') {
          return sock.sendMessage(from, { text: `❌ Usage: *${prefix}antiadd notify on|off*` }, { quoted: msg });
        }
        const updated = defaultAntiaddStore.setGroupConfig(from, { notify: toggle === 'on' });
        return sock.sendMessage(
          from,
          { text: `✅ Anti-Add alerts turned *${updated.notify ? 'ON' : 'OFF'}*.` },
          { quoted: msg },
        );
      }

      if (sub === 'whitelist' || sub === 'allow' || sub === 'exempt') {
        const op = String(tokens[1] || 'list').toLowerCase();
        const target = tokens.slice(2).join(' ').trim() || getQuotedOrMentionedTarget(msg) || '';

        if (op === 'list') {
          if (!cur.whitelist.length) {
            return sock.sendMessage(
              from,
              { text: `ℹ️ Anti-Add whitelist is empty. Use *${prefix}antiadd whitelist add <@user|number>*.` },
              { quoted: msg },
            );
          }
          const listText = [
            spiderHeader(botName, 'ANTIADD WHITELIST'),
            ...cur.whitelist.map((item, idx) => spiderRow(String(idx + 1).padStart(2, '0'), item, '✦')),
            spiderFooter(`TOTAL // ${cur.whitelist.length}`),
          ].join('\n');
          return sock.sendMessage(from, { text: listText }, { quoted: msg });
        }

        if (op === 'add') {
          if (!target) {
            return sock.sendMessage(from, { text: `❌ Usage: *${prefix}antiadd whitelist add <@user|number>*` }, { quoted: msg });
          }
          const { added, entry } = defaultAntiaddStore.addWhitelist(from, target);
          return sock.sendMessage(
            from,
            { text: added ? `✅ Added *${entry}* to the Anti-Add whitelist.` : `ℹ️ *${entry || target}* is already whitelisted.` },
            { quoted: msg },
          );
        }

        if (op === 'remove' || op === 'del' || op === 'rm') {
          if (!target) {
            return sock.sendMessage(from, { text: `❌ Usage: *${prefix}antiadd whitelist remove <@user|number>*` }, { quoted: msg });
          }
          const { removed, entry } = defaultAntiaddStore.removeWhitelist(from, target);
          return sock.sendMessage(
            from,
            { text: removed ? `✅ Removed *${entry}* from the Anti-Add whitelist.` : `❌ *${entry || target}* not found in whitelist.` },
            { quoted: msg },
          );
        }

        return sock.sendMessage(
          from,
          { text: `❌ Usage: *${prefix}antiadd whitelist add|remove|list <@user|number>*` },
          { quoted: msg },
        );
      }

      return sock.sendMessage(
        from,
        { text: `❌ Unknown option *"${sub}"*. Use *${prefix}antiadd* for usage.` },
        { quoted: msg },
      );
    },
  },
  buildMediaAttachmentCommand({
    name: 'antisticker',
    aliases: ['nosticker', 'stickerguard'],
    description: 'Block stickers in the group with delete, warn, kick, or warnkick enforcement.',
    label: 'Anti-Sticker',
    title: 'ANTISTICKER SHIELD',
    footer: 'ANTISTICKER // SPIDER-MAN',
    type: 'sticker',
  }),
  buildMediaAttachmentCommand({
    name: 'antimedia',
    aliases: ['nomedia', 'mediaguard'],
    description: 'Block image and video/GIF media in the group (all, video, image) with delete, warn, or kick.',
    label: 'Anti-Media',
    title: 'ANTIMEDIA SHIELD',
    footer: 'ANTIMEDIA // SPIDER-MAN',
    type: 'media',
  }),
  buildMediaAttachmentCommand({
    name: 'antivoice',
    aliases: ['novoice', 'antiaudio', 'noptt'],
    description: 'Block voice notes (PTT) and audio files in the group with delete, warn, or kick.',
    label: 'Anti-Voice',
    title: 'ANTIVOICE SHIELD',
    footer: 'ANTIVOICE // SPIDER-MAN',
    type: 'voice',
  }),
  buildMediaAttachmentCommand({
    name: 'antidoc',
    aliases: ['nodoc', 'antidocument', 'antiapk'],
    description: 'Block documents, .apk packages, and contact vCards in the group with delete, warn, or kick.',
    label: 'Anti-Document / APK',
    title: 'ANTIDOC SHIELD',
    footer: 'ANTIDOC // SPIDER-MAN',
    type: 'doc',
  }),
];
