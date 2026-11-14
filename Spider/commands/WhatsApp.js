import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import fs from 'fs-extra';
import path from 'path';
import { Jimp } from 'jimp';
import config from '../../spider/config.js';
import { t } from '../france/translator.js';
import { cleanJid, extractPhoneDigits } from '../../spider/utils/groupRoleResolver.js';
import {
  extractContextInfo,
  isFromBot,
  isSendMessageFailure,
  isViewOnceMessage,
  resolveTargetFromMessage,
} from '../../spider/utils/groupActionHelper.js';

const S_WHATSAPP_NET = 's.whatsapp.net';

function getOwnerJid() {
  if (!config.OWNER_NUMBER) return null;
  let owner = config.OWNER_NUMBER.toString();
  owner = owner.replace(/[+\s]/g, '');
  owner = owner.replace(/[^0-9]/g, '');
  return `${owner}@s.whatsapp.net`;
}

async function getBuffer(mediaMsg, mediaType) {
  const stream = await downloadContentFromMessage(mediaMsg, mediaType);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const resizeImage = async (filePath) => {
  const image = await Jimp.read(filePath);
  const cropped = image
    .crop({ x: 0, y: 0, w: image.bitmap.width, h: image.bitmap.height })
    .scaleToFit({ w: 720, h: 720 });
  return {
    img: await cropped.getBuffer('image/jpeg'),
    preview: await cropped.normalize().getBuffer('image/jpeg'),
  };
};

export const commands = [
  {
    name: 'fullpp',
    description: 'Set your profile picture without compression (owner only).',
    category: 'WhatsApp',
    aliases: ['mypp', 'dp'],
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      const { quotedMessage } = extractContextInfo(msg);
      const imageMsg = quotedMessage?.imageMessage;
      if (!imageMsg) {
        const noImgMsg = await t(from, 'whatsapp', 'fullpp.noImage');
        return sock.sendMessage(from, { text: noImgMsg }, { quoted: msg });
      }
      let tempPath = null;
      try {
        const mediaBuffer = await getBuffer(imageMsg, 'image');
        tempPath = path.join(process.cwd(), 'temp', `${Date.now()}.jpg`);
        await fs.ensureDir(path.dirname(tempPath));
        await fs.writeFile(tempPath, mediaBuffer);
        const { img } = await resizeImage(tempPath);
        const res = await sock.query({
          tag: 'iq',
          attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:picture' },
          content: [{ tag: 'picture', attrs: { type: 'image' }, content: img }],
        });
        if (isSendMessageFailure(res)) throw new Error('fullpp-failed');
        const successMsg = await t(from, 'whatsapp', 'fullpp.success');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch (err) {
        console.error('=== FULLPP ERROR ===', err.message);
        const errMsg = await t(from, 'whatsapp', 'fullpp.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
        const ownerJid = getOwnerJid();
        if (ownerJid) {
          await sock.sendMessage(ownerJid, {
            text: `Fullpp error in ${from}:\n${err.message}\n\nStack: ${err.stack?.slice(0, 200)}`,
          });
        }
      } finally {
        if (tempPath) await fs.remove(tempPath).catch(() => {});
      }
    },
  },
  {
    name: 'privacy',
    aliases: [],
    description: 'Displays your current privacy settings.',
    category: 'WhatsApp',
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      try {
        const settings = await sock.fetchPrivacySettings(true);
        const userName = sock.user?.name || 'User';
        const ppUrl = await sock
          .profilePictureUrl(sock.user.id, 'image')
          .catch(
            () =>
              'https://raw.githubusercontent.com/LilGabrielDev/Spider-Man/main/spider/assets/spider-man.jpg',
          );
        const tpl = await t(from, 'whatsapp', 'privacy.info');
        const formatted = tpl
          .replace('{name}', userName)
          .replace('{online}', settings.online || 'N/A')
          .replace('{profile}', settings.profile || 'N/A')
          .replace('{last}', settings.last || 'N/A')
          .replace('{readreceipts}', settings.readreceipts || 'N/A')
          .replace('{status}', settings.status || 'N/A')
          .replace('{groupadd}', settings.groupadd || 'N/A')
          .replace('{calladd}', settings.calladd || 'N/A');
        await sock.sendMessage(from, { image: { url: ppUrl }, caption: formatted }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'whatsapp', 'privacy.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'pin',
    description: 'Pin a chat.',
    category: 'WhatsApp',
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      try {
        const res = await sock.chatModify({ pin: true }, from);
        if (isSendMessageFailure(res)) throw new Error('pin-failed');
        const successMsg = await t(from, 'whatsapp', 'pin.success');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch (err) {
        console.error('Pin error:', err);
        const errMsg = await t(from, 'whatsapp', 'pin.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'unpin',
    description: 'Unpin a chat.',
    category: 'WhatsApp',
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      try {
        const res = await sock.chatModify({ pin: false }, from);
        if (isSendMessageFailure(res)) throw new Error('unpin-failed');
        const successMsg = await t(from, 'whatsapp', 'unpin.success');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch (err) {
        console.error('Unpin error:', err);
        const errMsg = await t(from, 'whatsapp', 'unpin.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'star',
    description: 'Star a quoted message.',
    category: 'WhatsApp',
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      const { contextInfo } = extractContextInfo(msg);
      const stanzaId = contextInfo?.stanzaId;
      const fromMe = isFromBot(contextInfo?.participant, sock);
      if (!stanzaId) {
        const noReply = await t(from, 'whatsapp', 'star.noReply');
        await sock.sendMessage(from, { text: noReply }, { quoted: msg });
        return;
      }
      try {
        const res = await sock.chatModify(
          { star: { messages: [{ id: stanzaId, fromMe }], star: true } },
          from,
        );
        if (isSendMessageFailure(res)) throw new Error('star-failed');
        const successMsg = await t(from, 'whatsapp', 'star.success');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch (err) {
        console.error('Star error:', err);
        const errMsg = await t(from, 'whatsapp', 'star.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'unstar',
    description: 'Unstar a quoted message.',
    category: 'WhatsApp',
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      const { contextInfo } = extractContextInfo(msg);
      const stanzaId = contextInfo?.stanzaId;
      const fromMe = isFromBot(contextInfo?.participant, sock);
      if (!stanzaId) {
        const noReply = await t(from, 'whatsapp', 'unstar.noReply');
        await sock.sendMessage(from, { text: noReply }, { quoted: msg });
        return;
      }
      try {
        const res = await sock.chatModify(
          { star: { messages: [{ id: stanzaId, fromMe }], star: false } },
          from,
        );
        if (isSendMessageFailure(res)) throw new Error('unstar-failed');
        const successMsg = await t(from, 'whatsapp', 'unstar.success');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch (err) {
        console.error('Unstar error:', err);
        const errMsg = await t(from, 'whatsapp', 'unstar.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'mydp',
    aliases: [],
    description: 'Updates your profile picture privacy setting.',
    category: 'WhatsApp',
    ownerOnly: true,
    execute: async ({ sock, from, text, msg }) => {
      const options = {
        all: await t(from, 'whatsapp', 'mydp.options.all'),
        contacts: await t(from, 'whatsapp', 'mydp.options.contacts'),
        contact_blacklist: await t(from, 'whatsapp', 'mydp.options.contact_blacklist'),
        none: await t(from, 'whatsapp', 'mydp.options.none'),
      };
      const choice = String(text || '').toLowerCase();
      if (!choice || !options[choice]) {
        const helpTpl = await t(from, 'whatsapp', 'mydp.help');
        const list = Object.entries(options)
          .map(([k, v]) => `- *${k}*: ${v}`)
          .join('\n');
        return sock.sendMessage(from, { text: helpTpl.replace('{options}', list) }, { quoted: msg });
      }
      try {
        const res = await sock.updateProfilePicturePrivacy(choice);
        if (isSendMessageFailure(res)) throw new Error('mydp-failed');
        const successTpl = await t(from, 'whatsapp', 'mydp.success');
        await sock.sendMessage(from, { text: successTpl.replace('{choice}', choice) }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'whatsapp', 'mydp.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'mystatus',
    aliases: [],
    description: 'Updates your status privacy setting.',
    category: 'WhatsApp',
    ownerOnly: true,
    execute: async ({ sock, from, text, msg }) => {
      const options = {
        all: await t(from, 'whatsapp', 'mystatus.options.all'),
        contacts: await t(from, 'whatsapp', 'mystatus.options.contacts'),
        contact_blacklist: await t(from, 'whatsapp', 'mystatus.options.contact_blacklist'),
        none: await t(from, 'whatsapp', 'mystatus.options.none'),
      };
      const choice = String(text || '').toLowerCase();
      if (!choice || !options[choice]) {
        const helpTpl = await t(from, 'whatsapp', 'mystatus.help');
        const list = Object.entries(options)
          .map(([k, v]) => `- *${k}*: ${v}`)
          .join('\n');
        return sock.sendMessage(from, { text: helpTpl.replace('{options}', list) }, { quoted: msg });
      }
      try {
        const res = await sock.updateStatusPrivacy(choice);
        if (isSendMessageFailure(res)) throw new Error('mystatus-failed');
        const successTpl = await t(from, 'whatsapp', 'mystatus.success');
        await sock.sendMessage(from, { text: successTpl.replace('{choice}', choice) }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'whatsapp', 'mystatus.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'groupadd',
    aliases: [],
    description: 'Updates who can add you to groups.',
    category: 'WhatsApp',
    ownerOnly: true,
    execute: async ({ sock, from, text, msg }) => {
      const options = {
        all: await t(from, 'whatsapp', 'groupadd.options.all'),
        contacts: await t(from, 'whatsapp', 'groupadd.options.contacts'),
        contact_blacklist: await t(from, 'whatsapp', 'groupadd.options.contact_blacklist'),
        none: await t(from, 'whatsapp', 'groupadd.options.none'),
      };
      const choice = String(text || '').toLowerCase();
      if (!choice || !options[choice]) {
        const helpTpl = await t(from, 'whatsapp', 'groupadd.help');
        const list = Object.entries(options)
          .map(([k, v]) => `- *${k}*: ${v}`)
          .join('\n');
        return sock.sendMessage(from, { text: helpTpl.replace('{options}', list) }, { quoted: msg });
      }
      try {
        const res = await sock.updateGroupsAddPrivacy(choice);
        if (isSendMessageFailure(res)) throw new Error('groupadd-failed');
        const successTpl = await t(from, 'whatsapp', 'groupadd.success');
        await sock.sendMessage(from, { text: successTpl.replace('{choice}', choice) }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'whatsapp', 'groupadd.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'lastseen',
    aliases: [],
    description: 'Updates your last seen privacy settings.',
    category: 'WhatsApp',
    ownerOnly: true,
    execute: async ({ sock, from, text, msg }) => {
      const options = {
        all: await t(from, 'whatsapp', 'lastseen.options.all'),
        contacts: await t(from, 'whatsapp', 'lastseen.options.contacts'),
        contact_blacklist: await t(from, 'whatsapp', 'lastseen.options.contact_blacklist'),
        none: await t(from, 'whatsapp', 'lastseen.options.none'),
      };
      const choice = String(text || '').toLowerCase();
      if (!choice || !options[choice]) {
        const helpHeader = await t(from, 'whatsapp', 'lastseen.help');
        let helpText = helpHeader;
        for (const [k, v] of Object.entries(options)) {
          helpText += `- *${k}*: ${v}\n`;
        }
        helpText += await t(from, 'whatsapp', 'lastseen.example');
        return sock.sendMessage(from, { text: helpText }, { quoted: msg });
      }
      try {
        const res = await sock.updateLastSeenPrivacy(choice);
        if (isSendMessageFailure(res)) throw new Error('lastseen-failed');
        const successTpl = await t(from, 'whatsapp', 'lastseen.success');
        await sock.sendMessage(
          from,
          { text: successTpl.replace('{priv}', choice).replace('{desc}', options[choice]) },
          { quoted: msg },
        );
      } catch (err) {
        console.error('Failed to update last seen:', err);
        const errMsg = await t(from, 'whatsapp', 'lastseen.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'myonline',
    aliases: [],
    description: 'Updates your online privacy setting.',
    category: 'WhatsApp',
    ownerOnly: true,
    execute: async ({ sock, from, text, msg }) => {
      const options = {
        all: await t(from, 'whatsapp', 'myonline.options.all'),
        match_last_seen: await t(from, 'whatsapp', 'myonline.options.match_last_seen'),
      };
      const choice = String(text || '').toLowerCase();
      if (!choice || !options[choice]) {
        const helpTpl = await t(from, 'whatsapp', 'myonline.help');
        const list = Object.entries(options)
          .map(([k, v]) => `- *${k}*: ${v}`)
          .join('\n');
        return sock.sendMessage(from, { text: helpTpl.replace('{options}', list) }, { quoted: msg });
      }
      try {
        const res = await sock.updateOnlinePrivacy(choice);
        if (isSendMessageFailure(res)) throw new Error('myonline-failed');
        const successTpl = await t(from, 'whatsapp', 'myonline.success');
        await sock.sendMessage(from, { text: successTpl.replace('{choice}', choice) }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'whatsapp', 'myonline.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'onwa',
    aliases: ['checkid', 'checkno'],
    description: 'Checks if a WhatsApp ID exists.',
    category: 'WhatsApp',
    execute: async ({ sock, from, text, msg }) => {
      const rawNum = String(text || '').trim().split(/\s+/)[0];
      if (!rawNum) {
        const noNum = await t(from, 'whatsapp', 'onwa.noNumber');
        return sock.sendMessage(from, { text: noNum }, { quoted: msg });
      }
      const digits = rawNum.replace(/[^\d]/g, '');
      if (digits.length < 10) {
        const invalidMsg = await t(from, 'whatsapp', 'onwa.invalid');
        return sock.sendMessage(from, { text: invalidMsg }, { quoted: msg });
      }
      const jid = `${digits}@s.whatsapp.net`;
      try {
        const [result] = await sock.onWhatsApp(jid);
        const existsTpl = await t(from, 'whatsapp', 'onwa.exists');
        const notExistsTpl = await t(from, 'whatsapp', 'onwa.notExists');
        const replyText = result?.exists
          ? existsTpl.replace('{number}', rawNum)
          : notExistsTpl.replace('{number}', rawNum);
        await sock.sendMessage(from, { text: replyText }, { quoted: msg });
      } catch (err) {
        const errMsg = await t(from, 'whatsapp', 'onwa.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
        console.error('checkIdCommand error:', err);
      }
    },
  },
  {
    name: 'bizprofile',
    aliases: ['bizp'],
    description: 'Fetches business description and category.',
    category: 'WhatsApp',
    execute: async ({ sock, from, text, msg }) => {
      const resolved = resolveTargetFromMessage({ sock, from, msg, text });
      const targetJid =
        resolved.targetJid || (text ? `${String(text).replace(/[^0-9]/g, '')}@s.whatsapp.net` : from);
      try {
        const profile = await sock.getBusinessProfile(targetJid);
        const tpl = await t(from, 'whatsapp', 'bizprofile.result');
        const formatted = tpl
          .replace('{description}', profile.description || 'N/A')
          .replace('{category}', profile.category || 'N/A');
        await sock.sendMessage(from, { text: formatted }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'whatsapp', 'bizprofile.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'removedp',
    aliases: [],
    description: 'Removes your profile picture.',
    category: 'WhatsApp',
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      try {
        const selfJid = cleanJid(sock.user?.id || sock.user?.jid || '') || from;
        const res = await sock.removeProfilePicture(selfJid);
        if (isSendMessageFailure(res)) throw new Error('removedp-failed');
        const successMsg = await t(from, 'whatsapp', 'removedp.success');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'whatsapp', 'removedp.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'archive',
    aliases: [],
    description: 'Archives the current chat.',
    category: 'WhatsApp',
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      try {
        const res = await sock.chatModify({ archive: true, lastMessages: [msg] }, from);
        if (isSendMessageFailure(res)) throw new Error('archive-failed');
        const successMsg = await t(from, 'whatsapp', 'archive.success');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch (err) {
        console.error('Error archiving chat:', err);
        const errMsg = await t(from, 'whatsapp', 'archive.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'vv',
    aliases: [],
    description: 'Reveals view-once images, videos or audios.',
    category: 'User',
    execute: async ({ sock, from, msg }) => {
      const { rawQuotedMessage, quotedMessage } = extractContextInfo(msg);
      if (!quotedMessage) return;
      const isVo =
        isViewOnceMessage(rawQuotedMessage) ||
        Boolean(
          quotedMessage.imageMessage?.viewOnce ||
            quotedMessage.videoMessage?.viewOnce ||
            quotedMessage.ptvMessage?.viewOnce ||
            quotedMessage.audioMessage?.viewOnce,
        );
      if (!isVo) return;
      try {
        let payload;
        const caption = await t(from, 'whatsapp', 'vv.caption');
        if (quotedMessage.imageMessage) {
          const buf = await getBuffer(quotedMessage.imageMessage, 'image');
          payload = { image: buf, caption };
        } else if (quotedMessage.videoMessage || quotedMessage.ptvMessage) {
          const buf = await getBuffer(
            quotedMessage.videoMessage || quotedMessage.ptvMessage,
            'video',
          );
          payload = { video: buf, caption };
        } else if (quotedMessage.audioMessage) {
          const buf = await getBuffer(quotedMessage.audioMessage, 'audio');
          payload = { audio: buf, mimetype: 'audio/mp4' };
        }
        if (payload) {
          await sock.sendMessage(from, payload, { quoted: msg });
        }
      } catch (err) {
        console.error('vv command error:', err);
      }
    },
  },
  {
    name: 'vv2',
    aliases: ['😂', '❤️', '👍'],
    description: 'Sends the view once media to the bot owner.',
    category: 'User',
    execute: async ({ sock, from, msg }) => {
      const { rawQuotedMessage, quotedMessage } = extractContextInfo(msg);
      if (!quotedMessage) return;
      const isVo =
        isViewOnceMessage(rawQuotedMessage) ||
        Boolean(
          quotedMessage.imageMessage?.viewOnce ||
            quotedMessage.videoMessage?.viewOnce ||
            quotedMessage.ptvMessage?.viewOnce ||
            quotedMessage.audioMessage?.viewOnce,
        );
      if (!isVo) return;
      const ownerJid = getOwnerJid();
      if (!ownerJid) {
        console.log('Owner number not configured in config.js');
        return;
      }
      try {
        let payload;
        const caption = await t(from, 'whatsapp', 'vv.caption');
        if (quotedMessage.imageMessage) {
          const buf = await getBuffer(quotedMessage.imageMessage, 'image');
          payload = { image: buf, caption };
        } else if (quotedMessage.videoMessage || quotedMessage.ptvMessage) {
          const buf = await getBuffer(
            quotedMessage.videoMessage || quotedMessage.ptvMessage,
            'video',
          );
          payload = { video: buf, caption };
        } else if (quotedMessage.audioMessage) {
          const buf = await getBuffer(quotedMessage.audioMessage, 'audio');
          payload = { audio: buf, mimetype: 'audio/mp4' };
        }
        if (payload) {
          await sock.sendMessage(ownerJid, payload);
        }
      } catch (err) {
        console.error('vv2Command error:', err);
      }
    },
  },
  {
    name: 'details',
    aliases: [],
    description: 'Displays the full raw quoted message using Baileys structure.',
    category: 'User',
    execute: async ({ sock, from, msg }) => {
      const { rawQuotedMessage, quotedMessage } = extractContextInfo(msg);
      const targetMsg = rawQuotedMessage || quotedMessage;
      if (!targetMsg) {
        const noReply = await t(from, 'whatsapp', 'details.noReply');
        return sock.sendMessage(from, { text: noReply }, { quoted: msg });
      }
      try {
        const json = JSON.stringify(targetMsg, null, 2);
        const chunks = json.match(/[\s\S]{1,3500}/g) || [];
        const tpl = await t(from, 'whatsapp', 'details.result');
        for (const chunk of chunks) {
          await sock.sendMessage(from, { text: tpl.replace('{part}', chunk) }, { quoted: msg });
        }
      } catch {
        const errMsg = await t(from, 'whatsapp', 'details.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'blocklist',
    aliases: ['blocked'],
    description: 'Shows the list of blocked users.',
    category: 'WhatsApp',
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      try {
        const blocked = await sock.fetchBlocklist();
        if (!blocked || blocked.length === 0) {
          const emptyMsg = await t(from, 'whatsapp', 'blocklist.empty');
          return sock.sendMessage(from, { text: emptyMsg }, { quoted: msg });
        }
        const formatted = blocked
          .map((jid, idx) => `${idx + 1}. ${jid.replace('@s.whatsapp.net', '')}`)
          .join('\n');
        const tpl = await t(from, 'whatsapp', 'blocklist.result');
        await sock.sendMessage(from, { text: tpl.replace('{list}', formatted) }, { quoted: msg });
      } catch (err) {
        console.error('Error fetching block list:', err);
        const errMsg = await t(from, 'whatsapp', 'blocklist.error');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'vcard',
    aliases: ['card'],
    description: "Save a contact from a replied message with a custom name.",
    category: 'WhatsApp',
    execute: async ({ sock, from, text, msg }) => {
      const { contextInfo } = extractContextInfo(msg);
      const participant = contextInfo?.participant || contextInfo?.remoteJid;
      if (!participant) {
        const noReply = await t(from, 'whatsapp', 'vcard.noReply');
        return sock.sendMessage(from, { text: noReply }, { quoted: msg });
      }
      if (!text) {
        const noName = await t(from, 'whatsapp', 'vcard.noName');
        return sock.sendMessage(from, { text: noName }, { quoted: msg });
      }
      let metadata = null;
      if (from && String(from).endsWith('@g.us') && String(participant).endsWith('@lid')) {
        try {
          metadata = await sock.groupMetadata(from);
        } catch {}
      }
      const resolved = resolveTargetFromMessage({ sock, from, msg, metadata });
      const waid =
        resolved.phone ||
        extractPhoneDigits(participant) ||
        cleanJid(participant).split('@')[0];
      const displayName = text;
      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${displayName}\nTEL;type=CELL;type=VOICE;waid=${waid}:${waid}\nEND:VCARD`;
      await sock.sendMessage(
        from,
        { contacts: { displayName, contacts: [{ displayName, vcard }] } },
        { quoted: msg },
      );
    },
  },
  {
    name: 'location',
    aliases: ['loc'],
    description: 'Returns Google Maps link from a replied location message.',
    category: 'WhatsApp',
    execute: async ({ sock, from, msg }) => {
      const { quotedMessage } = extractContextInfo(msg);
      const loc = quotedMessage?.locationMessage || quotedMessage?.liveLocationMessage;
      if (!loc) {
        const noReply = await t(from, 'whatsapp', 'location.noReply');
        return sock.sendMessage(from, { text: noReply }, { quoted: msg });
      }
      const { degreesLatitude, degreesLongitude } = loc;
      const mapUrl = `https://maps.google.com/?q=${degreesLatitude},${degreesLongitude}`;
      const tpl = await t(from, 'whatsapp', 'location.result');
      await sock.sendMessage(
        from,
        {
          text: tpl.replace('{url}', mapUrl),
          previewType: 0,
          contextInfo: { isForwarded: true },
        },
        { quoted: msg },
      );
    },
  },
];