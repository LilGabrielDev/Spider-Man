import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import performanceNow from 'performance-now';
import config from '../../spider/config.js';

if (!globalThis.botStartTime) {
  globalThis.botStartTime = Date.now();
}

export function buildStatusButtons(action, label) {
  const prefix = config.PREFIXES?.[0] || '.';
  const buttons = [{
    name: 'quick_reply',
    buttonParamsJson: JSON.stringify({
      display_text: label,
      id: `${prefix}${action}`,
    }),
  }];

  if (config.CHANNEL_URL) {
    buttons.push({
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: 'WhatsApp Channel',
        url: config.CHANNEL_URL,
      }),
    });
  }

  return buttons;
}

async function sendStatusButtons(sock, from, msg, { title, text, action, label }) {
  try {
    if (typeof sock.relayMessage !== 'function') {
      throw new Error('Baileys relayMessage is not available');
    }

    const generated = generateWAMessageFromContent(
      from,
      {
        interactiveMessage: {
          header: { title, hasMediaAttachment: false },
          body: { text },
          footer: { text: `> *${config.BOT_NAME || 'Spider Man'}*` },
          nativeFlowMessage: { buttons: buildStatusButtons(action, label) },
        },
      },
      { userJid: sock.user?.id },
    );

    await sock.relayMessage(from, generated.message, {
      messageId: generated.key.id,
      additionalNodes: [{ tag: 'biz', attrs: {} }],
    });
    return generated;
  } catch (error) {
    console.warn('Could not send interactive status buttons; using text fallback:', error?.message || error);
    return sock.sendMessage(from, { text }, { quoted: msg });
  }
}

export const commands = [
  {
    name: 'ping',
    aliases: ['latency', 'speed'],
    description: "Checks the bot's response time",
    category: 'General',
    execute: async ({ sock, from, msg }) => {
      const startedAt = performanceNow();
      const botName = config.BOT_NAME || 'Spider Man';
      await sock.sendMessage(from, { text: 'Pinging...' }, { quoted: msg });
      const latencyMs = Math.round(performanceNow() - startedAt);
      const text = `🏓 Pong!\n⏱️ *_${botName} Speed: ${latencyMs} ms_*`;

      return sendStatusButtons(sock, from, msg, {
        title: 'Bot Speed',
        text,
        action: 'uptime',
        label: '⏱️ Uptime',
      });
    },
  },
  {
    name: 'uptime',
    aliases: ['runtime'],
    description: 'Displays the bot uptime',
    category: 'General',
    execute: async ({ sock, from, msg }) => {
      const elapsedMs = Date.now() - globalThis.botStartTime;
      const uptime = formatUptime(elapsedMs);
      const botName = config.BOT_NAME || 'Spider Man';
      const text = `*${botName} UPTIME: ${uptime}*`;

      return sendStatusButtons(sock, from, msg, {
        title: 'Bot Uptime',
        text,
        action: 'ping',
        label: '⚡ Ping',
      });
    },
  },
];

function formatUptime(elapsedMs) {
  const seconds = Math.floor(elapsedMs / 1000) % 60;
  const minutes = Math.floor(elapsedMs / (1000 * 60)) % 60;
  const hours = Math.floor(elapsedMs / (1000 * 60 * 60)) % 24;
  const days = Math.floor(elapsedMs / (1000 * 60 * 60 * 24));
  const parts = [];

  if (days) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} m`);
  parts.push(`${seconds} s`);
  return parts.join(', ');
}
