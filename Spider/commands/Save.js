import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { SILENT_LOGGER } from '../../spider/utils/privacyLogger.js';
import config from '../../spider/config.js';
import { t } from '../france/translator.js';
import { extractContextInfo, sendWithAckCheck } from '../../spider/utils/groupActionHelper.js';

function getOwnerJid() {
  if (!config.OWNER_NUMBER) return null;
  let owner = config.OWNER_NUMBER.toString();
  owner = owner.replace(/[+\s]/g, '');
  owner = owner.replace(/[^0-9]/g, '');
  return `${owner}@s.whatsapp.net`;
}

export const commands = [
  {
    name: 'save',
    description: 'Save and forward a replied message to bot owner.',
    category: 'WhatsApp',
    execute: async ({ sock, from, msg }) => {
      const { quotedMessage } = extractContextInfo(msg);
      if (!quotedMessage) {
        const noReply = await t(from, 'save', 'noReply');
        return sock.sendMessage(from, { text: noReply }, { quoted: msg });
      }
      const ownerJid = getOwnerJid();
      if (!ownerJid) {
        const noOwner = await t(from, 'save', 'noOwner');
        return sock.sendMessage(from, { text: noOwner }, { quoted: msg });
      }
      try {
        const mediaHolder = { message: quotedMessage };
        let payload = null;
        if (quotedMessage.imageMessage) {
          const buf = await downloadMediaMessage(mediaHolder, 'buffer', {}, { logger: SILENT_LOGGER });
          const defaultCaption = await t(from, 'save', 'image');
          payload = { image: buf, caption: quotedMessage.imageMessage?.caption || defaultCaption };
        } else if (quotedMessage.videoMessage || quotedMessage.ptvMessage) {
          const vidNode = quotedMessage.videoMessage || quotedMessage.ptvMessage;
          const buf = await downloadMediaMessage(mediaHolder, 'buffer', {}, { logger: SILENT_LOGGER });
          const defaultCaption = await t(from, 'save', 'video');
          payload = { video: buf, caption: vidNode?.caption || defaultCaption };
        } else if (quotedMessage.audioMessage) {
          const buf = await downloadMediaMessage(mediaHolder, 'buffer', {}, { logger: SILENT_LOGGER });
          payload = { audio: buf, mimetype: 'audio/mp4', ptt: quotedMessage.audioMessage?.ptt || false };
        } else if (quotedMessage.stickerMessage) {
          const buf = await downloadMediaMessage(mediaHolder, 'buffer', {}, { logger: SILENT_LOGGER });
          payload = { sticker: buf };
        } else if (quotedMessage.documentMessage) {
          const buf = await downloadMediaMessage(mediaHolder, 'buffer', {}, { logger: SILENT_LOGGER });
          payload = {
            document: buf,
            mimetype: quotedMessage.documentMessage?.mimetype,
            fileName: quotedMessage.documentMessage?.fileName || 'document',
          };
        } else if (quotedMessage.conversation || quotedMessage.extendedTextMessage) {
          const textContent =
            quotedMessage.conversation || quotedMessage.extendedTextMessage?.text || 'No text content';
          payload = { text: textContent };
        } else {
          const unsupportedMsg = await t(from, 'save', 'unsupported');
          return sock.sendMessage(from, { text: unsupportedMsg }, { quoted: msg });
        }

        const forwardRes = await sendWithAckCheck({ sock, from: ownerJid, payload });
        if (!forwardRes.ok) {
          throw new Error(forwardRes.error || 'forward-failed');
        }
        const successMsg = await t(from, 'save', 'success');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch (err) {
        console.error('Save command error:', err);
        const errMsg = await t(from, 'save', 'error');
        await sock.sendMessage(from, { text: `${errMsg} ${err.message}` }, { quoted: msg });
      }
    },
  },
];