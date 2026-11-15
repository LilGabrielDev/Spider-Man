import { resolveTargetFromMessage } from '../../spider/utils/groupActionHelper.js';

export async function executeGetPP({ sock, from, text = '', args = [], msg }) {
  let metadata = null;
  if (from && String(from).endsWith('@g.us')) {
    try {
      metadata = await sock?.groupMetadata?.(from);
    } catch {}
  }
  const resolved = resolveTargetFromMessage({ sock, from, msg, text, args, metadata });
  const candidates = Array.from(
    new Set(
      [
        resolved.phone ? `${resolved.phone}@s.whatsapp.net` : '',
        resolved.targetJid,
        ...(Array.isArray(resolved.alternateJids) ? resolved.alternateJids : []),
      ].filter(Boolean),
    ),
  );
  if (!candidates.length && from) {
    candidates.push(from);
  }
  let image = null;
  for (const candidate of candidates) {
    try {
      const url = await sock.profilePictureUrl(candidate, 'image');
      if (url) {
        image = url;
        break;
      }
    } catch {}
  }
  if (image) {
    try {
      await sock.sendMessage(from, { image: { url: image } }, { quoted: msg });
      return;
    } catch {}
  }
  await sock.sendMessage(from, { text: 'No profile picture is available.' }, { quoted: msg });
}

export async function getProfilePictureUrl(sock, jid, type = 'image') {
  return sock?.profilePictureUrl ? sock.profilePictureUrl(jid, type) : null;
}

export default getProfilePictureUrl;
