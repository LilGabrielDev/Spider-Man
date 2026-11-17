import { downloadContentFromMessage, downloadMediaMessage, S_WHATSAPP_NET } from '@whiskeysockets/baileys';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import config from '../../spider/config.js';
import { messageStore } from '../../spider/anti.js';
import { SILENT_LOGGER } from '../../spider/utils/privacyLogger.js';
import { t } from '../france/translator.js';
import { cleanJid, extractPhoneDigits } from '../../spider/utils/groupRoleResolver.js';
import {
  extractContextInfo,
  isFromBot,
  isSendMessageFailure,
  isViewOnceMessage,
  resolveTargetFromMessage,
  unwrapMessageContent,
} from '../../spider/utils/groupActionHelper.js';
import { getPhoneFromJid, resolveRuntimeOwnerJid } from '../../spider/utils/userJid.js';
import {
  getCachedViewOnce,
  hasValidMediaKey,
  normalizeMediaKey,
  setCachedViewOnce,
} from '../../spider/viewOnceAutoSave.js';

function mergeMediaNodes(primary, fallback) {
  if (!primary && !fallback) return null;
  const out = { ...(fallback || {}), ...(primary || {}) };
  if (fallback && primary) {
    for (const key of Object.keys(fallback)) {
      if (out[key] === undefined || out[key] === null || out[key] === '') {
        out[key] = fallback[key];
      }
    }
  }
  return out;
}

async function getBuffer(mediaMsg, mediaType, sock = null, fullMsg = null) {
  if (!mediaMsg || typeof mediaMsg !== 'object') {
    throw new Error('Missing media message payload');
  }
  if (Buffer.isBuffer(mediaMsg._buffer)) return mediaMsg._buffer;
  if (Buffer.isBuffer(mediaMsg.buffer)) return mediaMsg.buffer;

  const normalizedKey = normalizeMediaKey(mediaMsg.mediaKey);
  const normalizedMedia = {
    ...mediaMsg,
    mediaKey: normalizedKey,
  };

  const hasValidUrl =
    typeof normalizedMedia.url === 'string' && normalizedMedia.url.trim().startsWith('https://');
  const hasDirectPath =
    typeof normalizedMedia.directPath === 'string' &&
    normalizedMedia.directPath.trim().length > 0;

  if ((!hasValidUrl && !hasDirectPath) || !hasValidMediaKey(normalizedKey)) {
    throw new Error(
      'View-once media credentials are missing or expired (ask sender to resend).',
    );
  }

  try {
    const stream = await downloadContentFromMessage(normalizedMedia, mediaType);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (buf.length > 0) return buf;
    throw new Error('Empty media stream returned');
  } catch (err) {
    const status = err?.status || err?.output?.statusCode;
    if (
      fullMsg &&
      sock &&
      typeof sock.updateMediaMessage === 'function' &&
      (status === 401 ||
        status === 403 ||
        status === 404 ||
        status === 410 ||
        /\b(401|403|404|410|empty media stream)\b/i.test(String(err?.message || '')))
    ) {
      return downloadMediaMessage(
        fullMsg,
        'buffer',
        {},
        {
          logger: SILENT_LOGGER,
          reuploadRequest: sock.updateMediaMessage.bind(sock),
        },
      );
    }
    throw err;
  }
}

async function buildViewOncePayload({ sock, from, msg }) {
  const { contextInfo, rawQuotedMessage, quotedMessage } = extractContextInfo(msg);
  const stanzaId = contextInfo?.stanzaId || '';
  const cached = stanzaId ? getCachedViewOnce(stanzaId) : null;
  const stored = stanzaId ? messageStore.get(stanzaId) : null;
  const storedRaw = stored?.message || null;
  const storedUnwrapped = storedRaw ? unwrapMessageContent(storedRaw) : null;

  if (!quotedMessage && !rawQuotedMessage && !storedUnwrapped && !cached) {
    return { status: 'no-reply' };
  }

  const footerCaption = await t(from, 'whatsapp', 'vv.caption');
  const formatTextCaption = (origCaption) => {
    const orig = String(origCaption || '').trim();
    return orig ? `${orig}\n\n${footerCaption}` : footerCaption;
  };

  // 1) Best path (matching silva-md-bot): bytes cached when the message first arrived
  if (cached && Buffer.isBuffer(cached.buffer) && cached.buffer.length > 0) {
    if (cached.type === 'image') {
      return {
        status: 'ok',
        payload: {
          image: cached.buffer,
          caption: formatTextCaption(cached.caption),
          mimetype: cached.mimetype || 'image/jpeg',
        },
      };
    }
    if (cached.type === 'video') {
      return {
        status: 'ok',
        payload: {
          video: cached.buffer,
          caption: formatTextCaption(cached.caption),
          mimetype: cached.mimetype || 'video/mp4',
        },
      };
    }
    if (cached.type === 'audio') {
      return {
        status: 'ok',
        payload: {
          audio: cached.buffer,
          mimetype: cached.mimetype || 'audio/mp4',
          ptt: Boolean(cached.ptt),
        },
      };
    }
  }

  // 2) Fallback: check quoted copy / messageStore if it is a view-once message
  const isVo =
    isViewOnceMessage(rawQuotedMessage) ||
    isViewOnceMessage(storedRaw) ||
    Boolean(
      quotedMessage?.imageMessage?.viewOnce ||
        quotedMessage?.videoMessage?.viewOnce ||
        quotedMessage?.ptvMessage?.viewOnce ||
        quotedMessage?.audioMessage?.viewOnce ||
        storedUnwrapped?.imageMessage?.viewOnce ||
        storedUnwrapped?.videoMessage?.viewOnce ||
        storedUnwrapped?.ptvMessage?.viewOnce ||
        storedUnwrapped?.audioMessage?.viewOnce,
    );

  if (!isVo) {
    return { status: 'not-viewonce' };
  }

  const imageMsg = mergeMediaNodes(quotedMessage?.imageMessage, storedUnwrapped?.imageMessage);
  const videoMsg = mergeMediaNodes(
    quotedMessage?.videoMessage || quotedMessage?.ptvMessage,
    storedUnwrapped?.videoMessage || storedUnwrapped?.ptvMessage,
  );
  const audioMsg = mergeMediaNodes(quotedMessage?.audioMessage, storedUnwrapped?.audioMessage);

  const reuploadKey = stored?.key || {
    remoteJid: from,
    id: stanzaId,
    fromMe: isFromBot(contextInfo?.participant, sock),
    ...(contextInfo?.participant ? { participant: contextInfo.participant } : {}),
  };

  if (imageMsg) {
    const normalized = { ...imageMsg, mediaKey: normalizeMediaKey(imageMsg.mediaKey) };
    const fullMsg = { key: reuploadKey, message: { imageMessage: normalized } };
    const buf = await getBuffer(normalized, 'image', sock, fullMsg);
    if (stanzaId && Buffer.isBuffer(buf) && buf.length > 0) {
      setCachedViewOnce(stanzaId, {
        type: 'image',
        dlType: 'image',
        isPtv: false,
        buffer: buf,
        mimetype: imageMsg.mimetype || 'image/jpeg',
        caption: String(imageMsg.caption || '').trim(),
        ptt: false,
        timestamp: Date.now(),
      });
    }
    return {
      status: 'ok',
      payload: {
        image: buf,
        caption: formatTextCaption(imageMsg.caption),
        mimetype: imageMsg.mimetype || 'image/jpeg',
      },
    };
  }

  if (videoMsg) {
    const isPtv = Boolean(
      (quotedMessage?.ptvMessage && !quotedMessage?.videoMessage) ||
        (storedUnwrapped?.ptvMessage && !storedUnwrapped?.videoMessage),
    );
    const normalized = { ...videoMsg, mediaKey: normalizeMediaKey(videoMsg.mediaKey) };
    const fullMsg = {
      key: reuploadKey,
      message: { [isPtv ? 'ptvMessage' : 'videoMessage']: normalized },
    };
    const buf = await getBuffer(normalized, 'video', sock, fullMsg);
    if (stanzaId && Buffer.isBuffer(buf) && buf.length > 0) {
      setCachedViewOnce(stanzaId, {
        type: 'video',
        dlType: 'video',
        isPtv,
        buffer: buf,
        mimetype: videoMsg.mimetype || 'video/mp4',
        caption: String(videoMsg.caption || '').trim(),
        ptt: false,
        timestamp: Date.now(),
      });
    }
    return {
      status: 'ok',
      payload: {
        video: buf,
        caption: formatTextCaption(videoMsg.caption),
        mimetype: videoMsg.mimetype || 'video/mp4',
      },
    };
  }

  if (audioMsg) {
    const normalized = { ...audioMsg, mediaKey: normalizeMediaKey(audioMsg.mediaKey) };
    const fullMsg = { key: reuploadKey, message: { audioMessage: normalized } };
    const buf = await getBuffer(normalized, 'audio', sock, fullMsg);
    if (stanzaId && Buffer.isBuffer(buf) && buf.length > 0) {
      setCachedViewOnce(stanzaId, {
        type: 'audio',
        dlType: 'audio',
        isPtv: false,
        buffer: buf,
        mimetype: audioMsg.mimetype || 'audio/mp4',
        caption: '',
        ptt: Boolean(audioMsg.ptt),
        timestamp: Date.now(),
      });
    }
    return {
      status: 'ok',
      payload: {
        audio: buf,
        mimetype: audioMsg.mimetype || 'audio/mp4',
        ptt: Boolean(audioMsg.ptt),
      },
    };
  }

  return { status: 'unsupported' };
}

const resizeImage = async (filePath) => {
  try {
    const mod = await import('jimp');
    const JimpCls = mod?.Jimp || mod?.default?.Jimp || mod?.default;
    if (JimpCls && typeof JimpCls.read === 'function') {
      const image = await JimpCls.read(filePath);
      const cropped = image
        .crop({ x: 0, y: 0, w: image.bitmap.width, h: image.bitmap.height })
        .scaleToFit({ w: 720, h: 720 });
      return {
        img: await cropped.getBuffer('image/jpeg'),
        preview: await cropped.normalize().getBuffer('image/jpeg'),
      };
    }
  } catch {}
  try {
    const sharpMod = await import('sharp');
    const sharpFn = sharpMod?.default || sharpMod;
    if (typeof sharpFn === 'function') {
      const img = await sharpFn(filePath).resize(720, 720, { fit: 'inside' }).jpeg().toBuffer();
      return { img, preview: img };
    }
  } catch {}
  const raw = await fs.readFile(filePath);
  return { img: raw, preview: raw };
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
        tempPath = path.join(os.tmpdir(), `spider-pp-${Date.now()}.jpg`);
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
        const ownerJid = resolveRuntimeOwnerJid({ sock, config });
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
      const rawText = String(text || '').trim();
      const targetJid =
        resolved.targetJid ||
        (rawText
          ? rawText.includes('@')
            ? cleanJid(rawText)
            : `${rawText.replace(/[^0-9]/g, '')}@s.whatsapp.net`
          : from);
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
        const selfJid =
          cleanJid(
            sock.user?.id ||
              sock.user?.jid ||
              sock.authState?.creds?.me?.id ||
              sock.user?.lid ||
              '',
          ) ||
          resolveRuntimeOwnerJid({ sock, config }) ||
          from;
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
    aliases: ['v', 'viewonce', 'vo', 'openphoto', 'openvideo', 'vvphoto'],
    description: 'Reveals view-once images, videos or audios.',
    category: 'User',
    execute: async ({ sock, from, msg }) => {
      try {
        const result = await buildViewOncePayload({ sock, from, msg });
        if (result.status === 'no-reply') {
          await sock.sendMessage(
            from,
            { text: '👁️ Please reply to a view-once image, video, or audio message.' },
            { quoted: msg },
          );
          return;
        }
        if (result.status === 'not-viewonce') {
          await sock.sendMessage(
            from,
            { text: '👁️ That message is not a view-once message.' },
            { quoted: msg },
          );
          return;
        }
        if (result.status !== 'ok' || !result.payload) {
          await sock.sendMessage(
            from,
            { text: '❌ Unsupported view-once media type.' },
            { quoted: msg },
          );
          return;
        }
        await sock.sendMessage(from, result.payload, { quoted: msg });
      } catch (err) {
        console.error('vv command error:', err);
        await sock.sendMessage(
          from,
          {
            text: `❌ Failed to reveal view-once media: ${err?.message || 'media expired or unavailable.'}`,
          },
          { quoted: msg },
        );
      }
    },
  },
  {
    name: 'vv2',
    aliases: ['v2', '😂', '❤️', '👍'],
    description: 'Sends the view once media to the bot owner.',
    category: 'User',
    execute: async ({ sock, from, msg }) => {
      try {
        const result = await buildViewOncePayload({ sock, from, msg });
        if (result.status !== 'ok' || !result.payload) return;
        const ownerJid = resolveRuntimeOwnerJid({ sock, config });
        if (!ownerJid) {
          console.log('Owner/linked-account JID not available');
          return;
        }
        await sock.sendMessage(ownerJid, result.payload);
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
      let waid =
        resolved.phone ||
        extractPhoneDigits(contextInfo?.participantAlt) ||
        extractPhoneDigits(contextInfo?.participantPn) ||
        extractPhoneDigits(contextInfo?.senderPn) ||
        extractPhoneDigits(participant);
      if (!waid && String(participant).toLowerCase().includes('@lid') && typeof sock?.signalRepository?.lidMapping?.getPNForLID === 'function') {
        try {
          const pn = await sock.signalRepository.lidMapping.getPNForLID(cleanJid(participant));
          waid = getPhoneFromJid(pn) || '';
        } catch {}
      }
      if (!waid) {
        waid = cleanJid(participant).split('@')[0];
      }
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