import _0x5acc47 from 'axios';
import _0xutil from 'util';
import { translateText, getBibleVerse, getRandomFact, getRandomQuote, defineTerm, MESSAGES } from '../france/index.js';
import { extractContextInfo, safeDeleteTempMessage } from '../../spider/utils/groupActionHelper.js';

export const commands = [
  {
    name: 'trt',
    aliases: ['translate'],
    description: 'Translate a replied message to the specified language.',
    category: 'General',
    execute: async ({ sock, from, text, msg, config }) => {
      const botName = config.BOT_NAME || 'Spider Man';
      const botVersion = config.BOT_VERSION || '1.0.0';
      const { quotedMessage } = extractContextInfo(msg);
      if (!quotedMessage) {
        return sock.sendMessage(
          from,
          { text: MESSAGES.translate.noReply.replace('{botName}', botName).replace('{botVersion}', botVersion) },
          { quoted: msg },
        );
      }

      const args = String(text || '').trim().split(/\s+/).filter(Boolean);
      if (args.length !== 1) {
        return sock.sendMessage(
          from,
          { text: MESSAGES.translate.usage.replace('{botName}', botName).replace('{botVersion}', botVersion) },
          { quoted: msg },
        );
      }

      const targetLang = args[0].toLowerCase();
      const sourceText =
        quotedMessage.conversation ||
        quotedMessage.extendedTextMessage?.text ||
        quotedMessage.imageMessage?.caption ||
        quotedMessage.videoMessage?.caption ||
        quotedMessage.documentMessage?.caption ||
        '';
      if (!sourceText) {
        return sock.sendMessage(
          from,
          { text: MESSAGES.translate.noText.replace('{botName}', botName).replace('{botVersion}', botVersion) },
          { quoted: msg },
        );
      }

      try {
        const translated = await translateText(sourceText, targetLang);
        await sock.sendMessage(
          from,
          { text: `${translated}\n\n⚡ Powered by ${botName} ${botVersion}` },
          { quoted: msg },
        );
      } catch {
        await sock.sendMessage(
          from,
          { text: MESSAGES.translate.error.replace('{botName}', botName).replace('{botVersion}', botVersion) },
          { quoted: msg },
        );
      }
    },
  },
  {
    name: 'owner',
    description: 'Sends contact card of the bot owner.',
    category: 'General',
    execute: async ({ sock, from, msg, config }) => {
      const botName = config.BOT_NAME || 'Spider Man';
      const botVersion = config.BOT_VERSION || '1.0.0';
      const connectedId = sock.user?.id?.split(':')[0]?.split('@')[0] || '';
      const ownerNumber = String(config.OWNER_NUMBER || connectedId).replace(/\D/g, '');
      const ownerName = config.OWNER_NAME || 'LilTech';
      if (!ownerNumber) {
        return sock.sendMessage(
          from,
          { text: 'Owner contact is not configured. Set OWNER_NUMBER or connect the owner WhatsApp account.' },
          { quoted: msg },
        );
      }
      const vcard =
        `BEGIN:VCARD\nVERSION:3.0\nFN:${ownerName}\nORG:${botName} ${botVersion};\n` +
        `TEL;type=CELL;type=VOICE;waid=${ownerNumber}:${ownerNumber}\nEND:VCARD`;
      await sock.sendMessage(
        from,
        {
          contacts: {
            displayName: `${ownerName} - ${botName} ${botVersion}`,
            contacts: [{ vcard }],
          },
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'ss',
    description: 'Takes a screenshot of a website using API.',
    category: 'General',
    execute: async ({ sock, from, text, msg, config }) => {
      const botName = config.BOT_NAME || 'Spider Man';
      const botVersion = config.BOT_VERSION || '1.0.0';
      if (!text) {
        return sock.sendMessage(
          from,
          { text: MESSAGES.screenshot.noUrl.replace('{botName}', botName).replace('{botVersion}', botVersion) },
          { quoted: msg },
        );
      }

      let targetUrl = text.trim();
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = `http://${targetUrl}`;
      }

      const theme = 'light';
      const device = 'desktop';
      const apiUrl = `https://api.siputzx.my.id/api/tools/ssweb?url=${encodeURIComponent(targetUrl)}&theme=${theme}&device=${device}`;
      let tempMsg = null;
      try {
        tempMsg = await sock.sendMessage(from, { text: '📸 Taking screenshot...' }, { quoted: msg });
        const response = await _0x5acc47.get(apiUrl, { responseType: 'arraybuffer', timeout: 30000 });
        await safeDeleteTempMessage(sock, from, tempMsg);
        await sock.sendMessage(
          from,
          {
            image: Buffer.from(response.data),
            caption: `*${botName.toUpperCase()} WEB SCREENSHOT*\n📡 URL: ${targetUrl}\n🎨 Theme: ${theme}\n💻 Device: ${device}\n\n⚡ Powered by ${botName} ${botVersion}`,
          },
          { quoted: msg },
        );
      } catch (err) {
        console.error('Screenshot error:', err);
        await safeDeleteTempMessage(sock, from, tempMsg);
        await sock.sendMessage(
          from,
          { text: MESSAGES.screenshot.error.replace('{botName}', botName).replace('{botVersion}', botVersion) },
          { quoted: msg },
        );
      }
    },
  },
  {
    name: 'bible',
    description: 'Get a Bible verse from a specific book, chapter, and verse.',
    category: 'General',
    execute: async ({ sock, from, text, msg, config }) => {
      const botName = config.BOT_NAME || 'Spider Man';
      const botVersion = config.BOT_VERSION || '1.0.0';
      if (!text) {
        return sock.sendMessage(
          from,
          { text: MESSAGES.bible.usage.replace('{botName}', botName).replace('{botVersion}', botVersion) },
          { quoted: msg },
        );
      }
      try {
        const result = await getBibleVerse(text);
        const reply =
          `📖 *THE HOLY BIBLE*\n\n📜 ${result.reference}\n🔢 Verses: ${result.verses.length}\n📝 ${result.text}\n🌍 Language: ${result.translation_name}\n\n⚡ Powered by ${botName} ${botVersion}`;
        await sock.sendMessage(from, { text: reply }, { quoted: msg });
      } catch {
        await sock.sendMessage(
          from,
          { text: MESSAGES.bible.error.replace('{botName}', botName).replace('{botVersion}', botVersion) },
          { quoted: msg },
        );
      }
    },
  },
  {
    name: 'poll',
    description: 'Create a poll.',
    category: 'General',
    execute: async ({ sock, from, text, msg, config }) => {
      const botName = config.BOT_NAME || 'Spider Man';
      const botVersion = config.BOT_VERSION || '1.0.0';
      const raw = String(text || '');
      const [question, optionsRaw] = raw.split('/');
      if (!question || !optionsRaw) {
        return sock.sendMessage(
          from,
          { text: MESSAGES.poll.usage.replace('{botName}', botName).replace('{botVersion}', botVersion) },
          { quoted: msg },
        );
      }
      const values = optionsRaw.split(',').map((opt) => opt.trim());
      await sock.sendMessage(
        from,
        {
          poll: {
            name: `${question.trim()} - ${botName} ${botVersion}`,
            values,
          },
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'fact',
    description: 'Get a random fact.',
    category: 'User',
    execute: async ({ sock, from, msg, config }) => {
      const botName = config.BOT_NAME || 'Spider Man';
      const botVersion = config.BOT_VERSION || '1.0.0';
      try {
        const fact = await getRandomFact();
        await sock.sendMessage(
          from,
          { text: `◆━━━━━━✦FACT✦━━━━━━◆\n◇ ${fact}\n◇ Powered by ${botName} ${botVersion}\n◇ KEEP USING ${botName}` },
          { quoted: msg },
        );
      } catch {
        await sock.sendMessage(
          from,
          { text: MESSAGES.fact.error.replace('{botName}', botName).replace('{botVersion}', botVersion) },
          { quoted: msg },
        );
      }
    },
  },
  {
    name: 'quotes',
    description: 'Get a random quote.',
    category: 'User',
    execute: async ({ sock, from, msg, config }) => {
      const botName = config.BOT_NAME || 'Spider Man';
      const botVersion = config.BOT_VERSION || '1.0.0';
      try {
        const quote = await getRandomQuote();
        const reply = `◆━━━━━━✦QUOTE✦━━━━━━◆\n◇ "${quote.body}"\n◇ — ${quote.author}\n◇ Powered by ${botName} ${botVersion}\n◇ KEEP USING ${botName}`;
        await sock.sendMessage(from, { text: reply }, { quoted: msg });
      } catch {
        await sock.sendMessage(
          from,
          { text: MESSAGES.quote.error.replace('{botName}', botName).replace('{botVersion}', botVersion) },
          { quoted: msg },
        );
      }
    },
  },
  {
    name: 'define',
    description: 'Get a definition for a term.',
    category: 'Search',
    execute: async ({ sock, from, text, msg, config }) => {
      const botName = config.BOT_NAME || 'Spider Man';
      const botVersion = config.BOT_VERSION || '1.0.0';
      if (!text) {
        return sock.sendMessage(
          from,
          { text: MESSAGES.define.usage.replace('{botName}', botName).replace('{botVersion}', botVersion) },
          { quoted: msg },
        );
      }
      try {
        const result = await defineTerm(text);
        const reply =
          `📚 Word: ${text}\n📝 Definition: ${result.definition.replace(/[\[\]]/g, '')}\n💡 Example: ${result.example.replace(/[\[\]]/g, '')}\n\n⚡ Powered by ${botName} ${botVersion}`;
        return sock.sendMessage(from, { text: reply }, { quoted: msg });
      } catch {
        return sock.sendMessage(
          from,
          {
            text: MESSAGES.define.notFound
              .replace('{word}', text)
              .replace('{botName}', botName)
              .replace('{botVersion}', botVersion),
          },
          { quoted: msg },
        );
      }
    },
  },
  {
    name: 'eval',
    aliases: ['evaluate'],
    description: 'Evaluate JavaScript code.',
    category: 'Owner',
    ownerOnly: true,
    execute: async ({ sock, from, text, msg, config }) => {
      const botName = config.BOT_NAME || 'Spider Man';
      const botVersion = config.BOT_VERSION || '1.0.0';
      if (!text) {
        return sock.sendMessage(
          from,
          { text: MESSAGES.evalSimple.usage.replace('{botName}', botName).replace('{botVersion}', botVersion) },
          { quoted: msg },
        );
      }
      try {
        let output = await eval(text);
        if (typeof output !== 'string') {
          output = _0xutil.inspect(output);
        }
        await sock.sendMessage(
          from,
          { text: `${String(output)}\n\n⚡ Powered by ${botName} ${botVersion}` },
          { quoted: msg },
        );
      } catch (err) {
        await sock.sendMessage(
          from,
          {
            text: MESSAGES.evalSimple.error
              .replace('{error}', err.message)
              .replace('{botName}', botName)
              .replace('{botVersion}', botVersion),
          },
          { quoted: msg },
        );
      }
    },
  },
];