import giftedButtons from 'gifted-btns';
import config from '../../spider/config.js';

const { sendButtons } = giftedButtons;

export function buildInteractiveButtons(actions = []) {
  const prefix = config.PREFIXES?.[0] || '.';
  const buttons = actions
    .filter((item) => item?.command && item?.label)
    .slice(0, 2)
    .map(({ command, label }) => ({
      id: `${prefix}${command}`,
      text: label,
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

    return await sendButtons(sock, from, {
      title,
      text,
      footer: `> *${config.BOT_NAME || 'Spider Man'}*`,
      buttons: buildInteractiveButtons(actions),
      aimode: true,
    });
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
