export async function executeGetPP({ sock, from, msg }) {
  const target = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || from;
  try {
    const image = await sock.profilePictureUrl(target, "image");
    await sock.sendMessage(from, { image: { url: image } }, { quoted: msg });
  } catch {
    await sock.sendMessage(from, { text: "No profile picture is available." }, { quoted: msg });
  }
}

export async function getProfilePictureUrl(sock, jid, type = "image") {
  return sock?.profilePictureUrl ? sock.profilePictureUrl(jid, type) : null;
}

export default getProfilePictureUrl;
