import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import config from '../../spider/config.js';

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

export async function sendStatusButtons(sock, from, msg, { title, text, action, label }) {
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
