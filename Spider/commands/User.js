import { S_WHATSAPP_NET } from '@whiskeysockets/baileys';
import { formatJid, protectOwner } from '../france/index.js';
import { t } from '../france/translator.js';
import { executeGetPP } from '../utils/profilePicture.js';
import { spiderHeader, spiderRow, spiderDivider, spiderFooter } from '../utils/tableStyle.js';
import { cleanJid, extractPhoneDigits } from '../../spider/utils/groupRoleResolver.js';
import { getPhoneFromJid } from '../../spider/utils/userJid.js';
import { listRecentChatMessages } from '../../spider/anti.js';
import {
  deleteMessageSafely,
  isSendMessageFailure,
  resolveQuotedDeleteTargetAsync,
  resolveTargetFromMessage,
} from '../../spider/utils/groupActionHelper.js';
import { applyPostUpdateReload } from '../../spider/utils/runtimeControl.js';
import {
  MAX_BIO_LENGTH,
  PRESET_AUTOBIOS,
  applyProfileBio,
  defaultAutobioManager,
  defaultAutobioStore,
  formatAutobioInterval,
  parseAutobioInterval,
} from '../../spider/utils/autobioStore.js';

function getAutobioManager() {
  return globalThis.__spiderAutobioManager || defaultAutobioManager;
}

function buildAutobioStatusCard(botName, state, headline = 'AUTO BIO') {
  const savedDisplay =
    state.bios.length > 0 ? `${state.bios.length}` : `0 (${PRESET_AUTOBIOS.length} built-in active)`;
  const lines = [
    spiderHeader(botName, headline),
    spiderRow('STATUS', state.enabled ? '🟢 ON' : '🔴 OFF', '⚙️'),
    spiderRow('INTERVAL', formatAutobioInterval(state.intervalMs), '⏱️'),
    spiderRow('SAVED BIOS', savedDisplay, '📝'),
    spiderRow('LAST ABOUT', state.lastBio || 'Not updated yet', '💬'),
    spiderDivider('COMMANDS'),
    spiderRow('ENABLE', '.autobio on', '▶️'),
    spiderRow('PRESETS', `.autobio presets (${PRESET_AUTOBIOS.length} bios)`, '📚'),
    spiderRow('ADD BIO', '.autobio add <text>', '➕'),
    spiderRow('SET BIO', '.autobio set <text>', '✏️'),
    spiderRow('LIST', '.autobio list [page|all]', '📋'),
    spiderRow('DELETE', '.autobio del <#|all>', '🗑️'),
    spiderRow('INTERVAL', '.autobio interval 60s', '🕒'),
    spiderRow('DISABLE', '.autobio off', '⏹️'),
    spiderFooter(`MAX ${MAX_BIO_LENGTH} CHARS PER BIO`),
  ];
  return lines.join('\n');
}

async function fetchMetaSafe(sock, from) {
  if (!from || !String(from).endsWith('@g.us')) return null;
  try {
    if (typeof sock?.groupMetadata === 'function') {
      return await sock.groupMetadata(from);
    }
  } catch {}
  return null;
}

export const commands = [
  {
    name: 'block',
    description: 'Block a WhatsApp user',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, text, args = [], msg }) => {
      const metadata = await fetchMetaSafe(sock, from);
      const resolved = resolveTargetFromMessage({ sock, from, msg, text, args, metadata });
      const rawText = String(text || '').trim();
      const targetJid =
        resolved.targetJid ||
        (rawText ? (rawText.includes('@') ? cleanJid(rawText) : formatJid(rawText)) : '');

      if (!targetJid) {
        const noTarget = await t(from, 'user', 'blockNoTarget');
        return sock.sendMessage(from, { text: noTarget }, { quoted: msg });
      }
      const phone = resolved.phone || extractPhoneDigits(targetJid);
      if (protectOwner(targetJid) || (phone && protectOwner(`${phone}@s.whatsapp.net`))) {
        const protectedMsg = await t(from, 'user', 'blockProtected');
        return sock.sendMessage(from, { text: protectedMsg }, { quoted: msg });
      }
      try {
        const res = await sock.updateBlockStatus(targetJid, 'block');
        if (isSendMessageFailure(res)) throw new Error('block-failed');
        const successMsg = await t(from, 'user', 'blockSuccess');
        await sock.sendMessage(from, { text: successMsg.replace('{jid}', targetJid) }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'user', 'blockError');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'unblock',
    description: 'Unblock a WhatsApp user',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, text, args = [], msg }) => {
      const metadata = await fetchMetaSafe(sock, from);
      const resolved = resolveTargetFromMessage({ sock, from, msg, text, args, metadata });
      const rawText = String(text || '').trim();
      const targetJid =
        resolved.targetJid ||
        (rawText ? (rawText.includes('@') ? cleanJid(rawText) : formatJid(rawText)) : '');

      if (!targetJid) {
        const noTarget = await t(from, 'user', 'unblockNoTarget');
        return sock.sendMessage(from, { text: noTarget }, { quoted: msg });
      }
      const phone = resolved.phone || extractPhoneDigits(targetJid);
      if (protectOwner(targetJid) || (phone && protectOwner(`${phone}@s.whatsapp.net`))) {
        const protectedMsg = await t(from, 'user', 'unblockProtected');
        return sock.sendMessage(from, { text: protectedMsg }, { quoted: msg });
      }
      try {
        const res = await sock.updateBlockStatus(targetJid, 'unblock');
        if (isSendMessageFailure(res)) throw new Error('unblock-failed');
        const successMsg = await t(from, 'user', 'unblockSuccess');
        await sock.sendMessage(from, { text: successMsg.replace('{jid}', targetJid) }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'user', 'unblockError');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'setbio',
    description: 'Set WhatsApp bio',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, text, msg }) => {
      const rawBio = String(text || '').trim();
      if (!rawBio) {
        const noText = await t(from, 'user', 'setbioNoText');
        return sock.sendMessage(from, { text: noText }, { quoted: msg });
      }
      try {
        const applied = await applyProfileBio(sock, rawBio);
        (getAutobioManager().store || defaultAutobioStore).recordAppliedBio(applied.bio);
        const successMsg = await t(from, 'user', 'setbioSuccess');
        await sock.sendMessage(from, { text: `${successMsg}\n\n📝 *About:* ${applied.bio}` }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'user', 'setbioError');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'autobio',
    aliases: ['bio', 'addbio', 'botbio', 'toggleautobio'],
    description: 'Auto-update WhatsApp About and manage custom bios',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, text, msg, config }) => {
      const botName = config?.BOT_NAME || 'Spider Man';
      const manager = getAutobioManager();
      const store = manager.store || defaultAutobioStore;
      const rawText = String(text || '').trim();

      if (!rawText) {
        const state = store.getState();
        return sock.sendMessage(from, { text: buildAutobioStatusCard(botName, state) }, { quoted: msg });
      }

      const [firstToken, ...otherTokens] = rawText.split(/\s+/);
      const sub = String(firstToken || '').toLowerCase();
      const restText = rawText.slice(firstToken.length).trim();

      if (sub === 'help' || sub === '?') {
        const state = store.getState();
        return sock.sendMessage(from, { text: buildAutobioStatusCard(botName, state) }, { quoted: msg });
      }

      if (sub === 'on' || sub === 'enable' || sub === 'start') {
        const res = await manager.enable({ sock, bioText: restText });
        if (!res.ok) {
          return sock.sendMessage(
            from,
            { text: `❌ ${res.error || 'Could not enable Auto-Bio.'}` },
            { quoted: msg },
          );
        }
        const rows = [
          spiderHeader(botName, 'AUTO BIO ENABLED'),
          spiderRow('STATUS', '🟢 ON', '⚙️'),
          spiderRow('INTERVAL', formatAutobioInterval(res.state.intervalMs), '⏱️'),
          spiderRow(
            'SAVED BIOS',
            res.state.bios.length > 0 ? `${res.state.bios.length}` : `0 (${PRESET_AUTOBIOS.length} built-in)`,
            '📝',
          ),
          spiderRow(
            'ABOUT NOW',
            res.updated ? res.bio : `⚠️ Failed: ${res.error || 'Socket not ready'}`,
            res.updated ? '✅' : '⚠️',
          ),
          ...(res.truncated ? [spiderRow('NOTE', `Trimmed to ${MAX_BIO_LENGTH} chars`, '✂️')] : []),
          spiderFooter(res.updated ? 'WHATSAPP ABOUT UPDATED' : 'AUTO BIO SAVED (RETRYING ON TICK)'),
        ];
        return sock.sendMessage(from, { text: rows.join('\n') }, { quoted: msg });
      }

      if (sub === 'off' || sub === 'disable' || sub === 'stop') {
        const wasEnabled = store.getState().enabled;
        manager.disable();
        const msgText = wasEnabled
          ? await t(from, 'user', 'autobioDisabled')
          : await t(from, 'user', 'autobioAlreadyOff');
        return sock.sendMessage(from, { text: `🔴 ${msgText}` }, { quoted: msg });
      }

      if (sub === 'add' || sub === '+') {
        if (!restText) {
          return sock.sendMessage(
            from,
            { text: '❌ Provide the bio text to add.\nExample: *.autobio add Available 24/7 ⚡*' },
            { quoted: msg },
          );
        }
        const res = await manager.addAndApply(restText, { sock, enableAuto: true });
        if (!res.ok) {
          return sock.sendMessage(from, { text: `❌ ${res.error || 'Could not add bio.'}` }, { quoted: msg });
        }
        const rows = [
          spiderHeader(botName, res.added ? 'BIO ADDED' : 'BIO SELECTED'),
          spiderRow('STATUS', '🟢 ON', '⚙️'),
          spiderRow('SLOT', `#${res.index + 1} of ${res.total}`, '📌'),
          spiderRow(
            'ABOUT NOW',
            res.updated ? res.bio : `⚠️ Saved, update failed: ${res.error || 'Socket not ready'}`,
            res.updated ? '✅' : '⚠️',
          ),
          ...(res.truncated ? [spiderRow('NOTE', `Trimmed to ${MAX_BIO_LENGTH} chars`, '✂️')] : []),
          spiderFooter(res.updated ? 'VISIBLE ON WHATSAPP ABOUT' : 'BIO SAVED (WILL RETRY)'),
        ];
        return sock.sendMessage(from, { text: rows.join('\n') }, { quoted: msg });
      }

      if (sub === 'set' || sub === 'replace') {
        if (!restText) {
          return sock.sendMessage(
            from,
            { text: '❌ Provide the bio text to set.\nExample: *.autobio set Spider Man Online ⚡*' },
            { quoted: msg },
          );
        }
        const res = await manager.setAndApply(restText, { sock, enableAuto: true });
        if (!res.ok) {
          return sock.sendMessage(from, { text: `❌ ${res.error || 'Could not set bio.'}` }, { quoted: msg });
        }
        const rows = [
          spiderHeader(botName, 'BIO SET'),
          spiderRow('STATUS', '🟢 ON', '⚙️'),
          spiderRow(
            'ABOUT NOW',
            res.updated ? res.bio : `⚠️ Saved, update failed: ${res.error || 'Socket not ready'}`,
            res.updated ? '✅' : '⚠️',
          ),
          ...(res.truncated ? [spiderRow('NOTE', `Trimmed to ${MAX_BIO_LENGTH} chars`, '✂️')] : []),
          spiderFooter(res.updated ? 'VISIBLE ON WHATSAPP ABOUT' : 'BIO SAVED (WILL RETRY)'),
        ];
        return sock.sendMessage(from, { text: rows.join('\n') }, { quoted: msg });
      }

      if (sub === 'presets' || sub === 'preset' || sub === 'load' || sub === '100' || sub === 'pack') {
        const replace = restText.toLowerCase() === 'replace' || restText.toLowerCase() === 'reset';
        const res = await manager.loadPresets({ sock, replace, enableAuto: true });
        const rows = [
          spiderHeader(botName, 'PRESET BIOS LOADED'),
          spiderRow('STATUS', '🟢 ON', '⚙️'),
          spiderRow('ADDED', `${res.addedCount} preset(s)`, '📚'),
          spiderRow('TOTAL SAVED', `${res.total}`, '📝'),
          spiderRow(
            'ABOUT NOW',
            res.updated ? res.bio : `⚠️ Saved, update failed: ${res.error || 'Socket not ready'}`,
            res.updated ? '✅' : '⚠️',
          ),
          spiderFooter(res.updated ? 'WHATSAPP ABOUT UPDATED' : 'PRESETS SAVED (WILL RETRY)'),
        ];
        return sock.sendMessage(from, { text: rows.join('\n') }, { quoted: msg });
      }

      if (sub === 'list' || sub === 'ls' || sub === 'status' || sub === 'info' || sub === 'show') {
        const state = store.getState();
        const activeIdx = state.bios.length > 0 ? state.currentIndex % state.bios.length : -1;
        const pageSize = 25;
        const showAll = restText.toLowerCase() === 'all';
        const totalPages = Math.max(1, Math.ceil(state.bios.length / pageSize));
        const requestedPage = Number.parseInt(restText || '1', 10);
        const page = Number.isFinite(requestedPage)
          ? Math.min(totalPages, Math.max(1, requestedPage))
          : 1;
        const startIdx = showAll ? 0 : (page - 1) * pageSize;
        const endIdx = showAll ? state.bios.length : Math.min(state.bios.length, startIdx + pageSize);

        const bioRows =
          state.bios.length > 0
            ? state.bios
                .slice(startIdx, endIdx)
                .map((b, offset) => {
                  const realIdx = startIdx + offset;
                  return `> ┃ ${realIdx === activeIdx ? '👉' : '•'} *#${realIdx + 1}*  ›  ${b}`;
                })
            : [
                `> ┃ ℹ️ No custom bios saved — rotating *${PRESET_AUTOBIOS.length}* built-in bios automatically.`,
                '> ┃ 💡 Run *.autobio presets* to load all 100 into your list.',
              ];

        const dividerLabel =
          state.bios.length > pageSize && !showAll
            ? `SAVED BIOS (${state.bios.length}) • PAGE ${page}/${totalPages}`
            : `SAVED BIOS (${state.bios.length})`;
        const footerText =
          state.bios.length > pageSize && !showAll
            ? `NEXT: .autobio list ${page < totalPages ? page + 1 : 1} | ALL: .autobio list all`
            : 'ADD: .autobio add <text> | PRESETS: .autobio presets';

        const rows = [
          spiderHeader(botName, 'AUTO BIO LIST'),
          spiderRow('STATUS', state.enabled ? '🟢 ON' : '🔴 OFF', '⚙️'),
          spiderRow('INTERVAL', formatAutobioInterval(state.intervalMs), '⏱️'),
          spiderRow('LAST ABOUT', state.lastBio || 'Not updated yet', '💬'),
          spiderDivider(dividerLabel),
          ...bioRows,
          spiderFooter(footerText),
        ];
        return sock.sendMessage(from, { text: rows.join('\n') }, { quoted: msg });
      }

      if (sub === 'del' || sub === 'delete' || sub === 'rm' || sub === 'remove' || sub === 'clear' || sub === 'reset') {
        const stateBefore = store.getState();
        if (sub === 'clear' || sub === 'reset' || restText.toLowerCase() === 'all') {
          const cleared = store.clearBios();
          let refreshNote = '';
          if (stateBefore.enabled) {
            const refreshed = await manager.updateNow({ sock });
            if (refreshed.ok) refreshNote = refreshed.bio;
          }
          const rows = [
            spiderHeader(botName, 'BIOS CLEARED'),
            spiderRow('REMOVED', `${cleared.removedCount} bio(s)`, '🗑️'),
            spiderRow('MODE', stateBefore.enabled ? 'Dynamic live About' : 'Off', '⚙️'),
            ...(refreshNote ? [spiderRow('ABOUT NOW', refreshNote, '✅')] : []),
            spiderFooter('AUTOBIO LIST UPDATED'),
          ];
          return sock.sendMessage(from, { text: rows.join('\n') }, { quoted: msg });
        }

        const idx = Number.parseInt(restText || otherTokens[0] || '', 10);
        if (!Number.isFinite(idx) || idx < 1) {
          return sock.sendMessage(
            from,
            { text: '❌ Usage: *.autobio del <number>* or *.autobio clear*\nUse *.autobio list* to see bio numbers.' },
            { quoted: msg },
          );
        }
        const removed = store.removeBio(idx);
        if (!removed.ok) {
          return sock.sendMessage(
            from,
            { text: `❌ Bio #${idx} not found. Use *.autobio list* to view saved bios.` },
            { quoted: msg },
          );
        }
        let refreshNote = '';
        if (stateBefore.enabled) {
          const refreshed = await manager.updateNow({ sock });
          if (refreshed.ok) refreshNote = refreshed.bio;
        }
        const rows = [
          spiderHeader(botName, 'BIO REMOVED'),
          spiderRow('DELETED', removed.removed, '🗑️'),
          spiderRow('REMAINING', `${removed.total}`, '📝'),
          ...(refreshNote ? [spiderRow('ABOUT NOW', refreshNote, '✅')] : []),
          spiderFooter('AUTOBIO LIST UPDATED'),
        ];
        return sock.sendMessage(from, { text: rows.join('\n') }, { quoted: msg });
      }

      if (sub === 'interval' || sub === 'time' || sub === 'delay') {
        if (!restText) {
          const current = store.getState();
          return sock.sendMessage(
            from,
            {
              text: `⏱️ Current Auto-Bio interval: *${formatAutobioInterval(current.intervalMs)}*\nUsage: *.autobio interval 60s* or *.autobio interval 5m* (min 15s, max 24h).`,
            },
            { quoted: msg },
          );
        }
        const parsedMs = parseAutobioInterval(restText);
        if (!parsedMs) {
          return sock.sendMessage(
            from,
            { text: '❌ Invalid interval. Use values like *30s*, *1m*, *5m*, or *1h* (min 15s, max 24h).' },
            { quoted: msg },
          );
        }
        const updated = manager.setIntervalMs(parsedMs);
        return sock.sendMessage(
          from,
          { text: `✅ Auto-Bio interval updated to *${formatAutobioInterval(updated.intervalMs)}*.` },
          { quoted: msg },
        );
      }

      // Direct text fallback: `.autobio <custom bio>` adds the bio and immediately updates WhatsApp About
      const res = await manager.addAndApply(rawText, { sock, enableAuto: true });
      if (!res.ok) {
        return sock.sendMessage(from, { text: `❌ ${res.error || 'Could not update bio.'}` }, { quoted: msg });
      }
      const rows = [
        spiderHeader(botName, res.added ? 'BIO ADDED' : 'BIO SELECTED'),
        spiderRow('STATUS', '🟢 ON', '⚙️'),
        spiderRow('SLOT', `#${res.index + 1} of ${res.total}`, '📌'),
        spiderRow(
          'ABOUT NOW',
          res.updated ? res.bio : `⚠️ Saved, update failed: ${res.error || 'Socket not ready'}`,
          res.updated ? '✅' : '⚠️',
        ),
        ...(res.truncated ? [spiderRow('NOTE', `Trimmed to ${MAX_BIO_LENGTH} chars`, '✂️')] : []),
        spiderFooter(res.updated ? 'VISIBLE ON WHATSAPP ABOUT' : 'BIO SAVED (WILL RETRY)'),
      ];
      return sock.sendMessage(from, { text: rows.join('\n') }, { quoted: msg });
    },
  },
  {
    name: 'getpp',
    description: 'Get profile picture',
    category: 'USER',
    execute: executeGetPP,
  },
  {
    name: 'whois',
    description: 'User information',
    category: 'USER',
    execute: async ({ sock, from, text, args = [], msg }) => {
      const metadata = await fetchMetaSafe(sock, from);
      const resolved = resolveTargetFromMessage({
        sock,
        from,
        msg,
        text,
        args,
        metadata,
        allowSenderFallback: true,
      });
      const targetJid = resolved.targetJid || from;
      const targetNum = resolved.displayUser || cleanJid(targetJid).split('@')[0];
      const candidates = Array.from(
        new Set(
          [
            resolved.phone ? `${resolved.phone}@s.whatsapp.net` : '',
            targetJid,
            ...(Array.isArray(resolved.alternateJids) ? resolved.alternateJids : []),
          ].filter(Boolean),
        ),
      );

      let ppUrl;
      for (const cand of candidates) {
        try {
          const fetched = await sock.profilePictureUrl(cand, 'image');
          if (fetched) {
            ppUrl = fetched;
            break;
          }
        } catch {}
      }
      if (!ppUrl) {
        ppUrl = await t(from, 'user', 'whoisDefaultImage');
      }

      let statusText = 'No status';
      let setDate = 'Unknown';
      let setTime = 'Unknown';
      for (const cand of candidates) {
        try {
          const statuses = await sock.fetchStatus(cand);
          if (statuses && statuses[0] && statuses[0].status) {
            const entry = statuses[0].status;
            statusText = entry.status || 'Unknown';
            if (entry.setAt) {
              const dt = new Date(entry.setAt);
              if (!isNaN(dt.getTime())) {
                setDate = dt.toLocaleDateString('en-GB');
                setTime = dt.toLocaleTimeString('en-GB');
              }
            }
            break;
          }
        } catch (err) {
          console.log('[WHOIS] fetchStatus error:', err.message);
        }
      }

      try {
        const pnCand = candidates.find((c) => /@(?:s\.whatsapp\.net|c\.us)$/i.test(c));
        if (pnCand) {
          await sock.onWhatsApp(pnCand);
        }
      } catch {}

      const aboutLabel = await t(from, 'user', 'whoisAbout');
      const nameLabel = await t(from, 'user', 'whoisName');
      const setOnLabel = await t(from, 'user', 'whoisSetOn');
      const setAtLabel = await t(from, 'user', 'whoisSetAt');
      const footerLabel = await t(from, 'user', 'whoisFooter');

      const caption = `👤 *${aboutLabel}:* ${statusText}\n\n*${nameLabel}:* @${targetNum}\n\n📅 *${setOnLabel}:* ${setDate}\n🕒 *${setAtLabel}:* ${setTime}\n\n${footerLabel}`;
      await sock.sendMessage(
        from,
        {
          image: { url: ppUrl },
          caption,
          mentions: [targetJid],
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'mygroups',
    description: 'List all groups',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      try {
        const groups = Object.values(await sock.groupFetchAllParticipating());
        const header = await t(from, 'user', 'mygroupsHeader');
        const itemTpl = await t(from, 'user', 'mygroupsItem');
        let output = header;
        for (const group of groups) {
          output += itemTpl
            .replace('{subject}', group.subject)
            .replace('{count}', group.participants.length)
            .replace('{id}', group.id);
        }
        await sock.sendMessage(from, { text: output }, { quoted: msg });
      } catch {
        const errMsg = await t(from, 'user', 'mygroupsError');
        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
      }
    },
  },
  {
    name: 'del',
    description: 'Delete a replied message or last N messages on both sides',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, msg, text = '', args = [] }) => {
      const metadata = await fetchMetaSafe(sock, from);
      const delTarget = await resolveQuotedDeleteTargetAsync({
        from,
        msg,
        sock,
        metadata,
        getPhoneFn: getPhoneFromJid,
      });

      const tokens = (Array.isArray(args) && args.length > 0
        ? args.map((item) => String(item || '').trim())
        : String(text || '').trim().split(/\s+/)
      ).filter(Boolean);
      const countToken = tokens.find((tok) => /^\d{1,3}$/.test(tok));
      const requestedCount = countToken ? Math.min(Math.max(Number.parseInt(countToken, 10), 1), 50) : null;

      // Single quoted message delete (standard .del reply)
      if (delTarget && !requestedCount) {
        const res = await deleteMessageSafely({
          sock,
          from,
          msg: delTarget.msg,
          targetJid: delTarget.participant,
          senderCandidates: delTarget.candidates,
          metadata,
          getPhoneFn: getPhoneFromJid,
          allowFromMeFallback: true,
          broadcastAlternates: true,
        });

        if (!res.ok) {
          await sock.sendMessage(
            from,
            { text: '❌ Failed to delete message.' },
            { quoted: msg },
          );
        }
        return;
      }

      if (!requestedCount && !delTarget) {
        return;
      }

      // Batch deletion mode: .del <count> [@user] or replying + .del <count>
      let remaining = requestedCount || 1;
      const seenIds = new Set();
      let deletedCount = 0;

      if (delTarget?.msg?.key?.id) {
        seenIds.add(delTarget.msg.key.id);
        const firstRes = await deleteMessageSafely({
          sock,
          from,
          msg: delTarget.msg,
          targetJid: delTarget.participant,
          senderCandidates: delTarget.candidates,
          metadata,
          getPhoneFn: getPhoneFromJid,
          allowFromMeFallback: true,
          broadcastAlternates: true,
        });
        if (firstRes.ok) deletedCount += 1;
        remaining = Math.max(0, remaining - 1);
      }

      if (remaining > 0) {
        const targetInfo = delTarget
          ? { targetJid: delTarget.participant, alternateJids: delTarget.candidates || [] }
          : resolveTargetFromMessage({
              sock,
              from,
              msg,
              text: tokens.filter((t) => t !== countToken).join(' '),
              metadata,
            });

        const recentMsgs = listRecentChatMessages(from, {
          limit: remaining + 5,
          targetJid: targetInfo?.targetJid || '',
          alternateJids: targetInfo?.alternateJids || [],
          getPhoneFn: getPhoneFromJid,
        });

        for (const item of recentMsgs) {
          if (deletedCount >= (requestedCount || 1)) break;
          const id = item?.key?.id;
          if (!id || id === msg?.key?.id || seenIds.has(id)) continue;
          seenIds.add(id);

          const batchRes = await deleteMessageSafely({
            sock,
            from,
            msg: item,
            targetJid: item?.key?.participant || targetInfo?.targetJid || '',
            senderCandidates: targetInfo?.alternateJids || [],
            metadata,
            getPhoneFn: getPhoneFromJid,
            allowFromMeFallback: true,
            broadcastAlternates: true,
          });
          if (batchRes.ok) deletedCount += 1;
        }
      }

      if (deletedCount === 0) {
        await sock.sendMessage(
          from,
          { text: 'ℹ️ No recent messages found in this chat to delete.' },
          { quoted: msg },
        );
      }
    },
  },
  {
    name: 'restart',
    description: 'Restart bot',
    category: 'USER',
    ownerOnly: true,
    execute: async ({ sock, from, msg }) => {
      const restartMsg = await t(from, 'user', 'restartMessage');
      await sock.sendMessage(from, { text: restartMsg }, { quoted: msg });
      const reloadRes = await applyPostUpdateReload();
      if (reloadRes?.mode !== 'supervised_restart') {
        process.exit(0);
      }
    },
  },
];