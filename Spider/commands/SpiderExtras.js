import axios from 'axios';
import config from '../../spider/config.js';
import {
  spiderHeader,
  spiderRow,
  spiderDivider,
  spiderFooter,
} from '../utils/tableStyle.js';

const botName = () => config.BOT_NAME || 'Spider Man';

function card(title, rows, footer = `${botName()} // COMMANDS`) {
  return [spiderHeader(botName(), title), ...rows, spiderFooter(footer)].join('\n');
}

const pendingGroupTimers = new Map();

export function clearPendingGroupTimers() {
  for (const timer of pendingGroupTimers.values()) {
    clearTimeout(timer);
  }
  pendingGroupTimers.clear();
}

function parseDurationMs(amountRaw, unitRaw) {
  const amount = Number.parseFloat(String(amountRaw || ''));
  const unit = String(unitRaw || '').trim().toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const multipliers = {
    s: 1000,
    sec: 1000,
    secs: 1000,
    second: 1000,
    seconds: 1000,
    m: 60 * 1000,
    min: 60 * 1000,
    mins: 60 * 1000,
    minute: 60 * 1000,
    minutes: 60 * 1000,
    h: 60 * 60 * 1000,
    hr: 60 * 60 * 1000,
    hrs: 60 * 60 * 1000,
    hour: 60 * 60 * 1000,
    hours: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
  };

  const mult = multipliers[unit];
  if (!mult) return null;
  const ms = Math.round(amount * mult);
  const maxMs = 7 * 24 * 60 * 60 * 1000;
  return ms > 0 && ms <= maxMs ? ms : null;
}

const STYLIZED_CHANNEL_CHARS = {
  a: '🅐', b: '🅑', c: '🅒', d: '🅓', e: '🅔', f: '🅕', g: '🅖',
  h: '🅗', i: '🅘', j: '🅙', k: '🅚', l: '🅛', m: '🅜', n: '🅝',
  o: '🅞', p: '🅟', q: '🅠', r: '🅡', s: '🅢', t: '🅣', u: '🅤',
  v: '🅥', w: '🅦', x: '🅧', y: '🅨', z: '🅩',
  '0': '⓿', '1': '➊', '2': '➋', '3': '➌', '4': '➍',
  '5': '➎', '6': '➏', '7': '➐', '8': '➑', '9': '➒',
};

const CHARACTER_TRAITS = [
  'Sigma',
  'Generous',
  'Grumpy',
  'Overconfident',
  'Obedient',
  'Kind-Hearted',
  'Charismatic',
  'Patient',
  'Loyal',
  'Cool',
  'Helpful',
  'Brilliant',
  'Witty',
  'Fearless',
  'Creative',
  'Charming',
];

async function runEmojiAnimation({ sock, from, msg, initialText, frames, frameDelay = 350 }) {
  const sentMsg = await sock.sendMessage(from, { text: initialText }, { quoted: msg });
  if (!sentMsg?.key) return sentMsg;

  for (const frame of frames) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, frameDelay);
      t?.unref?.();
    });
    try {
      await sock.sendMessage(from, { text: frame, edit: sentMsg.key });
    } catch {
      break;
    }
  }
  return sentMsg;
}

function createAnimationCommand({ name, aliases = [], description, initialText, frames, frameDelay = 350 }) {
  return {
    name,
    aliases,
    description,
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      try {
        return await runEmojiAnimation({ sock, from, msg, initialText, frames, frameDelay });
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Animation failed: ${err.message}` }, { quoted: msg });
      }
    },
  };
}

function createWaifuPicsCommand({ name, aliases = [], tag, label, description }) {
  return {
    name,
    aliases,
    description,
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      try {
        const res = await axios.get(`https://api.waifu.pics/sfw/${tag}`, { timeout: 10000 });
        const imgUrl = res.data?.url;
        if (!imgUrl || typeof imgUrl !== 'string') {
          return sock.sendMessage(from, { text: `❌ Could not fetch a ${label} image right now.` }, { quoted: msg });
        }
        return await sock.sendMessage(
          from,
          {
            image: { url: imgUrl },
            caption: card(`ANIME // ${label.toUpperCase()}`, [
              spiderRow('CATEGORY', label, '✨'),
            ], `${botName()} // FUN`),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to fetch ${label} image: ${err.message}` }, { quoted: msg });
      }
    },
  };
}

const UNIQUE_LOGO_EFFECTS = [
  { name: '3dcomic', description: 'Create a 3D Comic-style text logo.', url: 'https://en.ephoto360.com/create-online-3d-comic-style-text-effects-817.html' },
  { name: 'deadpool', description: 'Create a Deadpool-style text logo.', url: 'https://en.ephoto360.com/create-text-effects-in-the-style-of-the-deadpool-logo-818.html' },
  { name: 'blackpink', description: 'Create a Blackpink signature-style text logo.', url: 'https://en.ephoto360.com/create-a-blackpink-style-logo-with-members-signatures-810.html' },
  { name: 'neonlight', description: 'Create a colorful neon light text logo.', url: 'https://en.ephoto360.com/create-colorful-neon-light-text-effects-online-797.html' },
  { name: 'thor', description: 'Create a Thor-style text logo.', url: 'https://en.ephoto360.com/create-thor-logo-style-text-effects-online-for-free-796.html' },
  { name: 'america', description: 'Create a 3D American flag text logo.', url: 'https://en.ephoto360.com/free-online-american-flag-3d-text-effect-generator-725.html' },
  { name: 'eraser', description: 'Create an eraser-deleting text effect.', url: 'https://en.ephoto360.com/create-eraser-deleting-text-effect-online-717.html' },
  { name: '3dpaper', description: 'Create a multicolor 3D paper-cut text logo.', url: 'https://en.ephoto360.com/multicolor-3d-paper-cut-style-text-effect-658.html' },
  { name: 'clouds', description: 'Create a clouds-in-the-sky text effect.', url: 'https://en.ephoto360.com/write-text-effect-clouds-in-the-sky-online-619.html' },
  { name: 'galaxy', description: 'Create a galaxy mobile wallpaper text logo.', url: 'https://en.ephoto360.com/create-galaxy-wallpaper-mobile-online-528.html' },
  { name: 'nigeria', description: 'Create a 3D Nigeria flag text logo.', url: 'https://en.ephoto360.com/nigeria-3d-flag-text-effect-online-free-753.html' },
  { name: 'devilwings', description: 'Create a neon devil wings text logo.', url: 'https://en.ephoto360.com/neon-devil-wings-text-effect-online-683.html' },
  { name: 'luxury', description: 'Create a floral luxury branding text logo.', url: 'https://en.ephoto360.com/floral-luxury-logo-collection-for-branding-616.html' },
  { name: 'angelwings', description: 'Create an angel wings text effect.', url: 'https://en.ephoto360.com/angel-wing-effect-329.html' },
  { name: 'tattoo', aliases: ['tatoo'], description: 'Create a tattoo-style text effect.', url: 'https://en.ephoto360.com/make-tattoos-online-by-empire-tech-309.html' },
  { name: 'castle', description: 'Create a 3D castle pop-out text effect.', url: 'https://en.ephoto360.com/create-a-3d-castle-pop-out-mobile-photo-effect-786.html' },
  { name: 'paint', description: 'Create a 3D colorful paint text effect.', url: 'https://en.ephoto360.com/create-3d-colorful-paint-text-effect-online-801.html' },
  { name: 'birthday', description: 'Create a 3D foil balloon birthday text effect.', url: 'https://en.ephoto360.com/beautiful-3d-foil-balloon-effects-for-holidays-and-birthday-803.html' },
  { name: 'typography', description: 'Create a leafy typography status text logo.', url: 'https://en.ephoto360.com/create-typography-status-online-with-impressive-leaves-357.html' },
  { name: 'bear', description: 'Create a bear mascot text logo.', url: 'https://en.ephoto360.com/free-bear-logo-maker-online-673.html' },
];

function createLogoCommand({ name, aliases = [], description, url }) {
  return {
    name,
    aliases,
    description,
    category: 'Logo',
    execute: async ({ sock, from, msg, text }) => {
      const input = String(text || '').trim();
      if (!input) {
        return sock.sendMessage(
          from,
          { text: `🎨 Usage: \`.${name} <text>\`\nExample: \`.${name} ${botName()}\`` },
          { quoted: msg },
        );
      }
      try {
        const apiUrl = `https://api-pink-venom.vercel.app/api/logo?url=${encodeURIComponent(url)}&name=${encodeURIComponent(input)}`;
        const res = await axios.get(apiUrl, { timeout: 15000 });
        const imageUrl =
          res.data?.result?.download_url ||
          res.data?.result?.url ||
          (typeof res.data?.result === 'string' && /^https?:\/\//i.test(res.data.result) ? res.data.result : '');

        if (!imageUrl) {
          return sock.sendMessage(
            from,
            { text: `❌ Could not generate the *${name}* logo right now. Please try again later.` },
            { quoted: msg },
          );
        }

        return await sock.sendMessage(
          from,
          {
            image: { url: imageUrl },
            caption: card(`LOGO // ${name.toUpperCase()}`, [
              spiderRow('TEXT', input, '🎨'),
            ], `${botName()} // LOGO`),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Logo generation failed: ${err.message}` }, { quoted: msg });
      }
    },
  };
}

function extractGdriveId(input) {
  const str = String(input || '').trim();
  const patterns = [
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i,
    /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/i,
    /drive\.google\.com\/uc\?.*?\bid=([a-zA-Z0-9_-]+)/i,
    /docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/i,
  ];
  for (const re of patterns) {
    const match = str.match(re);
    if (match?.[1]) return match[1];
  }
  return null;
}

export const commands = [
  // =========================================================================
  // GROUP MANAGEMENT
  // =========================================================================
  {
    name: 'lockgs',
    aliases: ['lockgsettings'],
    description: 'Restrict group info editing (name, icon, description) to admins only.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    execute: async ({ sock, from, msg, isGroupAdmin, isBotGroupAdmin, isOwner }) => {
      if (!String(from || '').endsWith('@g.us')) {
        return sock.sendMessage(from, { text: '⛔ This command can only be used inside a group.' }, { quoted: msg });
      }
      if (!isGroupAdmin && !isOwner) {
        return sock.sendMessage(from, { text: '⛔ Only group admins can lock group info settings.' }, { quoted: msg });
      }
      if (isBotGroupAdmin === false) {
        return sock.sendMessage(from, { text: '⛔ I need to be a group admin to change group settings.' }, { quoted: msg });
      }
      try {
        await sock.groupSettingUpdate(from, 'locked');
        return sock.sendMessage(
          from,
          {
            text: card('GROUP SETTINGS LOCKED', [
              spiderRow('STATUS', 'Only admins can edit group info', '🔒'),
            ], `${botName()} // GROUP`),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to lock group settings: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'unlockgs',
    aliases: ['unlockgsettings'],
    description: 'Allow all members to edit group info (name, icon, description).',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    execute: async ({ sock, from, msg, isGroupAdmin, isBotGroupAdmin, isOwner }) => {
      if (!String(from || '').endsWith('@g.us')) {
        return sock.sendMessage(from, { text: '⛔ This command can only be used inside a group.' }, { quoted: msg });
      }
      if (!isGroupAdmin && !isOwner) {
        return sock.sendMessage(from, { text: '⛔ Only group admins can unlock group info settings.' }, { quoted: msg });
      }
      if (isBotGroupAdmin === false) {
        return sock.sendMessage(from, { text: '⛔ I need to be a group admin to change group settings.' }, { quoted: msg });
      }
      try {
        await sock.groupSettingUpdate(from, 'unlocked');
        return sock.sendMessage(
          from,
          {
            text: card('GROUP SETTINGS UNLOCKED', [
              spiderRow('STATUS', 'All members can edit group info', '🔓'),
            ], `${botName()} // GROUP`),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to unlock group settings: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'opentime',
    aliases: [],
    description: 'Schedule automatic group unlock after a specified duration.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    execute: async ({ sock, from, msg, args, isGroupAdmin, isBotGroupAdmin, isOwner }) => {
      if (!String(from || '').endsWith('@g.us')) {
        return sock.sendMessage(from, { text: '⛔ This command can only be used inside a group.' }, { quoted: msg });
      }
      if (!isGroupAdmin && !isOwner) {
        return sock.sendMessage(from, { text: '⛔ Only group admins can schedule group open time.' }, { quoted: msg });
      }
      if (isBotGroupAdmin === false) {
        return sock.sendMessage(from, { text: '⛔ I need to be a group admin to open the group.' }, { quoted: msg });
      }
      const ms = parseDurationMs(args?.[0], args?.[1]);
      if (!ms) {
        return sock.sendMessage(
          from,
          { text: '⏰ Usage: `.opentime <amount> <second|minute|hour|day>`\nExample: `.opentime 10 minute`' },
          { quoted: msg },
        );
      }
      const key = `${from}:open`;
      if (pendingGroupTimers.has(key)) clearTimeout(pendingGroupTimers.get(key));

      const label = `${args[0]} ${args[1]}`;
      await sock.sendMessage(
        from,
        {
          text: card('SCHEDULED GROUP OPEN', [
            spiderRow('DELAY', label, '⏰'),
            spiderRow('ACTION', 'Unlock group chat automatically', '🔓'),
          ], `${botName()} // GROUP`),
        },
        { quoted: msg },
      );

      const timer = setTimeout(async () => {
        pendingGroupTimers.delete(key);
        try {
          await sock.groupSettingUpdate(from, 'not_announcement');
          await sock.sendMessage(from, {
            text: card('GROUP OPENED', [
              spiderRow('STATUS', 'Group chat is now open for all members', '🔓'),
            ], `${botName()} // GROUP`),
          });
        } catch {}
      }, ms);
      timer?.unref?.();
      pendingGroupTimers.set(key, timer);
    },
  },
  {
    name: 'closetime',
    aliases: [],
    description: 'Schedule automatic group lock (admins only) after a specified duration.',
    category: 'Group',
    groupOnly: true,
    adminOnly: true,
    execute: async ({ sock, from, msg, args, isGroupAdmin, isBotGroupAdmin, isOwner }) => {
      if (!String(from || '').endsWith('@g.us')) {
        return sock.sendMessage(from, { text: '⛔ This command can only be used inside a group.' }, { quoted: msg });
      }
      if (!isGroupAdmin && !isOwner) {
        return sock.sendMessage(from, { text: '⛔ Only group admins can schedule group close time.' }, { quoted: msg });
      }
      if (isBotGroupAdmin === false) {
        return sock.sendMessage(from, { text: '⛔ I need to be a group admin to close the group.' }, { quoted: msg });
      }
      const ms = parseDurationMs(args?.[0], args?.[1]);
      if (!ms) {
        return sock.sendMessage(
          from,
          { text: '⏰ Usage: `.closetime <amount> <second|minute|hour|day>`\nExample: `.closetime 30 minute`' },
          { quoted: msg },
        );
      }
      const key = `${from}:close`;
      if (pendingGroupTimers.has(key)) clearTimeout(pendingGroupTimers.get(key));

      const label = `${args[0]} ${args[1]}`;
      await sock.sendMessage(
        from,
        {
          text: card('SCHEDULED GROUP CLOSE', [
            spiderRow('DELAY', label, '⏰'),
            spiderRow('ACTION', 'Lock group chat to admins only', '🔒'),
          ], `${botName()} // GROUP`),
        },
        { quoted: msg },
      );

      const timer = setTimeout(async () => {
        pendingGroupTimers.delete(key);
        try {
          await sock.groupSettingUpdate(from, 'announcement');
          await sock.sendMessage(from, {
            text: card('GROUP CLOSED', [
              spiderRow('STATUS', 'Group chat is now locked to admins only', '🔒'),
            ], `${botName()} // GROUP`),
          });
        } catch {}
      }, ms);
      timer?.unref?.();
      pendingGroupTimers.set(key, timer);
    },
  },
  {
    name: 'join',
    aliases: ['joinme'],
    description: 'Join a WhatsApp group using an invite link (owner only).',
    category: 'Group',
    ownerOnly: true,
    execute: async ({ sock, from, msg, text, isOwner }) => {
      if (!isOwner) {
        return sock.sendMessage(from, { text: '⛔ Only the bot owner can use `.join`.' }, { quoted: msg });
      }
      const raw = String(text || '').trim();
      const match = raw.match(/chat\.whatsapp\.com\/([0-9A-Za-z]{16,32})/i);
      const code = match?.[1] || (/^[0-9A-Za-z]{16,32}$/.test(raw) ? raw : '');
      if (!code) {
        return sock.sendMessage(
          from,
          { text: '🔗 Usage: `.join https://chat.whatsapp.com/<invite_code>`' },
          { quoted: msg },
        );
      }
      try {
        const joinedJid = await sock.groupAcceptInvite(code);
        return sock.sendMessage(
          from,
          {
            text: card('GROUP JOINED', [
              spiderRow('INVITE', code, '🔗'),
              spiderRow('GROUP JID', String(joinedJid || 'Joined'), '✅'),
            ], `${botName()} // GROUP`),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to join group: ${err.message}` }, { quoted: msg });
      }
    },
  },

  // =========================================================================
  // OWNER & UTILITY
  // =========================================================================
  {
    name: 'jid',
    aliases: [],
    description: 'Display the current chat JID, sender JID, and bot JID.',
    category: 'Utility',
    execute: async ({ sock, from, sender, msg }) => {
      const ctxInfo =
        msg?.message?.extendedTextMessage?.contextInfo ||
        msg?.message?.imageMessage?.contextInfo ||
        msg?.message?.videoMessage?.contextInfo ||
        {};
      const targetJid = ctxInfo.mentionedJid?.[0] || ctxInfo.participant || '';
      const botJid = sock?.user?.id || 'Unknown';
      const rows = [
        spiderRow('CHAT JID', from || 'Unknown', '💬'),
        spiderRow('SENDER JID', sender || 'Unknown', '👤'),
        spiderRow('BOT JID', botJid, '🤖'),
      ];
      if (targetJid) {
        rows.push(spiderRow('TARGET JID', targetJid, '🎯'));
      }
      return sock.sendMessage(
        from,
        { text: card('JID INSPECTOR', rows, `${botName()} // UTILITY`) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'gjid',
    aliases: [],
    description: 'List the JIDs of all groups the bot currently participates in (owner only).',
    category: 'Owner',
    ownerOnly: true,
    execute: async ({ sock, from, msg, isOwner }) => {
      if (!isOwner) {
        return sock.sendMessage(from, { text: '⛔ Only the bot owner can list group JIDs.' }, { quoted: msg });
      }
      try {
        const groups = (await sock.groupFetchAllParticipating?.()) || {};
        const entries = Object.entries(groups);
        if (!entries.length) {
          return sock.sendMessage(from, { text: '📭 The bot is not currently in any groups.' }, { quoted: msg });
        }
        const rows = entries.slice(0, 40).map(([jid, meta], i) =>
          spiderRow(String(i + 1).padStart(2, '0'), `${meta?.subject || 'Unnamed Group'} (${jid})`, '▹'),
        );
        if (entries.length > 40) {
          rows.push(spiderRow('MORE', `+${entries.length - 40} additional groups`, '…'));
        }
        return sock.sendMessage(
          from,
          {
            text: [
              spiderHeader(botName(), 'GROUP JIDS'),
              spiderRow('TOTAL GROUPS', String(entries.length), '👥'),
              spiderDivider('DIRECTORY'),
              ...rows,
              spiderFooter(`${botName()} // OWNER`),
            ].join('\n'),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to list group JIDs: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'chr',
    aliases: ['creact'],
    description: 'React to a WhatsApp Channel post with stylized enclosed text (owner only).',
    category: 'Owner',
    ownerOnly: true,
    execute: async ({ sock, from, msg, text, isOwner }) => {
      if (!isOwner) {
        return sock.sendMessage(from, { text: '⛔ Only the bot owner can use `.chr`.' }, { quoted: msg });
      }
      const raw = String(text || '').trim();
      if (!raw) {
        return sock.sendMessage(
          from,
          { text: '🔤 Usage: `.chr <channel-post-link> <text>`\nExample: `.chr https://whatsapp.com/channel/0029Vb.../123 hello`' },
          { quoted: msg },
        );
      }
      const [link, ...textParts] = raw.split(/\s+/);
      if (!link || !link.includes('whatsapp.com/channel/')) {
        return sock.sendMessage(from, { text: '❌ Invalid WhatsApp Channel post link.' }, { quoted: msg });
      }
      const inputText = textParts.join(' ').trim().toLowerCase();
      if (!inputText) {
        return sock.sendMessage(from, { text: '❌ Please provide text to react with after the channel link.' }, { quoted: msg });
      }
      const parts = link.replace(/\/+$/, '').split('/');
      const channelIdx = parts.findIndex((p) => p === 'channel');
      const channelCode = channelIdx >= 0 ? parts[channelIdx + 1] : '';
      const messageId = channelIdx >= 0 ? parts[channelIdx + 2] : '';
      if (!channelCode || !messageId) {
        return sock.sendMessage(from, { text: '❌ Channel link must include both channel ID and message ID.' }, { quoted: msg });
      }
      const stylized = [...inputText]
        .map((ch) => (ch === ' ' ? '―' : STYLIZED_CHANNEL_CHARS[ch] || ch))
        .join('');

      try {
        const meta = await sock.newsletterMetadata('invite', channelCode);
        if (!meta?.id) {
          return sock.sendMessage(from, { text: '❌ Unable to resolve that WhatsApp Channel.' }, { quoted: msg });
        }
        await sock.newsletterReactMessage(meta.id, messageId, stylized);
        return sock.sendMessage(
          from,
          {
            text: card('CHANNEL REACTION', [
              spiderRow('CHANNEL', meta.name || meta.id, '📢'),
              spiderRow('MESSAGE', messageId, '🆔'),
              spiderRow('REACTION', stylized, '✨'),
            ], `${botName()} // OWNER`),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to send channel reaction: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'tempnum',
    aliases: ['fakenum', 'tempnumber'],
    description: 'Fetch temporary SMS phone numbers by country code.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const code = String(args?.[0] || '').trim().toLowerCase();
      if (!code || !/^[a-z]{2,15}$/i.test(code)) {
        return sock.sendMessage(
          from,
          { text: '📱 Usage: `.tempnum <country-code>`\nExample: `.tempnum us`\nTip: Run `.templist` to see available countries and `.otpbox <number>` to check OTPs.' },
          { quoted: msg },
        );
      }
      try {
        const { data } = await axios.get(
          `https://api.vreden.my.id/api/tools/fakenumber/listnumber?id=${encodeURIComponent(code)}`,
          { timeout: 10000 },
        );
        const list = Array.isArray(data?.result) ? data.result : [];
        if (!list.length) {
          return sock.sendMessage(
            from,
            { text: `📭 No temporary numbers available for *${code.toUpperCase()}*. Run \`.templist\` to view supported countries.` },
            { quoted: msg },
          );
        }
        const rows = list.slice(0, 20).map((item, idx) =>
          spiderRow(String(idx + 1).padStart(2, '0'), item.number || String(item), '📱'),
        );
        return sock.sendMessage(
          from,
          {
            text: [
              spiderHeader(botName(), `TEMP NUMBERS // ${code.toUpperCase()}`),
              spiderRow('FOUND', String(list.length), '📊'),
              spiderDivider('NUMBERS'),
              ...rows,
              spiderFooter('USE .otpbox <number> TO CHECK OTPS'),
            ].join('\n'),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to fetch temporary numbers: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'templist',
    aliases: ['tempnumberlist', 'tempnlist', 'listnumbers'],
    description: 'List countries supported for temporary SMS phone numbers.',
    category: 'Utility',
    execute: async ({ sock, from, msg }) => {
      try {
        const { data } = await axios.get('https://api.vreden.my.id/api/tools/fakenumber/country', { timeout: 10000 });
        const list = Array.isArray(data?.result) ? data.result : [];
        if (!list.length) {
          return sock.sendMessage(from, { text: '❌ Could not load temporary number countries right now.' }, { quoted: msg });
        }
        const rows = list.slice(0, 35).map((c, idx) =>
          spiderRow(String(idx + 1).padStart(2, '0'), `${c.title || c.name || 'Country'} (\`${c.id || c.code}\`)`, '🌍'),
        );
        return sock.sendMessage(
          from,
          {
            text: [
              spiderHeader(botName(), 'TEMP NUMBER COUNTRIES'),
              spiderRow('TOTAL', String(list.length), '🌐'),
              spiderDivider('COUNTRIES'),
              ...rows,
              spiderFooter('USE .tempnum <code>'),
            ].join('\n'),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to fetch country list: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'otpbox',
    aliases: ['checkotp', 'getotp'],
    description: 'Check recent OTP / SMS messages received by a temporary phone number.',
    category: 'Utility',
    execute: async ({ sock, from, msg, text }) => {
      const num = String(text || '').replace(/\s+/g, '').trim();
      if (!num || !/^\+?\d{6,16}$/.test(num)) {
        return sock.sendMessage(
          from,
          { text: '📥 Usage: `.otpbox <phone_number>`\nExample: `.otpbox +12025550123`' },
          { quoted: msg },
        );
      }
      try {
        const { data } = await axios.get(
          `https://api.vreden.my.id/api/tools/fakenumber/message?nomor=${encodeURIComponent(num)}`,
          { timeout: 10000 },
        );
        const messages = Array.isArray(data?.result) ? data.result : [];
        if (!messages.length) {
          return sock.sendMessage(from, { text: `📭 No OTP messages found yet for \`${num}\`.` }, { quoted: msg });
        }
        const rows = messages.slice(0, 8).map((entry, idx) => {
          const senderName = entry.from || entry.sender || 'SMS';
          const body = String(entry.content || entry.message || entry.text || '').trim().slice(0, 140);
          return spiderRow(`${String(idx + 1).padStart(2, '0')} ${senderName}`, body || '(empty)', '💬');
        });
        return sock.sendMessage(
          from,
          {
            text: [
              spiderHeader(botName(), `OTP INBOX // ${num}`),
              ...rows,
              spiderFooter(`${botName()} // UTILITY`),
            ].join('\n'),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to fetch OTP inbox: ${err.message}` }, { quoted: msg });
      }
    },
  },

  // =========================================================================
  // SEARCH & DOWNLOAD
  // =========================================================================
  {
    name: 'srepo',
    aliases: [],
    description: 'Fetch detailed GitHub repository information for any owner/repo.',
    category: 'Search',
    execute: async ({ sock, from, msg, text }) => {
      const repoPath = String(text || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
      if (!repoPath || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoPath)) {
        return sock.sendMessage(
          from,
          { text: '📁 Usage: `.srepo <owner/repo>`\nExample: `.srepo LilGabrielDev/Spider-Man`' },
          { quoted: msg },
        );
      }
      try {
        const { data } = await axios.get(`https://api.github.com/repos/${repoPath}`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Spider-Man-MD' },
          timeout: 10000,
        });
        if (!data?.full_name && !data?.name) {
          return sock.sendMessage(from, { text: `❌ Repository \`${repoPath}\` not found.` }, { quoted: msg });
        }
        return sock.sendMessage(
          from,
          {
            text: card(`GITHUB // ${data.full_name || data.name}`, [
              spiderRow('DESCRIPTION', data.description || 'No description provided', '📝'),
              spiderRow('LANGUAGE', data.language || 'Unknown', '💻'),
              spiderRow('STARS', Number(data.stargazers_count || 0).toLocaleString(), '⭐'),
              spiderRow('FORKS', Number(data.forks_count || 0).toLocaleString(), '🍴'),
              spiderRow('OPEN ISSUES', Number(data.open_issues_count || 0).toLocaleString(), '🐛'),
              spiderRow('LICENSE', data.license?.spdx_id || data.license?.name || 'None', '📄'),
              spiderRow('URL', data.html_url || `https://github.com/${repoPath}`, '🔗'),
            ], `${botName()} // SEARCH`),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to fetch repository info: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'gdrive',
    aliases: ['gdrivedl'],
    description: 'Download a public file from a Google Drive share link.',
    category: 'Download',
    execute: async ({ sock, from, msg, text }) => {
      const input = String(text || '').trim();
      const fileId = extractGdriveId(input);
      if (!fileId) {
        return sock.sendMessage(
          from,
          { text: '📁 Usage: `.gdrive <google_drive_url>`\nExample: `.gdrive https://drive.google.com/file/d/<FILE_ID>/view`' },
          { quoted: msg },
        );
      }
      try {
        let downloadUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
        let fileName = `gdrive-${fileId}`;
        let mimetype = 'application/octet-stream';

        try {
          const apiRes = await axios.get(
            `https://api.davidcyriltech.my.id/gdrive?url=${encodeURIComponent(input)}`,
            { timeout: 12000 },
          );
          const candidate =
            apiRes.data?.download_link ||
            apiRes.data?.result?.downloadUrl ||
            apiRes.data?.result?.url;
          if (candidate && /^https?:\/\//i.test(candidate)) {
            downloadUrl = candidate;
            if (apiRes.data?.name || apiRes.data?.result?.fileName) {
              fileName = apiRes.data.name || apiRes.data.result.fileName;
            }
            if (apiRes.data?.mimetype || apiRes.data?.result?.mimetype) {
              mimetype = apiRes.data.mimetype || apiRes.data.result.mimetype;
            }
          }
        } catch {}

        return await sock.sendMessage(
          from,
          {
            document: { url: downloadUrl },
            fileName,
            mimetype,
            caption: card('GOOGLE DRIVE', [
              spiderRow('FILE', fileName, '📁'),
              spiderRow('ID', fileId, '🆔'),
            ], `${botName()} // DOWNLOAD`),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Google Drive download failed: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'img',
    aliases: ['pinterest', 'searchpin'],
    description: 'Search and download images / wallpapers by keyword.',
    category: 'Search',
    execute: async ({ sock, from, msg, text }) => {
      const query = String(text || '').trim();
      if (!query) {
        return sock.sendMessage(
          from,
          { text: '🔎 Usage: `.img <keywords>`\nExample: `.img cyberpunk city`' },
          { quoted: msg },
        );
      }
      try {
        const res = await axios.get(
          `https://api.davidcyriltech.my.id/pinterest?q=${encodeURIComponent(query)}`,
          { timeout: 12000 },
        );
        const list = Array.isArray(res.data?.result)
          ? res.data.result
          : Array.isArray(res.data?.results)
            ? res.data.results
            : [];
        const urls = list
          .map((item) => (typeof item === 'string' ? item : item?.image || item?.src || item?.url))
          .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));

        if (!urls.length) {
          return sock.sendMessage(
            from,
            { text: `⚠️ No images found for *${query}*. Try different keywords.` },
            { quoted: msg },
          );
        }

        const picked = urls.slice(0, 4);
        for (const imgUrl of picked) {
          await sock.sendMessage(
            from,
            {
              image: { url: imgUrl },
              caption: card('IMAGE SEARCH', [
                spiderRow('QUERY', query, '🔎'),
              ], `${botName()} // SEARCH`),
            },
            { quoted: msg },
          );
        }
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Image search failed: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'rw',
    aliases: ['randomwall', 'wallpaper'],
    description: 'Fetch a random HD wallpaper matching a keyword.',
    category: 'Search',
    execute: async ({ sock, from, msg, text }) => {
      const query = String(text || '').trim() || 'nature';
      try {
        const res = await axios.get(
          `https://pikabotzapi.vercel.app/random/randomwall/?apikey=anya-md&query=${encodeURIComponent(query)}`,
          { timeout: 12000 },
        );
        const imgUrl = res.data?.imgUrl || res.data?.url;
        if (!imgUrl || typeof imgUrl !== 'string') {
          return sock.sendMessage(
            from,
            { text: `❌ Could not find a wallpaper for *${query}* right now.` },
            { quoted: msg },
          );
        }
        return await sock.sendMessage(
          from,
          {
            image: { url: imgUrl },
            caption: card('WALLPAPER', [
              spiderRow('TOPIC', query, '🌌'),
            ], `${botName()} // SEARCH`),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to fetch wallpaper: ${err.message}` }, { quoted: msg });
      }
    },
  },

  // =========================================================================
  // FUN, ANIME & MEDIA
  // =========================================================================
  createWaifuPicsCommand({
    name: 'waifu',
    aliases: ['imgwaifu', 'animegirl'],
    tag: 'waifu',
    label: 'Waifu',
    description: 'Fetch a random SFW anime waifu image.',
  }),
  createWaifuPicsCommand({
    name: 'neko',
    aliases: ['imgneko'],
    tag: 'neko',
    label: 'Neko',
    description: 'Fetch a random SFW anime neko image.',
  }),
  createWaifuPicsCommand({
    name: 'megumin',
    aliases: ['imgmegumin'],
    tag: 'megumin',
    label: 'Megumin',
    description: 'Fetch a random SFW Megumin anime image.',
  }),
  createWaifuPicsCommand({
    name: 'awoo',
    aliases: ['imgawoo'],
    tag: 'awoo',
    label: 'Awoo',
    description: 'Fetch a random SFW anime awoo image.',
  }),
  {
    name: 'maid',
    aliases: ['imgmaid'],
    description: 'Fetch a random SFW anime maid image.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      try {
        const res = await axios.get('https://api.waifu.im/search/?included_tags=maid', { timeout: 10000 });
        const imgUrl = res.data?.images?.[0]?.url || res.data?.url;
        if (!imgUrl || typeof imgUrl !== 'string') {
          return sock.sendMessage(from, { text: '❌ Could not fetch a Maid image right now.' }, { quoted: msg });
        }
        return await sock.sendMessage(
          from,
          {
            image: { url: imgUrl },
            caption: card('ANIME // MAID', [
              spiderRow('CATEGORY', 'Maid', '✨'),
            ], `${botName()} // FUN`),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to fetch Maid image: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'dog',
    aliases: ['dogpic'],
    description: 'Fetch a random dog photo.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      try {
        const res = await axios.get('https://dog.ceo/api/breeds/image/random', { timeout: 10000 });
        const imgUrl = res.data?.message;
        if (!imgUrl || typeof imgUrl !== 'string' || !/^https?:\/\//i.test(imgUrl)) {
          return sock.sendMessage(from, { text: '❌ Could not fetch a dog photo right now.' }, { quoted: msg });
        }
        return await sock.sendMessage(
          from,
          {
            image: { url: imgUrl },
            caption: card('RANDOM DOG', [
              spiderRow('SPECIES', 'Good Boy / Good Girl', '🐶'),
            ], `${botName()} // FUN`),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to fetch dog photo: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'couplepp',
    aliases: ['cpp'],
    description: 'Fetch matching male & female couple profile pictures.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      try {
        const res = await axios.get('https://api.davidcyriltech.my.id/couplepp', { timeout: 10000 });
        const male = res.data?.male;
        const female = res.data?.female;
        if (!male && !female) {
          return sock.sendMessage(
            from,
            { text: '❌ Could not fetch couple profile pictures right now. Please try again later.' },
            { quoted: msg },
          );
        }
        if (male) {
          await sock.sendMessage(
            from,
            {
              image: { url: male },
              caption: card('COUPLE PP // MALE', [spiderRow('MATCH', 'Male Avatar', '👨')], `${botName()} // FUN`),
            },
            { quoted: msg },
          );
        }
        if (female) {
          await sock.sendMessage(
            from,
            {
              image: { url: female },
              caption: card('COUPLE PP // FEMALE', [spiderRow('MATCH', 'Female Avatar', '👩')], `${botName()} // FUN`),
            },
            { quoted: msg },
          );
        }
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Failed to fetch couple profile pictures: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'character',
    aliases: ['char'],
    description: 'Check the fun character trait of a mentioned or replied group member.',
    category: 'Fun',
    groupOnly: true,
    execute: async ({ sock, from, msg }) => {
      if (!String(from || '').endsWith('@g.us')) {
        return sock.sendMessage(from, { text: '⛔ This command can only be used inside a group.' }, { quoted: msg });
      }
      const ctxInfo =
        msg?.message?.extendedTextMessage?.contextInfo ||
        msg?.message?.imageMessage?.contextInfo ||
        {};
      const target = ctxInfo.mentionedJid?.[0] || ctxInfo.participant || '';
      if (!target) {
        return sock.sendMessage(
          from,
          { text: '🔥 Mention or reply to a group member to check their character.\nExample: `.character @user`' },
          { quoted: msg },
        );
      }
      const trait = CHARACTER_TRAITS[Math.floor(Math.random() * CHARACTER_TRAITS.length)];
      const handle = target.split('@')[0];
      return sock.sendMessage(
        from,
        {
          text: card('CHARACTER CHECK', [
            spiderRow('USER', `@${handle}`, '👤'),
            spiderRow('TRAIT', `${trait} 🔥`, '⚡'),
          ], `${botName()} // FUN`),
          mentions: [target],
        },
        { quoted: msg },
      );
    },
  },

  // Animated Emoji Sequences
  createAnimationCommand({
    name: 'hpy',
    aliases: ['happy'],
    description: 'Play an animated happy faces emoji sequence.',
    initialText: '😂',
    frames: ['😃', '😄', '😁', '😊', '😎', '🥳', '😸', '😹', '🌞', '🌈', '😁', '🥳'],
    frameDelay: 300,
  }),
  createAnimationCommand({
    name: 'hrt',
    aliases: ['heart'],
    description: 'Play an animated rainbow heart emoji sequence.',
    initialText: '💖',
    frames: ['💗', '💕', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💘', '💝', '❤️‍🔥'],
    frameDelay: 300,
  }),
  createAnimationCommand({
    name: 'anger',
    aliases: ['angry'],
    description: 'Play an animated angry faces emoji sequence.',
    initialText: '😠',
    frames: ['😡', '🤬', '😤', '💢', '🌋', '🔥', '😡', '🤬', '💥'],
    frameDelay: 300,
  }),
  createAnimationCommand({
    name: 'sad',
    aliases: [],
    description: 'Play an animated sad faces emoji sequence.',
    initialText: '🥺',
    frames: ['😟', '😕', '🙁', '😩', '😥', '😓', '😢', '😔', '😞', '😭', '💔', '😿'],
    frameDelay: 300,
  }),
  createAnimationCommand({
    name: 'shy',
    aliases: [],
    description: 'Play an animated shy blushing emoji sequence.',
    initialText: '😊',
    frames: ['☺️', '😌', '😳', '🙈', '🙊', '👉👈', '🥺', '🥰', '😳'],
    frameDelay: 300,
  }),
  createAnimationCommand({
    name: 'mon',
    aliases: ['moon'],
    description: 'Play an animated moon phases emoji sequence.',
    initialText: '🌑',
    frames: ['🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘', '🌑', '🌒', '🌓', '🌔', '🌕', '🌚🌝'],
    frameDelay: 300,
  }),
  createAnimationCommand({
    name: 'confused',
    aliases: [],
    description: 'Play an animated confused faces emoji sequence.',
    initialText: '🤔',
    frames: ['🤨', '🧐', '😕', '😵‍💫', '🤷', '❓', '🤨', '🤔', '😵'],
    frameDelay: 300,
  }),
  createAnimationCommand({
    name: 'kiss',
    aliases: [],
    description: 'Play an animated kissy faces emoji sequence.',
    initialText: '😘',
    frames: ['😗', '😙', '😚', '💋', '❤️', '🥰', '😘', '💋', '💞'],
    frameDelay: 300,
  }),

  // =========================================================================
  // UNIQUE TEXT-EFFECT LOGOS
  // =========================================================================
  ...UNIQUE_LOGO_EFFECTS.map(createLogoCommand),
];
