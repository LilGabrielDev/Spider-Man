import axios from 'axios';
import config from '../../spider/config.js';
import {
  spiderHeader,
  spiderRow,
  spiderDivider,
  spiderFooter,
} from '../utils/tableStyle.js';

const botName = () => config.BOT_NAME || 'Spider Man';

const NEWS_FEEDS = {
  world: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  tech: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
  africa: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml',
  business: 'https://feeds.bbci.co.uk/news/business/rss.xml',
  sports: 'https://feeds.bbci.co.uk/sport/rss.xml',
};

const BUILTIN_RHYMES = {
  moon: ['June', 'tune', 'soon', 'noon', 'spoon', 'balloon', 'cartoon', 'lagoon'],
  day: ['way', 'say', 'play', 'stay', 'ray', 'bay', 'hay', 'pay'],
  love: ['above', 'dove', 'shove', 'glove'],
  night: ['light', 'right', 'sight', 'fight', 'bright', 'might', 'flight', 'kite'],
  time: ['rhyme', 'climb', 'lime', 'prime', 'chime', 'sublime'],
  fire: ['desire', 'hire', 'higher', 'inspire', 'wire', 'admire'],
  rain: ['pain', 'gain', 'main', 'plain', 'train', 'brain', 'chain'],
  star: ['far', 'bar', 'car', 'jar', 'scar', 'guitar', 'radar'],
  heart: ['art', 'start', 'part', 'smart', 'chart', 'dart'],
  dream: ['team', 'beam', 'cream', 'gleam', 'stream', 'theme'],
};

const TTS_VOICES = {
  en: 'en', fr: 'fr', sw: 'sw', ar: 'ar', es: 'es',
  de: 'de', ja: 'ja', zh: 'zh-CN', hi: 'hi', pt: 'pt',
};

function fmtNum(n) {
  if (n === undefined || n === null) return 'N/A';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export const commands = [
  {
    name: 'wiki',
    aliases: ['wikipedia'],
    description: 'Search Wikipedia for summaries and article links.',
    category: 'Search',
    execute: async ({ sock, from, msg, text }) => {
      const query = String(text || '').trim();
      if (!query) {
        return sock.sendMessage(
          from,
          { text: '📖 Usage: `.wiki <topic>`\nExample: `.wiki Black holes`' },
          { quoted: msg },
        );
      }
      try {
        const searchRes = await axios.get('https://en.wikipedia.org/w/api.php', {
          params: { action: 'query', list: 'search', srsearch: query, format: 'json', srlimit: 1 },
          timeout: 8000,
        });
        const title = searchRes.data?.query?.search?.[0]?.title || query;
        const summaryRes = await axios.get(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
          { timeout: 8000 },
        );
        const data = summaryRes.data || {};
        const displayTitle = data.displaytitle || data.title || title;
        const extract = String(data.extract || 'Summary available on Wikipedia.').slice(0, 1200);
        const pageUrl = data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
        const caption = [
          spiderHeader(botName(), `WIKIPEDIA // ${displayTitle}`),
          `> ┃ ${extract}`,
          spiderRow('LINK', pageUrl, '🔗'),
          spiderFooter(`${botName()} // SEARCH`),
        ].join('\n');

        if (data.thumbnail?.source) {
          return sock.sendMessage(from, { image: { url: data.thumbnail.source }, caption }, { quoted: msg });
        }
        return sock.sendMessage(from, { text: caption }, { quoted: msg });
      } catch (err) {
        return sock.sendMessage(
          from,
          { text: `❌ Nothing found on Wikipedia for *"${query}"*. (${err.message})` },
          { quoted: msg },
        );
      }
    },
  },
  {
    name: 'ghstalk',
    aliases: ['githubstalk'],
    description: 'Inspect a GitHub user profile, stars, and top repos.',
    category: 'Search',
    execute: async ({ sock, from, msg, args }) => {
      const username = String(args[0] || '').replace(/^@/, '').trim();
      if (!username) {
        return sock.sendMessage(
          from,
          { text: '🐙 Usage: `.ghstalk <username>`\nExample: `.ghstalk torvalds`' },
          { quoted: msg },
        );
      }
      const headers = { 'User-Agent': 'SpiderMan-Bot/1.0', Accept: 'application/vnd.github+json' };
      try {
        const [userRes, reposRes] = await Promise.allSettled([
          axios.get(`https://api.github.com/users/${encodeURIComponent(username)}`, { headers, timeout: 8000 }),
          axios.get(`https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=updated&per_page=5&type=owner`, { headers, timeout: 8000 }),
        ]);
        if (userRes.status === 'rejected') {
          if (userRes.reason?.response?.status === 404) {
            return sock.sendMessage(from, { text: `❌ GitHub user *${username}* not found.` }, { quoted: msg });
          }
          throw userRes.reason;
        }
        const u = userRes.value.data || {};
        const repos = reposRes.status === 'fulfilled' && Array.isArray(reposRes.value.data) ? reposRes.value.data : [];
        const totalStars = repos.reduce((sum, r) => sum + (r.stargazers_count || 0), 0);
        const topLangs = [...new Set(repos.map((r) => r.language).filter(Boolean))].slice(0, 4).join(', ') || 'N/A';

        const lines = [
          spiderHeader(botName(), `GITHUB // ${u.login || username}`),
          spiderRow('NAME', u.name || u.login || username, '👤'),
          spiderRow('REPOS', fmtNum(u.public_repos ?? 0), '📦'),
          spiderRow('FOLLOWERS', `${fmtNum(u.followers ?? 0)} / Following ${fmtNum(u.following ?? 0)}`, '👥'),
          spiderRow('TOP STARS', fmtNum(totalStars), '⭐'),
          spiderRow('LANGUAGES', topLangs, '💻'),
          ...(u.bio ? [spiderRow('BIO', String(u.bio).slice(0, 140), '📝')] : []),
          ...(repos.length
            ? [
                spiderDivider('RECENT REPOS'),
                ...repos.slice(0, 5).map((r) =>
                  spiderRow(r.name || 'repo', `${r.language || 'Code'} · ⭐${r.stargazers_count || 0}`, '▹'),
                ),
              ]
            : []),
          spiderRow('PROFILE', u.html_url || `https://github.com/${u.login || username}`, '🔗'),
          spiderFooter(`${botName()} // GITHUB`),
        ];
        const text = lines.join('\n');
        if (u.avatar_url) {
          try {
            return await sock.sendMessage(from, { image: { url: u.avatar_url }, caption: text }, { quoted: msg });
          } catch {}
        }
        return sock.sendMessage(from, { text }, { quoted: msg });
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ GitHub lookup failed: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'crypto',
    aliases: ['coinprice', 'btc'],
    description: 'Get live cryptocurrency prices in USD.',
    category: 'Search',
    execute: async ({ sock, from, msg, args }) => {
      const query = (args.length ? args.join(',') : 'bitcoin,ethereum,solana')
        .toLowerCase()
        .replace(/\s+/g, ',');
      try {
        const { data } = await axios.get(
          `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(query)}&vs_currencies=usd&include_24hr_change=true`,
          { timeout: 8000 },
        );
        const entries = Object.entries(data || {}).filter(([, v]) => typeof v?.usd === 'number');
        if (!entries.length) {
          return sock.sendMessage(
            from,
            { text: '❌ No coin prices found. Use CoinGecko IDs like `bitcoin`, `ethereum`, `solana`, `dogecoin`.' },
            { quoted: msg },
          );
        }
        const rows = entries.map(([coin, v]) => {
          const price = v.usd.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
          const chg = typeof v.usd_24h_change === 'number' ? v.usd_24h_change.toFixed(2) : null;
          const badge = chg !== null ? ` (${Number(chg) >= 0 ? '+' : ''}${chg}%)` : '';
          return spiderRow(coin.toUpperCase(), `${price}${badge}`, Number(chg) >= 0 ? '📈' : '📉');
        });
        return sock.sendMessage(
          from,
          { text: [spiderHeader(botName(), 'CRYPTO MARKET'), ...rows, spiderFooter(`${botName()} // COINGECKO`)].join('\n') },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Crypto lookup failed: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'news',
    aliases: ['headlines'],
    description: 'Fetch latest BBC news headlines (world, tech, africa, business, sports).',
    category: 'Search',
    execute: async ({ sock, from, msg, args }) => {
      const cat = String(args[0] || 'world').toLowerCase();
      const feedUrl = NEWS_FEEDS[cat] || NEWS_FEEDS.world;
      const activeCat = NEWS_FEEDS[cat] ? cat : 'world';
      try {
        const { data } = await axios.get(
          `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}&count=5`,
          { timeout: 8000 },
        );
        const items = Array.isArray(data?.items) ? data.items : [];
        if (!items.length) throw new Error('No headlines returned');
        const rows = items.slice(0, 5).map((item, idx) =>
          spiderRow(`0${idx + 1}`, `${item.title || 'Headline'}\n> ┃   🔗 ${item.link || ''}`, '📰'),
        );
        const body = [
          spiderHeader(botName(), `NEWS // ${activeCat.toUpperCase()}`),
          ...rows,
          spiderDivider(`FEEDS: ${Object.keys(NEWS_FEEDS).join(' · ')}`),
          spiderFooter(`${botName()} // BBC NEWS`),
        ].join('\n');
        return sock.sendMessage(from, { text: body }, { quoted: msg });
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ Could not fetch news: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'rhyme',
    aliases: ['rhymes'],
    description: 'Find words that rhyme with a given word.',
    category: 'Search',
    execute: async ({ sock, from, msg, args }) => {
      const word = String(args[0] || '').toLowerCase().trim();
      if (!word) {
        return sock.sendMessage(from, { text: '🎵 Usage: `.rhyme <word>`\nExample: `.rhyme moon`' }, { quoted: msg });
      }
      let rhymes = [];
      let source = 'Datamuse';
      try {
        const res = await axios.get(
          `https://api.datamuse.com/words?rel_rhy=${encodeURIComponent(word)}&max=20`,
          { timeout: 6000 },
        );
        if (Array.isArray(res.data)) {
          rhymes = res.data.map((r) => r?.word).filter(Boolean);
        }
      } catch {}
      if (!rhymes.length && BUILTIN_RHYMES[word]) {
        rhymes = BUILTIN_RHYMES[word];
        source = 'Built-in';
      }
      if (!rhymes.length) {
        return sock.sendMessage(from, { text: `🎵 No rhymes found for *"${word}"*.` }, { quoted: msg });
      }
      const reply = [
        spiderHeader(botName(), `RHYMES // ${word.toUpperCase()}`),
        spiderRow('WORDS', rhymes.join(', '), '🎵'),
        spiderRow('SOURCE', `${source} (${rhymes.length})`, '📚'),
        spiderFooter(`${botName()} // LANGUAGE`),
      ].join('\n');
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'tts',
    aliases: ['speak', 'voice'],
    description: 'Convert text into a spoken voice note.',
    category: 'Converter',
    execute: async ({ sock, from, msg, args }) => {
      if (!args.length) {
        return sock.sendMessage(
          from,
          { text: `🗣️ Usage: \`.tts <text>\` or \`.tts <lang> <text>\`\nLanguages: ${Object.keys(TTS_VOICES).join(', ')}` },
          { quoted: msg },
        );
      }
      let lang = 'en';
      let body = args.join(' ');
      const maybeLang = String(args[0] || '').toLowerCase();
      if (TTS_VOICES[maybeLang] && args.length > 1) {
        lang = TTS_VOICES[maybeLang];
        body = args.slice(1).join(' ');
      }
      body = body.trim();
      if (!body) return sock.sendMessage(from, { text: '❌ Please provide text to speak.' }, { quoted: msg });
      if (body.length > 200) return sock.sendMessage(from, { text: '❌ Max 200 characters for TTS.' }, { quoted: msg });
      try {
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(body)}`;
        const res = await axios.get(ttsUrl, {
          responseType: 'arraybuffer',
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        return sock.sendMessage(
          from,
          { audio: Buffer.from(res.data), mimetype: 'audio/mpeg', ptt: true },
          { quoted: msg },
        );
      } catch (err) {
        return sock.sendMessage(from, { text: `❌ TTS failed: ${err.message}` }, { quoted: msg });
      }
    },
  },
  {
    name: 'carbon',
    aliases: ['codeimg', 'code2img'],
    description: 'Render source code as a stylized Carbon image.',
    category: 'Converter',
    execute: async ({ sock, from, msg, text }) => {
      const code = String(text || '').trim();
      if (!code) {
        return sock.sendMessage(
          from,
          { text: '💻 Usage: `.carbon <code>`\nExample: `.carbon console.log("Spider Man");`' },
          { quoted: msg },
        );
      }
      const carbonUrl = `https://carbon.now.sh/?bg=rgba%28171%2C184%2C195%2C1%29&t=monokai&wt=none&l=auto&code=${encodeURIComponent(code)}`;
      try {
        const screenshotUrl = `https://image.thum.io/get/width/1200/crop/700/${carbonUrl}`;
        const res = await axios.get(screenshotUrl, {
          responseType: 'arraybuffer',
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (res.data?.length > 5000) {
          return sock.sendMessage(
            from,
            { image: Buffer.from(res.data), caption: `💻 *Code Snippet* // ${botName()}` },
            { quoted: msg },
          );
        }
      } catch {}
      return sock.sendMessage(
        from,
        { text: `💻 *Carbon Code Snippet*\nOpen or preview:\n${carbonUrl}` },
        { quoted: msg },
      );
    },
  },
];
