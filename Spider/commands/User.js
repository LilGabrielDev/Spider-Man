import { S_WHATSAPP_NET } from '@whiskeysockets/baileys';
import { formatJid, protectOwner } from '../france/index.js';
import { t } from '../france/translator.js';
import { executeGetPP } from '../utils/profilePicture.js';
import { cleanJid, extractPhoneDigits } from '../../spider/utils/groupRoleResolver.js';
import {
  deleteMessageSafely,
  isSendMessageFailure,
  resolveQuotedDeleteTargetAsync,
  resolveTargetFromMessage,
} from '../../spider/utils/groupActionHelper.js';

let isStatusFetching = false;
let fetchInterval = null;

async function fetchMetaSafe(sock, from) {
  if (!from || !String(from).endsWith('@g.us')) return null;
  try {
    if (typeof sock?.groupMetadata === 'function') {
      return await sock.groupMetadata(from);
    }
  } catch {}
  return null;
}

export const commands = [
  {
    name: 'block',
    description: 'Block a WhatsApp user',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, text, args = [], msg }) => {
      const metadata = await fetchMetaSafe(sock, from);
      const resolved = resolveTargetFromMessage({ sock, from, msg, text, args, metadata });
      const rawText = String(text || '').trim();
      const targetJid =
        resolved.targetJid ||
        (rawText ? (rawText.includes('@') ? cleanJid(rawText) : formatJid(rawText)) : '');

      if (!targetJid) {
        const noTarget = await t(from, 'user', 'blockNoTarget');
        return sock.sendMessage(from, { text: noTarget }, { quoted: msg });
      }
      const phone = resolved.phone || extractPhoneDigits(targetJid);
      if (protectOwner(targetJid) || (phone && protectOwner(`${phone}@s.whatsapp.net`))) {
        const protectedMsg = await t(from, 'user', 'blockProtected');
        return sock.sendMessage(from, { text: protectedMsg }, { quoted: msg });
      }
      try {
        const res = await sock.updateBlockStatus(targetJid, 'block');
        if (isSendMessageFailure(res)) throw new Error('block-failed');
        const successMsg = await t(from, 'user', 'blockSuccess');
        await sock.sendMessage(from, { text: successMsg.replace('{jid}', targetJid) }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'user', 'blockError');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'unblock',
    description: 'Unblock a WhatsApp user',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, text, args = [], msg }) => {
      const metadata = await fetchMetaSafe(sock, from);
      const resolved = resolveTargetFromMessage({ sock, from, msg, text, args, metadata });
      const rawText = String(text || '').trim();
      const targetJid =
        resolved.targetJid ||
        (rawText ? (rawText.includes('@') ? cleanJid(rawText) : formatJid(rawText)) : '');

      if (!targetJid) {
        const noTarget = await t(from, 'user', 'unblockNoTarget');
        return sock.sendMessage(from, { text: noTarget }, { quoted: msg });
      }
      const phone = resolved.phone || extractPhoneDigits(targetJid);
      if (protectOwner(targetJid) || (phone && protectOwner(`${phone}@s.whatsapp.net`))) {
        const protectedMsg = await t(from, 'user', 'unblockProtected');
        return sock.sendMessage(from, { text: protectedMsg }, { quoted: msg });
      }
      try {
        const res = await sock.updateBlockStatus(targetJid, 'unblock');
        if (isSendMessageFailure(res)) throw new Error('unblock-failed');
        const successMsg = await t(from, 'user', 'unblockSuccess');
        await sock.sendMessage(from, { text: successMsg.replace('{jid}', targetJid) }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'user', 'unblockError');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'setbio',
    description: 'Set WhatsApp bio',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, text, msg }) => {
      if (!text) {
        const noText = await t(from, 'user', 'setbioNoText');
        return sock.sendMessage(from, { text: noText }, { quoted: msg });
      }
      try {
        const res = await sock.query({
          tag: 'iq',
          attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'status' },
          content: [{ tag: 'status', attrs: {}, content: Buffer.from(text, 'utf-8') }],
        });
        if (isSendMessageFailure(res)) throw new Error('setbio-failed');
        const successMsg = await t(from, 'user', 'setbioSuccess');
        await sock.sendMessage(from, { text: successMsg }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'user', 'setbioError');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'autobio',
    description: 'Toggle automatic bio',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, text, msg }) => {
      if (!text) {
        const usageMsg = await t(from, 'user', 'autobioUsage');
        return sock.sendMessage(from, { text: usageMsg }, { quoted: msg });
      }
      if (text === 'on') {
        if (isStatusFetching) {
          const alreadyOn = await t(from, 'user', 'autobioAlreadyOn');
          return sock.sendMessage(from, { text: alreadyOn }, { quoted: msg });
        }
        isStatusFetching = true;
        clearInterval(fetchInterval);
        fetchInterval = setInterval(async () => {
          try {
            const resp = await fetch('https://nekos.life/api/v2/fact');
            const data = await resp.json();
            const bioText = `Spider Man: ${data.fact}`;
            await sock.query({
              tag: 'iq',
              attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'status' },
              content: [{ tag: 'status', attrs: {}, content: Buffer.from(bioText, 'utf-8') }],
            });
          } catch {}
        }, 60000);
        fetchInterval?.unref?.();
        const enabledMsg = await t(from, 'user', 'autobioEnabled');
        return sock.sendMessage(from, { text: enabledMsg }, { quoted: msg });
      }
      if (text === 'off') {
        if (!isStatusFetching) {
          const alreadyOff = await t(from, 'user', 'autobioAlreadyOff');
          return sock.sendMessage(from, { text: alreadyOff }, { quoted: msg });
        }
        clearInterval(fetchInterval);
        fetchInterval = null;
        isStatusFetching = false;
        const disabledMsg = await t(from, 'user', 'autobioDisabled');
        return sock.sendMessage(from, { text: disabledMsg }, { quoted: msg });
      }
      const usageMsg = await t(from, 'user', 'autobioUsage');
      await sock.sendMessage(from, { text: usageMsg }, { quoted: msg });
    },
  },
  {
    name: 'getpp',
    description: 'Get profile picture',
    category: 'USER',
    execute: executeGetPP,
  },
  {
    name: 'whois',
    description: 'User information',
    category: 'USER',
    execute: async ({ sock, from, text, args = [], msg }) => {
      const metadata = await fetchMetaSafe(sock, from);
      const resolved = resolveTargetFromMessage({
        sock,
        from,
        msg,
        text,
        args,
        metadata,
        allowSenderFallback: true,
      });
      const targetJid = resolved.targetJid || from;
      const targetNum = resolved.displayUser || cleanJid(targetJid).split('@')[0];
      const candidates = Array.from(
        new Set(
          [
            resolved.phone ? `${resolved.phone}@s.whatsapp.net` : '',
            targetJid,
            ...(Array.isArray(resolved.alternateJids) ? resolved.alternateJids : []),
          ].filter(Boolean),
        ),
      );

      let ppUrl;
      for (const cand of candidates) {
        try {
          const fetched = await sock.profilePictureUrl(cand, 'image');
          if (fetched) {
            ppUrl = fetched;
            break;
          }
        } catch {}
      }
      if (!ppUrl) {
        ppUrl = await t(from, 'user', 'whoisDefaultImage');
      }

      let statusText = 'No status';
      let setDate = 'Unknown';
      let setTime = 'Unknown';
      for (const cand of candidates) {
        try {
          const statuses = await sock.fetchStatus(cand);
          if (statuses && statuses[0] && statuses[0].status) {
            const entry = statuses[0].status;
            statusText = entry.status || 'Unknown';
            if (entry.setAt) {
              const dt = new Date(entry.setAt);
              if (!isNaN(dt.getTime())) {
                setDate = dt.toLocaleDateString('en-GB');
                setTime = dt.toLocaleTimeString('en-GB');
              }
            }
            break;
          }
        } catch (err) {
          console.log('[WHOIS] fetchStatus error:', err.message);
        }
      }

      try {
        await sock.onWhatsApp(candidates[0] || targetJid);
      } catch {}

      const aboutLabel = await t(from, 'user', 'whoisAbout');
      const nameLabel = await t(from, 'user', 'whoisName');
      const setOnLabel = await t(from, 'user', 'whoisSetOn');
      const setAtLabel = await t(from, 'user', 'whoisSetAt');
      const footerLabel = await t(from, 'user', 'whoisFooter');

      const caption = `👤 *${aboutLabel}:* ${statusText}\n\n*${nameLabel}:* @${targetNum}\n\n📅 *${setOnLabel}:* ${setDate}\n🕒 *${setAtLabel}:* ${setTime}\n\n${footerLabel}`;
      await sock.sendMessage(
        from,
        {
          image: { url: ppUrl },
          caption,
          mentions: [targetJid],
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'mygroups',
    description: 'List all groups',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      try {
        const groups = Object.values(await sock.groupFetchAllParticipating());
        const header = await t(from, 'user', 'mygroupsHeader');
        const itemTpl = await t(from, 'user', 'mygroupsItem');
        let output = header;
        for (const group of groups) {
          output += itemTpl
            .replace('{subject}', group.subject)
            .replace('{count}', group.participants.length)
            .replace('{id}', group.id);
        }
        await sock.sendMessage(from, { text: output }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'user', 'mygroupsError');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'del',
    description: 'Delete a replied message',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      const metadata = await fetchMetaSafe(sock, from);
      const delTarget = await resolveQuotedDeleteTargetAsync({ from, msg, sock, metadata });
      if (!delTarget) return;

      const res = await deleteMessageSafely({
        sock,
        from,
        msg: delTarget.msg,
        targetJid: delTarget.participant,
        senderCandidates: delTarget.candidates,
        metadata,
        allowFromMeFallback: true,
        broadcastAlternates: true,
      });

      if (!res.ok) {
        await sock.sendMessage(
          from,
          { text: '❌ Failed to delete message.' },
          { quoted: msg },
        );
      }
    },
  },
  {
    name: 'restart',
    description: 'Restart bot',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      const restartMsg = await t(from, 'user', 'restartMessage');
      await sock.sendMessage(from, { text: restartMsg }, { quoted: msg });
      process.exit(0);
    },
  },
];