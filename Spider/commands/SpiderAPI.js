import {
  requestJson,
  requestRaw,
  extractDownload,
  extractTitle,
  isHttpUrl,
  summarizeError,
} from '../france/spiderApiClient.js';
import {
  videoDownload,
  getTikTokMedia,
  getInstaMedia,
  facebookDownload,
  spotifySearch,
} from '../france/spiderApiWrappers.js';

const ROUTES = new Set([
  '/api/download',
  '/api/download/ytaudio',
  '/api/ytmp3',
  '/api/download/ytmp4',
  '/api/ytmp4',
  '/api/spotify',
  '/api/download/tiktok',
  '/api/download/instagram',
  '/api/download/facebook',
  '/api/download/twitter',
  '/api/download/pinterest',
  '/api/download/tiktokdl',
  '/api/download/instagramdl',
  '/api/download/spotify',
  '/api/download/ytsearch',
  '/api/stalk/tiktok',
  '/api/stalk/instagram',
  '/api/stalk/github',
  '/api/ai/chat',
  '/api/ai/gpt',
  '/api/ai/gemini',
  '/api/ai/mistral',
  '/api/ai/image',
  '/api/lyrics',
  '/api/ssweb',
  '/api/tts',
  '/api/qr',
  '/api/tools/nsfw',
  '/api/tools/nsfw/status',
  '/api/tools/upload',
  '/api/img/blur',
  '/api/img/pixelate',
  '/api/img/grayscale',
  '/api/img/circle',
  '/api/img/upscale',
  '/api/img/meme',
  '/api/img/ascii',
  '/api/img/colors',
  '/api/img/removebg',
  '/api/card/welcome',
  '/api/card/goodbye',
  '/api/card/rank',
  '/api/card/quote',
  '/api/card/wanted',
  '/api/card/jail',
  '/api/yt/card',
  '/api/fun/joke',
  '/api/fun/meme',
  '/api/fun/roast',
  '/api/fun/insult',
  '/api/fun/compliment',
  '/api/fun/flirt',
  '/api/anime/neko',
  '/api/anime/waifu',
  '/api/anime/husbando',
  '/api/anime/kitsune',
  '/api/anime/maid',
  '/api/anime/megumin',
  '/api/anime/awoo',
  '/api/anime/konachan',
  '/api/anime/random',
  '/api/anime/quotes',
  '/api/anime/char-quotes',
  '/api/anime/show-quotes',
  '/api/gif',
  '/api/gif/hug',
  '/api/gif/slap',
  '/api/gif/kiss',
  '/api/gif/pat',
  '/api/gif/cuddle',
  '/api/gif/poke',
  '/api/gif/dance',
  '/api/gif/cry',
  '/api/gif/bite',
  '/api/gif/blush',
  '/api/gif/bonk',
  '/api/gif/wave',
  '/api/gif/wink',
  '/api/gif/smile',
  '/api/gif/smug',
  '/api/gif/tickle',
  '/api/gif/highfive',
  '/api/gif/handhold',
  '/api/gif/yeet',
  '/api/gif/punch',
  '/api/gif/feed',
  '/api/gif/happy',
  '/api/gif/bored',
  '/api/gif/angry',
  '/api/gif/confused',
  '/api/gif/facepalm',
  '/api/gif/shrug',
  '/api/gif/sleep',
  '/api/gif/laugh',
  '/api/fake/tweet',
  '/api/fake/ytcomment',
  '/api/tools/translate',
  '/api/tools/weather',
  '/api/tools/define',
  '/api/tools/wiki',
  '/api/tools/currency',
  '/api/tools/shorturl',
  '/api/tools/npm',
  '/api/tools/country',
  '/api/tools/time',
  '/api/tools/calc',
  '/api/religion/quran',
  '/api/religion/bible',
  '/api/game/trivia',
  '/api/game/truth',
  '/api/game/dare',
  '/api/game/riddle',
]);

const ROUTE_ALIASES = {
  universal: '/api/download',
  ytaudio: '/api/download/ytaudio',
  youtubeaudio: '/api/download/ytaudio',
  ytmp3: '/api/ytmp3',
  ytmp4: '/api/ytmp4',
  spotify: '/api/spotify',
  tiktok: '/api/download/tiktok',
  instagram: '/api/download/instagram',
  facebook: '/api/download/facebook',
  twitter: '/api/download/twitter',
  x: '/api/download/twitter',
  pinterest: '/api/download/pinterest',
  ytsearch: '/api/download/ytsearch',
  tiktokstalk: '/api/stalk/tiktok',
  instagramstalk: '/api/stalk/instagram',
  githubstalk: '/api/stalk/github',
  chat: '/api/ai/chat',
  gpt: '/api/ai/gpt',
  gemini: '/api/ai/gemini',
  mistral: '/api/ai/mistral',
  aiimage: '/api/ai/image',
  lyrics: '/api/lyrics',
  ssweb: '/api/ssweb',
  tts: '/api/tts',
  qr: '/api/qr',
  joke: '/api/fun/joke',
  funmeme: '/api/fun/meme',
  roast: '/api/fun/roast',
  insult: '/api/fun/insult',
  compliment: '/api/fun/compliment',
  flirt: '/api/fun/flirt',
  weather: '/api/tools/weather',
  define: '/api/tools/define',
  wiki: '/api/tools/wiki',
  currency: '/api/tools/currency',
  shorturl: '/api/tools/shorturl',
  npm: '/api/tools/npm',
  country: '/api/tools/country',
  time: '/api/tools/time',
  calc: '/api/tools/calc',
  translate: '/api/tools/translate',
  quran: '/api/religion/quran',
  bible: '/api/religion/bible',
  trivia: '/api/game/trivia',
  truth: '/api/game/truth',
  dare: '/api/game/dare',
  riddle: '/api/game/riddle',
};

const DEFAULT_PARAM = {
  '/api/download': 'url',
  '/api/download/ytaudio': 'url',
  '/api/ytmp3': 'query',
  '/api/download/ytmp4': 'url',
  '/api/ytmp4': 'query',
  '/api/spotify': 'url',
  '/api/download/tiktok': 'url',
  '/api/download/instagram': 'url',
  '/api/download/facebook': 'url',
  '/api/download/twitter': 'url',
  '/api/download/pinterest': 'url',
  '/api/download/tiktokdl': 'url',
  '/api/download/instagramdl': 'url',
  '/api/download/spotify': 'url',
  '/api/download/ytsearch': 'query',
  '/api/stalk/tiktok': 'username',
  '/api/stalk/instagram': 'username',
  '/api/stalk/github': 'username',
  '/api/ai/chat': 'q',
  '/api/ai/gpt': 'q',
  '/api/ai/gemini': 'q',
  '/api/ai/mistral': 'q',
  '/api/ai/image': 'prompt',
  '/api/lyrics': 'query',
  '/api/ssweb': 'url',
  '/api/tts': 'text',
  '/api/qr': 'text',
  '/api/gif': 'type',
  '/api/tools/nsfw': 'url',
  '/api/tools/upload': 'url',
  '/api/tools/weather': 'city',
  '/api/tools/define': 'word',
  '/api/tools/wiki': 'q',
  '/api/tools/npm': 'q',
  '/api/tools/country': 'name',
  '/api/tools/shorturl': 'url',
  '/api/tools/calc': 'expr',
  '/api/tools/translate': 'text',
  '/api/tools/time': 'tz',
  '/api/religion/quran': 'ayah',
  '/api/religion/bible': 'ref',
  '/api/game/trivia': 'difficulty',
  '/api/anime/char-quotes': 'character',
  '/api/anime/show-quotes': 'show',
};

const ROUTE_DEFAULTS = {
  '/api/download': { type: 'mp4' },
  '/api/download/ytaudio': { format: '128kbps' },
  '/api/download/ytmp4': { format: '480p' },
  '/api/tts': { lang: 'en' },
  '/api/tools/translate': { to: 'en' },
  '/api/img/blur': { level: '12' },
  '/api/img/pixelate': { size: '16' },
  '/api/img/circle': { size: '512' },
  '/api/img/upscale': { scale: '2' },
  '/api/img/ascii': { width: '80' },
  '/api/img/colors': { count: '6' },
  '/api/game/trivia': { difficulty: 'easy' },
};

const IMAGE_EFFECTS = {
  blur: { path: '/api/img/blur', defaults: { level: '12' } },
  pixelate: { path: '/api/img/pixelate', defaults: { size: '16' } },
  grayscale: { path: '/api/img/grayscale', defaults: {} },
  circle: { path: '/api/img/circle', defaults: { size: '512' } },
  upscale: { path: '/api/img/upscale', defaults: { scale: '2' } },
  meme: { path: '/api/img/meme', defaults: {} },
  ascii: { path: '/api/img/ascii', defaults: { width: '80' } },
  colors: { path: '/api/img/colors', defaults: { count: '6' } },
  removebg: { path: '/api/img/removebg', defaults: {} },
};

function parseParams(rawInput, defaultKey) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return {};
  const matches = [...trimmed.matchAll(/(?:^|\s)([a-zA-Z][\w-]*)=/g)];
  if (!matches.length) {
    return defaultKey ? { [defaultKey]: trimmed } : {};
  }
  const params = {};
  matches.forEach((match, idx) => {
    if (match[1].toLowerCase() === 'apikey') return;
    const start = match.index + match[0].length;
    const end = matches[idx + 1]?.index ?? trimmed.length;
    const value = trimmed.slice(start, end).trim();
    if (value) params[match[1]] = value;
  });
  return params;
}

function parseJson(buffer) {
  try {
    return JSON.parse(Buffer.from(buffer).toString('utf8'));
  } catch {
    return null;
  }
}

function pickText(payload) {
  if (typeof payload === 'string' || typeof payload === 'number' || typeof payload === 'boolean') {
    return String(payload);
  }
  if (!payload || typeof payload !== 'object') return '';
  const keys = [
    'text',
    'response',
    'reply',
    'answer',
    'message',
    'translation',
    'translatedText',
    'definition',
    'meaning',
    'summary',
    'joke',
    'quote',
    'lyrics',
    'description',
    'title',
    'name',
  ];
  for (const key of keys) {
    if (typeof payload[key] === 'string' && payload[key].trim()) {
      return payload[key].trim();
    }
  }
  return JSON.stringify(payload, null, 2);
}

async function sendApiResult(sock, from, msg, route, params, label) {
  const res = await requestRaw(route, params, {
    timeout: 22_000,
    maxContentLength: 18 * 1024 * 1024,
  });
  const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
  const quoted = msg ? { quoted: msg } : undefined;
  const buf = Buffer.from(res.data);

  if (contentType.startsWith('image/')) {
    return sock.sendMessage(from, { image: buf, mimetype: contentType.split(';')[0] }, quoted);
  }
  if (contentType.startsWith('audio/')) {
    return sock.sendMessage(from, { audio: buf, mimetype: contentType.split(';')[0] }, quoted);
  }
  if (contentType.startsWith('video/')) {
    return sock.sendMessage(from, { video: buf, mimetype: contentType.split(';')[0] }, quoted);
  }

  const parsed = parseJson(buf);
  if (!parsed || parsed.success !== true) {
    throw new Error(parsed?.error || parsed?.message || 'Unreadable API response.');
  }

  const result = parsed.result;
  const mediaUrl = extractDownload(result);
  if (mediaUrl) {
    const cleanUrl = mediaUrl.toLowerCase().split('?')[0];
    const title = extractTitle(result, label);
    if (
      /\.(mp3|m4a|ogg|wav|opus)$/.test(cleanUrl) ||
      /(?:ytaudio|ytmp3|spotify|\/api\/tts)/.test(route)
    ) {
      return sock.sendMessage(
        from,
        {
          audio: { url: mediaUrl },
          mimetype: 'audio/mpeg',
          fileName: `${title.replace(/[^\w\s.-]/g, '')}.mp3`,
        },
        quoted,
      );
    }
    if (
      /\.(mp4|webm|mov)$/.test(cleanUrl) ||
      /(?:\/api\/download|ytmp4|\/api\/gif)/.test(route)
    ) {
      return sock.sendMessage(
        from,
        { video: { url: mediaUrl }, mimetype: 'video/mp4', caption: title },
        quoted,
      );
    }
    if (
      /\.(png|jpe?g|webp|gif)$/.test(cleanUrl) ||
      /(?:\/api\/img\/|\/api\/card\/|\/api\/anime\/|\/api\/fake\/|\/api\/ssweb|\/api\/ai\/image)/.test(
        route,
      )
    ) {
      return sock.sendMessage(from, { image: { url: mediaUrl }, caption: title }, quoted);
    }
  }

  const textOut = pickText(result).slice(0, 3500) || 'No content returned.';
  return sock.sendMessage(from, { text: `*KnightBotAPI · ${label}*\n\n${textOut}` }, quoted);
}

async function tryPlatformFallback({ sock, from, url, type, msg, config }) {
  const quoted = msg ? { quoted: msg } : undefined;
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  try {
    if (type === 'mp3' && /(^|\.)spotify\.com$/.test(hostname)) {
      const sp = await spotifySearch(url);
      if (sp?.success && sp.data?.audio) {
        const track = sp.data;
        if (track.thumbnail) {
          await sock.sendMessage(
            from,
            { image: { url: track.thumbnail }, caption: `${track.title} · ${track.artist}` },
            quoted,
          );
        }
        await sock.sendMessage(
          from,
          {
            audio: { url: track.audio },
            mimetype: 'audio/mpeg',
            fileName: `${String(track.title || 'song').replace(/[^\w\s.-]/g, '')}.mp3`,
            ptt: false,
          },
          quoted,
        );
        return true;
      }
    }

    if (type === 'mp3' && /(^|\.)((youtube\.com)|(youtu\.be))$/.test(hostname)) {
      const { commands: playCommands = [] } = await import('./Play.js');
      const playCmd = playCommands.find((cmd) => cmd.name === 'play');
      if (playCmd) {
        await playCmd.execute({
          sock,
          from,
          msg,
          text: url,
          args: [url],
          config,
          global: globalThis,
        });
        return true;
      }
    }

    if (type === 'mp4' && /(^|\.)((youtube\.com)|(youtu\.be))$/.test(hostname)) {
      const yt = await videoDownload(url);
      if (yt?.success && yt.links?.high) {
        await sock.sendMessage(
          from,
          {
            video: { url: yt.links.high },
            mimetype: 'video/mp4',
            caption: yt.title || 'Downloaded video',
          },
          quoted,
        );
        return true;
      }
    }

    if (type === 'mp4' && /(^|\.)((tiktok\.com)|(vm\.tiktok\.com))$/.test(hostname)) {
      const tt = await getTikTokMedia(url);
      if (tt?.success && tt.video) {
        await sock.sendMessage(
          from,
          {
            video: { url: tt.video },
            mimetype: 'video/mp4',
            caption: tt.title || 'TikTok video',
          },
          quoted,
        );
        return true;
      }
    }

    if (type === 'mp4' && /(^|\.)instagram\.com$/.test(hostname)) {
      const ig = await getInstaMedia(url);
      if (!ig?.error && Array.isArray(ig?.data) && ig.data.length) {
        for (const item of ig.data.slice(0, 10)) {
          if (item.type === 'video') {
            await sock.sendMessage(from, { video: { url: item.url }, mimetype: 'video/mp4' }, quoted);
          } else {
            await sock.sendMessage(from, { image: { url: item.url } }, quoted);
          }
        }
        return true;
      }
    }

    if (type === 'mp4' && (/(^|\.)facebook\.com$/.test(hostname) || hostname === 'fb.watch')) {
      const fb = await facebookDownload(url);
      if (fb?.hd) {
        if (fb.thumbnail) {
          await sock.sendMessage(
            from,
            { image: { url: fb.thumbnail }, caption: fb.title || 'Facebook video' },
            quoted,
          );
        }
        await sock.sendMessage(
          from,
          { video: { url: fb.hd }, mimetype: 'video/mp4', caption: 'Downloaded video' },
          quoted,
        );
        return true;
      }
    }
  } catch (err) {
    console.warn('KnightBotAPI platform fallback:', summarizeError(err));
  }

  return false;
}

async function universalDownload({ sock, from, text, msg, config }) {
  const input = String(text || '').trim();
  const quoted = msg ? { quoted: msg } : undefined;
  if (!input) {
    return sock.sendMessage(
      from,
      { text: 'Usage: *.download <public URL> [mp3|mp4]*\nExample: .download https://youtu.be/... mp3' },
      quoted,
    );
  }

  const parts = input.split(/\s+/);
  const last = parts.at(-1).toLowerCase();
  const type = ['mp3', 'audio'].includes(last) ? 'mp3' : 'mp4';
  const targetUrl = ['mp3', 'audio', 'mp4', 'video'].includes(last)
    ? parts.slice(0, -1).join(' ')
    : input;

  if (!isHttpUrl(targetUrl)) {
    return sock.sendMessage(
      from,
      { text: 'Please provide a valid public http/https URL.' },
      quoted,
    );
  }

  try {
    const res = await requestJson('/api/download', { url: targetUrl, type }, { timeout: 22_000 });
    const result = res.result || {};
    const mediaUrl = extractDownload(result);
    if (!mediaUrl) throw new Error('The API did not return a media URL.');
    const title = extractTitle(result, 'Downloaded media');

    if (type === 'mp3') {
      await sock.sendMessage(
        from,
        {
          audio: { url: mediaUrl },
          mimetype: 'audio/mpeg',
          fileName: `${title.replace(/[^\w\s.-]/g, '')}.mp3`,
          ptt: false,
        },
        quoted,
      );
    } else {
      await sock.sendMessage(
        from,
        { video: { url: mediaUrl }, mimetype: 'video/mp4', caption: title },
        quoted,
      );
    }
  } catch (err) {
    console.error('KnightBotAPI universal download:', summarizeError(err));
    if (await tryPlatformFallback({ sock, from, url: targetUrl, type, msg, config })) {
      return;
    }
    await sock.sendMessage(
      from,
      {
        text: `KnightBotAPI could not fetch that URL (${summarizeError(err)}). Try the platform-specific command if available.`,
      },
      quoted,
    );
  }
}

async function imageEffect({ sock, from, text, msg }) {
  const match = String(text || '').trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const effectName = match?.[1]?.toLowerCase();
  const effect = IMAGE_EFFECTS[effectName];
  const quoted = msg ? { quoted: msg } : undefined;

  if (!effect) {
    return sock.sendMessage(
      from,
      {
        text: `Choose an image effect: ${Object.keys(IMAGE_EFFECTS).join(', ')}\nUsage: *.imgfx blur https://example.com/image.jpg level=20*`,
      },
      quoted,
    );
  }

  const rest = String(match?.[2] || '').trim();
  const urlMatch = rest.match(/https?:\/\/\S+/i);
  if (!urlMatch) {
    return sock.sendMessage(
      from,
      {
        text: 'Provide a publicly accessible image URL. Local sticker/audio/video conversions remain available through the existing converter commands.',
      },
      quoted,
    );
  }

  const imageUrl = urlMatch[0].replace(/[),]+$/, '');
  const extraRaw = rest.replace(urlMatch[0], '').trim();
  const params = { ...effect.defaults, ...parseParams(extraRaw, null), url: imageUrl };

  try {
    const res = await requestRaw(effect.path, params, {
      timeout: 35_000,
      maxContentLength: 20 * 1024 * 1024,
    });
    const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
    if (contentType.startsWith('image/')) {
      return sock.sendMessage(
        from,
        {
          image: Buffer.from(res.data),
          mimetype: contentType.split(';')[0],
          caption: `KnightBotAPI · ${effectName}`,
        },
        quoted,
      );
    }

    const parsed = parseJson(res.data);
    if (!parsed?.success) {
      throw new Error(parsed?.error || parsed?.message || 'The image effect did not return an image.');
    }
    const resultUrl = extractDownload(parsed.result);
    if (resultUrl) {
      return sock.sendMessage(
        from,
        { image: { url: resultUrl }, caption: `KnightBotAPI · ${effectName}` },
        quoted,
      );
    }
    return sock.sendMessage(
      from,
      { text: `*KnightBotAPI · ${effectName}*\n\n${pickText(parsed.result).slice(0, 2500)}` },
      quoted,
    );
  } catch (err) {
    console.error('KnightBotAPI image effect:', summarizeError(err));
    return sock.sendMessage(
      from,
      { text: `Image effect unavailable: ${summarizeError(err)}` },
      quoted,
    );
  }
}

async function callRoute({ sock, from, text, msg }) {
  const match = String(text || '').trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const quoted = msg ? { quoted: msg } : undefined;
  if (!match) {
    return sock.sendMessage(
      from,
      {
        text: [
          '*KnightBotAPI route command*',
          'Usage: *.kapi <route> <key=value ...>*',
          'Examples:',
          '• .kapi ai/chat q=Explain gravity simply',
          '• .kapi tools/weather city=Nairobi',
          '• .kapi anime/waifu',
          '• .kapi img/blur url=https://example.com/image.jpg level=20',
          'All 112 documented routes are allowlisted; parameters: knightbotapi.stream/#/routes',
        ].join('\n'),
      },
      quoted,
    );
  }

  const rawRoute = match[1].replace(/^\/+/, '');
  const normalized = rawRoute.startsWith('api/') ? `/${rawRoute}` : `/api/${rawRoute}`;
  const route = ROUTES.has(normalized) ? normalized : ROUTE_ALIASES[rawRoute.toLowerCase()];

  if (!route || !ROUTES.has(route)) {
    return sock.sendMessage(
      from,
      { text: 'Unknown route. Example: *.kapi tools/weather city=Nairobi*.' },
      quoted,
    );
  }

  const params = {
    ...(ROUTE_DEFAULTS[route] || {}),
    ...parseParams(match[2], DEFAULT_PARAM[route]),
  };

  try {
    await sendApiResult(sock, from, msg, route, params, route.replace(/^\/api\//, ''));
  } catch (err) {
    console.error(`KnightBotAPI ${route}:`, summarizeError(err));
    await sock.sendMessage(
      from,
      { text: `KnightBotAPI route failed: ${summarizeError(err)}.` },
      quoted,
    );
  }
}

export const commands = [
  {
    name: 'download',
    aliases: ['unidownload', 'knightdownload'],
    description: 'Universal KnightBotAPI downloader for supported public URLs. Usage: .download <URL> [mp3|mp4]',
    category: 'Download',
    execute: universalDownload,
  },
  {
    name: 'imgfx',
    aliases: ['imagefx'],
    description: 'Apply a KnightBotAPI image effect to a public image URL.',
    category: 'Converter',
    execute: imageEffect,
  },
  {
    name: 'kapi',
    aliases: ['knightapi', 'knightbotapi'],
    description: 'Call one of the 112 allowlisted KnightBotAPI routes.',
    category: 'General',
    execute: callRoute,
  },
];
