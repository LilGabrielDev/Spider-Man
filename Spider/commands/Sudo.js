import { loadSudoList, saveSudoList } from '../../spider/utils/sudoStore.js';
import { t } from '../france/translator.js';
import { extractPhoneDigits } from '../../spider/utils/groupRoleResolver.js';
import { resolveTargetFromMessage } from '../../spider/utils/groupActionHelper.js';
import { normalizeSudoTarget } from '../../spider/utils/userJid.js';

export const commands = [
  {
    name: 'sudo',
    description: 'Add, remove, or list users with sudo access.',
    category: 'Owner',
    ownerOnly: true,
    execute: async ({ sock, from, text = '', msg, args = [] }) => {
      if (!(global.ALLOWED_USERS instanceof Set)) {
        global.ALLOWED_USERS = loadSudoList();
      }
      const tokens = (Array.isArray(args) && args.length > 0
        ? args.map((item) => String(item || '').trim())
        : String(text || '').trim().split(/\s+/)
      ).filter(Boolean);
      const subCommand = String(tokens[0] || '').toLowerCase();

      if (subCommand === 'list') {
        const users = [...global.ALLOWED_USERS];
        if (users.length === 0) {
          const emptyMsg = await t(from, 'sudo', 'listEmpty');
          return sock.sendMessage(from, { text: emptyMsg }, { quoted: msg });
        }
        const header = await t(from, 'sudo', 'listHeader');
        const listText =
          header +
          users
            .map((u, idx) => `${idx + 1}. ${String(u).includes('@') ? u : `+${u}`}`)
            .join('\n');
        return sock.sendMessage(from, { text: listText }, { quoted: msg });
      }

      const restTokens = tokens.slice(1);
      let metadata = null;
      if (from && String(from).endsWith('@g.us')) {
        try {
          metadata = await sock?.groupMetadata?.(from);
        } catch {}
      }

      const resolved = resolveTargetFromMessage({
        sock,
        from,
        msg,
        text: restTokens.join(' '),
        args: restTokens,
        metadata,
      });
      const fallbackRaw =
        msg?.message?.extendedTextMessage?.contextInfo?.participant ||
        msg?.message?.extendedTextMessage?.contextInfo?.remoteJidAlt ||
        '';
      const targetJid = resolved.targetJid || fallbackRaw;

      if (!targetJid) {
        const noReply = await t(from, 'sudo', 'noReply');
        return sock.sendMessage(from, { text: noReply }, { quoted: msg });
      }

      const number = normalizeSudoTarget(
        resolved.phone || extractPhoneDigits(targetJid) || targetJid,
      );

      if (!number) {
        const noReply = await t(from, 'sudo', 'noReply');
        return sock.sendMessage(from, { text: noReply }, { quoted: msg });
      }

      if (subCommand === 'add') {
        global.ALLOWED_USERS.add(number);
        saveSudoList(global.ALLOWED_USERS);
        const addedMsg = await t(from, 'sudo', 'added');
        return sock.sendMessage(from, { text: addedMsg.replace('{number}', number) }, { quoted: msg });
      }
      if (subCommand === 'del') {
        global.ALLOWED_USERS.delete(number);
        saveSudoList(global.ALLOWED_USERS);
        const removedMsg = await t(from, 'sudo', 'removed');
        return sock.sendMessage(from, { text: removedMsg.replace('{number}', number) }, { quoted: msg });
      }
      const invalidMsg = await t(from, 'sudo', 'invalid');
      return sock.sendMessage(from, { text: invalidMsg }, { quoted: msg });
    },
  },
];