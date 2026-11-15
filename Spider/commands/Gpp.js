import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { MESSAGES } from '../france/index.js';
import { extractContextInfo, isSendMessageFailure } from '../../spider/utils/groupActionHelper.js';

const S_WHATSAPP_NET = 's.whatsapp.net';

async function loadJimpClass() {
  try {
    const mod = await import('jimp');
    return mod?.Jimp || mod?.default?.Jimp || mod?.default || null;
  } catch {
    return null;
  }
}

async function resizeGroupImage(buf) {
  const JimpCls = await loadJimpClass();
  if (JimpCls && typeof JimpCls.read === 'function') {
    const image = await JimpCls.read(buf);
    const resized = image
      .crop({ x: 0, y: 0, w: image.bitmap.width, h: image.bitmap.height })
      .scaleToFit({ w: 720, h: 720 });
    return resized.getBuffer('image/jpeg');
  }
  try {
    const sharpMod = await import('sharp');
    const sharpFn = sharpMod?.default || sharpMod;
    if (typeof sharpFn === 'function') {
      return await sharpFn(buf).resize(720, 720, { fit: 'inside' }).jpeg().toBuffer();
    }
  } catch {}
  return buf;
}

async function getBuffer(mediaMsg, mediaType) {
  const stream = await downloadContentFromMessage(mediaMsg, mediaType);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export const commands = [
  {
    name: 'fullgpp',
    description: 'Set group profile picture without cropping or compression.',
    category: 'Group',
    aliases: ['fullgp', 'gpp'],
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    execute: async ({ sock, from, msg }) => {
      const { quotedMessage } = extractContextInfo(msg);
      const imageMsg = quotedMessage?.imageMessage;
      if (!imageMsg) {
        return sock.sendMessage(from, { text: MESSAGES.gpp.noImage }, { quoted: msg });
      }
      let tempPath = null;
      try {
        const buf = await getBuffer(imageMsg, 'image');
        tempPath = path.join(os.tmpdir(), `spider-gpp-${Date.now()}.jpg`);
        await fs.writeFile(tempPath, buf).catch(() => {});
        const imgBuffer = await resizeGroupImage(buf);

        let res;
        if (typeof sock.updateProfilePicture === 'function') {
          res = await sock.updateProfilePicture(from, imgBuffer);
        } else {
          res = await sock.query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, target: from, type: 'set', xmlns: 'w:profile:picture' },
            content: [{ tag: 'picture', attrs: { type: 'image' }, content: imgBuffer }],
          });
        }
        if (isSendMessageFailure(res)) throw new Error('fullgpp-failed');
        await sock.__spiderInvalidateGroupCache?.(from);
        await sock.sendMessage(from, { text: MESSAGES.gpp.success }, { quoted: msg });
      } catch (err) {
        console.error('=== FULLGPP ERROR ===', err.message);
        await sock.sendMessage(from, { text: MESSAGES.gpp.error }, { quoted: msg });
      } finally {
        if (tempPath) await fs.remove(tempPath).catch(() => {});
      }
    },
  },
];