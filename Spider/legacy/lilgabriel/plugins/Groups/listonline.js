import { cleanUserJid } from '../../../../../spider/utils/userJid.js';
import { sendInteractive } from '../../lib/sendInteractive.js';

const ONLINE_STATES = new Set(['available', 'composing', 'recording']);
const PRESENCE_FRESH_MS = 120_000;

export default {
  name: 'listonline',
  aliases: ['onlinelist', 'whosonline', 'online'],
  description: 'List group members who are currently online',
  run: async (ctx) => {
    const { client, m, isGroup } = ctx;
    await client.sendMessage(m.chat, { react: { text: '⌛', key: m.reactKey } });
    const inGroup = isGroup || m.isGroup || m.chat?.endsWith('@g.us');
    if (!inGroup) {
      return sendInteractive(
        client,
        m,
        '⚡ ──「 Oɴʟɪɴᴇ Lɪsᴛ 」──\n│\n▢ This only works in groups, genius.\n└──✦ 𝐒𝐏𝐈𝐃𝐄𝐑 𝐌𝐀𝐍 ┃ ᴹᴰ ✦──',
      );
    }

    try {
      const metadata = await client.groupMetadata(m.chat);
      const participants = (metadata?.participants || []).slice(0, 25);
      const targets = [];

      for (const p of participants) {
        const candidates = [];
        const add = (val) => {
          const s = String(val || '').trim();
          if (!s) return;
          if (!candidates.includes(s)) candidates.push(s);
          const cleaned = cleanUserJid(s);
          if (cleaned && !candidates.includes(cleaned)) candidates.push(cleaned);
        };

        add(p?.phoneNumber);
        add(p?.pn);
        add(p?.id);
        add(p?.jid);

        const rawId = p?.id || p?.jid || '';
        if (rawId.endsWith('@lid') || rawId.endsWith('@hosted.lid')) {
          const cleanedLid = cleanUserJid(rawId);
          const cached =
            (typeof globalThis.resolvePhoneFromLid === 'function'
              ? globalThis.resolvePhoneFromLid(cleanedLid)
              : '') ||
            globalThis.lidPhoneCache?.get?.(cleanedLid) ||
            '';
          if (cached) {
            const digits = String(cached).replace(/\D/g, '');
            if (digits) add(`${digits}@s.whatsapp.net`);
          }
          const getPNForLID = client?.signalRepository?.lidMapping?.getPNForLID;
          if (typeof getPNForLID === 'function') {
            try {
              const pn = await getPNForLID.call(client.signalRepository.lidMapping, cleanedLid);
              if (pn) add(pn);
            } catch {}
          }
        }

        if (candidates.length > 0) {
          const preferred =
            candidates.find((c) => !c.endsWith('@lid') && !c.endsWith('@hosted.lid')) ||
            candidates[0];
          targets.push({ preferred, candidates });
        }
      }

      if (typeof client.presenceSubscribe === 'function') {
        for (const { preferred } of targets) {
          try {
            await client.presenceSubscribe(preferred);
          } catch {}
        }
      }

      const presenceMap =
        global._spiderPresenceMap instanceof Map
          ? global._spiderPresenceMap
          : globalThis._spiderPresenceMap instanceof Map
            ? globalThis._spiderPresenceMap
            : new Map();
      const hasImmediateData =
        presenceMap.size > 0 ||
        Boolean(client.userPresence && Object.keys(client.userPresence).length > 0);
      await new Promise((resolve) => setTimeout(resolve, hasImmediateData ? 50 : 1500));

      const now = Date.now();
      const online = [];
      const seen = new Set();

      for (const { preferred, candidates } of targets) {
        let isOnline = false;
        for (const cand of candidates) {
          const entry = presenceMap.get(cand) || client.userPresence?.[cand];
          if (
            entry &&
            ONLINE_STATES.has(entry.lastKnownPresence) &&
            (!entry.timestamp || now - entry.timestamp < PRESENCE_FRESH_MS)
          ) {
            isOnline = true;
            break;
          }
        }
        if (isOnline && !seen.has(preferred)) {
          seen.add(preferred);
          online.push(preferred);
        }
      }

      await client.sendMessage(m.chat, { react: { text: '✅', key: m.reactKey } });
      const body =
        online.length > 0
          ? online.map((jid, idx) => `▢ [${idx + 1}] @${jid.split('@')[0]}`).join('\n')
          : "▢ Nobody seems online right now.\n▢ WhatsApp only reports presence for subscribed contacts.";
      return client.sendMessage(m.chat, {
        text: `⚡ ──「 Oɴʟɪɴᴇ Mᴇᴍʙᴇʀs 」──\n│\n${body}\n└──✦ 𝐒𝐏𝐈𝐃𝐄𝐑 𝐌𝐀𝐍 ┃ ᴹᴰ ✦──`,
        mentions: online,
      });
    } catch {
      await client.sendMessage(m.chat, { react: { text: '❌', key: m.reactKey } });
      return sendInteractive(
        client,
        m,
        "⚡ ──「 Oɴʟɪɴᴇ Lɪsᴛ 」──\n│\n▢ Couldn't fetch online members.\n└──✦ 𝐒𝐏𝐈𝐃𝐄𝐑 𝐌𝐀𝐍 ┃ ᴹᴰ ✦──",
      );
    }
  },
};