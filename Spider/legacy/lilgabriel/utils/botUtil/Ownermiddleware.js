import { ownerNumber } from '../../config/settings.js';
import { getSudoUsers } from '../../database/config.js';

function digitsOnly(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

export default async function Ownermiddleware(context = {}, next) {
  const client = context.client || context.sock;
  const m = context.m || {};
  const senderDigits = digitsOnly(context.sender || m.sender || m.key?.participant || m.key?.remoteJid);
  const ownerDigits = digitsOnly(ownerNumber || process.env.OWNER_NUMBER);

  let isAuthorized = Boolean(
    context.isOwner ||
      context.isSuperUser ||
      m.isOwner ||
      m.fromMe ||
      (ownerDigits && senderDigits && ownerDigits === senderDigits),
  );

  if (!isAuthorized && senderDigits) {
    try {
      const sudoUsers = await getSudoUsers();
      isAuthorized = sudoUsers.some((u) => digitsOnly(u) === senderDigits);
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
