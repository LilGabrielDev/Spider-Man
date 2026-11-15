export default async function middleware(context = {}, next) {
  const client = context.client || context.sock;
  const m = context.m || {};
  const chat = m.chat || context.from || '';
  const isGroup = Boolean(context.isGroup || m.isGroup || String(chat).endsWith('@g.us'));
  const isOwner = Boolean(context.isOwner || context.isSuperUser || m.isOwner || m.fromMe);
  const isAdmin = Boolean(context.isAdmin || m.isAdmin || isOwner);

  if (isGroup && !isAdmin) {
    if (client && typeof client.sendMessage === 'function' && chat) {
      if (m.reactKey) {
        await client.sendMessage(chat, { react: { text: '❌', key: m.reactKey } }).catch(() => {});
      }
      await client.sendMessage(chat, { text: '❌ Admin Only Command!' }, m.key ? { quoted: m } : {}).catch(() => {});
    }
    return null;
  }

  if (typeof next === 'function') {
    return next();
  }
  return true;
}
