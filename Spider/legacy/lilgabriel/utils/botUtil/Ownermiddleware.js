import { ownerNumber } from '../../config/settings.js';
import { getSudoUsers } from '../../database/config.js';
import {
  cleanUserJid,
  getLidFromJid,
  getPhoneFromJid,
  isOwnerIdentity,
  normalizeSudoTarget,
} from '../../../../../spider/utils/userJid.js';

export default async function Ownermiddleware(context = {}, next) {
  const client = context.client || context.sock;
  const m = context.m || {};
  const senderJid = cleanUserJid(context.sender || m.sender || m.key?.participant || m.key?.remoteJid);
  const senderPhone = getPhoneFromJid(senderJid);
  const senderLid = getLidFromJid(senderJid);

  let isAuthorized = Boolean(
    context.isOwner ||
      context.isSuperUser ||
      m.isOwner ||
      m.fromMe ||
      isOwnerIdentity({
        jid: senderJid,
        ownerNumber,
        sock: client,
      }),
  );

  if (!isAuthorized && (senderPhone || senderLid)) {
    try {
      const sudoUsers = await getSudoUsers();
      isAuthorized = sudoUsers.some((u) => {
        const norm = normalizeSudoTarget(u);
        return Boolean(norm && ((senderPhone && norm === senderPhone) || (senderLid && norm === senderLid)));
      });
    } catch {
      // keep existing authorization value
    }
  }

  if (!isAuthorized) {
    if (client && typeof client.sendMessage === 'function' && m.chat) {
      if (m.reactKey) {
        await client.sendMessage(m.chat, { react: { text: '❌', key: m.reactKey } }).catch(() => {});
      }
      await client.sendMessage(m.chat, { text: '❌ Owner Only Command!' }, m.key ? { quoted: m } : {}).catch(() => {});
    }
    return null;
  }

  if (typeof next === 'function') {
    return next();
  }
  return true;
}
