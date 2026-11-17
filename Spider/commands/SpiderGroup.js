import fs from 'node:fs';
import path from 'node:path';
import config from '../../spider/config.js';
import {
  cleanJid,
  extractPhoneDigits,
  isParticipantAdminEntry,
} from '../../spider/utils/groupRoleResolver.js';
import {
  spiderHeader,
  spiderRow,
  spiderDivider,
  spiderFooter,
} from '../utils/tableStyle.js';

const botName = () => config.BOT_NAME || 'Spider Man';

function getRulesFilePath() {
  return path.join(process.cwd(), 'data', 'grouprules.json');
}

function loadGroupRules() {
  try {
    return JSON.parse(fs.readFileSync(getRulesFilePath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveGroupRules(rulesMap) {
  const filePath = getRulesFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(rulesMap, null, 2));
}

export const commands = [
  {
    name: 'admins',
    aliases: ['listadmins', 'adminlist'],
    description: 'List all admins and the superadmin of the current group.',
    category: 'Group',
    groupOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!String(from || '').endsWith('@g.us')) {
        return sock.sendMessage(from, { text: '⛔ This command can only be used inside a group.' }, { quoted: msg });
      }
      try {
        const meta = await sock.groupMetadata(from);
        const participants = Array.isArray(meta?.participants) ? meta.participants : [];
        const admins = participants.filter((p) => isParticipantAdminEntry(p));
        if (!admins.length) {
          return sock.sendMessage(from, { text: '❌ No admins found in this group.' }, { quoted: msg });
        }
        const mentions = [];
        const rows = admins.map((p, idx) => {
          const jid = cleanJid(p.phoneNumber || p.pn || p.id || p.jid || '');
          const digits = extractPhoneDigits(jid) || jid.split('@')[0] || 'Admin';
          if (jid) mentions.push(jid);
          const role = String(p.admin || '').toLowerCase() === 'superadmin' ? '👑 Super Admin' : '🛡️ Admin';
          return spiderRow(String(idx + 1).padStart(2, '0'), `@${digits} — ${role}`, '▹');
        });
        const reply = [
          spiderHeader(botName(), `${meta?.subject || 'GROUP'} // ADMINS`),
          spiderRow('TOTAL ADMINS', String(admins.length), '🛡️'),
          spiderDivider('ADMIN ROSTER'),
          ...rows,
          spiderFooter(`${botName()} // GROUP`),
        ].join('\n');
        return sock.sendMessage(from, { text: reply, mentions }, { quoted: msg });
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to fetch admins: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'rules',
    aliases: ['grouprules'],
    description: 'View the saved rules for this group.',
    category: 'Group',
    groupOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!String(from || '').endsWith('@g.us')) {
        return sock.sendMessage(from, { text: '⛔ This command can only be used inside a group.' }, { quoted: msg });
      }
      const allRules = loadGroupRules();
      const groupRules = allRules[from];
      if (!groupRules) {
        return sock.sendMessage(
          from,
          { text: '📋 No rules have been set for this group yet.\nAdmins can set them with `.setrules <text>`.' },
          { quoted: msg },
        );
      }
      const reply = [
        spiderHeader(botName(), 'GROUP RULES'),
        ...String(groupRules).split('\n').map((line) => `> ┃ ${line}`),
        spiderFooter(`${botName()} // GROUP`),
      ].join('\n');
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'setrules',
    aliases: [],
    description: 'Set or update rules for the current group (admins only).',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    execute: async ({ sock, from, msg, text, isGroupAdmin, isOwner }) => {
      if (!String(from || '').endsWith('@g.us')) {
        return sock.sendMessage(from, { text: '⛔ This command can only be used inside a group.' }, { quoted: msg });
      }
      if (!isGroupAdmin && !isOwner) {
        return sock.sendMessage(from, { text: '⛔ Only group admins can update group rules.' }, { quoted: msg });
      }
      const content = String(text || '').trim();
      if (!content) {
        return sock.sendMessage(from, { text: '📋 Usage: `.setrules <rules text>`' }, { quoted: msg });
      }
      const allRules = loadGroupRules();
      allRules[from] = content;
      saveGroupRules(allRules);
      return sock.sendMessage(
        from,
        {
          text: [
            spiderHeader(botName(), 'GROUP RULES UPDATED'),
            ...content.split('\n').map((line) => `> ┃ ${line}`),
            spiderFooter(`${botName()} // GROUP`),
          ].join('\n'),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'delrules',
    aliases: ['clearrules'],
    description: 'Delete the saved rules for the current group (admins only).',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    execute: async ({ sock, from, msg, isGroupAdmin, isOwner }) => {
      if (!String(from || '').endsWith('@g.us')) {
        return sock.sendMessage(from, { text: '⛔ This command can only be used inside a group.' }, { quoted: msg });
      }
      if (!isGroupAdmin && !isOwner) {
        return sock.sendMessage(from, { text: '⛔ Only group admins can delete group rules.' }, { quoted: msg });
      }
      const allRules = loadGroupRules();
      if (!allRules[from]) {
        return sock.sendMessage(from, { text: 'ℹ️ This group has no saved rules to clear.' }, { quoted: msg });
      }
      delete allRules[from];
      saveGroupRules(allRules);
      return sock.sendMessage(from, { text: '🗑️ Group rules cleared.' }, { quoted: msg });
    },
  },
];
