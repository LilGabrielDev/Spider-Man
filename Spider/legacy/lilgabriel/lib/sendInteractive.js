async function sendInteractive(client, m, text, options = {}) {
  const target = m?.chat || m?.from || m?.key?.remoteJid;
  if (!client || typeof client.sendMessage !== 'function' || !target) {
    return null;
  }
  const payload = typeof text === 'string' ? { text, ...options } : { ...text, ...options };
  const sendOpts = m?.key ? { quoted: m } : {};
  return client.sendMessage(target, payload, sendOpts);
}

module.exports = sendInteractive;
module.exports.sendInteractive = sendInteractive;
module.exports.default = sendInteractive;
