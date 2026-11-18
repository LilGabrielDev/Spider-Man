import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import config from '../../spider/config.js';

export function buildInteractiveButtons(actions = []) {
  const prefix = config.PREFIXES?.[0] || '.';
  const buttons = actions
    .filter((item) => item?.command && item?.label)
    .slice(0, 2)
    .map(({ command, label }) => ({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({
        display_text: label,
        id: `${prefix}${command}`,
      }),
    }));

  if (config.CHANNEL_URL && buttons.length < 3) {
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

export function buildStatusButtons(action, label) {
  return buildInteractiveButtons([{ command: action, label }]);
}

export async function sendInteractiveButtons(sock, from, msg, { title, text, actions = [] }) {
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
          nativeFlowMessage: { buttons: buildInteractiveButtons(actions) },
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
    console.warn('Could not send interactive buttons; using text fallback:', error?.message || error);
    return sock.sendMessage(from, { text }, { quoted: msg });
  }
}

export async function sendStatusButtons(sock, from, msg, { title, text, action, label }) {
  return sendInteractiveButtons(sock, from, msg, {
    title,
    text,
    actions: [{ command: action, label }],
  });
}
