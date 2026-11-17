import CONFIG from '../../spider/config.js';
import { spiderHeader, spiderRow, spiderDivider, spiderFooter } from '../utils/tableStyle.js';
import { extractContextInfo } from '../../spider/utils/groupActionHelper.js';
import { collectSenderIdentities, extractPhoneDigits } from '../../spider/utils/groupRoleResolver.js';
import {
  defaultReminderStore,
  extractDurationAndMessage,
  formatDuration,
} from '../../spider/utils/reminderStore.js';

function resolveQuotedReminderText(msg) {
  const { quotedMessage } = extractContextInfo(msg);
  if (!quotedMessage) return '';
  return String(
    quotedMessage.conversation ||
      quotedMessage.extendedTextMessage?.text ||
      quotedMessage.imageMessage?.caption ||
      quotedMessage.videoMessage?.caption ||
      quotedMessage.documentMessage?.caption ||
      '',
  ).trim();
}

function resolveActorPhone(sender, msg, senderNumber = '') {
  const cleanDigits = String(senderNumber || '').replace(/\D/g, '');
  if (cleanDigits) return cleanDigits;
  const lidToPhoneMap = globalThis.__spiderLidToPhoneMap || null;
  const candidates = collectSenderIdentities(msg, [sender]);
  for (const cand of candidates) {
    const ph = extractPhoneDigits(cand);
    if (ph) return ph;
    if (lidToPhoneMap && cand.includes('@lid')) {
      const lid = cand.split('@')[0].split(':')[0];
      const mapped = lidToPhoneMap.get(lid);
      if (mapped) return String(mapped).replace(/\D/g, '');
    }
  }
  return '';
}

function buildRemindUsage(botName) {
  return [
    spiderHeader(botName, 'REMINDERS'),
    spiderRow('SET', '.remind 2h Check deployment', '⏰'),
    spiderRow('COMPOUND', '.remind 1h30m Team standup', '🕒'),
    spiderRow('LIST', '.reminders [chat|all]', '📋'),
    spiderRow('DELETE', '.delremind <id|all>', '🗑️'),
    spiderFooter('WORKS IN DM & GROUP CHATS'),
  ].join('\n');
}

export const commands = [
  {
    name: 'remind',
    aliases: ['remindme', 'setremind', 'reminder'],
    description: 'Set a time-based reminder in DM or group chat (e.g., .remind 2h Check deployment).',
    category: 'General',
    execute: async ({ sock, from, msg, text, sender, senderNumber, config }) => {
      const botName = config?.BOT_NAME || CONFIG.BOT_NAME || 'Spider Man';
      const rawInput = String(text || '').trim();
      if (!rawInput) {
        return sock.sendMessage(from, { text: buildRemindUsage(botName) }, { quoted: msg });
      }

      const parsed = extractDurationAndMessage(rawInput);
      if (!parsed.ok) {
        if (parsed.reason === 'too-short') {
          return sock.sendMessage(
            from,
            { text: '❌ Reminder duration must be at least *5 seconds* (e.g. `.remind 30s Check logs`).' },
            { quoted: msg },
          );
        }
        if (parsed.reason === 'too-long') {
          return sock.sendMessage(
            from,
            { text: '❌ Maximum reminder duration is *365 days*.' },
            { quoted: msg },
          );
        }
        return sock.sendMessage(from, { text: buildRemindUsage(botName) }, { quoted: msg });
      }

      const reminderMessage = parsed.message || resolveQuotedReminderText(msg);
      if (!reminderMessage) {
        return sock.sendMessage(
          from,
          { text: '❌ Please include a reminder message or reply to a message.\nExample: *.remind 2h Check deployment*' },
          { quoted: msg },
        );
      }

      const creatorJid = sender || msg?.key?.participant || from;
      const creatorPhone = resolveActorPhone(creatorJid, msg, senderNumber);
      const isGroup = String(from).endsWith('@g.us');

      const added = defaultReminderStore.addReminder({
        chatJid: from,
        creatorJid,
        creatorPhone,
        mentionJids: creatorJid ? [creatorJid] : [],
        text: reminderMessage,
        durationMs: parsed.durationMs,
      });

      if (!added.ok) {
        const errText =
          added.reason === 'user-limit'
            ? `❌ You have reached the limit of *${added.limit}* active reminders. Delete one with *.delremind <id>*.`
            : '❌ Could not save reminder right now.';
        return sock.sendMessage(from, { text: errText }, { quoted: msg });
      }

      globalThis.__spiderReminderScheduler?.nudge?.();

      const rem = added.reminder;
      const countdown = formatDuration(rem.durationMs);
      const confirmation = [
        spiderHeader(botName, 'REMINDER SET'),
        spiderRow('ID', rem.id, '🆔'),
        spiderRow('IN', countdown, '⏳'),
        spiderRow('CHAT', isGroup ? 'This Group' : 'Direct Message', isGroup ? '👥' : '👤'),
        spiderRow('MESSAGE', rem.text, '⏰'),
        spiderFooter(`CANCEL: .delremind ${rem.id}`),
      ].join('\n');

      return sock.sendMessage(from, { text: confirmation }, { quoted: msg });
    },
  },
  {
    name: 'reminders',
    aliases: ['listreminders', 'myreminders', 'remindlist'],
    description: 'List active reminders in this DM or group chat.',
    category: 'General',
    execute: async ({
      sock,
      from,
      msg,
      text,
      args = [],
      sender,
      senderNumber,
      isGroupAdmin = false,
      isOwner = false,
      config,
    }) => {
      const botName = config?.BOT_NAME || CONFIG.BOT_NAME || 'Spider Man';
      const tokens = (Array.isArray(args) && args.length > 0
        ? args
        : String(text || '').trim().split(/\s+/)
      ).filter(Boolean);
      const arg = String(tokens[0] || '').toLowerCase();

      const actorJid = sender || msg?.key?.participant || from;
      const actorPhone = resolveActorPhone(actorJid, msg, senderNumber);
      const lidToPhoneMap = globalThis.__spiderLidToPhoneMap || null;

      let scope = 'user';
      if (arg === 'all' && isOwner) {
        scope = 'all';
      } else if ((arg === 'chat' || arg === 'group') && (isGroupAdmin || isOwner || !String(from).endsWith('@g.us'))) {
        scope = 'chat';
      }

      const items = defaultReminderStore.listReminders({
        chatJid: from,
        actorJid,
        actorPhone,
        scope,
        lidToPhoneMap,
      });

      if (items.length === 0) {
        const emptyText = [
          spiderHeader(botName, 'REMINDERS'),
          spiderRow('ACTIVE', '0 pending reminders', '📭'),
          spiderRow('CREATE', '.remind 2h Check deployment', '➕'),
          spiderFooter('NO PENDING REMINDERS'),
        ].join('\n');
        return sock.sendMessage(from, { text: emptyText }, { quoted: msg });
      }

      const nowMs = Date.now();
      const lines = items.slice(0, 25).map((r) => {
        const remaining = r.dueAt > nowMs ? `in ${formatDuration(r.dueAt - nowMs)}` : 'due now';
        const preview = r.text.length > 48 ? `${r.text.slice(0, 45)}...` : r.text;
        return `> ┃ *${r.id}* (${remaining})  ›  ${preview}`;
      });

      const scopeLabel = scope === 'all' ? 'ALL CHATS' : scope === 'chat' ? 'CHAT REMINDERS' : 'YOUR REMINDERS';
      const output = [
        spiderHeader(botName, 'ACTIVE REMINDERS'),
        spiderRow('SCOPE', scopeLabel, '📋'),
        spiderRow('COUNT', String(items.length), '⏰'),
        spiderDivider(),
        ...lines,
        spiderFooter('DELETE: .delremind <id|all>'),
      ].join('\n');

      return sock.sendMessage(from, { text: output }, { quoted: msg });
    },
  },
  {
    name: 'delremind',
    aliases: ['cancelremind', 'rmremind', 'clearremind'],
    description: 'Delete a pending reminder by ID or clear your reminders (.delremind all).',
    category: 'General',
    execute: async ({
      sock,
      from,
      msg,
      text,
      args = [],
      sender,
      senderNumber,
      isGroupAdmin = false,
      isOwner = false,
      config,
    }) => {
      const botName = config?.BOT_NAME || CONFIG.BOT_NAME || 'Spider Man';
      const tokens = (Array.isArray(args) && args.length > 0
        ? args
        : String(text || '').trim().split(/\s+/)
      ).filter(Boolean);
      const targetId = String(tokens[0] || '').trim();

      if (!targetId) {
        return sock.sendMessage(
          from,
          { text: '❌ Usage: *.delremind <id>* or *.delremind all*\nCheck IDs with *.reminders*.' },
          { quoted: msg },
        );
      }

      const actorJid = sender || msg?.key?.participant || from;
      const actorPhone = resolveActorPhone(actorJid, msg, senderNumber);
      const lidToPhoneMap = globalThis.__spiderLidToPhoneMap || null;
      const lowerTarget = targetId.toLowerCase();

      if (lowerTarget === 'all' || lowerTarget === 'chat') {
        const res = defaultReminderStore.clearReminders({
          chatJid: from,
          actorJid,
          actorPhone,
          isOwner,
          isGroupAdmin,
          allChat: lowerTarget === 'chat',
          lidToPhoneMap,
        });
        globalThis.__spiderReminderScheduler?.nudge?.();

        if (res.removedCount === 0) {
          return sock.sendMessage(
            from,
            { text: 'ℹ️ No matching reminders found to remove in this chat.' },
            { quoted: msg },
          );
        }

        const clearedText = [
          spiderHeader(botName, 'REMINDERS CLEARED'),
          spiderRow('REMOVED', `${res.removedCount} reminder(s)`, '🗑️'),
          spiderFooter('SCHEDULE UPDATED'),
        ].join('\n');
        return sock.sendMessage(from, { text: clearedText }, { quoted: msg });
      }

      const deleted = defaultReminderStore.deleteReminder(targetId, {
        chatJid: from,
        actorJid,
        actorPhone,
        isOwner,
        isGroupAdmin,
        lidToPhoneMap,
      });

      if (!deleted.ok) {
        const reasonMsg =
          deleted.reason === 'forbidden'
            ? '❌ You can only delete your own reminders (or any in this group if you are an admin).'
            : `❌ Reminder *${targetId.toUpperCase()}* was not found. Use *.reminders* to view IDs.`;
        return sock.sendMessage(from, { text: reasonMsg }, { quoted: msg });
      }

      globalThis.__spiderReminderScheduler?.nudge?.();
      const confirmText = [
        spiderHeader(botName, 'REMINDER DELETED'),
        spiderRow('ID', deleted.reminder.id, '🗑️'),
        spiderRow('MESSAGE', deleted.reminder.text, '⏰'),
        spiderFooter('SCHEDULE UPDATED'),
      ].join('\n');
      return sock.sendMessage(from, { text: confirmText }, { quoted: msg });
    },
  },
];
