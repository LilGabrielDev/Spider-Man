import { resolveTargetFromMessage } from '../../spider/utils/groupActionHelper.js';

export async function executeGetPP({ sock, from, text = '', args = [], msg }) {
  let metadata = null;
  if (from && String(from).endsWith('@g.us')) {
    try {
      metadata = await sock?.groupMetadata?.(from);
    } catch {}
  }
  const resolved = resolveTargetFromMessage({ sock, from, msg, text, args, metadata });
  const target = resolved.targetJid || from;
  try {
    const image = await sock.profilePictureUrl(target, 'image');
    await sock.sendMessage(from, { image: { url: image } }, { quoted: msg });
  } catch {
    await sock.sendMessage(from, { text: 'No profile picture is available.' }, { quoted: msg });
  }
}

export async function getProfilePictureUrl(sock, jid, type = 'image') {
  return sock?.profilePictureUrl ? sock.profilePictureUrl(jid, type) : null;
}

export default getProfilePictureUrl;
