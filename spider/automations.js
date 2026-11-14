function pickEmoji(config) {
  const values = String(config?.AUTO_REACT_EMOJIS || "🐾,⚡,💜")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values[Math.floor(Math.random() * values.length)] || "🐾";
}

export async function maybeAutoReact(sock, message, config = {}) {
  if (!config.AUTO_REACT || !sock?.sendMessage || !message?.key?.remoteJid || message.key.fromMe) return;
  await sock.sendMessage(message.key.remoteJid, {
    react: { text: pickEmoji(config), key: message.key },
  });
}
