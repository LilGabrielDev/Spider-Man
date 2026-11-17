import { S_WHATSAPP_NET } from '@whiskeysockets/baileys';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import config from '../../spider/config.js';
import { getMessageForRetry, messageStore } from '../../spider/anti.js';
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
  downloadMediaWithRecovery,
  extractViewOnceMedia,
  getCachedViewOnce,
  hasValidMediaKey,
  normalizeMediaKey,
  setCachedViewOnce,
  waitForPendingViewOnceCache,
} from '../../spider/viewOnceAutoSave.js';

function isEmptyMediaField(val) {
  if (val === undefined || val === null) return true;
  if (typeof val === 'string') return val.trim() === '';
  if (Buffer.isBuffer(val) || val instanceof Uint8Array || ArrayBuffer.isView(val)) {
    return val.byteLength === 0;
  }
  if (Array.isArray(val)) return val.length === 0;
  if (typeof val === 'object' && !(val instanceof Date)) {
    return Object.keys(val).length === 0;
  }
  return false;
}

function mergeMediaNodes(primary, fallback) {
  if (!primary && !fallback) return null;
  const out = { ...(fallback || {}), ...(primary || {}) };
  if (fallback && primary) {
    for (const key of Object.keys(fallback)) {
      if (isEmptyMediaField(out[key]) && !isEmptyMediaField(fallback[key])) {
        out[key] = fallback[key];
      }
    }
    if (!hasValidMediaKey(out.mediaKey) && hasValidMediaKey(fallback.mediaKey)) {
      out.mediaKey = fallback.mediaKey;
    }
    const primaryUrlOk = typeof out.url === 'string' && out.url.trim().startsWith('https://');
    const fallbackUrlOk =
      typeof fallback.url === 'string' && fallback.url.trim().startsWith('https://');
    if (!primaryUrlOk && fallbackUrlOk) {
      out.url = fallback.url;
    }
  }
  return out;
}

function extractThumbnailBuffer(mediaNode) {
  const raw = mediaNode?.jpegThumbnail;
  if (!raw) return null;
  let buf = null;
  if (Buffer.isBuffer(raw)) buf = raw;
  else if (raw instanceof Uint8Array || ArrayBuffer.isView(raw)) {
    buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  } else if (typeof raw === 'string' && raw.trim().length > 0) {
    buf = Buffer.from(raw.trim(), 'base64');
  } else if (raw && typeof raw === 'object' && typeof raw.__spiderBytes === 'string') {
    buf = Buffer.from(raw.__spiderBytes, 'base64');
  }
  return buf && buf.length > 64 ? buf : null;
}

async function resolveStoredViewOnceMessage(sock, from, stanzaId) {
  if (!stanzaId) return null;
  const direct = messageStore.get(stanzaId);
  if (direct?.message) return direct;

  try {
    const retryMsg = await getMessageForRetry({ remoteJid: from, id: stanzaId });
    if (retryMsg) {
      return { key: { remoteJid: from, id: stanzaId }, message: retryMsg };
    }
  } catch {}

  if (sock?.store && typeof sock.store.loadMessage === 'function') {
    try {
      const loaded = await sock.store.loadMessage(from, stanzaId);
      if (loaded?.message) return loaded;
    } catch {}
  }

  if (typeof sock?.getMessage === 'function') {
    try {
      const fetched = await sock.getMessage({ remoteJid: from, id: stanzaId });
      if (fetched?.message) return fetched;
      if (fetched && typeof fetched === 'object' && Object.keys(fetched).length > 0) {
        return { key: { remoteJid: from, id: stanzaId }, message: fetched };
      }
    } catch {}
  }

  return null;
}

async function getBuffer(mediaMsg, mediaType, sock = null, fullMsg = null, { isPtv = false } = {}) {
  if (!mediaMsg || typeof mediaMsg !== 'object') {
    throw new Error('Missing media message payload');
  }
  const buf = await downloadMediaWithRecovery({
    media: mediaMsg,
    dlType: mediaType,
    isPtv,
    sock,
    msg: fullMsg,
  });
  if (Buffer.isBuffer(buf) && buf.length > 0) {
    return buf;
  }
  throw new Error('Unable to download media');
}

async function buildViewOncePayload({ sock, from, msg }) {
  const { contextInfo, rawQuotedMessage, quotedMessage } = extractContextInfo(msg);
  const stanzaId = contextInfo?.stanzaId || '';
  if (stanzaId) {
    await waitForPendingViewOnceCache(stanzaId);
  }
  const cached = stanzaId ? getCachedViewOnce(stanzaId) : null;
  const stored = await resolveStoredViewOnceMessage(sock, from, stanzaId);
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

  // 1) Best path: bytes cached on arrival (in-memory or persisted on disk)
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
    if (cached.type === 'document') {
      return {
        status: 'ok',
        payload: {
          document: cached.buffer,
          caption: formatTextCaption(cached.caption),
          mimetype: cached.mimetype || 'application/octet-stream',
        },
      };
    }
  }

  // 2) Fallback: check quoted copy / messageStore / socket store if it is a view-once message
  const quotedVo = extractViewOnceMedia(rawQuotedMessage);
  const storedVo = extractViewOnceMedia(storedRaw);
  const isVo =
    Boolean(quotedVo || storedVo) ||
    isViewOnceMessage(rawQuotedMessage) ||
    isViewOnceMessage(storedRaw) ||
    Boolean(
      quotedMessage?.imageMessage?.viewOnce ||
        quotedMessage?.videoMessage?.viewOnce ||
        quotedMessage?.ptvMessage?.viewOnce ||
        quotedMessage?.audioMessage?.viewOnce ||
        quotedMessage?.documentMessage?.viewOnce ||
        storedUnwrapped?.imageMessage?.viewOnce ||
        storedUnwrapped?.videoMessage?.viewOnce ||
        storedUnwrapped?.ptvMessage?.viewOnce ||
        storedUnwrapped?.audioMessage?.viewOnce ||
        storedUnwrapped?.documentMessage?.viewOnce,
    );

  if (!isVo) {
    return { status: 'not-viewonce' };
  }

  const imageMsg = mergeMediaNodes(
    quotedMessage?.imageMessage || (quotedVo?.type === 'image' ? quotedVo.media : null),
    storedUnwrapped?.imageMessage || (storedVo?.type === 'image' ? storedVo.media : null),
  );
  const videoMsg = mergeMediaNodes(
    quotedMessage?.videoMessage ||
      quotedMessage?.ptvMessage ||
      (quotedVo?.type === 'video' ? quotedVo.media : null),
    storedUnwrapped?.videoMessage ||
      storedUnwrapped?.ptvMessage ||
      (storedVo?.type === 'video' ? storedVo.media : null),
  );
  const audioMsg = mergeMediaNodes(
    quotedMessage?.audioMessage || (quotedVo?.type === 'audio' ? quotedVo.media : null),
    storedUnwrapped?.audioMessage || (storedVo?.type === 'audio' ? storedVo.media : null),
  );
  const documentMsg = mergeMediaNodes(
    quotedMessage?.documentMessage || (quotedVo?.type === 'document' ? quotedVo.media : null),
    storedUnwrapped?.documentMessage || (storedVo?.type === 'document' ? storedVo.media : null),
  );

  const reuploadKey = stored?.key || {
    remoteJid: from,
    id: stanzaId,
    fromMe: isFromBot(contextInfo?.participant, sock),
    ...(contextInfo?.participant ? { participant: contextInfo.participant } : {}),
  };

  if (imageMsg) {
    const normalized = { ...imageMsg, mediaKey: normalizeMediaKey(imageMsg.mediaKey) };
    const fullMsg = { key: reuploadKey, message: { imageMessage: normalized } };
    const buf = await downloadMediaWithRecovery({
      media: normalized,
      dlType: 'image',
      mediaTypeKey: 'imageMessage',
      sock,
      msg: fullMsg,
    });
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
    if (Buffer.isBuffer(buf) && buf.length > 0) {
      return {
        status: 'ok',
        payload: {
          image: buf,
          caption: formatTextCaption(imageMsg.caption),
          mimetype: imageMsg.mimetype || 'image/jpeg',
        },
      };
    }
    const thumbBuf = extractThumbnailBuffer(imageMsg);
    if (thumbBuf) {
      return {
        status: 'ok',
        payload: {
          image: thumbBuf,
          caption: formatTextCaption(imageMsg.caption),
          mimetype: 'image/jpeg',
        },
      };
    }
    return { status: 'unavailable' };
  }

  if (videoMsg) {
    const isPtv = Boolean(
      (quotedMessage?.ptvMessage && !quotedMessage?.videoMessage) ||
        (storedUnwrapped?.ptvMessage && !storedUnwrapped?.videoMessage) ||
        quotedVo?.isPtv ||
        storedVo?.isPtv,
    );
    const normalized = { ...videoMsg, mediaKey: normalizeMediaKey(videoMsg.mediaKey) };
    const fullMsg = {
      key: reuploadKey,
      message: { [isPtv ? 'ptvMessage' : 'videoMessage']: normalized },
    };
    const buf = await downloadMediaWithRecovery({
      media: normalized,
      dlType: 'video',
      mediaTypeKey: isPtv ? 'ptvMessage' : 'videoMessage',
      isPtv,
      sock,
      msg: fullMsg,
    });
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
    if (Buffer.isBuffer(buf) && buf.length > 0) {
      return {
        status: 'ok',
        payload: {
          video: buf,
          caption: formatTextCaption(videoMsg.caption),
          mimetype: videoMsg.mimetype || 'video/mp4',
        },
      };
    }
    const thumbBuf = extractThumbnailBuffer(videoMsg);
    if (thumbBuf) {
      return {
        status: 'ok',
        payload: {
          image: thumbBuf,
          caption: formatTextCaption(videoMsg.caption),
          mimetype: 'image/jpeg',
        },
      };
    }
    return { status: 'unavailable' };
  }

  if (audioMsg) {
    const normalized = { ...audioMsg, mediaKey: normalizeMediaKey(audioMsg.mediaKey) };
    const fullMsg = { key: reuploadKey, message: { audioMessage: normalized } };
    const buf = await downloadMediaWithRecovery({
      media: normalized,
      dlType: 'audio',
      mediaTypeKey: 'audioMessage',
      sock,
      msg: fullMsg,
    });
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
    if (Buffer.isBuffer(buf) && buf.length > 0) {
      return {
        status: 'ok',
        payload: {
          audio: buf,
          mimetype: audioMsg.mimetype || 'audio/mp4',
          ptt: Boolean(audioMsg.ptt),
        },
      };
    }
    return { status: 'unavailable' };
  }

  if (documentMsg) {
    const normalized = { ...documentMsg, mediaKey: normalizeMediaKey(documentMsg.mediaKey) };
    const fullMsg = { key: reuploadKey, message: { documentMessage: normalized } };
    const buf = await downloadMediaWithRecovery({
      media: normalized,
      dlType: 'document',
      mediaTypeKey: 'documentMessage',
      sock,
      msg: fullMsg,
    });
    if (stanzaId && Buffer.isBuffer(buf) && buf.length > 0) {
      setCachedViewOnce(stanzaId, {
        type: 'document',
        dlType: 'document',
        isPtv: false,
        buffer: buf,
        mimetype: documentMsg.mimetype || 'application/octet-stream',
        caption: String(documentMsg.caption || '').trim(),
        ptt: false,
        timestamp: Date.now(),
      });
    }
    if (Buffer.isBuffer(buf) && buf.length > 0) {
      return {
        status: 'ok',
        payload: {
          document: buf,
          caption: formatTextCaption(documentMsg.caption),
          mimetype: documentMsg.mimetype || 'application/octet-stream',
          fileName: documentMsg.fileName || 'view-once-file',
        },
      };
    }
    return { status: 'unavailable' };
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
        if (result.status === 'unavailable') {
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