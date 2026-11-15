import { createRequire } from 'node:module';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import _0x21bd49 from '../../spider/config.js';
import { collectSenderIdentities, resolveGroupRolesAsync } from '../../spider/utils/groupRoleResolver.js';
import {
  deleteMessageSafely,
  extractContextInfo,
  isFromBot,
  unwrapMessageContent,
} from '../../spider/utils/groupActionHelper.js';

const require = createRequire(import.meta.url);
const legacyConfig = require('../legacy/lil/config/settings.js');
const legacyLoader = require('../legacy/lil/handlers/loader.js');

const OWNER_ONLY_NAMES = new Set([
  'allvar',
  'getvar',
  'setvar',
  'triggerupdate',
  'update',
  'broadcast',
  'broadcaststatus',
  'robotbroadcast',
  'massdm',
  'masspromote',
  'massdemote',
  'nuke',
  'xkill',
  'mentionbomb',
  'shell',
  'eval',
  'eval2',
  'restart',
  'restartbot',
  'shutdown',
  'kill',
  'cleartmp',
  'clearcache',
  'getcmd',
  'getfunc',
  'joingc',
  'leavegc',
  'groupclone',
  'tokengen',
  'lockdown',
  'unlockdown',
  'setbotpic',
  'setmenupic',
  'setbotname',
  'setmenu',
  'setfooter',
  'setcaption',
  'botidentity',
  'rebrand',
  'tobugil',
  'undress',
  'morph',
  'hentai',
  'xvideos',
  'ass',
  'boobs',
  'fuck',
]);

const ADMIN_ONLY_NAMES = new Set([
  'add',
  'approve-all',
  'reject-all',
  'requests',
  'remove',
  'kick',
  'promote',
  'demote',
  'promoteall',
  'demoteall',
  'close',
  'open',
  'link',
  'revoke',
  'clear',
  'clearchat',
  'tagall',
  'tagadmins',
  'foreigners',
  'warn',
  'resetwarn',
  'setwarncount',
  'setwarnlimit',
  'welcome',
  'goodbye',
  'antibot',
  'antilink',
  'antistatusmention',
  'antitag',
  'antiforeign',
  'mute',
  'unmute',
  'pin',
  'pinm',
  'togstatus',
  'accept',
  'reject',
  'acceptall',
  'rejectall',
]);

function textFromMessage(content = {}) {
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content.templateButtonReplyMessage?.selectedId ||
    ''
  );
}

function typeFromMessage(content = {}) {
  return Object.keys(content)[0] || 'unknown';
}

function normalizeNumber(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function makeMessageView({ raw, sock, from, sender, senderNumber, isOwner, groupMeta, isAdmin, isBotAdmin }) {
  const rawMessage = raw?.message || {};
  const unwrappedMessage = unwrapMessageContent(rawMessage) || rawMessage;
  const { contextInfo, quotedMessage: unwrappedQuoted, rawQuotedMessage } = extractContextInfo(raw);
  const quotedMessage = unwrappedQuoted || rawQuotedMessage || null;
  const ctx = contextInfo || {};
  const isGroupChat = String(from || '').endsWith('@g.us');

  const quotedParticipant = ctx.participant || '';
  const quotedFromMe = Boolean(
    quotedParticipant
      ? isFromBot(quotedParticipant, sock)
      : (!isGroupChat && ctx.stanzaId && !quotedParticipant),
  );

  const quotedKey = ctx.stanzaId
    ? {
        remoteJid: from,
        id: ctx.stanzaId,
        ...(quotedParticipant ? { participant: quotedParticipant } : {}),
        fromMe: quotedFromMe,
      }
    : null;

  const quoted = quotedMessage
    ? {
        key: quotedKey,
        id: ctx.stanzaId || '',
        fromMe: quotedFromMe,
        message: quotedMessage,
        rawMessage: rawQuotedMessage || quotedMessage,
        sender: quotedParticipant || ctx.remoteJid || '',
        chat: from,
        mtype: typeFromMessage(quotedMessage),
        text: textFromMessage(quotedMessage),
        body: textFromMessage(quotedMessage),
        mimetype: Object.values(quotedMessage)[0]?.mimetype || '',
        get msg() {
          return Object.values(quotedMessage)[0] || null;
        },
        async download() {
          if (!quotedKey) throw new Error('Quoted media key is unavailable.');
          return downloadMediaMessage({ key: quotedKey, message: quotedMessage }, 'buffer', {});
        },
      }
    : null;

  const view = {
    ...raw,
    key: raw?.key || {},
    message: unwrappedMessage,
    rawMessage,
    chat: from,
    from,
    sender: sender || '',
    senderNumber: senderNumber || normalizeNumber(sender),
    pushName: raw?.pushName || 'WhatsApp user',
    body: textFromMessage(unwrappedMessage),
    text: textFromMessage(unwrappedMessage),
    mtype: typeFromMessage(unwrappedMessage),
    isGroup: isGroupChat,
    isOwner: Boolean(isOwner),
    fromMe: Boolean(raw?.key?.fromMe),
    isAdmin: Boolean(isAdmin),
    isBotAdmin: Boolean(isBotAdmin),
    isSuperAdmin: Boolean(isAdmin),
    isSudo: Boolean(isOwner),
    isButtonResponse: false,
    reactKey: raw?.key,
    mentionedJid: ctx.mentionedJid || [],
    tagged: ctx.mentionedJid || [],
    participants: groupMeta?.participants || [],
    groupMetadata: groupMeta || null,
    quoted,
    quotedMsg: quotedMessage,
    quotedKey,
    quotedUser: quoted?.sender || '',
    async download() {
      return downloadMediaMessage(raw, 'buffer', {});
    },
    async reply(content, options = {}) {
      const payload = typeof content === 'string' ? { text: content } : content;
      return sock.sendMessage(from, payload, { quoted: raw, ...options });
    },
  };

  view.react = async (emoji) => sock.sendMessage(from, { react: { text: emoji, key: raw.key } });
  view.delete = async () =>
    deleteMessageSafely({
      sock,
      from,
      msg: raw,
      metadata: groupMeta,
      allowFromMeFallback: true,
      broadcastAlternates: true,
    });
  return view;
}

async function resolveGroupContext(sock, from, sender, senderNumber, msg = null) {
  if (!String(from || '').endsWith('@g.us')) {
    return { groupMeta: null, isAdmin: false, isBotAdmin: false };
  }
  try {
    const groupMeta = await sock.groupMetadata(from);
    const roles = await resolveGroupRolesAsync({
      metadata: groupMeta,
      sock,
      senderJids: collectSenderIdentities(msg, [sender, senderNumber]),
    });
    return {
      groupMeta,
      isAdmin: roles.isSenderAdmin,
      isBotAdmin: roles.isBotAdmin,
    };
  } catch {
    return { groupMeta: null, isAdmin: false, isBotAdmin: false };
  }
}

export async function loadLegacyCommands() {
  legacyConfig.BOT_NAME = _0x21bd49.BOT_NAME || 'Spider Man';
  process.env.BOT_NAME = legacyConfig.BOT_NAME;
  legacyConfig.PACK_NAME = legacyConfig.BOT_NAME;
  legacyConfig.BOT_PIC = _0x21bd49.BOT_PIC;
  if (_0x21bd49.BOT_PIC) process.env.BOT_PIC = _0x21bd49.BOT_PIC;
  legacyConfig.OWNER_NUMBER = _0x21bd49.OWNER_NUMBER || process.env.OWNER_NUMBER || '';
  legacyConfig.OWNER_NAME = _0x21bd49.OWNER_NAME || 'Spider Man Owner';
  legacyConfig.MODE = _0x21bd49.MODE;
  legacyConfig.BOT_PREFIX = _0x21bd49.PREFIXES?.[0] || '.';

  await legacyLoader.loadPlugins();
  const cmds = legacyLoader.getAllCmds();

  return cmds.map((cmd) => {
    const name = String(cmd.name || '').toLowerCase();
    const aliases = (cmd.aliases || []).map((a) => String(a).toLowerCase()).filter(Boolean);
    const categoryLabel = String(cmd.category || 'Legacy').replace(/^./, (c) => c.toUpperCase());
    const ownerOnly = OWNER_ONLY_NAMES.has(name) || ['owner', 'heroku', 'settings'].includes(cmd.category);
    const adminOnly = !ownerOnly && (cmd.adminOnly || ADMIN_ONLY_NAMES.has(name));

    return {
      name,
      aliases,
      description: cmd.desc || `Legacy ${categoryLabel} feature from the running Spider Man bot.`,
      category: `Legacy ${categoryLabel}`,
      ownerOnly: Boolean(cmd.ownerOnly || ownerOnly),
      groupOnly: Boolean(cmd.groupOnly),
      adminOnly: Boolean(adminOnly),
      execute: async (ctx) => {
        legacyConfig.MODE = ctx.config.MODE;
        const groupCtx = ctx.groupMeta
          ? {
              groupMeta: ctx.groupMeta,
              isAdmin: Boolean(ctx.isGroupAdmin),
              isBotAdmin: Boolean(ctx.isBotGroupAdmin),
            }
          : await resolveGroupContext(ctx.sock, ctx.from, ctx.sender, ctx.senderNumber, ctx.msg);

        const { groupMeta, isAdmin, isBotAdmin } = groupCtx;
        const view = makeMessageView({
          raw: ctx.msg,
          sock: ctx.sock,
          from: ctx.from,
          sender: ctx.sender,
          senderNumber: ctx.senderNumber,
          isOwner: ctx.isOwner,
          groupMeta,
          isAdmin,
          isBotAdmin,
        });

        if (cmd.groupOnly && !view.isGroup) {
          await view.reply('This command can only be used in a group.');
          return;
        }
        if (adminOnly && !isAdmin) {
          await view.reply('Only a group admin can run this command.');
          return;
        }

        const pluginContext = {
          sock: ctx.sock,
          client: ctx.sock,
          from: ctx.from,
          sender: ctx.sender,
          senderNumber: ctx.senderNumber,
          pushName: view.pushName,
          pushname: view.pushName,
          participants: view.participants,
          msg: ctx.msg,
          m: view,
          text: ctx.text,
          body: view.body,
          args: ctx.args,
          command: name,
          commandName: ctx.command || name,
          prefix: ctx.prefix || legacyConfig.BOT_PREFIX || '.',
          packname: legacyConfig.PACK_NAME || legacyConfig.BOT_NAME || 'SPIDER-MAN-MD',
          mode: legacyConfig.MODE || 'public',
          pict: legacyConfig.BOT_PIC || _0x21bd49.BOT_PIC,
          botname: legacyConfig.BOT_NAME || _0x21bd49.BOT_NAME || 'SPIDER-MAN MD',
          botspeed: Number(ctx.botspeed || 12),
          sendJson: async (client, jid, payload) => {
            if (!client) return null;
            if (typeof client.relayMessage === 'function') {
              const id = typeof client.generateMessageTag === 'function' ? client.generateMessageTag() : undefined;
              return client.relayMessage(jid, payload, id ? { messageId: id } : {});
            }
            return client.sendMessage?.(jid, payload);
          },
          groupMeta,
          isGroup: view.isGroup,
          isAdmin,
          isBotAdmin,
          isOwner: ctx.isOwner,
          quoted: view.quoted,
          reply: view.reply,
          send: (payload, options) => ctx.sock.sendMessage(ctx.from, payload, options),
          react: view.react,
          config: legacyConfig,
        };
        return cmd.handler(pluginContext);
      },
    };
  });
}

export function isLegacyOwnerOnly(name) {
  return OWNER_ONLY_NAMES.has(String(name || '').toLowerCase());
}

export function isLegacyAdminOnly(name) {
  return ADMIN_ONLY_NAMES.has(String(name || '').toLowerCase());
}