import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import axios from 'axios';
import config from '../../spider/config.js';
import {
  spiderHeader,
  spiderRow,
  spiderDivider,
  spiderFooter,
} from '../utils/tableStyle.js';

const botName = () => config.BOT_NAME || 'Spider Man';

const NAMED_COLORS = {
  red: { hex: '#FF0000', rgb: '255, 0, 0', name: 'Red' },
  blue: { hex: '#0000FF', rgb: '0, 0, 255', name: 'Blue' },
  green: { hex: '#00FF00', rgb: '0, 255, 0', name: 'Lime Green' },
  yellow: { hex: '#FFFF00', rgb: '255, 255, 0', name: 'Yellow' },
  purple: { hex: '#800080', rgb: '128, 0, 128', name: 'Purple' },
  orange: { hex: '#FFA500', rgb: '255, 165, 0', name: 'Orange' },
  pink: { hex: '#FFC0CB', rgb: '255, 192, 203', name: 'Pink' },
  black: { hex: '#000000', rgb: '0, 0, 0', name: 'Black' },
  white: { hex: '#FFFFFF', rgb: '255, 255, 255', name: 'White' },
  cyan: { hex: '#00FFFF', rgb: '0, 255, 255', name: 'Cyan' },
  gold: { hex: '#FFD700', rgb: '255, 215, 0', name: 'Gold' },
  teal: { hex: '#008080', rgb: '0, 128, 128', name: 'Teal' },
};

const HTTP_CODES = {
  200: 'OK — Request succeeded',
  201: 'Created — New resource created',
  204: 'No Content — Success with empty body',
  301: 'Moved Permanently',
  302: 'Found — Temporary redirect',
  304: 'Not Modified',
  400: 'Bad Request — Invalid syntax or parameters',
  401: 'Unauthorized — Authentication required',
  403: 'Forbidden — Access denied',
  404: 'Not Found — Resource does not exist',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  429: 'Too Many Requests — Rate limit exceeded',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const FOOD_CALORIES = {
  apple: { cal: 95, protein: '0.5g', carbs: '25g', fat: '0.3g' },
  banana: { cal: 105, protein: '1.3g', carbs: '27g', fat: '0.4g' },
  rice: { cal: 206, protein: '4.3g', carbs: '45g', fat: '0.4g' },
  chicken: { cal: 165, protein: '31g', carbs: '0g', fat: '3.6g' },
  egg: { cal: 78, protein: '6g', carbs: '0.6g', fat: '5g' },
  bread: { cal: 79, protein: '2.7g', carbs: '15g', fat: '1g' },
  milk: { cal: 149, protein: '8g', carbs: '12g', fat: '8g' },
  potato: { cal: 161, protein: '4.3g', carbs: '37g', fat: '0.2g' },
  pasta: { cal: 220, protein: '8g', carbs: '43g', fat: '1.3g' },
  fish: { cal: 136, protein: '25g', carbs: '0g', fat: '3.5g' },
  beef: { cal: 250, protein: '26g', carbs: '0g', fat: '15g' },
  pizza: { cal: 285, protein: '12g', carbs: '36g', fat: '10g' },
  burger: { cal: 354, protein: '20g', carbs: '29g', fat: '17g' },
  avocado: { cal: 240, protein: '3g', carbs: '13g', fat: '22g' },
  mango: { cal: 99, protein: '1.4g', carbs: '25g', fat: '0.6g' },
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
];

function card(title, rows, footer = `${botName()} // UTILITY`) {
  return [spiderHeader(botName(), title), ...rows, spiderFooter(footer)].join('\n');
}

function safeEvalMath(rawExpr) {
  const sanitized = String(rawExpr || '')
    .replace(/\s+/g, '')
    .replace(/\^/g, '**');
  if (!sanitized || !/^[0-9+\-*/().%]+$/.test(sanitized)) return null;
  if (sanitized.length > 120) return null;
  const result = Function(`"use strict"; return (${sanitized})`)();
  return typeof result === 'number' && Number.isFinite(result) ? result : null;
}

export const commands = [
  {
    name: 'calc',
    aliases: ['calculate'],
    description: 'Evaluate a mathematical expression.',
    category: 'Utility',
    execute: async ({ sock, from, msg, text }) => {
      const expr = String(text || '').trim();
      if (!expr) {
        return sock.sendMessage(
          from,
          { text: '🧮 Usage: `.calc <expression>`\nExamples: `.calc (25 * 4) + 10`, `.calc 2^10`' },
          { quoted: msg },
        );
      }
      try {
        const result = safeEvalMath(expr);
        if (result === null) throw new Error('Invalid');
        return sock.sendMessage(
          from,
          {
            text: card('CALCULATOR', [
              spiderRow('INPUT', expr, '📥'),
              spiderRow('RESULT', result.toLocaleString(), '📤'),
            ]),
          },
          { quoted: msg },
        );
      } catch {
        return sock.sendMessage(from, { text: `❌ Invalid math expression: \`${expr}\`` }, { quoted: msg });
      }
    },
  },
  {
    name: 'passgen',
    aliases: ['password', 'passwd', 'genpass'],
    description: 'Generate a strong random password.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const len = Math.min(Math.max(parseInt(args[0], 10) || 16, 6), 64);
      const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const lower = 'abcdefghijklmnopqrstuvwxyz';
      const digits = '0123456789';
      const syms = '!@#$%^&*()-_=+[]{}';
      const all = upper + lower + digits + syms;
      const chars = [
        upper[crypto.randomInt(upper.length)],
        lower[crypto.randomInt(lower.length)],
        digits[crypto.randomInt(digits.length)],
        syms[crypto.randomInt(syms.length)],
      ];
      while (chars.length < len) chars.push(all[crypto.randomInt(all.length)]);
      for (let i = chars.length - 1; i > 0; i -= 1) {
        const j = crypto.randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
      }
      const strength = len >= 20 ? '🟢 Very Strong' : len >= 14 ? '🟡 Strong' : '🟠 Moderate';
      return sock.sendMessage(
        from,
        {
          text: card('PASSWORD GENERATOR', [
            spiderRow('LENGTH', String(len), '📏'),
            spiderRow('STRENGTH', strength, '🛡️'),
            spiderRow('PASSWORD', chars.join(''), '🔐'),
          ]),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'uuid',
    aliases: ['guid'],
    description: 'Generate a random UUID v4.',
    category: 'Utility',
    execute: async ({ sock, from, msg }) => {
      return sock.sendMessage(
        from,
        { text: card('UUID V4', [spiderRow('UUID', crypto.randomUUID(), '🆔')]) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'hash',
    aliases: ['md5', 'sha256', 'sha1'],
    description: 'Compute MD5, SHA-1, and SHA-256 hashes for text.',
    category: 'Utility',
    execute: async ({ sock, from, msg, text }) => {
      const input = String(text || '');
      if (!input.trim()) {
        return sock.sendMessage(from, { text: '🔐 Usage: `.hash <text>`' }, { quoted: msg });
      }
      return sock.sendMessage(
        from,
        {
          text: card('HASH DIGEST', [
            spiderRow('MD5', crypto.createHash('md5').update(input).digest('hex'), '🔹'),
            spiderRow('SHA1', crypto.createHash('sha1').update(input).digest('hex'), '🔸'),
            spiderRow('SHA256', crypto.createHash('sha256').update(input).digest('hex'), '🔐'),
          ]),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'timestamp',
    aliases: ['epoch', 'unixtime'],
    description: 'Show current Unix timestamp or convert a given epoch.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const raw = parseInt(args[0], 10);
      if (!Number.isNaN(raw) && args[0]) {
        const ms = raw > 1e12 ? raw : raw * 1000;
        const d = new Date(ms);
        return sock.sendMessage(
          from,
          {
            text: card('TIMESTAMP CONVERTER', [
              spiderRow('INPUT', String(raw), '⏱️'),
              spiderRow('UTC ISO', d.toISOString(), '🌐'),
              spiderRow('LOCAL', d.toLocaleString(), '📅'),
            ]),
          },
          { quoted: msg },
        );
      }
      const now = Date.now();
      return sock.sendMessage(
        from,
        {
          text: card('CURRENT TIMESTAMP', [
            spiderRow('SECONDS', String(Math.floor(now / 1000)), '⏱️'),
            spiderRow('MILLIS', String(now), '⚡'),
            spiderRow('ISO 8601', new Date(now).toISOString(), '🌐'),
          ]),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'jsonformat',
    aliases: ['prettyjson', 'json'],
    description: 'Validate and pretty-print a JSON payload.',
    category: 'Utility',
    execute: async ({ sock, from, msg, text }) => {
      const raw = String(text || '').trim();
      if (!raw) {
        return sock.sendMessage(from, { text: '📋 Usage: `.jsonformat {"hello":"world"}`' }, { quoted: msg });
      }
      try {
        const parsed = JSON.parse(raw);
        return sock.sendMessage(
          from,
          { text: `\`\`\`json\n${JSON.stringify(parsed, null, 2).slice(0, 3500)}\n\`\`\`` },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Invalid JSON: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'urlencode',
    aliases: ['encodeurl'],
    description: 'URL-encode a text string.',
    category: 'Utility',
    execute: async ({ sock, from, msg, text }) => {
      const input = String(text || '').trim();
      if (!input) return sock.sendMessage(from, { text: '🔗 Usage: `.urlencode <text>`' }, { quoted: msg });
      return sock.sendMessage(from, { text: encodeURIComponent(input) }, { quoted: msg });
    },
  },
  {
    name: 'urldecode',
    aliases: ['decodeurl'],
    description: 'Decode a URL-encoded string.',
    category: 'Utility',
    execute: async ({ sock, from, msg, text }) => {
      const input = String(text || '').trim();
      if (!input) return sock.sendMessage(from, { text: '🔗 Usage: `.urldecode <encoded>`' }, { quoted: msg });
      try {
        return sock.sendMessage(from, { text: decodeURIComponent(input) }, { quoted: msg });
      } catch {
        return sock.sendMessage(from, { text: '❌ Invalid URL-encoded string.' }, { quoted: msg });
      }
    },
  },
  {
    name: 'qr',
    aliases: ['qrcode', 'makeqr'],
    description: 'Generate a QR code PNG image for any text or URL.',
    category: 'Utility',
    execute: async ({ sock, from, msg, text }) => {
      const content = String(text || '').trim();
      if (!content) {
        return sock.sendMessage(
          from,
          { text: '📱 Usage: `.qr <text or URL>`\nExample: `.qr https://github.com`' },
          { quoted: msg },
        );
      }
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(content)}&margin=20`;
      try {
        const res = await axios.get(qrUrl, { responseType: 'arraybuffer', timeout: 8000 });
        return sock.sendMessage(
          from,
          {
            image: Buffer.from(res.data),
            caption: card('QR GENERATOR', [
              spiderRow('CONTENT', content.length > 80 ? `${content.slice(0, 77)}...` : content, '📝'),
            ]),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ QR generation failed: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'colorinfo',
    aliases: ['hexcolor', 'color'],
    description: 'Look up HEX/RGB/HSL info and swatch for a color.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const raw = String(args[0] || '').trim().toLowerCase();
      if (!raw) {
        return sock.sendMessage(
          from,
          { text: '🎨 Usage: `.colorinfo <hex or name>`\nExamples: `.colorinfo #ff5733`, `.colorinfo gold`' },
          { quoted: msg },
        );
      }
      if (NAMED_COLORS[raw]) {
        const c = NAMED_COLORS[raw];
        return sock.sendMessage(
          from,
          {
            text: card('COLOR INFO', [
              spiderRow('NAME', c.name, '🎨'),
              spiderRow('HEX', c.hex, '🔖'),
              spiderRow('RGB', `rgb(${c.rgb})`, '🌈'),
            ]),
          },
          { quoted: msg },
        );
      }
      let hex = raw.replace(/^#/, '');
      if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex)) {
        return sock.sendMessage(
          from,
          { text: '❌ Provide a valid 3/6-digit HEX code (e.g. `ff5733`) or color name (e.g. `gold`).' },
          { quoted: msg },
        );
      }
      if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      let name = `#${hex.toUpperCase()}`;
      let hslStr = 'N/A';
      try {
        const res = await axios.get(`https://www.thecolorapi.com/id?hex=${hex}`, { timeout: 6000 });
        if (res.data?.name?.value) name = res.data.name.value;
        if (res.data?.hsl) hslStr = `hsl(${res.data.hsl.h}°, ${res.data.hsl.s}%, ${res.data.hsl.l}%)`;
      } catch {}

      const caption = card('COLOR INFO', [
        spiderRow('NAME', name, '🎨'),
        spiderRow('HEX', `#${hex.toUpperCase()}`, '🔖'),
        spiderRow('RGB', `rgb(${r}, ${g}, ${b})`, '🌈'),
        spiderRow('HSL', hslStr, '🎛️'),
      ]);
      try {
        return await sock.sendMessage(
          from,
          { image: { url: `https://singlecolorimage.com/get/${hex}/200x200` }, caption },
          { quoted: msg },
        );
      } catch {
        return sock.sendMessage(from, { text: caption }, { quoted: msg });
      }
    },
  },
  {
    name: 'ip',
    aliases: ['iplookup', 'ipinfo'],
    description: 'Look up geolocation & ISP details for an IP address.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const target = String(args[0] || '').trim();
      if (!target || !/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i.test(target)) {
        return sock.sendMessage(from, { text: '🌐 Usage: `.ip <ip_address>`\nExample: `.ip 8.8.8.8`' }, { quoted: msg });
      }
      try {
        const res = await axios.get(`http://ip-api.com/json/${encodeURIComponent(target)}`, {
          params: { fields: 'status,message,country,regionName,city,lat,lon,timezone,isp,org,query,mobile,proxy' },
          timeout: 7000,
        });
        const d = res.data;
        if (!d || (d.status && d.status !== 'success')) {
          throw new Error(d?.message || 'Lookup failed');
        }
        return sock.sendMessage(
          from,
          {
            text: card(`IP // ${d.query || target}`, [
              spiderRow('COUNTRY', d.country || 'N/A', '🏳️'),
              spiderRow('CITY', [d.city, d.regionName].filter(Boolean).join(', ') || 'N/A', '🏙️'),
              spiderRow('TIMEZONE', d.timezone || 'N/A', '🕐'),
              spiderRow('ISP', d.isp || 'N/A', '🏢'),
              spiderRow('PROXY/VPN', d.proxy ? '⚠️ Yes' : 'No', '🕵️'),
            ]),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ IP lookup failed: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'dns',
    aliases: ['dnslookup', 'nslookup'],
    description: 'Look up DNS records (A, MX, NS, TXT) for a domain.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const domain = String(args[0] || '').replace(/^https?:\/\//i, '').split('/')[0].trim();
      if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
        return sock.sendMessage(from, { text: '🔍 Usage: `.dns <domain>`\nExample: `.dns github.com`' }, { quoted: msg });
      }
      try {
        const [a, mx, ns, txt] = await Promise.allSettled([
          dns.resolve4(domain),
          dns.resolveMx(domain),
          dns.resolveNs(domain),
          dns.resolveTxt(domain),
        ]);
        const aVal = a.status === 'fulfilled' ? a.value.join(', ') : 'N/A';
        const mxVal = mx.status === 'fulfilled' ? mx.value.slice(0, 3).map((r) => r.exchange).join(', ') : 'N/A';
        const nsVal = ns.status === 'fulfilled' ? ns.value.slice(0, 3).join(', ') : 'N/A';
        const txtVal = txt.status === 'fulfilled' ? txt.value.slice(0, 2).map((t) => t.join('')).join(' | ') : 'N/A';

        return sock.sendMessage(
          from,
          {
            text: card(`DNS // ${domain}`, [
              spiderRow('A (IPv4)', aVal, '🖥️'),
              spiderRow('MX', mxVal, '📧'),
              spiderRow('NS', nsVal, '🌐'),
              spiderRow('TXT', txtVal, '📋'),
            ]),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ DNS lookup failed: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'httpcode',
    aliases: ['statuscode', 'http'],
    description: 'Explain any standard HTTP status code.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const code = String(args[0] || '').trim();
      if (!code || !/^\d{3}$/.test(code)) {
        return sock.sendMessage(from, { text: '🌐 Usage: `.httpcode <code>`\nExample: `.httpcode 404`' }, { quoted: msg });
      }
      return sock.sendMessage(
        from,
        {
          text: card(`HTTP ${code}`, [
            spiderRow('MEANING', HTTP_CODES[code] || 'Non-standard or uncommon HTTP status code', '🌐'),
          ]),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'charcode',
    aliases: ['asciicode'],
    description: 'Show ASCII / Unicode code points for characters.',
    category: 'Utility',
    execute: async ({ sock, from, msg, text }) => {
      const input = String(text || '');
      if (!input) return sock.sendMessage(from, { text: '📊 Usage: `.charcode <text>`' }, { quoted: msg });
      const lines = [...input].slice(0, 30).map((ch) => `'${ch}' → ${ch.charCodeAt(0)} (0x${ch.charCodeAt(0).toString(16).toUpperCase()})`);
      return sock.sendMessage(from, { text: `📊 *Character Codes*\n\n${lines.join('\n')}` }, { quoted: msg });
    },
  },
  {
    name: 'useragent',
    aliases: ['ua'],
    description: 'Generate a realistic browser User-Agent string.',
    category: 'Utility',
    execute: async ({ sock, from, msg }) => {
      const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      return sock.sendMessage(
        from,
        { text: card('USER AGENT', [spiderRow('STRING', ua, '🌐')]) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'chmod',
    aliases: ['permissions'],
    description: 'Decode a 3-digit Unix chmod permission number.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const raw = String(args[0] || '').trim();
      if (!/^[0-7]{3}$/.test(raw)) {
        return sock.sendMessage(from, { text: '📁 Usage: `.chmod <octal>`\nExample: `.chmod 755`' }, { quoted: msg });
      }
      const perms = raw.split('').map((d) => {
        const v = Number(d);
        return `${v & 4 ? 'r' : '-'}${v & 2 ? 'w' : '-'}${v & 1 ? 'x' : '-'}`;
      });
      return sock.sendMessage(
        from,
        {
          text: card(`CHMOD ${raw}`, [
            spiderRow('OWNER', perms[0], '👤'),
            spiderRow('GROUP', perms[1], '👥'),
            spiderRow('OTHER', perms[2], '🌐'),
            spiderRow('SYMBOLIC', perms.join(''), '📁'),
          ]),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'cron',
    aliases: ['cronhelp'],
    description: 'Show quick cron schedule syntax reference.',
    category: 'Utility',
    execute: async ({ sock, from, msg }) => {
      const guide = [
        spiderHeader(botName(), 'CRON REFERENCE'),
        spiderRow('FORMAT', '`min hour day month weekday`', '⏰'),
        spiderDivider('EXAMPLES'),
        spiderRow('EVERY 5M', '`*/5 * * * *`', '▸'),
        spiderRow('HOURLY', '`0 * * * *`', '▸'),
        spiderRow('9AM M-F', '`0 9 * * 1-5`', '▸'),
        spiderRow('SUNDAY', '`0 0 * * 0`', '▸'),
        spiderFooter(`${botName()} // DEV TOOLS`),
      ].join('\n');
      return sock.sendMessage(from, { text: guide }, { quoted: msg });
    },
  },
  {
    name: 'regex',
    aliases: ['testregex'],
    description: 'Test a regular expression pattern against text.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const pattern = args[0];
      const target = args.slice(1).join(' ');
      if (!pattern || !target) {
        return sock.sendMessage(from, { text: '🔍 Usage: `.regex <pattern> <text>`\nExample: `.regex \\d+ Order 42 and 99`' }, { quoted: msg });
      }
      try {
        const re = new RegExp(pattern, 'g');
        const matches = target.match(re) || [];
        return sock.sendMessage(
          from,
          {
            text: card('REGEX TESTER', [
              spiderRow('PATTERN', `/${pattern}/g`, '🔍'),
              spiderRow('COUNT', String(matches.length), '📊'),
              spiderRow('MATCHES', matches.length ? matches.join(', ') : 'None', '✅'),
            ]),
          },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Invalid regex: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'bmi',
    aliases: ['bodymass'],
    description: 'Calculate Body Mass Index (weight kg, height cm).',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const w = parseFloat(args[0]);
      const h = parseFloat(args[1]);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        return sock.sendMessage(from, { text: '📊 Usage: `.bmi <weight_kg> <height_cm>`\nExample: `.bmi 70 175`' }, { quoted: msg });
      }
      const bmi = w / ((h / 100) ** 2);
      const category = bmi < 18.5 ? 'Underweight' : bmi < 25 ? 'Normal' : bmi < 30 ? 'Overweight' : 'Obese';
      return sock.sendMessage(
        from,
        {
          text: card('BMI CALCULATOR', [
            spiderRow('METRICS', `${w} kg / ${h} cm`, '📏'),
            spiderRow('BMI', bmi.toFixed(1), '📊'),
            spiderRow('CATEGORY', category, '🩺'),
          ]),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'calories',
    aliases: ['calorie', 'foodcal'],
    description: 'Look up calories and macros for common foods.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const q = String(args[0] || '').toLowerCase().trim();
      const info = FOOD_CALORIES[q];
      if (!info) {
        return sock.sendMessage(
          from,
          { text: `🍽️ Usage: \`.calories <food>\`\n*Foods:* ${Object.keys(FOOD_CALORIES).join(', ')}` },
          { quoted: msg },
        );
      }
      return sock.sendMessage(
        from,
        {
          text: card(`NUTRITION // ${q.toUpperCase()}`, [
            spiderRow('CALORIES', `${info.cal} kcal`, '🔥'),
            spiderRow('PROTEIN', info.protein, '🥩'),
            spiderRow('CARBS', info.carbs, '🌾'),
            spiderRow('FAT', info.fat, '🥑'),
          ]),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'waterintake',
    aliases: ['hydration'],
    description: 'Estimate recommended daily water intake by body weight.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const kg = parseFloat(args[0]);
      if (!Number.isFinite(kg) || kg <= 0) {
        return sock.sendMessage(from, { text: '💧 Usage: `.waterintake <weight_kg>`\nExample: `.waterintake 70`' }, { quoted: msg });
      }
      const liters = (kg * 0.033).toFixed(1);
      const glasses = Math.ceil(Number(liters) * 4.23);
      return sock.sendMessage(
        from,
        {
          text: card('DAILY HYDRATION', [
            spiderRow('WEIGHT', `${kg} kg`, '⚖️'),
            spiderRow('TARGET', `${liters} L / day`, '💧'),
            spiderRow('GLASSES', `~${glasses} × 240ml`, '🥤'),
          ]),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'age',
    aliases: ['agecalc'],
    description: 'Calculate age and total days lived from birth date.',
    category: 'Utility',
    execute: async ({ sock, from, msg, text }) => {
      const raw = String(text || '').trim();
      const d = raw ? new Date(raw) : null;
      if (!d || Number.isNaN(d.getTime()) || raw.length < 4) {
        return sock.sendMessage(from, { text: '🎂 Usage: `.age <YYYY-MM-DD>`\nExample: `.age 2000-05-15`' }, { quoted: msg });
      }
      const now = new Date();
      let years = now.getFullYear() - d.getFullYear();
      const mo = now.getMonth() - d.getMonth();
      if (mo < 0 || (mo === 0 && now.getDate() < d.getDate())) years -= 1;
      const days = Math.max(0, Math.floor((now - d) / 86400000));
      return sock.sendMessage(
        from,
        {
          text: card('AGE CALCULATOR', [
            spiderRow('BORN', d.toDateString(), '📅'),
            spiderRow('AGE', `${years} years`, '🎂'),
            spiderRow('DAYS LIVED', days.toLocaleString(), '⏳'),
          ]),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'prime',
    aliases: ['isprime'],
    description: 'Check whether an integer is a prime number.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const n = parseInt(args[0], 10);
      if (Number.isNaN(n) || n < 2 || n > 1e12) {
        return sock.sendMessage(from, { text: '🔢 Usage: `.prime <integer >= 2>`' }, { quoted: msg });
      }
      let ok = true;
      for (let i = 2; i <= Math.sqrt(n); i += 1) {
        if (n % i === 0) {
          ok = false;
          break;
        }
      }
      return sock.sendMessage(
        from,
        { text: `🔢 *${n}* is ${ok ? '✅ a *prime* number' : '❌ *not* a prime number'}.` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'factorial',
    aliases: ['factnum'],
    description: 'Calculate n! (for 0 <= n <= 170).',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const n = parseInt(args[0], 10);
      if (Number.isNaN(n) || n < 0 || n > 170) {
        return sock.sendMessage(from, { text: '❗ Usage: `.factorial <0-170>`' }, { quoted: msg });
      }
      let res = 1;
      for (let i = 2; i <= n; i += 1) res *= i;
      return sock.sendMessage(from, { text: `🔢 ${n}! = *${res}*` }, { quoted: msg });
    },
  },
  {
    name: 'fibonacci',
    aliases: ['fib'],
    description: 'Generate the first N Fibonacci numbers.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const count = Math.min(Math.max(parseInt(args[0], 10) || 10, 2), 50);
      const seq = [0, 1];
      for (let i = 2; i < count; i += 1) seq.push(seq[i - 1] + seq[i - 2]);
      return sock.sendMessage(
        from,
        { text: `🔢 *Fibonacci (${count})*\n\n${seq.join(', ')}` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'gcd',
    aliases: ['hcf'],
    description: 'Calculate Greatest Common Divisor of numbers.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const nums = args.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (nums.length < 2) return sock.sendMessage(from, { text: '➗ Usage: `.gcd 12 18`' }, { quoted: msg });
      const gcd = (a, b) => (b ? gcd(b, a % b) : a);
      return sock.sendMessage(from, { text: `📐 GCD(${nums.join(', ')}) = *${nums.reduce(gcd)}*` }, { quoted: msg });
    },
  },
  {
    name: 'lcm',
    aliases: [],
    description: 'Calculate Least Common Multiple of numbers.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const nums = args.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (nums.length < 2) return sock.sendMessage(from, { text: '✖️ Usage: `.lcm 4 6`' }, { quoted: msg });
      const gcd = (a, b) => (b ? gcd(b, a % b) : a);
      const lcm = (a, b) => (a * b) / gcd(a, b);
      return sock.sendMessage(from, { text: `📐 LCM(${nums.join(', ')}) = *${nums.reduce(lcm)}*` }, { quoted: msg });
    },
  },
  {
    name: 'percentage',
    aliases: ['percent', 'pct'],
    description: 'Calculate what percentage one number is of another.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const val = Number(args[0]);
      const total = Number(args[1]);
      if (args.length < 2 || !Number.isFinite(val) || !Number.isFinite(total) || total === 0) {
        return sock.sendMessage(from, { text: '📊 Usage: `.percentage <part> <total>`' }, { quoted: msg });
      }
      return sock.sendMessage(from, { text: `📊 ${val} / ${total} = *${((val / total) * 100).toFixed(2)}%*` }, { quoted: msg });
    },
  },
  {
    name: 'average',
    aliases: ['avg', 'mean'],
    description: 'Calculate arithmetic mean of a list of numbers.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const nums = args.map(Number).filter((n) => !Number.isNaN(n));
      if (!nums.length) return sock.sendMessage(from, { text: '📊 Usage: `.average 10 20 30`' }, { quoted: msg });
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
      return sock.sendMessage(from, { text: `📊 Average of [${nums.join(', ')}] = *${avg.toFixed(2)}*` }, { quoted: msg });
    },
  },
  {
    name: 'median',
    aliases: [],
    description: 'Calculate median value of a list of numbers.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const nums = args.map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
      if (!nums.length) return sock.sendMessage(from, { text: '📊 Usage: `.median 10 20 30`' }, { quoted: msg });
      const mid = Math.floor(nums.length / 2);
      const med = nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
      return sock.sendMessage(from, { text: `📊 Median of [${nums.join(', ')}] = *${med}*` }, { quoted: msg });
    },
  },
  {
    name: 'sqrt',
    aliases: ['squareroot'],
    description: 'Calculate the square root of a number.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const n = parseFloat(args[0]);
      if (!Number.isFinite(n) || n < 0) return sock.sendMessage(from, { text: '√ Usage: `.sqrt <number >= 0>`' }, { quoted: msg });
      return sock.sendMessage(from, { text: `√${n} = *${Number(Math.sqrt(n).toFixed(6))}*` }, { quoted: msg });
    },
  },
  {
    name: 'power',
    aliases: ['pow'],
    description: 'Raise base to an exponent.',
    category: 'Utility',
    execute: async ({ sock, from, msg, args }) => {
      const base = Number(args[0]);
      const exp = Number(args[1]);
      if (args.length < 2 || !Number.isFinite(base) || !Number.isFinite(exp)) {
        return sock.sendMessage(from, { text: '📐 Usage: `.power <base> <exponent>`' }, { quoted: msg });
      }
      return sock.sendMessage(from, { text: `${base}^${exp} = *${Math.pow(base, exp)}*` }, { quoted: msg });
    },
  },
  {
    name: 'compound',
    aliases: ['interest'],
    description: 'Calculate annual compound interest.',
    category: 'Economy',
    execute: async ({ sock, from, msg, args }) => {
      const p = Number(args[0]);
      const r = Number(args[1]);
      const t = Number(args[2]);
      if (args.length < 3 || !Number.isFinite(p) || !Number.isFinite(r) || !Number.isFinite(t)) {
        return sock.sendMessage(from, { text: '💰 Usage: `.compound <principal> <rate%> <years>`' }, { quoted: msg });
      }
      const total = p * Math.pow(1 + r / 100, t);
      return sock.sendMessage(
        from,
        {
          text: card('COMPOUND INTEREST', [
            spiderRow('PRINCIPAL', `$${p.toFixed(2)}`, '💵'),
            spiderRow('RATE / TIME', `${r}% × ${t} yrs`, '⏳'),
            spiderRow('FINAL', `$${total.toFixed(2)}`, '💰'),
            spiderRow('PROFIT', `$${(total - p).toFixed(2)}`, '📈'),
          ]),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'tip',
    aliases: ['tipcalc'],
    description: 'Calculate tip and total bill amount.',
    category: 'Economy',
    execute: async ({ sock, from, msg, args }) => {
      const bill = parseFloat(args[0]);
      const pct = parseFloat(args[1]) || 15;
      if (!Number.isFinite(bill)) {
        return sock.sendMessage(from, { text: '💵 Usage: `.tip <bill> [percent]`' }, { quoted: msg });
      }
      const tipAmt = (bill * pct) / 100;
      return sock.sendMessage(
        from,
        {
          text: card('TIP CALCULATOR', [
            spiderRow('BILL', `$${bill.toFixed(2)}`, '🧾'),
            spiderRow(`TIP (${pct}%)`, `$${tipAmt.toFixed(2)}`, '🪙'),
            spiderRow('TOTAL', `$${(bill + tipAmt).toFixed(2)}`, '💳'),
          ]),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'fakename',
    aliases: ['randomname'],
    description: 'Generate a random fictional full name.',
    category: 'Utility',
    execute: async ({ sock, from, msg }) => {
      const first = ['Amara', 'Brian', 'Clara', 'Daniel', 'Elena', 'Fatima', 'Gabriel', 'Hassan', 'Iris', 'Kwame', 'Liam', 'Zara'];
      const last = ['Mwangi', 'Okafor', 'Kamau', 'Chen', 'Kimani', 'Patel', 'Rivera', 'Mensah', 'Taylor', 'Walker'];
      const full = `${first[Math.floor(Math.random() * first.length)]} ${last[Math.floor(Math.random() * last.length)]}`;
      return sock.sendMessage(from, { text: card('RANDOM NAME', [spiderRow('NAME', full, '👤')]) }, { quoted: msg });
    },
  },
  {
    name: 'fakeemail',
    aliases: ['randomemail'],
    description: 'Generate a random placeholder email address.',
    category: 'Utility',
    execute: async ({ sock, from, msg }) => {
      const words = ['cyber', 'spider', 'swift', 'nova', 'pixel', 'cloud', 'storm', 'alpha'];
      const domains = ['example.com', 'mail.test', 'inbox.dev'];
      const email = `${words[Math.floor(Math.random() * words.length)]}.${words[Math.floor(Math.random() * words.length)]}${Math.floor(Math.random() * 900 + 100)}@${domains[Math.floor(Math.random() * domains.length)]}`;
      return sock.sendMessage(from, { text: card('RANDOM EMAIL', [spiderRow('EMAIL', email, '📧')]) }, { quoted: msg });
    },
  },
];
