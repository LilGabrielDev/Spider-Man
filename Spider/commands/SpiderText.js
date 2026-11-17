import config from '../../spider/config.js';
import {
  spiderHeader,
  spiderRow,
  spiderFooter,
} from '../utils/tableStyle.js';

const botName = () => config.BOT_NAME || 'Spider Man';

const MORSE_MAP = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.',
  G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
  M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
  1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....',
  6: '-....', 7: '--...', 8: '---..', 9: '----.', 0: '-----',
  ' ': '/',
};

const REVERSE_MORSE = Object.fromEntries(
  Object.entries(MORSE_MAP).map(([k, v]) => [v, k]),
);

const BUBBLE_SRC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BUBBLE_DST = [...'ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ⓪①②③④⑤⑥⑦⑧⑨'];

const ZALGO_CHARS = [
  '\u0300', '\u0301', '\u0302', '\u0303', '\u0304', '\u0305',
  '\u0306', '\u0307', '\u0308', '\u0309', '\u030A', '\u030B',
  '\u030C', '\u030D', '\u030E', '\u030F', '\u0310', '\u0311',
  '\u0312', '\u0313', '\u0314', '\u0315', '\u033D', '\u033E',
];

const EMOJI_ALPHA = {
  a: '🅰️', b: '🅱️', c: '©️', d: '🇩', e: '📧', f: '🎏',
  g: '🇬', h: '♓', i: 'ℹ️', j: '🎷', k: '🎋', l: '🕒',
  m: 'Ⓜ️', n: '🇳', o: '⭕', p: '🅿️', q: '🇶', r: '®️',
  s: '💲', t: '✝️', u: '⛎', v: '♈', w: '〰️', x: '❌',
  y: '💴', z: '💤', ' ': '  ',
};

const UNIT_FACTORS = {
  km: { mi: 0.621371, m: 1000 },
  mi: { km: 1.60934, m: 1609.34 },
  m: { ft: 3.28084, cm: 100, km: 0.001 },
  ft: { m: 0.3048, cm: 30.48 },
  cm: { in: 0.393701, mm: 10, m: 0.01 },
  in: { cm: 2.54, mm: 25.4 },
  kg: { lb: 2.20462, g: 1000 },
  lb: { kg: 0.453592, g: 453.592 },
  l: { gal: 0.264172, ml: 1000 },
  gal: { l: 3.78541, ml: 3785.41 },
};

function requireText(sock, from, msg, text, usage) {
  const clean = String(text || '').trim();
  if (!clean) {
    sock.sendMessage(from, { text: `📝 Usage: \`${usage}\`` }, { quoted: msg });
    return null;
  }
  return clean;
}

export const commands = [
  {
    name: 'base64',
    aliases: ['encode64'],
    description: 'Encode text into Base64.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.base64 <text>');
      if (!input) return;
      return sock.sendMessage(from, { text: Buffer.from(input, 'utf8').toString('base64') }, { quoted: msg });
    },
  },
  {
    name: 'decode64',
    aliases: ['unbase64'],
    description: 'Decode a Base64 string back to plain text.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.decode64 <base64>');
      if (!input) return;
      try {
        const decoded = Buffer.from(input, 'base64').toString('utf8');
        return sock.sendMessage(from, { text: decoded || '❌ Empty output.' }, { quoted: msg });
      } catch {
        return sock.sendMessage(from, { text: '❌ Invalid Base64 input.' }, { quoted: msg });
      }
    },
  },
  {
    name: 'binary',
    aliases: ['bin'],
    description: 'Convert text to 8-bit binary.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.binary <text>');
      if (!input) return;
      const out = input.split('').map((ch) => ch.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
      return sock.sendMessage(from, { text: out }, { quoted: msg });
    },
  },
  {
    name: 'unbinary',
    aliases: ['frombin'],
    description: 'Convert 8-bit binary back to text.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.unbinary <binary>');
      if (!input) return;
      const parts = input.split(/\s+/).filter(Boolean);
      if (parts.some((b) => !/^[01]+$/.test(b))) {
        return sock.sendMessage(from, { text: '❌ Please provide space-separated 0/1 binary bytes.' }, { quoted: msg });
      }
      const out = parts.map((b) => String.fromCharCode(parseInt(b, 2))).join('');
      return sock.sendMessage(from, { text: out }, { quoted: msg });
    },
  },
  {
    name: 'hex',
    aliases: ['tohex'],
    description: 'Encode text into hexadecimal.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.hex <text>');
      if (!input) return;
      return sock.sendMessage(from, { text: Buffer.from(input, 'utf8').toString('hex') }, { quoted: msg });
    },
  },
  {
    name: 'unhex',
    aliases: ['fromhex'],
    description: 'Decode hexadecimal back to UTF-8 text.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.unhex <hex>');
      if (!input) return;
      const clean = input.replace(/\s+/g, '');
      if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) {
        return sock.sendMessage(from, { text: '❌ Invalid hexadecimal string.' }, { quoted: msg });
      }
      return sock.sendMessage(from, { text: Buffer.from(clean, 'hex').toString('utf8') }, { quoted: msg });
    },
  },
  {
    name: 'morse',
    aliases: ['morseencode'],
    description: 'Convert text into Morse code.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.morse <text>');
      if (!input) return;
      const out = input.toUpperCase().split('').map((ch) => MORSE_MAP[ch] || ch).join(' ');
      return sock.sendMessage(from, { text: out }, { quoted: msg });
    },
  },
  {
    name: 'unmorse',
    aliases: ['morsedecode', 'demorse'],
    description: 'Decode Morse code back into readable text.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.unmorse <morse>');
      if (!input) return;
      const out = input.split(/\s+/).map((code) => REVERSE_MORSE[code] || '?').join('');
      return sock.sendMessage(from, { text: out }, { quoted: msg });
    },
  },
  {
    name: 'rot13',
    aliases: ['caesar'],
    description: 'Encode or decode text using ROT13 cipher.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.rot13 <text>');
      if (!input) return;
      const out = input.replace(/[a-zA-Z]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) + (ch.toLowerCase() < 'n' ? 13 : -13)),
      );
      return sock.sendMessage(from, { text: out }, { quoted: msg });
    },
  },
  {
    name: 'reverse',
    aliases: ['rev'],
    description: 'Reverse any text string.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.reverse <text>');
      if (!input) return;
      return sock.sendMessage(from, { text: [...input].reverse().join('') }, { quoted: msg });
    },
  },
  {
    name: 'upper',
    aliases: ['uppercase', 'caps'],
    description: 'Convert text to UPPERCASE.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.upper <text>');
      if (!input) return;
      return sock.sendMessage(from, { text: input.toUpperCase() }, { quoted: msg });
    },
  },
  {
    name: 'lower',
    aliases: ['lowercase'],
    description: 'Convert text to lowercase.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.lower <text>');
      if (!input) return;
      return sock.sendMessage(from, { text: input.toLowerCase() }, { quoted: msg });
    },
  },
  {
    name: 'titlecase',
    aliases: ['totitle'],
    description: 'Capitalize the first letter of each word.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.titlecase <text>');
      if (!input) return;
      return sock.sendMessage(
        from,
        { text: input.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'snakecase',
    aliases: ['snake'],
    description: 'Convert text to snake_case.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.snakecase <text>');
      if (!input) return;
      return sock.sendMessage(from, { text: input.toLowerCase().replace(/\s+/g, '_') }, { quoted: msg });
    },
  },
  {
    name: 'camelcase',
    aliases: ['camel'],
    description: 'Convert text to camelCase.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.camelcase <text>');
      if (!input) return;
      const words = input.split(/\s+/).filter(Boolean);
      const out = words[0].toLowerCase() +
        words.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
      return sock.sendMessage(from, { text: out }, { quoted: msg });
    },
  },
  {
    name: 'mock',
    aliases: ['spongebob'],
    description: 'Convert text into aLtErNaTiNg mocking case.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.mock <text>');
      if (!input) return;
      const out = input.split('').map((ch, i) => (i % 2 ? ch.toUpperCase() : ch.toLowerCase())).join('');
      return sock.sendMessage(from, { text: out }, { quoted: msg });
    },
  },
  {
    name: 'bubble',
    aliases: ['circled'],
    description: 'Convert letters and digits into circled bubble text.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.bubble <text>');
      if (!input) return;
      const out = input.split('').map((ch) => {
        const idx = BUBBLE_SRC.indexOf(ch);
        return idx >= 0 ? BUBBLE_DST[idx] : ch;
      }).join('');
      return sock.sendMessage(from, { text: out }, { quoted: msg });
    },
  },
  {
    name: 'aesthetic',
    aliases: ['vaporwave'],
    description: 'Convert text into fullwidth vaporwave style.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.aesthetic <text>');
      if (!input) return;
      const out = input.split('').map((ch) => {
        if (ch === ' ') return '  ';
        return /[!-~]/.test(ch) ? String.fromCharCode(ch.charCodeAt(0) + 0xfee0) : ch;
      }).join('');
      return sock.sendMessage(from, { text: out }, { quoted: msg });
    },
  },
  {
    name: 'zalgo',
    aliases: ['creepy'],
    description: 'Add spooky Zalgo diacritics to text.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.zalgo <text>');
      if (!input) return;
      const out = input.split('').map((ch) => {
        const marks = Array.from({ length: 3 }, () => ZALGO_CHARS[Math.floor(Math.random() * ZALGO_CHARS.length)]).join('');
        return ch + marks;
      }).join('');
      return sock.sendMessage(from, { text: out }, { quoted: msg });
    },
  },
  {
    name: 'leetspeak',
    aliases: ['leet', '1337'],
    description: 'Convert text to 1337 leetspeak.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.leet <text>');
      if (!input) return;
      const map = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7', g: '9' };
      const out = input.toLowerCase().split('').map((ch) => map[ch] || ch).join('');
      return sock.sendMessage(from, { text: out }, { quoted: msg });
    },
  },
  {
    name: 'piglatin',
    aliases: ['pig'],
    description: 'Translate English text into Pig Latin.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.piglatin <text>');
      if (!input) return;
      const out = input.split(/\s+/).map((word) => {
        const m = word.match(/^([^aeiouAEIOU]*)(.*)$/);
        return m ? `${m[2]}${m[1]}ay` : `${word}ay`;
      }).join(' ');
      return sock.sendMessage(from, { text: out }, { quoted: msg });
    },
  },
  {
    name: 'emojify',
    aliases: ['textemoji'],
    description: 'Turn letters into emoji tiles.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.emojify <text>');
      if (!input) return;
      const out = input.toLowerCase().split('').map((ch) => EMOJI_ALPHA[ch] || ch).join(' ');
      return sock.sendMessage(from, { text: out }, { quoted: msg });
    },
  },
  {
    name: 'clap',
    aliases: ['clapback'],
    description: 'Insert 👏 between words for emphasis.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.clap <text>');
      if (!input) return;
      return sock.sendMessage(from, { text: input.split(/\s+/).join(' 👏 ') }, { quoted: msg });
    },
  },
  {
    name: 'shuffletext',
    aliases: ['scramble'],
    description: 'Randomly shuffle the characters in text.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.shuffletext <text>');
      if (!input) return;
      const chars = [...input];
      for (let i = chars.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [chars[i], chars[j]] = [chars[j], chars[i]];
      }
      return sock.sendMessage(from, { text: chars.join('') }, { quoted: msg });
    },
  },
  {
    name: 'wordcount',
    aliases: ['wc', 'charcount'],
    description: 'Analyze characters, words, vowels, and sentences.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const input = requireText(sock, from, msg, text, '.wc <text>');
      if (!input) return;
      const words = input.split(/\s+/).filter(Boolean);
      const sentences = input.split(/[.!?]+/).filter((s) => s.trim());
      const vowels = (input.match(/[aeiou]/gi) || []).length;
      const consonants = (input.match(/[bcdfghjklmnpqrstvwxyz]/gi) || []).length;
      const reply = [
        spiderHeader(botName(), 'TEXT ANALYSIS'),
        spiderRow('CHARACTERS', String(input.length), '🔠'),
        spiderRow('WORDS', String(words.length), '📝'),
        spiderRow('SENTENCES', String(sentences.length), '📄'),
        spiderRow('VOWELS / CONS', `${vowels} / ${consonants}`, '📊'),
        spiderFooter(`${botName()} // CONVERTER`),
      ].join('\n');
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'roman',
    aliases: ['toroman'],
    description: 'Convert an integer (1–3999) into Roman numerals.',
    category: 'Converter',
    execute: async ({ sock, from, msg, args }) => {
      const n = parseInt(args[0], 10);
      if (Number.isNaN(n) || n < 1 || n > 3999) {
        return sock.sendMessage(from, { text: '🏛️ Usage: `.roman <1-3999>`' }, { quoted: msg });
      }
      const table = [
        [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
        [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
        [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
      ];
      let rem = n;
      let out = '';
      for (const [val, sym] of table) {
        while (rem >= val) {
          out += sym;
          rem -= val;
        }
      }
      return sock.sendMessage(from, { text: `🏛️ ${n} = *${out}*` }, { quoted: msg });
    },
  },
  {
    name: 'celsius',
    aliases: ['ftoc', 'tocelsius'],
    description: 'Convert Fahrenheit to Celsius.',
    category: 'Converter',
    execute: async ({ sock, from, msg, args }) => {
      const f = parseFloat(args[0]);
      if (Number.isNaN(f)) {
        return sock.sendMessage(from, { text: '🌡️ Usage: `.celsius <fahrenheit>`' }, { quoted: msg });
      }
      return sock.sendMessage(from, { text: `🌡️ ${f}°F = *${(((f - 32) * 5) / 9).toFixed(2)}°C*` }, { quoted: msg });
    },
  },
  {
    name: 'fahrenheit',
    aliases: ['ctof', 'tofahrenheit'],
    description: 'Convert Celsius to Fahrenheit.',
    category: 'Converter',
    execute: async ({ sock, from, msg, args }) => {
      const c = parseFloat(args[0]);
      if (Number.isNaN(c)) {
        return sock.sendMessage(from, { text: '🌡️ Usage: `.fahrenheit <celsius>`' }, { quoted: msg });
      }
      return sock.sendMessage(from, { text: `🌡️ ${c}°C = *${((c * 9) / 5 + 32).toFixed(2)}°F*` }, { quoted: msg });
    },
  },
  {
    name: 'unitconvert',
    aliases: ['uconvert'],
    description: 'Convert between common distance, weight, and volume units.',
    category: 'Converter',
    execute: async ({ sock, from, msg, args }) => {
      const val = parseFloat(args[0]);
      const unitFrom = String(args[1] || '').toLowerCase();
      const unitTo = String(args[2] || '').toLowerCase();
      if (Number.isNaN(val) || !unitFrom || !unitTo) {
        return sock.sendMessage(
          from,
          { text: '📐 Usage: `.unitconvert <value> <from> <to>`\nSupported: `km/mi`, `m/ft`, `cm/in`, `kg/lb`, `l/gal`' },
          { quoted: msg },
        );
      }
      const factor = UNIT_FACTORS[unitFrom]?.[unitTo];
      if (!factor) {
        return sock.sendMessage(
          from,
          { text: '❌ Unsupported pair. Try: `km/mi`, `m/ft`, `cm/in`, `kg/lb`, `l/gal`' },
          { quoted: msg },
        );
      }
      return sock.sendMessage(
        from,
        { text: `📐 *${val} ${unitFrom}* = *${(val * factor).toFixed(4)} ${unitTo}*` },
        { quoted: msg },
      );
    },
  },
];
