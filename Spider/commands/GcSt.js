import {
  downloadContentFromMessage,
  generateWAMessageContent,
  generateWAMessageFromContent,
} from '@whiskeysockets/baileys';
import crypto from 'crypto';
import { extractContextInfo } from '../../spider/utils/groupActionHelper.js';

export const commands = [
  {
    name: 'status',
    aliases: ['setstatus', 'mentionstatus', 'togstatus'],
    description: 'Send media/text to group status (lasts 24h).',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    execute: async ({ sock, from, text, msg }) => {
      if (!from.endsWith('@g.us')) {
        return sock.sendMessage(
          from,
          { text: 'This command can only be used in groups.' },
          { quoted: msg },
        );
      }
      const { quotedMessage } = extractContextInfo(msg);
      if (!quotedMessage && !text) {
        return sock.sendMessage(
          from,
          {
            text: '❌ *Please reply to a message or provide text!*\n\nReply to image/video/audio/text with .status',
          },
          { quoted: msg },
        );
      }
      try {
        let payload = null;
        let label = 'Text';
        if (quotedMessage) {
          payload = await buildPayload(quotedMessage);
          label = getMediaType(quotedMessage);
          if (text && payload && (payload.image || payload.video)) {
            payload.caption = text;
          }
        } else if (text) {
          payload = { text };
          label = 'Text';
        }
        if (!payload) {
          return sock.sendMessage(from, { text: '❌ Failed to process message' }, { quoted: msg });
        }
        await sendGroupStatus(sock, from, payload);
        await sock.sendMessage(
          from,
          {
            text: `✅ ${label} sent to group status!${payload.caption ? `\n📝 "${payload.caption}"` : ''}`,
          },
          { quoted: msg },
        );
      } catch (err) {
        console.error('[STATUS ERROR]', err);
        await sock.sendMessage(from, { text: `❌ Error: ${err.message}` }, { quoted: msg });
      }
    },
  },
];

async function buildPayload(quoted) {
  if (quoted.imageMessage) {
    const buf = await downloadMedia(quoted.imageMessage, 'image');
    return {
      image: buf,
      caption: quoted.imageMessage.caption || '',
      mimetype: quoted.imageMessage.mimetype || 'image/jpeg',
    };
  }
  if (quoted.videoMessage) {
    const buf = await downloadMedia(quoted.videoMessage, 'video');
    return {
      video: buf,
      caption: quoted.videoMessage.caption || '',
      gifPlayback: quoted.videoMessage.gifPlayback || false,
      mimetype: quoted.videoMessage.mimetype || 'video/mp4',
    };
  }
  if (quoted.stickerMessage) {
    const buf = await downloadMedia(quoted.stickerMessage, 'sticker');
    return { image: buf, caption: '', mimetype: 'image/webp' };
  }
  if (quoted.audioMessage) {
    const buf = await downloadMedia(quoted.audioMessage, 'audio');
    return {
      audio: buf,
      mimetype: quoted.audioMessage.mimetype || 'audio/mpeg',
      ptt: quoted.audioMessage.ptt || false,
    };
  }
  if (quoted.conversation || quoted.extendedTextMessage?.text) {
    return { text: quoted.conversation || quoted.extendedTextMessage.text };
  }
  return null;
}

async function downloadMedia(mediaObj, type) {
  const stream = await downloadContentFromMessage(mediaObj, type);
  let buf = Buffer.from([]);
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk]);
  }
  return buf;
}

function getMediaType(quoted) {
  if (quoted.imageMessage) return 'Image';
  if (quoted.videoMessage) return 'Video';
  if (quoted.stickerMessage) return 'Sticker';
  if (quoted.audioMessage) return 'Audio';
  return 'Text';
}

async function sendGroupStatus(sock, groupJid, payload) {
  const mediaContent = await generateWAMessageContent(payload, { upload: sock.waUploadToServer });
  const secret = crypto.randomBytes(32);
  const waMsg = generateWAMessageFromContent(
    groupJid,
    {
      messageContextInfo: { messageSecret: secret },
      groupStatusMessageV2: {
        message: { ...mediaContent, messageContextInfo: { messageSecret: secret } },
      },
    },
    {},
    { userJid: sock?.user?.id, timestamp: new Date() },
  );
  await sock.relayMessage(groupJid, waMsg.message, { messageId: waMsg.key.id });
  return waMsg;
}