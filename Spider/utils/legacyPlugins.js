import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import _0x21bd49 from '../../spider/config.js';
import { collectSenderIdentities, extractPhoneDigits, resolveGroupRolesAsync } from '../../spider/utils/groupRoleResolver.js';
import { SILENT_LOGGER } from '../../spider/utils/privacyLogger.js';
import { resolveRuntimeOwnerPhone } from '../../spider/utils/userJid.js';
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
  return extractPhoneDigits(jid);
}

const MEDIA_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'stickerMessage',
  'documentMessage',
  'ptvMessage',
];

function inferMediaMessageWrapper(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Media message is unavailable.');
  }
  if (input.message && typeof input.message === 'object') {
    const unwrapped = unwrapMessageContent(input.message) || input.message;
    return { ...input, message: unwrapped };
  }
  const hasMediaKey = MEDIA_KEYS.some((key) => Boolean(input[key]));
  if (hasMediaKey) {
    return { message: input };
  }
  const mime = String(input.mimetype || '').toLowerCase();
  let mediaKey = 'documentMessage';
  if (mime.includes('webp') && (input.isAnimated !== undefined || input.stickerSentTs !== undefined)) {
    mediaKey = 'stickerMessage';
  } else if (mime.startsWith('image/')) {
    mediaKey = mime === 'image/webp' ? 'stickerMessage' : 'imageMessage';
  } else if (mime.startsWith('video/')) {
    mediaKey = 'videoMessage';
  } else if (mime.startsWith('audio/')) {
    mediaKey = 'audioMessage';
  } else if (input.isAnimated !== undefined) {
    mediaKey = 'stickerMessage';
  }
  return { message: { [mediaKey]: input } };
}

function extensionFromMimetype(mimetype, fallback = 'bin') {
  const mime = String(mimetype || '').split(';')[0].trim().toLowerCase();
  if (!mime.includes('/')) return fallback;
  const sub = mime.split('/')[1];
  if (sub === 'jpeg') return 'jpg';
  if (sub === 'mpeg') return 'mp3';
  if (sub === 'ogg; codecs=opus' || sub === 'ogg') return 'ogg';
  if (sub === 'webp') return 'webp';
  return sub.replace(/[^a-z0-9]/gi, '') || fallback;
}

export function ensureSocketMediaHelpers(sock) {
  if (!sock || typeof sock !== 'object') return sock;

  if (typeof sock.downloadMediaMessage !== 'function') {
    sock.downloadMediaMessage = async (msg) => {
      const wrapped = inferMediaMessageWrapper(msg);
      return downloadMediaMessage(
        wrapped,
        'buffer',
        {},
        {
          logger: SILENT_LOGGER,
          ...(typeof sock.updateMediaMessage === 'function'
            ? { reuploadRequest: sock.updateMediaMessage.bind(sock) }
            : {}),
        },
      );
    };
  }

  if (typeof sock.downloadAndSaveMediaMessage !== 'function') {
    sock.downloadAndSaveMediaMessage = async (msg, filename = '', attachExtension = true) => {
      const buffer = await sock.downloadMediaMessage(msg);
      const wrapped = inferMediaMessageWrapper(msg);
      const inner = wrapped?.message || {};
      const mediaObj = MEDIA_KEYS.map((k) => inner[k]).find(Boolean) || Object.values(inner)[0] || {};
      const ext = extensionFromMimetype(mediaObj?.mimetype, 'bin');

      const rawName = String(filename || '').trim() || `spider_${Date.now()}`;
      const baseTarget =
        path.isAbsolute(rawName) || rawName.includes('/') || rawName.includes('\\')
          ? rawName
          : path.join(os.tmpdir(), rawName);
      const hasExt = path.extname(baseTarget).length > 0;
      const finalPath = attachExtension && !hasExt ? `${baseTarget}.${ext}` : baseTarget;
      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      await fs.writeFile(finalPath, buffer);
      return finalPath;
    };
  }

  return sock;
}

function collectGroupAdminSets(groupMeta) {
  const participants = Array.isArray(groupMeta?.participants) ? groupMeta.participants : [];
  const groupAdmins = [];
  const groupSuperAdmins = [];
  for (const p of participants) {
    if (!p || typeof p !== 'object') continue;
    const role = String(p.admin || '').toLowerCase();
    const id = p.phoneNumber || p.pn || p.id || p.jid || '';
    if (!id) continue;
    if (role === 'superadmin' || p.isSuperAdmin === true) {
      groupSuperAdmins.push(id);
      groupAdmins.push(id);
    } else if (role === 'admin' || p.isAdmin === true) {
      groupAdmins.push(id);
    }
  }
  return { groupAdmins, groupSuperAdmins };
}

function makeMessageView({
  raw,
  sock,
  from,
  sender,
  senderNumber,
  isOwner,
  groupMeta,
  isAdmin,
  isBotAdmin,
  isSuperAdmin = false,
}) {
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
    isSuperAdmin: Boolean(isSuperAdmin),
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

async function resolveGroupContext(sock, from, sender, senderNumber, msg = null, isOwner = false) {
  if (!String(from || '').endsWith('@g.us')) {
    return { groupMeta: null, isAdmin: false, isBotAdmin: false, isSuperAdmin: Boolean(isOwner) };
  }
  try {
    const groupMeta = await sock.groupMetadata(from);
    const roles = await resolveGroupRolesAsync({
      metadata: groupMeta,
      sock,
      senderJids: collectSenderIdentities(msg, [sender, senderNumber]),
    });
    const senderParticipantAdmin = String(roles.senderRole?.participant?.admin || '').toLowerCase();
    const isSuperAdmin =
      senderParticipantAdmin === 'superadmin' ||
      roles.senderRole?.participant?.isSuperAdmin === true ||
      Boolean(roles.senderRole?.isOwner) ||
      Boolean(isOwner);
    return {
      groupMeta,
      isAdmin: roles.isSenderAdmin,
      isBotAdmin: roles.isBotAdmin,
      isSuperAdmin,
    };
  } catch {
    return { groupMeta: null, isAdmin: false, isBotAdmin: false, isSuperAdmin: false };
  }
}

export async function loadLegacyCommands() {
  legacyConfig.BOT_NAME = _0x21bd49.BOT_NAME || 'Spider Man';
  process.env.BOT_NAME = legacyConfig.BOT_NAME;
  legacyConfig.PACK_NAME = legacyConfig.BOT_NAME;
  legacyConfig.BOT_PIC = _0x21bd49.BOT_PIC;
  if (_0x21bd49.BOT_PIC) process.env.BOT_PIC = _0x21bd49.BOT_PIC;
  legacyConfig.OWNER_NUMBER = resolveRuntimeOwnerPhone({ config: _0x21bd49 });
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
      botAdminOnly: Boolean(cmd.botAdminOnly),
      execute: async (ctx) => {
        legacyConfig.MODE = ctx.config.MODE;
        legacyConfig.OWNER_NUMBER = resolveRuntimeOwnerPhone({
          sock: ctx.sock,
          config: ctx.config || _0x21bd49,
        });
        let groupCtx;
        if (ctx.groupMeta) {
          const roles = await resolveGroupRolesAsync({
            metadata: ctx.groupMeta,
            sock: ctx.sock,
            senderJids: collectSenderIdentities(ctx.msg, [ctx.sender, ctx.senderNumber]),
          });
          const senderPartAdmin = String(roles.senderRole?.participant?.admin || '').toLowerCase();
          groupCtx = {
            groupMeta: ctx.groupMeta,
            isAdmin:
              ctx.isGroupAdmin !== undefined ? Boolean(ctx.isGroupAdmin) : roles.isSenderAdmin,
            isBotAdmin:
              ctx.isBotGroupAdmin !== undefined
                ? Boolean(ctx.isBotGroupAdmin)
                : roles.isBotAdmin,
            isSuperAdmin:
              senderPartAdmin === 'superadmin' ||
              roles.senderRole?.participant?.isSuperAdmin === true ||
              Boolean(roles.senderRole?.isOwner) ||
              Boolean(ctx.isOwner),
          };
        } else {
          groupCtx = await resolveGroupContext(
            ctx.sock,
            ctx.from,
            ctx.sender,
            ctx.senderNumber,
            ctx.msg,
            ctx.isOwner,
          );
        }

        const { groupMeta, isAdmin, isBotAdmin, isSuperAdmin } = groupCtx;
        const { groupAdmins, groupSuperAdmins } = collectGroupAdminSets(groupMeta);
        const runtimeOwnerPhone = resolveRuntimeOwnerPhone({
          sock: ctx.sock,
          config: ctx.config || _0x21bd49,
        });
        const superUser = [
          ...(runtimeOwnerPhone ? [`${runtimeOwnerPhone}@s.whatsapp.net`] : []),
          ...(ctx.isOwner && ctx.sender ? [ctx.sender] : []),
        ];
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
          isSuperAdmin,
        });

        if (cmd.groupOnly && !view.isGroup) {
          await view.reply('This command can only be used in a group.');
          return;
        }
        if (adminOnly && !isAdmin && !ctx.isOwner) {
          await view.reply('Only a group admin can run this command.');
          return;
        }
        if (cmd.botAdminOnly && !isBotAdmin) {
          await view.reply('I need to be a group admin to perform that action.');
          return;
        }

        const botName = legacyConfig.BOT_NAME || _0x21bd49.BOT_NAME || 'SPIDER-MAN MD';
        const botPrefix = ctx.prefix || legacyConfig.BOT_PREFIX || '.';
        const pluginContext = {
          sock: ctx.sock,
          client: ctx.sock,
          from: ctx.from,
          sender: ctx.sender,
          senderNumber: ctx.senderNumber,
          pushName: view.pushName,
          pushname: view.pushName,
          participants: view.participants,
          groupAdmins,
          groupSuperAdmins,
          superUser,
          msg: ctx.msg,
          m: view,
          text: ctx.text,
          body: view.body,
          args: ctx.args,
          command: name,
          commandName: ctx.command || name,
          prefix: botPrefix,
          botPrefix,
          packname: legacyConfig.PACK_NAME || botName || 'SPIDER-MAN-MD',
          mode: legacyConfig.MODE || 'public',
          pict: legacyConfig.BOT_PIC || _0x21bd49.BOT_PIC,
          botname: botName,
          botName,
          botFooter: legacyConfig.FOOTER || botName,
          newsletterJid: legacyConfig.CHANNEL_JID || _0x21bd49.CHANNEL_JID || '',
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
          groupMetadata: groupMeta,
          isGroup: view.isGroup,
          isAdmin,
          isSuperAdmin,
          isBotAdmin,
          isOwner: ctx.isOwner,
          isSuperUser: Boolean(ctx.isOwner),
          quoted: view.quoted,
          reply: view.reply,
          send: (payload, options) => ctx.sock.sendMessage(ctx.from, payload, options),
          react: view.react,
          config: legacyConfig,
        };
        ensureSocketMediaHelpers(ctx.sock);
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