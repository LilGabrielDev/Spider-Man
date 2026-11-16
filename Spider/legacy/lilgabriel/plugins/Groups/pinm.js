import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import { isFromBot, pinMessageSafely } from '../../../../../spider/utils/groupActionHelper.js';

if (!global._spiderPinPending) {
  global._spiderPinPending = new Map();
}

async function sendInteractive(client, m, text) {
  return client.sendMessage(m.chat, { text }, { quoted: m });
}

const parseDuration = (raw) => {
  const match = String(raw || '').toLowerCase().match(/^(\d+)\s*(s|m|h|d)$/);
  if (match) {
    const val = parseInt(match[1], 10);
    if (match[2] === 's') return val;
    if (match[2] === 'm') return val * 60;
    if (match[2] === 'h') return val * 3600;
    if (match[2] === 'd') return val * 86400;
  }
  if (/^\d+$/.test(String(raw || ''))) return parseInt(raw, 10);
  return null;
};

const durationLabel = (sec) => {
  if (sec >= 86400 && sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
};

async function sendPinButtons(client, m, _fq, prefix) {
  const p = prefix || '.';
  const bodyText =
    '⚡ ──「 PIN MESSAGE 」──\n│\n' +
    '▢ How long should it stay pinned?\n│\n' +
    '└──✦ 𝐒𝐏𝐈𝐃𝐄𝐑 𝐌𝐀𝐍 ┃ ᴹᴰ ✦──';

  try {
    const interactive = generateWAMessageFromContent(
      m.chat,
      {
        interactiveMessage: {
          body: { text: bodyText },
          footer: { text: '' },
          nativeFlowMessage: {
            buttons: [
              {
                name: 'single_select',
                buttonParamsJson: JSON.stringify({
                  title: 'Pin Duration',
                  sections: [
                    {
                      title: 'How long?',
                      rows: [
                        { header: '⏱️ 24 Hours', title: 'Pin for 1 day', id: `${p}pinm 24h` },
                        { header: '📅 7 Days', title: 'Pin for 1 week', id: `${p}pinm 7d` },
                        { header: '🗓️ 30 Days', title: 'Pin for 1 month', id: `${p}pinm 30d` },
                      ],
                    },
                  ],
                }),
              },
            ],
          },
        },
      },
      { userJid: client?.user?.id || client?.authState?.creds?.me?.id || m?.sender, timestamp: new Date() },
    );
    await client.relayMessage(m.chat, interactive.message, { messageId: interactive.key.id });
  } catch {
    await sendInteractive(
      client,
      m,
      `${bodyText}\n\n▢ Use:\n▢ ${p}pinm 24h\n▢ ${p}pinm 7d\n▢ ${p}pinm 30d`,
    );
  }
}

export default {
  name: 'pinm',
  aliases: ['pinmessage', 'pinmsg'],
  description: 'Pin a replied-to message. Reply to message, then pick duration.',
  run: async (context) => {
    const { client, m, prefix, isGroup, IsGroup, args = [] } = context;
    const isGroupChat = Boolean(isGroup ?? IsGroup ?? String(m?.chat || '').endsWith('@g.us'));
    if (!isGroupChat) {
      await client.sendMessage(m.chat, { react: { text: '❌', key: m.reactKey } }).catch(() => {});
      return sendInteractive(client, m, '▢ \n▢ Groups only.\n└──✦ 𝐒𝐏𝐈𝐃𝐄𝐑 𝐌𝐀𝐍 ┃ ᴹᴰ ✦──');
    }

    const durationArg = args[0] || '';
    const duration = durationArg ? parseDuration(durationArg) : null;

    if (m.quoted) {
      const quotedId = m.quoted.id || m.quoted.key?.id;
      if (quotedId) {
        const quotedFromMe = Boolean(
          m.quoted.fromMe ??
            m.quoted.key?.fromMe ??
            isFromBot(m.quoted.sender || m.quoted.key?.participant, client),
        );
        const quotedParticipant = m.quoted.sender || m.quoted.key?.participant;
        const pinKey = {
          remoteJid: m.chat,
          id: quotedId,
          fromMe: quotedFromMe,
          ...(quotedParticipant ? { participant: quotedParticipant } : {}),
        };
        global._spiderPinPending.set(m.chat, { key: pinKey, ts: Date.now() });
        const pinTimeout = setTimeout(() => {
          const entry = global._spiderPinPending.get(m.chat);
          if (entry && Date.now() - entry.ts > 5 * 60 * 1000) {
            global._spiderPinPending.delete(m.chat);
          }
        }, 5 * 60 * 1000);
        pinTimeout?.unref?.();

        if (!duration) {
          await client.sendMessage(m.chat, { react: { text: '📌', key: m.reactKey } }).catch(() => {});
          return sendPinButtons(client, m, m, prefix);
        }
      }
    }

    const pending = global._spiderPinPending.get(m.chat);
    const quotedId = m.quoted?.id || m.quoted?.key?.id;
    const targetKey =
      pending?.key ||
      (m.quoted && quotedId
        ? {
            remoteJid: m.chat,
            id: quotedId,
            fromMe: Boolean(
              m.quoted.fromMe ??
                m.quoted.key?.fromMe ??
                isFromBot(m.quoted.sender || m.quoted.key?.participant, client),
            ),
            ...(m.quoted.sender || m.quoted.key?.participant
              ? { participant: m.quoted.sender || m.quoted.key?.participant }
              : {}),
          }
        : null);

    if (!targetKey) {
      await client.sendMessage(m.chat, { react: { text: '❌', key: m.reactKey } }).catch(() => {});
      return sendInteractive(
        client,
        m,
        `▢ \n▢ Reply to a message first, then use ${prefix || '.'}pinm.\n└──✦ 𝐒𝐏𝐈𝐃𝐄𝐑 𝐌𝐀𝐍 ┃ ᴹᴰ ✦──`,
      );
    }

    const pinDuration = duration || 86400;
    await client.sendMessage(m.chat, { react: { text: '⌛', key: m.reactKey } }).catch(() => {});
    try {
      const pinRes = await pinMessageSafely({
        sock: client,
        from: m.chat,
        key: targetKey,
        type: 1,
        time: pinDuration,
      });
      if (!pinRes.ok) {
        throw new Error(pinRes.error || 'Pin action rejected');
      }
      global._spiderPinPending.delete(m.chat);
      await client.sendMessage(m.chat, { react: { text: '✅', key: m.reactKey } }).catch(() => {});
      await sendInteractive(
        client,
        m,
        `▢ \n▢ 📌 Message pinned!\n▢ Duration: ${durationLabel(pinDuration)}\n└──✦ 𝐒𝐏𝐈𝐃𝐄𝐑 𝐌𝐀𝐍 ┃ ᴹᴰ ✦──`,
      );
    } catch (err) {
      await client.sendMessage(m.chat, { react: { text: '❌', key: m.reactKey } }).catch(() => {});
      await sendInteractive(
        client,
        m,
        `▢ \n▢ ❌ Failed to pin: ${err.message}\n└──✦ 𝐒𝐏𝐈𝐃𝐄𝐑 𝐌𝐀𝐍 ┃ ᴹᴰ ✦──`,
      );
    }
  },
};