import ytSearch from 'yt-search';
import axios from 'axios';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { API_CONFIG, MESSAGES } from '../france/index.js';
import {
  spiderHeader,
  spiderRow,
  spiderDivider,
  spiderFooter,
} from '../utils/tableStyle.js';

const requireFromPlay = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const MAX_SOURCE_BYTES = 80 * 1024 * 1024;
const MAX_WHATSAPP_AUDIO_BYTES = 15 * 1024 * 1024;
const DEFAULT_API_TIMEOUT_MS = 20_000;
const MAX_API_TIMEOUT_MS = 30_000;
const PLAY_DOWNLOAD_TIMEOUT_MS = 45_000;
const FALLBACK_DOWNLOAD_TIMEOUT_MS = 20_000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function getOptionalFfmpegStatic() {
  for (const pkg of ['ffmpeg-static', '@ffmpeg-installer/ffmpeg']) {
    try {
      const mod = requireFromPlay(pkg);
      const binPath = typeof mod === 'string' ? mod : mod?.path || mod?.default;
      if (binPath && typeof binPath === 'string') return binPath;
    } catch {
      // Optional dependency may not be installed
    }
  }
  return null;
}

const OPTIONAL_FFMPEG_BIN = getOptionalFfmpegStatic();

function findFfmpegPath() {
  const candidates = [
    process.env.FFMPEG_PATH,
    OPTIONAL_FFMPEG_BIN,
    'ffmpeg',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/data/data/com.termux/files/usr/bin/ffmpeg',
    process.platform === 'win32' ? 'ffmpeg.exe' : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const check = spawnSync(candidate, ['-version'], { stdio: 'ignore' });
      if (!check.error && check.status === 0) return candidate;
    } catch {
      // Try next candidate
    }
  }

  if (process.platform === 'win32') {
    try {
      const whereRes = spawnSync('where', ['ffmpeg'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const firstLine = String(whereRes?.stdout || '').split(/\r?\n/)[0]?.trim();
      if (firstLine) return firstLine;
    } catch {
      // Ignore Windows lookup error
    }
  }
  return null;
}

const FFMPEG_PATH = findFfmpegPath();

function safeFileName(name) {
  return (
    String(name || 'song')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 96) || 'song'
  );
}

function safeDisplay(value, fallback = 'N/A') {
  return (
    String(value || fallback)
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 160) || fallback
  );
}

function safeErrorSummary(err) {
  const parts = Array.isArray(err?.errors) && err.errors.length ? err.errors : [err];
  return parts
    .map((item) => String(item?.stderr || item?.message || 'Unknown error'))
    .join(' | ')
    .replace(/https?:\/\/[^\s"')]+/gi, '[URL]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function playResponse(botName, title, rows, footer = 'SPIDER MAN // AUDIO') {
  const lines = [spiderHeader(botName, title)];
  rows.forEach((row, index) => {
    if (index > 0) lines.push(spiderDivider());
    lines.push(spiderRow(row.label, row.value, row.marker || '◈'));
  });
  lines.push(spiderFooter(footer));
  return lines.join('\n');
}

export function extractYouTubeId(input) {
  const match = String(input || '').match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/|live\/))([A-Za-z0-9_-]{11})/i,
  );
  return match ? match[1] : null;
}

function extensionFromMime(mime) {
  const normalized = String(mime || '').toLowerCase();
  if (normalized.includes('mpeg') || normalized.includes('audio/mp3')) return 'mp3';
  if (normalized.includes('opus') || normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('mp4') || normalized.includes('m4a')) return 'm4a';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('aac')) return 'aac';
  if (normalized.includes('webm')) return 'webm';
  return '';
}

function extensionFrom(source, contentType) {
  const mimeType = String(contentType || '').split(';')[0].toLowerCase();
  let ext = '';
  if (typeof source === 'string') {
    if (source.startsWith('data:')) {
      const match = source.match(/^data:([^;,]+)/i);
      if (match?.[1]) return extensionFromMime(match[1]);
    }
    try {
      ext = path.extname(new URL(source).pathname).slice(1).toLowerCase();
    } catch {
      ext = path.extname(source).slice(1).toLowerCase();
    }
  }
  if (['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'webm', 'mp4'].includes(ext)) {
    return ext;
  }
  return extensionFromMime(mimeType) || 'bin';
}

function resolveCandidateValue(item) {
  if (typeof item === 'string' && item.trim()) return item.trim();
  if (item && typeof item === 'object') {
    const nested = item.url || item.downloadUrl || item.download_url || item.link;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
    if (Buffer.isBuffer(item.data) || item.data instanceof Uint8Array) return item.data;
    if (typeof item.base64 === 'string' && item.base64.trim()) {
      return `data:audio/mpeg;base64,${item.base64.trim()}`;
    }
  }
  return null;
}

export function extractAudioCandidates(payload, { allowVideoFallback = false } = {}) {
  const candidates = [];
  const seen = new Set();

  const pushCandidate = (raw, kind = 'audio') => {
    if (Array.isArray(raw)) {
      for (const entry of raw) pushCandidate(entry, kind);
      return;
    }
    const resolved = resolveCandidateValue(raw);
    if (!resolved) return;
    const dedupeKey = typeof resolved === 'string' ? resolved : `buf:${resolved.length}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    candidates.push({ source: resolved, kind });
  };

  const audioFields = [
    payload?.audio,
    payload?.audioUrl,
    payload?.audio_url,
    payload?.downloadLink,
    payload?.downloadUrl,
    payload?.download_url,
    payload?.mp3,
    payload?.music,
    payload?.url,
    payload?.link,
    payload?.download,
  ];
  for (const field of audioFields) pushCandidate(field, 'audio');

  if (allowVideoFallback) {
    const videoFields = [
      payload?.video,
      payload?.videoUrl,
      payload?.video_url,
      payload?.video_hd,
      payload?.high,
      payload?.hd,
      payload?.sd,
      payload?.low,
    ];
    for (const field of videoFields) pushCandidate(field, 'video');
  }

  return candidates;
}

function isInvalidMediaPayload(buffer, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (
    ct.includes('text/html') ||
    ct.includes('application/xhtml') ||
    ct.includes('application/json') ||
    ct.includes('application/xml') ||
    ct.includes('text/xml') ||
    ct.includes('text/plain')
  ) {
    return true;
  }

  const head = buffer.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<body') ||
    head.startsWith('<?xml') ||
    (head.startsWith('{') && /"(error|status|success|message|code)"\s*:/.test(head))
  ) {
    return true;
  }

  return false;
}

function looksLikeMp3Buffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true; // ID3
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
  return false;
}

async function loadAudio(source, httpGet, timeoutMs) {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    const buffer = Buffer.from(source);
    if (!buffer.length) throw new Error('Audio buffer is empty.');
    return { buffer, contentType: 'audio/mpeg', source };
  }

  if (typeof source !== 'string') {
    throw new Error('Audio source is not a supported URL or buffer.');
  }

  const dataUriMatch = source.match(/^data:([^;,]+)?;base64,(.+)$/i);
  if (dataUriMatch) {
    const buffer = Buffer.from(dataUriMatch[2], 'base64');
    if (!buffer.length) throw new Error('Base64 audio payload is empty.');
    return {
      buffer,
      contentType: dataUriMatch[1] || 'audio/mpeg',
      source,
    };
  }

  if (/^https?:\/\//i.test(source)) {
    const res = await httpGet(source, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      maxContentLength: MAX_SOURCE_BYTES,
      maxBodyLength: MAX_SOURCE_BYTES,
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
    });
    if (res?.status >= 400) {
      throw new Error(`Audio download returned HTTP ${res.status}`);
    }
    const contentType = String(res?.headers?.['content-type'] || '');
    const buffer = Buffer.from(res?.data || []);
    if (!buffer.length) {
      throw new Error('Downloaded audio response was empty.');
    }
    if (isInvalidMediaPayload(buffer, contentType)) {
      throw new Error(`Downloaded non-audio payload (${contentType || 'markup'})`);
    }
    return { buffer, contentType, source };
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(source) && source.length > 256) {
    return {
      buffer: Buffer.from(source, 'base64'),
      contentType: 'audio/mpeg',
      source,
    };
  }

  throw new Error('Audio download link was not valid.');
}

async function loadFromCandidates(candidates, httpGet, defaultTimeoutMs) {
  let lastError = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const hasMore = i < candidates.length - 1;
    const timeoutMs = hasMore
      ? Math.min(defaultTimeoutMs, FALLBACK_DOWNLOAD_TIMEOUT_MS)
      : defaultTimeoutMs;
    try {
      const loaded = await loadAudio(candidate.source, httpGet, timeoutMs);
      return { ...loaded, candidateKind: candidate.kind };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('No downloadable audio source returned.');
}

async function resolveYtDlpRunner(overrides = {}) {
  if (overrides.ytDlp) {
    const custom = overrides.ytDlp;
    const execFn = typeof custom.exec === 'function' ? custom.exec.bind(custom) : custom;
    if (typeof execFn === 'function') return { execFn, isCustom: true };
  }

  try {
    const mod = await import('youtube-dl-exec');
    const ytDlpMod = mod.default || mod;
    const binPath = ytDlpMod?.constants?.YOUTUBE_DL_PATH;
    if (binPath && fs.existsSync(binPath)) {
      const execFn = typeof ytDlpMod.exec === 'function' ? ytDlpMod.exec.bind(ytDlpMod) : ytDlpMod;
      if (typeof execFn === 'function') return { execFn, isCustom: false };
    }
  } catch {
    // Optional youtube-dl-exec unavailable
  }

  const binCandidates = [
    process.env.YTDLP_PATH,
    'yt-dlp',
    '/usr/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/data/data/com.termux/files/usr/bin/yt-dlp',
  ].filter(Boolean);

  for (const bin of binCandidates) {
    try {
      const check = spawnSync(bin, ['--version'], { stdio: 'ignore' });
      if (!check.error && check.status === 0) {
        const mod = await import('youtube-dl-exec').catch(() => null);
        const createFn = mod?.create || mod?.default?.create;
        if (typeof createFn === 'function') {
          const created = createFn(bin);
          const execFn = typeof created.exec === 'function' ? created.exec.bind(created) : created;
          if (typeof execFn === 'function') return { execFn, isCustom: false };
        }
      }
    } catch {
      // Try next binary
    }
  }

  return null;
}

async function downloadWithYtDlp(videoUrl, tmpDir, overrides = {}, ffmpegPath = null) {
  if (typeof overrides.downloadWithYtDlp === 'function') {
    return overrides.downloadWithYtDlp(videoUrl, tmpDir, overrides);
  }

  const runner = await resolveYtDlpRunner(overrides);
  if (!runner) {
    throw new Error('Local audio downloader is unavailable.');
  }

  const outputTemplate = path.join(tmpDir, 'yt-dlp-source.%(ext)s');
  const baseFlags = {
    format: 'bestaudio/best',
    output: outputTemplate,
    noPlaylist: true,
    noWarnings: true,
    noProgress: true,
    restrictFilenames: true,
  };
  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    baseFlags.ffmpegLocation = ffmpegPath;
  }

  const flagVariants = [
    { ...baseFlags, extractorArgs: 'youtube:player_client=android,ios,web' },
    { ...baseFlags, jsRuntimes: 'node' },
    baseFlags,
  ];

  let lastErr = null;
  for (const flags of flagVariants) {
    try {
      await runner.execFn(videoUrl, flags, {
        timeout: PLAY_DOWNLOAD_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      });
      const files = fs.readdirSync(tmpDir);
      const found = files.find(
        (file) => file.startsWith('yt-dlp-source.') && !file.endsWith('.part'),
      );
      if (found) return path.join(tmpDir, found);
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('Local audio downloader produced no file.');
}

async function transcodeToMp3(inputPath, outputPath, ffmpegPath, execFileFn) {
  await execFileFn(
    ffmpegPath,
    ['-y', '-i', inputPath, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-f', 'mp3', outputPath],
    { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
  );
}

function parseDurationSeconds(timestamp) {
  const parts = String(timestamp || '')
    .split(':')
    .map((n) => Number(n));
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  return parts.reduce((acc, val) => acc * 60 + val, 0);
}

export async function runPlay({ sock, from, text, msg, config }, overrides = {}) {
  const botName = config?.BOT_NAME || 'Spider Man';
  const ownerName = config?.OWNER_NAME || 'LilTech';
  const playMsgs = MESSAGES?.play || {};
  const trimmedQuery = String(text || '').trim();

  const search = overrides.search || ytSearch;
  const httpClient = overrides.http || axios;
  const httpGet = httpClient.get.bind(httpClient);
  const apiConfig = overrides.apiConfig || API_CONFIG;
  const ffmpegPath = Object.hasOwn(overrides, 'ffmpegPath')
    ? overrides.ffmpegPath
    : FFMPEG_PATH;
  const execFileFn = overrides.execFile || execFileAsync;

  const rawConfiguredTimeout = Number(apiConfig?.nayanApi?.timeout);
  const apiTimeoutMs =
    Number.isFinite(rawConfiguredTimeout) && rawConfiguredTimeout > 0
      ? Math.min(rawConfiguredTimeout, MAX_API_TIMEOUT_MS)
      : DEFAULT_API_TIMEOUT_MS;
  const downloadTimeoutMs = PLAY_DOWNLOAD_TIMEOUT_MS;

  let tmpDir;

  if (!trimmedQuery) {
    return sock.sendMessage(
      from,
      {
        text: playResponse(
          botName,
          'MUSIC PLAYER',
          [
            {
              label: 'REQUEST',
              value: playMsgs.noQuery || 'Send a song title or YouTube link.',
              marker: '⚠️',
            },
            { label: 'EXAMPLE', value: '.play song name', marker: '›' },
          ],
          'SPIDER MAN // READY',
        ),
      },
      { quoted: msg },
    );
  }

  const requestStartedAt = Date.now();
  console.log(`[PLAY] received query="${trimmedQuery.slice(0, 120)}"`);

  try {
    await sock.sendMessage(
      from,
      {
        text: playResponse(
          botName,
          'MUSIC SEARCH',
          [
            { label: 'STATUS', value: 'Searching for your song…', marker: '🔎' },
            { label: 'QUERY', value: trimmedQuery, marker: '›' },
          ],
          'SPIDER MAN // AUDIO',
        ),
      },
      { quoted: msg },
    );

    const directVideoId = extractYouTubeId(trimmedQuery);
    let searchResult = null;
    try {
      searchResult = await search(trimmedQuery);
    } catch (searchErr) {
      if (!directVideoId) throw searchErr;
    }

    const searchVideos = Array.isArray(searchResult?.videos) ? searchResult.videos : [];
    let primaryVideo = searchVideos[0] || null;
    if (!primaryVideo && directVideoId) {
      primaryVideo = {
        videoId: directVideoId,
        url: `https://www.youtube.com/watch?v=${directVideoId}`,
        title: trimmedQuery,
        author: { name: 'YouTube' },
        timestamp: 'N/A',
        thumbnail: `https://i.ytimg.com/vi/${directVideoId}/hqdefault.jpg`,
      };
    }

    if (!primaryVideo) {
      return sock.sendMessage(
        from,
        {
          text: playResponse(
            botName,
            'MUSIC SEARCH',
            [
              {
                label: 'STATUS',
                value: playMsgs.noResults || 'No matching song was found.',
                marker: '❌',
              },
              {
                label: 'NEXT STEP',
                value: 'Try a different title or YouTube link.',
                marker: '›',
              },
            ],
            'SPIDER MAN // AUDIO',
          ),
        },
        { quoted: msg },
      );
    }

    const videoUrl =
      primaryVideo.url || `https://www.youtube.com/watch?v=${primaryVideo.videoId}`;
    const displayTitle = safeDisplay(primaryVideo.title || trimmedQuery, 'Unknown song');
    const displayChannel = safeDisplay(primaryVideo.author?.name, 'Unknown');
    const displayDuration = safeDisplay(primaryVideo.timestamp, 'N/A');
    const thumbUrl =
      primaryVideo.thumbnail ||
      (primaryVideo.videoId
        ? `https://i.ytimg.com/vi/${primaryVideo.videoId}/hqdefault.jpg`
        : '') ||
      config?.BOT_PIC ||
      '';

    const previewCaption = playResponse(
      botName,
      'MUSIC PLAYER',
      [
        { label: 'TITLE', value: displayTitle, marker: '🎵' },
        { label: 'CHANNEL', value: displayChannel, marker: '👤' },
        { label: 'DURATION', value: displayDuration, marker: '⏱️' },
        { label: 'AUDIO', value: 'MP3 · 128 kbps', marker: '🔊' },
        { label: 'STATUS', value: 'Preparing the audio…', marker: '⏳' },
      ],
      `POWERED BY ${ownerName}`,
    );

    try {
      if (thumbUrl) {
        await sock.sendMessage(
          from,
          { image: { url: thumbUrl }, caption: previewCaption },
          { quoted: msg },
        );
      } else {
        await sock.sendMessage(from, { text: previewCaption }, { quoted: msg });
      }
    } catch (previewErr) {
      console.warn('[PLAY] Preview send failed:', previewErr.message);
      try {
        await sock.sendMessage(from, { text: previewCaption }, { quoted: msg });
      } catch {
        // Best-effort preview notification
      }
    }

    const allowVideoFallback = Boolean(ffmpegPath);

    async function fetchFromNayan(targetUrl) {
      const endpoint = apiConfig?.nayanApi?.youtube;
      if (!endpoint) throw new Error('Hosted downloader (nayanApi) is not configured.');
      const requestUrl = new URL(endpoint);
      requestUrl.searchParams.set('url', targetUrl);

      const response = await httpGet(requestUrl.toString(), {
        timeout: apiTimeoutMs,
        maxContentLength: 4 * 1024 * 1024,
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
      });
      const body = response.data;
      const payload = body?.data?.data || body?.data || body?.result || body || {};
      if (body?.status === false || body?.success === false) {
        throw new Error('nayanApi: returned unsuccessful status.');
      }
      const candidates = extractAudioCandidates(payload, { allowVideoFallback });
      if (!candidates.length) {
        throw new Error('nayanApi: no audio returned.');
      }
      const loaded = await loadFromCandidates(candidates, httpGet, downloadTimeoutMs);
      return { ...loaded, payload, via: 'nayanApi' };
    }

    async function fetchFromNoobs(targetVideoId) {
      if (!targetVideoId) throw new Error('noobsApi: no video id to look up.');
      const base = apiConfig?.noobsApi || 'https://noobs-api.top';
      const requestUrl = new URL('/dipto/ytDl3', base);
      requestUrl.searchParams.set('link', targetVideoId);
      requestUrl.searchParams.set('format', 'mp3');

      const response = await httpGet(requestUrl.toString(), {
        timeout: apiTimeoutMs,
        maxContentLength: 4 * 1024 * 1024,
        headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'application/json' },
      });
      const body = response.data;
      const candidates = extractAudioCandidates(body || {}, { allowVideoFallback });
      if (!candidates.length) {
        throw new Error('noobsApi: no download link returned.');
      }
      const loaded = await loadFromCandidates(candidates, httpGet, downloadTimeoutMs);
      return { ...loaded, payload: { title: body?.title }, via: 'noobsApi' };
    }

    async function fetchFromNexray(targetUrl) {
      const requestUrl = new URL('https://api.nexray.web.id/downloader/ytmp3');
      requestUrl.searchParams.set('url', targetUrl);

      const response = await httpGet(requestUrl.toString(), {
        timeout: Math.min(apiTimeoutMs, 12_000),
        maxContentLength: 4 * 1024 * 1024,
        headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'application/json' },
      });
      const body = response.data;
      if (body?.status === false) {
        throw new Error('nexray: unavailable.');
      }
      const payload = body?.result || body?.data || body || {};
      const candidates = extractAudioCandidates(payload, { allowVideoFallback });
      if (!candidates.length) {
        throw new Error('nexray: no audio returned.');
      }
      const loaded = await loadFromCandidates(candidates, httpGet, downloadTimeoutMs);
      return { ...loaded, payload, via: 'nexray' };
    }

    const fetchStartedAt = Date.now();
    let payloadMeta = {};
    let resolvedDownload = null;
    let primaryError = null;

    // Tier 1: Primary hosted providers (nayanApi + noobsApi)
    try {
      const firstHit = await Promise.any([
        fetchFromNayan(videoUrl),
        fetchFromNoobs(primaryVideo.videoId),
      ]);
      resolvedDownload = firstHit;
      payloadMeta = firstHit.payload || {};
      console.log(`[PLAY] audio source=${firstHit.via} elapsedMs=${Date.now() - fetchStartedAt}`);
    } catch (err) {
      primaryError = err;
      const errors = (err?.errors || [err]).map((e) => safeErrorSummary(e));
      console.warn('[PLAY] Primary hosted audio sources failed:', errors.join(' | '));
    }

    // Tier 2: Secondary hosted fallbacks (custom overrides, nexray, or alternate search match)
    if (!resolvedDownload?.buffer?.length) {
      const secondaryJobs = [];

      if (Array.isArray(overrides.fallbackSources)) {
        for (const fn of overrides.fallbackSources) {
          if (typeof fn === 'function') secondaryJobs.push(fn(videoUrl, primaryVideo));
        }
      }

      if (!overrides.skipBuiltinFallbacks) {
        secondaryJobs.push(fetchFromNexray(videoUrl));
        // Retry nayanApi once in case of transient edge error
        secondaryJobs.push(fetchFromNayan(videoUrl));

        // If user searched by title (not direct URL), try alternate search matches (<= 15m)
        if (!directVideoId && searchVideos.length > 1) {
          const altVideos = searchVideos
            .slice(1, 3)
            .filter((v) => {
              const secs = parseDurationSeconds(v?.timestamp);
              return (v?.url || v?.videoId) && (secs === 0 || secs <= 900);
            });
          for (const alt of altVideos) {
            const altUrl = alt.url || `https://www.youtube.com/watch?v=${alt.videoId}`;
            secondaryJobs.push(fetchFromNayan(altUrl));
          }
        }
      }

      if (secondaryJobs.length) {
        try {
          const fallbackHit = await Promise.any(secondaryJobs);
          resolvedDownload = fallbackHit;
          payloadMeta = fallbackHit.payload || {};
          console.log(
            `[PLAY] audio fallback source=${fallbackHit.via || 'secondary'} elapsedMs=${Date.now() - fetchStartedAt}`,
          );
        } catch (fallbackErr) {
          const errors = (fallbackErr?.errors || [fallbackErr]).map((e) => safeErrorSummary(e));
          console.warn('[PLAY] Secondary hosted audio fallbacks failed:', errors.join(' | '));
        }
      }
    }

    let rawBuffer;
    let sourceRef;
    let contentType = '';
    let localFile = null;

    if (resolvedDownload?.buffer?.length) {
      rawBuffer = resolvedDownload.buffer;
      sourceRef = resolvedDownload.source;
      contentType = resolvedDownload.contentType || '';
    } else {
      // Tier 3: Silent local yt-dlp fallback ONLY when a local yt-dlp runner is available
      const hasCustomLocal =
        typeof overrides.downloadWithYtDlp === 'function' || Boolean(overrides.ytDlp);
      const localRunner = hasCustomLocal ? true : Boolean(await resolveYtDlpRunner(overrides));

      if (!localRunner || !ffmpegPath) {
        throw primaryError || new Error('No working audio download source is currently available.');
      }

      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultra-lil-play-'));
      localFile = await downloadWithYtDlp(videoUrl, tmpDir, overrides, ffmpegPath);
      rawBuffer = fs.readFileSync(localFile);
      sourceRef = localFile;
    }

    if (!rawBuffer.length || rawBuffer.length > MAX_SOURCE_BYTES) {
      throw new Error('The downloaded audio is empty or too large.');
    }

    const baseFileName = safeFileName(
      payloadMeta?.title || primaryVideo.title || trimmedQuery,
    );
    const outFileName = `${baseFileName}.mp3`;
    const detectedExt = extensionFrom(sourceRef, contentType);

    if (ffmpegPath) {
      tmpDir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'ultra-lil-play-'));
      const inputPath = localFile || path.join(tmpDir, `source.${detectedExt}`);
      const outputPath = path.join(tmpDir, 'audio.mp3');
      if (!localFile) fs.writeFileSync(inputPath, rawBuffer);
      try {
        await transcodeToMp3(inputPath, outputPath, ffmpegPath, execFileFn);
        rawBuffer = fs.readFileSync(outputPath);
      } catch (transcodeErr) {
        const alreadyMp3 = detectedExt === 'mp3' || looksLikeMp3Buffer(rawBuffer);
        if (!alreadyMp3) throw transcodeErr;
        console.warn('[PLAY] FFmpeg transcode skipped for valid MP3:', transcodeErr.message);
      }
    } else if (detectedExt !== 'mp3' && !looksLikeMp3Buffer(rawBuffer)) {
      throw new Error('MP3 conversion is unavailable on this deployment.');
    }

    if (!rawBuffer.length || rawBuffer.length > MAX_WHATSAPP_AUDIO_BYTES) {
      throw new Error('The finished audio exceeds WhatsApp’s 15 MB audio-message limit.');
    }

    await sock.sendMessage(
      from,
      {
        audio: rawBuffer,
        mimetype: 'audio/mpeg',
        fileName: outFileName,
        ptt: false,
      },
      { quoted: msg },
    );

    console.log(
      `[PLAY] sent title="${safeDisplay(primaryVideo.title || trimmedQuery, trimmedQuery)}" elapsedMs=${Date.now() - requestStartedAt}`,
    );
  } catch (err) {
    const summary = safeErrorSummary(err);
    console.error(
      `[PLAY] Song request failed elapsedMs=${Date.now() - requestStartedAt}:`,
      summary,
    );
    const isTimeout = /timeout|timed out|ETIMEDOUT|ECONNABORTED/i.test(summary);
    const errorValue = isTimeout
      ? playMsgs.timeout || '⏱️ The song service timed out. Please try again.'
      : playMsgs.error || '❌ Could not prepare that song right now. Please try again later.';

    await sock.sendMessage(
      from,
      {
        text: playResponse(
          botName,
          'PLAYBACK STATUS',
          [
            { label: 'ERROR', value: errorValue, marker: '❌' },
            { label: 'NEXT STEP', value: 'Please try again shortly.', marker: '›' },
          ],
          `POWERED BY ${ownerName}`,
        ),
      },
      { quoted: msg },
    );
  } finally {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

export const commands = [
  {
    name: 'play',
    description:
      'Search for a song and send its cover preview plus WhatsApp-playable MP3 audio.',
    category: 'Search',
    execute: runPlay,
  },
];