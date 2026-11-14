export const messageStore = new Map();
const messagesByChatAndId = new Map();
const wrappedSockets = new WeakSet();
const MAX_MESSAGES = 1000;

function chatMessageKey(key) {
  if (!key?.remoteJid || !key?.id) return '';
  return `${key.remoteJid}\u0000${key.id}`;
}

export function cleanMessageStore() {
  while (messageStore.size > MAX_MESSAGES) {
    messageStore.delete(messageStore.keys().next().value);
  }
  while (messagesByChatAndId.size > MAX_MESSAGES) {
    messagesByChatAndId.delete(messagesByChatAndId.keys().next().value);
  }
}

export function rememberMessage(message) {
  const id = message?.key?.id;
  if (!id || !message?.message) return false;

  const stored = { ...message, timestamp: Date.now() };
  messageStore.delete(id);
  messageStore.set(id, stored);

  const compositeKey = chatMessageKey(message.key);
  if (compositeKey) {
    messagesByChatAndId.delete(compositeKey);
    messagesByChatAndId.set(compositeKey, stored);
  }

  cleanMessageStore();
  return true;
}

export async function getMessageForRetry(key) {
  if (!key?.id) return undefined;
  const compositeKey = chatMessageKey(key);
  const stored = compositeKey
    ? messagesByChatAndId.get(compositeKey)
    : messageStore.get(key.id);
  return stored?.message;
}

export function installMessageRetryStore(sock) {
  if (!sock || typeof sock.sendMessage !== 'function') return false;
  if (wrappedSockets.has(sock)) return true;

  const originalSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const sentMessage = await originalSendMessage(...args);
    rememberMessage(sentMessage);
    return sentMessage;
  };

  if (typeof sock.relayMessage === 'function') {
    const originalRelayMessage = sock.relayMessage.bind(sock);
    sock.relayMessage = async (jid, message, options = {}) => {
      const result = await originalRelayMessage(jid, message, options);
      const id = options?.messageId || result?.key?.id;
      if (id) rememberMessage({ key: { remoteJid: jid, id, fromMe: true }, message });
      return result;
    };
  }

  wrappedSockets.add(sock);
  return true;
}

export async function handleDeletedMessage() {}
export async function handleEditedMessage() {}
