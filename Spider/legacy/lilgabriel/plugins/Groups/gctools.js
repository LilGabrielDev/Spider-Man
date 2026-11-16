import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import {
  isFromBot,
  isSendMessageFailure,
  normalizeTargetJidInput,
} from '../../../../../spider/utils/groupActionHelper.js';

const H = (title) => `⚡ ──「 ${title} 」──\n├`;
const F = '└──✦ 𝐒𝐏𝐈𝐃𝐄𝐑 𝐌𝐀𝐍 ┃ ᴹᴰ ✦──';
const box = (title, rows) => `${H(title)}\n${rows.map((r) => `▢ ${r}`).join('\n')}\n│\n${F}`;

async function withAdminCheck(context, fn) {
  const { client, m, isGroup, isAdmin, isBotAdmin } = context;
  if (!isGroup && !String(m?.chat || '').endsWith('@g.us')) {
    return client.sendMessage(m.chat, { text: box('ERROR', ['❌ Use this inside a group.']) });
  }
  if (!isAdmin) {
    return client.sendMessage(m.chat, { text: box('ERROR', ['❌ Group admin only command.']) });
  }
  if (!isBotAdmin) {
    return client.sendMessage(m.chat, { text: box('ERROR', ['❌ Bot needs admin permissions.']) });
  }
  return fn();
}

async function sendSelectButtons(client, chat, _m, bodyText, title, rows) {
  try {
    const interactive = generateWAMessageFromContent(
      chat,
      {
        interactiveMessage: {
          body: { text: bodyText },
          footer: { text: '' },
          nativeFlowMessage: {
            buttons: [
              {
                name: 'single_select',
                buttonParamsJson: JSON.stringify({
                  title,
                  sections: [{ title: 'Options', rows }],
                }),
              },
            ],
          },
        },
      },
      { userJid: client?.user?.id || client?.authState?.creds?.me?.id, timestamp: new Date() },
    );
    await client.relayMessage(chat, interactive.message, { messageId: interactive.key.id });
  } catch {
    await client.sendMessage(chat, { text: bodyText });
  }
}

export default [
  {
    name: 'ngc',
    aliases: ['newgc', 'groupcreate', 'creategc', 'newgroup', 'creategroup'],
    description: 'Create a new WhatsApp group',
    run: async (context) => {
      const { client, m, text, isOwner, isSudo } = context;
      if (!isOwner && !isSudo) {
        return client.sendMessage(m.chat, { text: box('ERROR', ['❌ Owner only command.']) });
      }
      const subject = text?.trim();
      if (!subject) {
        return client.sendMessage(m.chat, {
          text: box('USAGE', [
            '📋 .ngc <group name>',
            '📌 Tag members to add them',
            '',
            '  .ngc Spider Squad @user',
            '  .newgc My Group',
          ]),
        });
      }

      await client.sendMessage(m.chat, { react: { text: '⌛', key: m.reactKey } }).catch(() => {});
      try {
        const members = (m.mentionedJid || [])
          .map((id) => normalizeTargetJidInput(id))
          .filter((id) => id && !isFromBot(id, client));
        const created = await client.groupCreate(subject, members);
        if (isSendMessageFailure(created)) {
          throw new Error(created?.error || 'Failed to create group');
        }
        const gid = created?.id || created?.gid || '';
        if (!gid) {
          throw new Error('WhatsApp did not return a group JID');
        }
        let inviteUrl = '';
        try {
          const code = await client.groupInviteCode(gid);
          if (code) inviteUrl = `https://chat.whatsapp.com/${code}`;
        } catch {}

        await client.sendMessage(m.chat, { react: { text: '✅', key: m.reactKey } }).catch(() => {});
        await client.sendMessage(m.chat, {
          text: box('GROUP CREATED', [
            `✅ *Name:* ${subject}`,
            `👥 *Members added:* ${members.length}`,
            `🔗 *JID:* ${gid}`,
            ...(inviteUrl ? [`🔑 *Link:* ${inviteUrl}`] : []),
          ]),
        });
      } catch (err) {
        await client.sendMessage(m.chat, { react: { text: '❌', key: m.reactKey } }).catch(() => {});
        await client.sendMessage(m.chat, { text: box('ERROR', [`❌ ${err.message}`]) });
      }
    },
  },
  {
    name: 'ginfo',
    aliases: ['groupinfo', 'gcinfo', 'groupmeta', 'gmetadata', 'gcmeta'],
    description: 'Show group info and metadata',
    run: async (context) => {
      await withAdminCheck(context, async () => {
        const { client, m } = context;
        if (!m.isGroup) {
          return client.sendMessage(m.chat, { text: box('ERROR', ['❌ Use this inside a group.']) });
        }

        await client.sendMessage(m.chat, { react: { text: '⌛', key: m.reactKey } }).catch(() => {});
        try {
          const meta = await client.groupMetadata(m.chat);
          const subject = meta?.subject || 'Unknown';
          const desc = meta?.desc || meta?.description || 'None';
          const ownerJid = meta?.owner || '';
          let ownerDisplay = 'Unknown';
          if (ownerJid) {
            if (ownerJid.endsWith('@lid')) {
              const lid = ownerJid.split('@')[0].split(':')[0];
              const cached = globalThis.lidPhoneCache?.get(lid);
              if (cached) {
                ownerDisplay = `+${cached}`;
              } else {
                const resolved = globalThis.resolvePhoneFromLidAsync
                  ? await globalThis.resolvePhoneFromLidAsync(ownerJid).catch(() => null)
                  : null;
                ownerDisplay = resolved ? `+${resolved}` : `+${lid}`;
              }
            } else {
              ownerDisplay = `+${ownerJid.split('@')[0]}`;
            }
          }

          const createdDate = meta?.creation
            ? new Date(meta.creation * 1000).toLocaleDateString('en-GB')
            : 'Unknown';
          const memberCount = meta?.participants?.length ?? 0;
          const adminCount = (meta?.participants || []).filter((p) => p.admin).length;
          const ephem = meta?.ephemeralDuration;
          const ephemLabel = ephem
            ? ephem === 86400
              ? '24 hours'
              : ephem === 604800
                ? '7 days'
                : ephem === 7776000
                  ? '90 days'
                  : `${ephem}s`
            : 'Off';

          await client.sendMessage(m.chat, { react: { text: '📋', key: m.reactKey } }).catch(() => {});
          await client.sendMessage(m.chat, {
            text: box('GROUP INFO', [
              `📛 *Name:* ${subject}`,
              `👑 *Owner:* ${ownerDisplay}`,
              `📅 *Created:* ${createdDate}`,
              `👥 *Members:* ${memberCount}`,
              `🛡️ *Admins:* ${adminCount}`,
              `⏳ *Disappearing:* ${ephemLabel}`,
              `📝 *Desc:* ${desc.slice(0, 80)}${desc.length > 80 ? '...' : ''}`,
            ]),
          });
        } catch (err) {
          await client.sendMessage(m.chat, { react: { text: '❌', key: m.reactKey } }).catch(() => {});
          await client.sendMessage(m.chat, { text: box('ERROR', [`❌ ${err.message}`]) });
        }
      });
    },
  },
  {
    name: 'wabot',
    aliases: ['addaibot', 'addwabot', 'gcaibot', 'addwhatsappbot'],
    description: 'Add the WhatsApp AI bot to this group',
    run: async (context) => {
      const { client, m, isOwner, isSudo } = context;
      if (!isOwner && !isSudo) {
        return client.sendMessage(m.chat, { text: box('ERROR', ['❌ Owner only command.']) });
      }
      if (!m.isGroup) {
        return client.sendMessage(m.chat, { text: box('ERROR', ['❌ Use this inside a group.']) });
      }
      await client.sendMessage(m.chat, { react: { text: '⌛', key: m.reactKey } }).catch(() => {});
      try {
        const res = await client.aiGroupAddBot(m.chat);
        if (isSendMessageFailure(res)) {
          throw new Error(res?.error || 'Failed to add WhatsApp AI bot');
        }
        await client.sendMessage(m.chat, { react: { text: '✅', key: m.reactKey } }).catch(() => {});
        await client.sendMessage(m.chat, {
          text: box('AI BOT ADDED', ['✅ WhatsApp AI bot has been added to this group!']),
        });
      } catch (err) {
        await client.sendMessage(m.chat, { react: { text: '❌', key: m.reactKey } }).catch(() => {});
        await client.sendMessage(m.chat, { text: box('ERROR', [`❌ ${err.message}`]) });
      }
    },
  },
  {
    name: 'disappearing',
    aliases: ['disappear', 'disap', 'dsp', 'vanish', 'gvanish', 'timer', 'ephemeral', 'vanish', 'gcvanish'],
    description: 'Set disappearing messages. No args = show picker.',
    run: async (context) => {
      await withAdminCheck(context, async () => {
        const { client, m, args, prefix } = context;
        if (!m.isGroup) {
          return client.sendMessage(m.chat, { text: box('ERROR', ['❌ Use this inside a group.']) });
        }

        const durations = {
          off: 0,
          '0': 0,
          no: 0,
          none: 0,
          disable: 0,
          '24h': 86400,
          '24': 86400,
          '1d': 86400,
          day: 86400,
          '7d': 604800,
          '7': 604800,
          week: 604800,
          '1w': 604800,
          '90d': 7776000,
          '90': 7776000,
          '3m': 7776000,
          month: 7776000,
        };

        const key = (args?.[0] || '').toLowerCase();
        if (!key || !(key in durations)) {
          const p = prefix || '.';
          const boxText = box('DISAPPEARING MESSAGES', [
            '⏳ Pick a timer for this group:',
            '',
            '  🚫 off  — Disable',
            '  ⏰ 24h — 24 hours',
            '  📅 7d  — 7 days',
            '  🗓️ 90d — 90 days',
          ]);
          return sendSelectButtons(client, m.chat, m, boxText, 'Set Timer', [
            { header: '🚫 Off', title: 'Disable disappearing messages', id: `${p}disappearing off` },
            { header: '⏰ 24 Hours', title: 'Messages vanish after 24h', id: `${p}disappearing 24h` },
            { header: '📅 7 Days', title: 'Messages vanish after 7 days', id: `${p}disappearing 7d` },
            { header: '🗓️ 90 Days', title: 'Messages vanish after 90 days', id: `${p}disappearing 90d` },
          ]);
        }

        const sec = durations[key];
        const label =
          sec === 0 ? 'Off' : sec === 86400 ? '24 hours' : sec === 604800 ? '7 days' : '90 days';
        await client.sendMessage(m.chat, { react: { text: '⌛', key: m.reactKey } }).catch(() => {});
        try {
          const res = await client.groupToggleEphemeral(m.chat, sec);
          if (isSendMessageFailure(res)) {
            throw new Error(res?.error || 'Failed to update disappearing messages');
          }
          await client.__spiderInvalidateGroupCache?.(m.chat);
          await client.sendMessage(m.chat, { react: { text: '✅', key: m.reactKey } }).catch(() => {});
          await client.sendMessage(m.chat, {
            text: box('DISAPPEARING MESSAGES', [`⏳ *Set to:* ${label}`]),
          });
        } catch (err) {
          await client.sendMessage(m.chat, { react: { text: '❌', key: m.reactKey } }).catch(() => {});
          await client.sendMessage(m.chat, { text: box('ERROR', [`❌ ${err.message}`]) });
        }
      });
    },
  },
];