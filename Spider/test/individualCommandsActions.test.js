import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import axios from 'axios';
import * as baileys from '@whiskeysockets/baileys';
import { Jimp } from 'jimp';
import { Sticker, StickerTypes } from 'wa-sticker-formatter';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

let ffmpegPath = null;
try {
  const pkg = require('@ffmpeg-installer/ffmpeg');
  ffmpegPath = pkg?.path || pkg?.default || pkg || null;
} catch {}
if (!ffmpegPath) {
  try {
    const pkg = require('ffmpeg-static');
    ffmpegPath = typeof pkg === 'string' ? pkg : pkg?.path || pkg?.default || null;
  } catch {}
}

const origFetch = globalThis.fetch;
const origHttpsRequest = https.request;
const origHttpsGet = https.get;
const origHttpRequest = http.request;
const origHttpGet = http.get;
const origAxiosGet = axios.get.bind(axios);
const origAxiosPost = axios.post.bind(axios);
const origAxiosRequest = axios.request.bind(axios);
const origAxiosHead = axios.head?.bind(axios);

const mumaker = require('mumaker');
const origMumakerEphoto = mumaker.ephoto;
const aptoide = require('aptoide_scrapper_fixed');
const origAptoideSearch = aptoide.search;
const origAptoideDownload = aptoide.download;

let reloadCommandsFromDisk;
let loadLegacyCommands;
let config;
let securityStore;
let antiAdUtils;
let antilinkUtils;
let antifloodUtils;
let antiscamUtils;
let sudoStoreUtils;
let translatorUtils;

const commandsMap = new Map();
const aliasesMap = new Map();

let testTmpDir;
let fixtures = {};

function makeHttpMockResponse(statusCode, headersObj, bodyBuf) {
  const res = new PassThrough();
  res.statusCode = statusCode;
  res.statusMessage = statusCode === 200 ? 'OK' : 'Error';
  res.headers = Object.fromEntries(
    Object.entries(headersObj || {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
  res.rawHeaders = [];
  process.nextTick(() => {
    res.end(bodyBuf);
  });
  return res;
}

function buildApiPayloadForUrl(rawUrl) {
  const url = String(rawUrl || '');

  // Encrypted WhatsApp CDN media blobs
  if (url.includes('mmg.whatsapp.net/mock/')) {
    const token = url.split('mmg.whatsapp.net/mock/')[1]?.split(/[?#]/)[0] || '';
    if (token === 'image') return { buf: fixtures.encImage, ct: 'application/octet-stream' };
    if (token === 'video') return { buf: fixtures.encVideo, ct: 'application/octet-stream' };
    if (token === 'audio') return { buf: fixtures.encAudio, ct: 'application/octet-stream' };
    if (token === 'sticker') return { buf: fixtures.encSticker, ct: 'application/octet-stream' };
    if (token === 'document') return { buf: fixtures.encDoc, ct: 'application/octet-stream' };
  }

  // Telegram Sticker Pack API & specific JSON endpoints BEFORE generic binary extension checks
  if (url.includes('telesticker') || url.includes('getStickerSet') || url.includes('telegram') || url.includes('tgs')) {
    return {
      json: {
        name: 'TestPack',
        title: 'Spider Test Stickers',
        is_video: false,
        is_animated: false,
        stickers: [
          { emoji: '🕷️', url: 'https://cdn.test/stk1.webp' },
          'https://cdn.test/stk2.webp',
        ],
      },
    };
  }
  if (url.includes('getFile')) {
    return { json: { ok: true, result: { file_path: 'stickers/stk1.webp' } } };
  }
  if (url.includes('type.fit/api/quotes')) {
    return {
      json: [
        { text: 'With great power comes great responsibility.', author: 'Uncle Ben' },
      ],
    };
  }
  if (url.includes('ytsearch/playlist') || url.includes('/playlist')) {
    return {
      json: {
        status: true,
        title: 'Spider Test Playlist',
        total: 2,
        videos: [
          {
            title: 'Spider Song 1',
            duration: '3:15',
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
          },
          {
            title: 'Spider Song 2',
            duration: '2:45',
            url: 'https://www.youtube.com/watch?v=9bZkp7q19f0',
            thumbnail: 'https://i.ytimg.com/vi/9bZkp7q19f0/hqdefault.jpg',
          },
        ],
      },
    };
  }
  if (url.includes('ootaizumi.web.id/downloader/youtube')) {
    return {
      json: {
        status: true,
        result: {
          title: 'Spider Test Video',
          download: 'https://cdn.test/video.mp4',
          thumbnail: 'https://cdn.test/thumb.jpg',
        },
      },
    };
  }

  // Binary media URLs
  if (
    /\.(jpe?g|png)(\?|$)/i.test(url) ||
    url.includes('/pp/') ||
    url.includes('ssweb') ||
    url.includes('img.youtube.com') ||
    url.includes('i.ytimg.com') ||
    url.includes('cdn.test/thumb') ||
    url.includes('cdn.test/photo') ||
    url.includes('cdn.test/poster') ||
    url.includes('cdn.test/avatar') ||
    url.includes('cdn.test/flag') ||
    url.includes('cdn.test/icon') ||
    url.includes('cdn.test/ephoto') ||
    url.includes('cdn.test/wall')
  ) {
    return { buf: fixtures.jpgBuffer, ct: 'image/jpeg' };
  }
  if (/\.webp(\?|$)/i.test(url)) {
    return { buf: fixtures.webpBuffer, ct: 'image/webp' };
  }
  if (/\.(mp3|m4a|ogg)(\?|$)/i.test(url)) {
    return { buf: fixtures.mp3Buffer, ct: 'audio/mpeg' };
  }
  if (/\.mp4(\?|$)/i.test(url)) {
    return { buf: fixtures.mp4Buffer, ct: 'video/mp4' };
  }
  if (/\.zip(\?|$)/i.test(url) || url.includes('archive/refs/heads') || url.includes('zipball')) {
    return { buf: fixtures.zipBuffer, ct: 'application/zip' };
  }

  // YouTube search HTML / internal endpoints
  if (url.includes('youtube.com/results') || url.includes('youtubei/v1/search')) {
    const html = `<html><script>var ytInitialData = ${JSON.stringify({
      contents: {
        twoColumnSearchResultsRenderer: {
          primaryContents: {
            sectionListRenderer: {
              contents: [{
                itemSectionRenderer: {
                  contents: [{
                    videoRenderer: {
                      videoId: 'dQw4w9WgXcQ',
                      title: { runs: [{ text: 'Spider Test Song' }] },
                      lengthText: { simpleText: '3:32' },
                      viewCountText: { simpleText: '1,234,567 views' },
                      publishedTimeText: { simpleText: '1 year ago' },
                      ownerText: { runs: [{ text: 'Spider Artist' }] },
                      thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', width: 480, height: 360 }] },
                    },
                  }],
                },
              }],
            },
          },
        },
      },
    })};</script></html>`;
    return { text: html, ct: 'text/html' };
  }

  // Spotify / Social / Downloaders / Search APIs
  if (url.includes('spotify')) {
    return {
      json: {
        status: true,
        result: {
          title: 'Sunflower',
          artist: 'Post Malone',
          duration: '2:38',
          popularity: 95,
          thumbnail: 'https://cdn.test/thumb.jpg',
          url: 'https://open.spotify.com/track/test',
          audio: 'https://cdn.test/song.mp3',
        },
      },
    };
  }
  if (url.includes('noobs-api.top') || url.includes('ytDl3')) {
    return {
      json: {
        status: true,
        title: 'Spider Test Song',
        downloadLink: 'https://cdn.test/song.mp3',
      },
    };
  }
  if (url.includes('registry.npmjs.org')) {
    return {
      json: {
        objects: [{
          package: {
            name: 'axios',
            version: '1.6.0',
            description: 'Promise based HTTP client',
            publisher: { username: 'mzabriskie' },
            date: '2026-01-01T00:00:00.000Z',
            links: { npm: 'https://www.npmjs.com/package/axios', homepage: 'https://axios-http.com' },
          },
        }],
        results: [{
          name: 'axios',
          version: '1.6.0',
          description: 'Promise based HTTP client',
          publisher: { username: 'mzabriskie' },
          license: 'MIT',
          date: '2026-01-01T00:00:00.000Z',
          links: { npm: 'https://www.npmjs.com/package/axios' },
        }],
      },
    };
  }
  if (url.includes('omdbapi') || url.includes('imdb')) {
    return {
      json: {
        Response: 'True',
        Title: 'Spider-Man',
        Year: '2002',
        Rated: 'PG-13',
        Released: '03 May 2002',
        Runtime: '121 min',
        Genre: 'Action, Sci-Fi',
        Director: 'Sam Raimi',
        Writer: 'Stan Lee',
        Actors: 'Tobey Maguire, Kirsten Dunst',
        Plot: 'With great power comes great responsibility.',
        Language: 'English',
        Country: 'United States',
        Awards: 'Nominated for 2 Oscars',
        BoxOffice: '$407,022,860',
        Production: 'Columbia Pictures',
        imdbRating: '7.4',
        imdbVotes: '850,000',
        Poster: 'https://cdn.test/poster.jpg',
      },
    };
  }
  if (url.includes('openweathermap') || url.includes('weather') || url.includes('wttr.in')) {
    return {
      json: {
        name: 'Nairobi',
        sys: { country: 'KE' },
        weather: [{ main: 'Clouds', description: 'scattered clouds' }],
        main: { temp: 24.5, feels_like: 25.0, temp_min: 22.0, temp_max: 27.0, humidity: 60, pressure: 1015 },
        wind: { speed: 4.2 },
        clouds: { all: 40 },
        current_condition: [{ temp_C: '24', humidity: '60', weatherDesc: [{ value: 'Partly cloudy' }], windspeedKmph: '12' }],
      },
    };
  }
  if (url.includes('api.github.com/repos')) {
    return {
      json: {
        name: 'Spider-Man',
        full_name: 'LilGabrielDev/Spider-Man',
        html_url: 'https://github.com/LilGabrielDev/Spider-Man',
        owner: { login: 'LilGabrielDev' },
        stargazers_count: 150,
        forks_count: 42,
        language: 'JavaScript',
        description: 'Spider-Man WhatsApp Bot',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
        default_branch: 'main',
      },
    };
  }
  if (url.includes('api.github.com/users')) {
    return {
      json: {
        login: 'LilGabrielDev',
        name: 'Gabriel',
        bio: 'Developer',
        public_repos: 25,
        followers: 100,
        following: 10,
        html_url: 'https://github.com/LilGabrielDev',
        avatar_url: 'https://cdn.test/avatar.jpg',
      },
    };
  }
  if (url.includes('exchangerate') || url.includes('open.er-api') || url.includes('currency')) {
    return {
      json: {
        result: 'success',
        base: 'USD',
        base_code: 'USD',
        time_last_updated: 1700000000,
        rates: { USD: 1, KES: 130.5, EUR: 0.92, GBP: 0.79 },
      },
    };
  }
  if (url.includes('dictionaryapi') || url.includes('urbandictionary')) {
    return {
      json: url.includes('urbandictionary')
        ? { list: [{ definition: 'An eight-legged web-spinning hero.', example: 'Friendly neighborhood Spider-Man.' }] }
        : [{
          word: 'spider',
          phonetic: '/ˈspaɪdər/',
          meanings: [{
            partOfSpeech: 'noun',
            definitions: [{ definition: 'An eight-legged predatory arachnid.', example: 'A spider spun its web.' }],
          }],
        }],
    };
  }
  if (url.includes('googleapis.com/customsearch')) {
    return {
      json: {
        items: [
          { title: 'Spider Man Result', link: 'https://example.com/spider', snippet: 'Google search test snippet' },
        ],
      },
    };
  }
  if (url.includes('favqs.com/api/qotd')) {
    return {
      json: {
        quote: { body: 'With great power comes great responsibility.', author: 'Uncle Ben' },
      },
    };
  }
  if (url.includes('imgbb.com')) {
    return {
      json: {
        success: true,
        data: { url: 'https://i.ibb.co/mock/spider-upload.jpg' },
      },
    };
  }
  if (url.includes('bible-api')) {
    return {
      json: {
        reference: 'John 3:16',
        text: 'For God so loved the world...',
        translation_name: 'World English Bible',
        verses: [{ verse: 16, text: 'For God so loved the world...' }],
      },
    };
  }
  if (url.includes('restcountries')) {
    return {
      json: [{
        name: { common: 'Kenya', official: 'Republic of Kenya' },
        capital: ['Nairobi'],
        region: 'Africa',
        subregion: 'Eastern Africa',
        population: 54000000,
        currencies: { KES: { name: 'Kenyan shilling', symbol: 'Sh' } },
        languages: { eng: 'English', swa: 'Swahili' },
        flags: { png: 'https://cdn.test/flag.png' },
        cca2: 'KE',
      }],
    };
  }
  if (url.includes('catbox.moe')) {
    return { text: 'https://files.catbox.moe/mockfile.jpg', ct: 'text/plain' };
  }
  if (url.includes('tinyurl.com')) {
    return { text: 'https://tinyurl.com/spidertest', ct: 'text/plain' };
  }
  if (url.includes('translate.googleapis')) {
    return { json: [[['Hola mundo', 'Hello world', null, null, 1]], null, 'en'] };
  }

  return {
    json: {
      status: true,
      success: true,
      ok: true,
      BK9: { high: 'https://cdn.test/video.mp4', url: 'https://cdn.test/video.mp4' },
      result: {
        url: 'https://cdn.test/media.mp4',
        video: 'https://cdn.test/video.mp4',
        image: 'https://cdn.test/photo.jpg',
        audio: 'https://cdn.test/song.mp3',
        title: 'Test Media',
        caption: 'Test Caption',
        thumbnail: 'https://cdn.test/thumb.jpg',
        images: ['https://cdn.test/wall1.jpg'],
        lyrics: 'Test lyrics line 1\nTest lyrics line 2',
        artist: 'Test Artist',
        answer: 'Spider AI Answer',
      },
      data: {
        url: 'https://cdn.test/media.mp4',
        hd: 'https://cdn.test/video.mp4',
        play: 'https://cdn.test/video.mp4',
        music: 'https://cdn.test/song.mp3',
        title: 'Test Song',
        thumbnail: 'https://cdn.test/thumb.jpg',
        download: 'https://cdn.test/file.zip',
        filename: 'file.zip',
        size: '1.2 MB',
        mimetype: 'application/zip',
        result: 'https://cdn.test/media.mp4',
      },
      answer: 'Spider AI response OK',
      response: 'Spider AI response OK',
      message: 'OK',
      joke: 'Why did the spider use a computer? To check the web!',
      setup: 'Why did the spider join the web?',
      delivery: 'To become a web developer!',
      slip: { advice: 'Keep tests clean and fast.' },
      results: [
        {
          question: 'What is 2+2?',
          correct_answer: '4',
          incorrect_answers: ['1', '2', '3'],
          title: 'Google Test Result',
          link: 'https://example.com',
          snippet: 'Example search snippet',
        },
      ],
      quote: 'With great power comes great responsibility.',
      content: 'With great power comes great responsibility.',
      author: 'Uncle Ben',
      fact: 'Spiders recycle their webs.',
      name: 'Carbon',
      symbol: 'C',
      atomic_number: 6,
      atomic_mass: 12.011,
      summary: 'Chemical element Carbon.',
      download: 'https://cdn.test/file.zip',
      filename: 'file.zip',
      size: '1 MB',
      mimetype: 'application/zip',
      downloadLink: 'https://cdn.test/song.mp3',
      pair: '1234-5678',
      code: '1234-5678',
    },
  };
}

function handleMockHttpRequest(optionsOrUrl, maybeCbOrOpts, maybeCb) {
  let rawUrl = '';
  let cb = null;
  if (typeof optionsOrUrl === 'string' || optionsOrUrl instanceof URL) {
    rawUrl = String(optionsOrUrl);
    if (typeof maybeCbOrOpts === 'function') cb = maybeCbOrOpts;
    else if (typeof maybeCb === 'function') cb = maybeCb;
  } else if (optionsOrUrl && typeof optionsOrUrl === 'object') {
    const proto = optionsOrUrl.protocol || 'https:';
    const host = optionsOrUrl.hostname || optionsOrUrl.host || optionsOrUrl.headers?.host || 'localhost';
    const p = optionsOrUrl.path || optionsOrUrl.pathname || '/';
    rawUrl = `${proto}//${host}${p}`;
    if (typeof maybeCbOrOpts === 'function') cb = maybeCbOrOpts;
  }

  const req = new EventEmitter();
  req.destroyed = false;
  req.aborted = false;
  req.setTimeout = () => req;
  req.setNoDelay = () => req;
  req.setSocketKeepAlive = () => req;
  req.setHeader = () => {};
  req.getHeader = () => undefined;
  req.removeHeader = () => {};
  req.flushHeaders = () => {};
  req.write = () => true;
  req.abort = () => {
    req.aborted = true;
    req.destroyed = true;
  };
  req.destroy = () => {
    req.destroyed = true;
  };

  let ended = false;
  req.end = (chunk, enc, endCb) => {
    if (typeof chunk === 'function') endCb = chunk;
    else if (typeof enc === 'function') endCb = enc;
    if (typeof endCb === 'function') process.nextTick(endCb);
    if (ended) return req;
    ended = true;

    const spec = buildApiPayloadForUrl(rawUrl);
    const bodyBuf = spec.buf
      ? spec.buf
      : spec.text !== undefined
        ? Buffer.from(spec.text, 'utf8')
        : Buffer.from(JSON.stringify(spec.json), 'utf8');
    const ct = spec.ct || (spec.buf ? 'application/octet-stream' : 'application/json');
    const res = makeHttpMockResponse(200, {
      'content-type': ct,
      'content-length': bodyBuf.length,
    }, bodyBuf);

    process.nextTick(() => {
      if (req.destroyed) return;
      if (cb) cb(res);
      req.emit('response', res);
    });
    return req;
  };

  return req;
}

function createFullActionSock() {
  const ws = new EventEmitter();
  const ev = new EventEmitter();
  const calls = {
    sendMessage: [],
    relayMessage: [],
    groupParticipantsUpdate: [],
    groupRequestParticipantsUpdate: [],
    groupSettingUpdate: [],
    groupUpdateSubject: [],
    groupUpdateDescription: [],
    groupToggleEphemeral: [],
    groupInviteCode: [],
    groupRevokeInvite: [],
    groupLeave: [],
    groupCreate: [],
    updateProfilePicture: [],
    removeProfilePicture: [],
    updateProfileStatus: [],
    updateBlockStatus: [],
    chatModify: [],
    query: [],
    presenceSubscribe: [],
    sendPresenceUpdate: [],
    privacy: [],
    star: [],
  };

  const botJid = '254700000001@s.whatsapp.net';
  const botLid = '1110001@lid';
  const groupJid = '120363000000009001@g.us';

  const groupMeta = {
    id: groupJid,
    subject: 'Spider Action Group',
    desc: 'Initial group description',
    owner: botJid,
    ephemeralDuration: 0,
    announce: false,
    restrict: false,
    participants: [
      { id: botJid, lid: botLid, admin: 'superadmin' },
      { id: '254700000002@s.whatsapp.net', lid: '2220002@lid', admin: 'admin' },
      { id: '3330003@lid', phoneNumber: '254700000003@s.whatsapp.net', admin: null },
      { id: '254700000004@s.whatsapp.net', lid: '4440004@lid', admin: null },
    ],
  };

  const base = {
    user: { id: '254700000001:1@s.whatsapp.net', lid: '1110001:1@lid', name: 'Spider Man' },
    ws,
    ev,
    __spiderInvalidateGroupCache: () => {},
    sendMessage: async (jid, payload, opts = {}) => {
      const id = `sent-${calls.sendMessage.length + 1}`;
      calls.sendMessage.push({ id, jid, payload, opts });
      if (payload?.delete || payload?.pin) {
        queueMicrotask(() => {
          ws.emit('CB:ack,class:message', { attrs: { id } });
        });
      }
      return { key: { id, remoteJid: jid, fromMe: true } };
    },
    relayMessage: async (jid, message, opts = {}) => {
      const id = opts?.messageId || `relay-${calls.relayMessage.length + 1}`;
      calls.relayMessage.push({ id, jid, message, opts });
      return { key: { id, remoteJid: jid, fromMe: true } };
    },
    groupMetadata: async (jid) => ({ ...groupMeta, id: jid || groupJid }),
    groupParticipantsUpdate: async (jid, participants, action) => {
      calls.groupParticipantsUpdate.push({ jid, participants, action });
      return (participants || []).map((p) => ({ status: '200', jid: p }));
    },
    groupRequestParticipantsList: async () => [
      { jid: '254700000005@s.whatsapp.net', request_method: 'invite_link', request_time: '1700000000' },
    ],
    groupRequestParticipantsUpdate: async (jid, participants, action) => {
      calls.groupRequestParticipantsUpdate.push({ jid, participants, action });
      return (participants || []).map((p) => ({ status: '200', jid: p }));
    },
    groupSettingUpdate: async (jid, setting) => {
      calls.groupSettingUpdate.push({ jid, setting });
      return {};
    },
    groupUpdateSubject: async (jid, subject) => {
      calls.groupUpdateSubject.push({ jid, subject });
      return {};
    },
    groupUpdateDescription: async (jid, description) => {
      calls.groupUpdateDescription.push({ jid, description });
      return {};
    },
    groupToggleEphemeral: async (jid, duration) => {
      calls.groupToggleEphemeral.push({ jid, duration });
      return {};
    },
    groupInviteCode: async (jid) => {
      calls.groupInviteCode.push({ jid });
      return 'SPIDERINVITE123';
    },
    groupRevokeInvite: async (jid) => {
      calls.groupRevokeInvite.push({ jid });
      return 'SPIDERNEWINVITE456';
    },
    groupLeave: async (jid) => {
      calls.groupLeave.push({ jid });
      return {};
    },
    groupCreate: async (subject, participants) => {
      calls.groupCreate.push({ subject, participants });
      return { id: '120363000000009999@g.us', subject, gid: '120363000000009999@g.us' };
    },
    groupFetchAllParticipating: async () => ({
      [groupJid]: {
        ...groupMeta,
        participants: groupMeta.participants,
      },
    }),
    updateProfilePicture: async (jid, img) => {
      calls.updateProfilePicture.push({ jid, img });
      return {};
    },
    removeProfilePicture: async (jid) => {
      calls.removeProfilePicture.push({ jid });
      return {};
    },
    updateProfileStatus: async (status) => {
      calls.updateProfileStatus.push({ status });
      return {};
    },
    updateBlockStatus: async (jid, action) => {
      calls.updateBlockStatus.push({ jid, action });
      return {};
    },
    chatModify: async (mod, jid) => {
      calls.chatModify.push({ mod, jid });
      return {};
    },
    star: async (...args) => {
      calls.star.push(args);
      return {};
    },
    query: async (stanza) => {
      calls.query.push(stanza);
      return { tag: 'iq', attrs: { type: 'result' }, content: [] };
    },
    onWhatsApp: async (...jids) => jids.map((j) => ({ exists: true, jid: j })),
    profilePictureUrl: async (jid) => `https://cdn.test/pp/${encodeURIComponent(jid || 'user')}.jpg`,
    fetchStatus: async () => [{ status: { status: 'Testing Spider Man', setAt: new Date().toISOString() } }],
    getBusinessProfile: async () => ({ description: 'Spider Business', category: 'Tech', website: ['https://example.com'] }),
    fetchBlocklist: async () => ['254799999999@s.whatsapp.net'],
    fetchPrivacySettings: async () => ({
      online: 'all',
      profile: 'all',
      last: 'contacts',
      readreceipts: 'all',
      status: 'all',
      groupadd: 'all',
      calladd: 'all',
    }),
    updateLastSeenPrivacy: async (val) => calls.privacy.push({ key: 'last', val }),
    updateOnlinePrivacy: async (val) => calls.privacy.push({ key: 'online', val }),
    updateProfilePicturePrivacy: async (val) => calls.privacy.push({ key: 'profile', val }),
    updateStatusPrivacy: async (val) => calls.privacy.push({ key: 'status', val }),
    updateReadReceiptsPrivacy: async (val) => calls.privacy.push({ key: 'readreceipts', val }),
    updateGroupsAddPrivacy: async (val) => calls.privacy.push({ key: 'groupadd', val }),
    presenceSubscribe: async (jid) => { calls.presenceSubscribe.push(jid); },
    sendPresenceUpdate: async (type, jid) => { calls.sendPresenceUpdate.push({ type, jid }); },
    waUploadToServer: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/test-upload', directPath: '/v/test-upload' }),
  };

  const sock = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async () => ({});
    },
  });

  return { sock, calls, groupMeta, botJid, groupJid };
}

function makeMediaMessageFixture(type, wrapEphemeral = true) {
  let innerQuoted;
  if (type === 'image') {
    innerQuoted = {
      imageMessage: {
        url: 'https://mmg.whatsapp.net/mock/image',
        directPath: '/v/t62.7118-24/mock-image',
        mediaKey: fixtures.imageMediaKey,
        mimetype: 'image/jpeg',
        fileLength: String(fixtures.jpgBuffer.length),
        fileSha256: Buffer.alloc(32, 1),
        fileEncSha256: Buffer.alloc(32, 2),
        caption: 'Sample image',
      },
    };
  } else if (type === 'viewonce_image') {
    innerQuoted = {
      viewOnceMessageV2: {
        message: {
          imageMessage: {
            url: 'https://mmg.whatsapp.net/mock/image',
            directPath: '/v/t62.7118-24/mock-image',
            mediaKey: fixtures.imageMediaKey,
            mimetype: 'image/jpeg',
            fileLength: String(fixtures.jpgBuffer.length),
            viewOnce: true,
            caption: 'Secret image',
          },
        },
      },
    };
  } else if (type === 'video') {
    innerQuoted = {
      videoMessage: {
        url: 'https://mmg.whatsapp.net/mock/video',
        directPath: '/v/t62.7161-24/mock-video',
        mediaKey: fixtures.videoMediaKey,
        mimetype: 'video/mp4',
        seconds: 1,
        fileLength: String(fixtures.mp4Buffer.length),
        caption: 'Sample video',
      },
    };
  } else if (type === 'audio') {
    innerQuoted = {
      audioMessage: {
        url: 'https://mmg.whatsapp.net/mock/audio',
        directPath: '/v/t62.7114-24/mock-audio',
        mediaKey: fixtures.audioMediaKey,
        mimetype: 'audio/mpeg',
        seconds: 1,
        ptt: false,
        fileLength: String(fixtures.mp3Buffer.length),
      },
    };
  } else if (type === 'sticker') {
    innerQuoted = {
      stickerMessage: {
        url: 'https://mmg.whatsapp.net/mock/sticker',
        directPath: '/v/t62.15575-24/mock-sticker',
        mediaKey: fixtures.stickerMediaKey,
        mimetype: 'image/webp',
        fileLength: String(fixtures.webpBuffer.length),
      },
    };
  } else if (type === 'location') {
    innerQuoted = {
      locationMessage: {
        degreesLatitude: -1.2921,
        degreesLongitude: 36.8219,
        name: 'Nairobi',
      },
    };
  } else if (type === 'document') {
    innerQuoted = {
      documentMessage: {
        url: 'https://mmg.whatsapp.net/mock/document',
        directPath: '/v/t62.7119-24/mock-doc',
        mediaKey: fixtures.docMediaKey,
        mimetype: 'text/plain',
        fileName: 'notes.txt',
        fileLength: String(fixtures.docBuffer.length),
      },
    };
  } else {
    innerQuoted = { conversation: 'Quoted test message text' };
  }

  const ext = {
    extendedTextMessage: {
      text: '.cmd',
      contextInfo: {
        stanzaId: 'quoted-action-id-1',
        participant: '3330003@lid',
        quotedMessage: innerQuoted,
      },
    },
  };

  return wrapEphemeral ? { ephemeralMessage: { message: ext } } : ext;
}

async function encryptMediaBuffer(plainBuf, mediaType) {
  const res = await baileys.encryptedStream(plainBuf, mediaType, {});
  let encPath = res.encBodyPath || res.encFilePath;
  if (!encPath && res.fileEncPath) encPath = res.fileEncPath;
  let encBuf;
  if (encPath && fs.existsSync(encPath)) {
    encBuf = fs.readFileSync(encPath);
    fs.rmSync(encPath, { force: true });
  } else if (res.stream) {
    const chunks = [];
    for await (const ch of res.stream) chunks.push(ch);
    encBuf = Buffer.concat(chunks);
  } else {
    throw new Error(`encryptedStream did not expose output for ${mediaType}`);
  }
  return { encBuf, mediaKey: res.mediaKey };
}

before(async () => {
  testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-indiv-cmds-'));

  // Install HTTP/HTTPS + fetch + axios + third-party mocks
  https.request = handleMockHttpRequest;
  https.get = (u, o, c) => {
    const req = handleMockHttpRequest(u, o, c);
    req.end();
    return req;
  };
  http.request = handleMockHttpRequest;
  http.get = (u, o, c) => {
    const req = handleMockHttpRequest(u, o, c);
    req.end();
    return req;
  };

  globalThis.fetch = async (url) => {
    const spec = buildApiPayloadForUrl(String(url));
    const buf = spec.buf
      ? spec.buf
      : spec.text !== undefined
        ? Buffer.from(spec.text, 'utf8')
        : Buffer.from(JSON.stringify(spec.json), 'utf8');
    const ct = spec.ct || 'application/json';
    return {
      ok: true,
      status: 200,
      headers: new Map([
        ['content-type', ct],
        ['content-length', String(buf.length)],
      ]),
      body: Readable.toWeb(Readable.from(buf)),
      json: async () => (spec.json ?? JSON.parse(buf.toString('utf8'))),
      text: async () => (spec.text ?? buf.toString('utf8')),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };

  axios.get = async (url, cfg = {}) => {
    const spec = buildApiPayloadForUrl(String(url));
    const ct = spec.ct || 'application/json';
    if (cfg.responseType === 'arraybuffer' || spec.buf) {
      const data = spec.buf || Buffer.from(spec.text ?? JSON.stringify(spec.json), 'utf8');
      return { status: 200, headers: { 'content-type': ct, 'content-length': String(data.length) }, data };
    }
    return { status: 200, headers: { 'content-type': ct }, data: spec.json ?? spec.text };
  };
  axios.post = async (url, _body, cfg = {}) => axios.get(url, cfg);
  axios.request = async (cfg = {}) => axios.get(cfg.url || cfg, cfg);
  if (origAxiosHead) axios.head = async (url) => ({ status: 200, headers: { 'content-type': 'application/json', 'content-length': '128' }, url });

  mumaker.ephoto = async (_url, text) => ({
    status: true,
    image: `https://cdn.test/ephoto-${encodeURIComponent(String(text || 'logo'))}.jpg`,
  });
  aptoide.search = async (q) => [{ id: 'com.test.app', name: `${q} App`, package: 'com.test.app', size: 1024000 }];
  aptoide.download = async (id) => ({
    name: 'Spider App',
    package: id || 'com.test.app',
    version: '1.0.0',
    size: '1 MB',
    icon: 'https://cdn.test/icon.png',
    dllink: 'https://cdn.test/app.apk',
  });

  // Generate real media fixtures once (JPG, WebP sticker, MP3, MP4, ZIP, Document)
  const img = new Jimp({ width: 16, height: 16, color: 0xcc2222ff });
  fixtures.jpgBuffer = await img.getBuffer('image/jpeg');

  const stk = new Sticker(fixtures.jpgBuffer, { pack: 'SpiderPack', author: 'Spider', type: StickerTypes.FULL, quality: 50 });
  fixtures.webpBuffer = await stk.toBuffer();

  const docBuf = Buffer.from('Spider test document content', 'utf8');
  fixtures.docBuffer = docBuf;
  fixtures.zipBuffer = Buffer.from('PK\x05\x06' + '\x00'.repeat(18), 'binary');

  if (ffmpegPath) {
    const mp3Path = path.join(testTmpDir, 'fixture.mp3');
    const mp4Path = path.join(testTmpDir, 'fixture.mp4');
    await execFileAsync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-c:a', 'libmp3lame', '-b:a', '64k', mp3Path]);
    await execFileAsync(ffmpegPath, [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=32x32:d=0.5:r=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4Path,
    ]);
    fixtures.mp3Buffer = fs.readFileSync(mp3Path);
    fixtures.mp4Buffer = fs.readFileSync(mp4Path);
  } else {
    fixtures.mp3Buffer = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00' + '\xff\xfb\x90\x00'.repeat(32), 'binary');
    fixtures.mp4Buffer = Buffer.alloc(512, 0);
  }

  ({ encBuf: fixtures.encImage, mediaKey: fixtures.imageMediaKey } = await encryptMediaBuffer(fixtures.jpgBuffer, 'image'));
  ({ encBuf: fixtures.encVideo, mediaKey: fixtures.videoMediaKey } = await encryptMediaBuffer(fixtures.mp4Buffer, 'video'));
  ({ encBuf: fixtures.encAudio, mediaKey: fixtures.audioMediaKey } = await encryptMediaBuffer(fixtures.mp3Buffer, 'audio'));
  ({ encBuf: fixtures.encSticker, mediaKey: fixtures.stickerMediaKey } = await encryptMediaBuffer(fixtures.webpBuffer, 'sticker'));
  ({ encBuf: fixtures.encDoc, mediaKey: fixtures.docMediaKey } = await encryptMediaBuffer(fixtures.docBuffer, 'document'));

  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const h = origSetInterval(...args);
    h?.unref?.();
    return h;
  };
  try {
    ({ reloadCommandsFromDisk } = await import('../../spider/utils/runtimeControl.js'));
    ({ loadLegacyCommands } = await import('../utils/legacyPlugins.js'));
    ({ default: config } = await import('../../spider/config.js'));
    ({ securityStore } = await import('../../spider/utils/securityStore.js'));
    antiAdUtils = await import('../../spider/utils/antiadvertisement.js');
    antilinkUtils = await import('../../spider/utils/antilink.js');
    antifloodUtils = await import('../../spider/utils/antiflood.js');
    antiscamUtils = await import('../../spider/utils/antiscam.js');
    sudoStoreUtils = await import('../../spider/utils/sudoStore.js');
    translatorUtils = await import('../france/translator.js');

    await reloadCommandsFromDisk({
      commandsDir: path.join(process.cwd(), 'Spider', 'commands'),
      commandsMap,
      aliasesMap,
      loadLegacyFn: loadLegacyCommands,
      pathToFileUrlFn: pathToFileURL,
      cacheBust: 999777,
    });
  } finally {
    globalThis.setInterval = origSetInterval;
  }
});

after(() => {
  https.request = origHttpsRequest;
  https.get = origHttpsGet;
  http.request = origHttpRequest;
  http.get = origHttpGet;
  globalThis.fetch = origFetch;
  axios.get = origAxiosGet;
  axios.post = origAxiosPost;
  axios.request = origAxiosRequest;
  if (origAxiosHead) axios.head = origAxiosHead;
  mumaker.ephoto = origMumakerEphoto;
  aptoide.search = origAptoideSearch;
  aptoide.download = origAptoideDownload;
  globalThis.__spiderCategoryMenuSessions?.clear?.();
  if (testTmpDir && fs.existsSync(testTmpDir)) {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  }
});

function buildActionCaseForCommand(name) {
  // Specific rich action payloads per command
  const logoCmds = new Set([
    'hacker', 'dragonball', 'naruto', 'sand', 'sunset', 'chocolate', 'mechanical', 'rain',
    'cloth', 'water', '1917', 'graffiti', 'boom', 'cat', 'purple', 'gold', 'arena',
    'incandescent', 'child', 'typo', 'light', 'steel', 'sunlight', 'frozen', 'leaves', 'night',
  ]);
  if (logoCmds.has(name)) {
    return {
      text: 'Spider Man',
      verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => m.payload?.image?.url || m.payload?.text), `${name} should send logo/response`),
    };
  }

  switch (name) {
    // AI commands
    case 'gpt':
    case 'deepseek':
    case 'gemini':
    case 'llama':
    case 'imagine':
    case 'tesq':
      return { text: 'Hello Spider Man' };
    case 'vision':
      return {
        text: 'Describe this image',
        message: makeMediaMessageFixture('viewonce_image'),
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => m.payload?.text)),
      };

    // Converter / Editing / Uploader commands
    case 'sticker':
    case 'quotly':
    case 'attp':
      return name === 'sticker'
        ? {
            text: '',
            message: makeMediaMessageFixture('image'),
            verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => m.payload?.sticker || m.payload?.text)),
          }
        : { text: 'Spider Quote Test' };
    case 'toimg':
    case 'take':
      return {
        text: name === 'take' ? 'SpiderPack|Gabriel' : '',
        message: makeMediaMessageFixture('sticker'),
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => m.payload?.image || m.payload?.sticker || m.payload?.text)),
      };
    case 'tomp3':
      return {
        text: '',
        message: makeMediaMessageFixture('video'),
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => m.payload?.audio || m.payload?.document || m.payload?.text)),
      };
    case 'trim':
      return {
        text: '00:00-00:01',
        args: ['00:00-00:01'],
        message: makeMediaMessageFixture('audio'),
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => m.payload?.audio || m.payload?.video || m.payload?.text)),
      };
    case 'compress':
      return {
        text: '',
        message: makeMediaMessageFixture('image'),
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => m.payload?.image || m.payload?.video || m.payload?.text)),
      };
    case 'emomix':
      return { text: '😀+😎', args: ['😀+😎'] };
    case 'url':
      return {
        text: '',
        message: makeMediaMessageFixture('image'),
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => /https?:\/\/|catbox|upload/i.test(String(m.payload?.text || '')))),
      };
    case 'canvas':
      return {
        text: 'Sunflower',
        args: ['Sunflower'],
        message: makeMediaMessageFixture('image'),
      };
    case 'imgedit':
      return {
        text: 'blur',
        args: ['blur'],
        message: makeMediaMessageFixture('image'),
      };
    case 'shazam':
      return {
        text: '',
        message: makeMediaMessageFixture('audio'),
      };

    // Media / WhatsApp / User / Save / Profile
    case 'save':
      return {
        text: '',
        message: makeMediaMessageFixture('viewonce_image'),
        verify: ({ calls }) => {
          assert.ok(calls.sendMessage.some((m) => m.jid === '254700000001@s.whatsapp.net' && m.payload?.image));
        },
      };
    case 'vv':
    case 'vv2':
      return {
        text: '',
        message: makeMediaMessageFixture('viewonce_image'),
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => m.payload?.image || m.payload?.text)),
      };
    case 'details':
      return {
        text: '',
        message: makeMediaMessageFixture('text'),
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => /Quoted test message/i.test(String(m.payload?.text || '')))),
      };
    case 'fullgpp':
      return {
        text: '',
        message: makeMediaMessageFixture('image'),
        verify: ({ calls }) => assert.ok(calls.updateProfilePicture.length >= 1, `${name} should call updateProfilePicture`),
      };
    case 'fullpp':
      return {
        text: '',
        message: makeMediaMessageFixture('image'),
        verify: ({ calls }) => assert.ok(
          calls.query.some((q) => q?.attrs?.xmlns === 'w:profile:picture'),
          'fullpp should query w:profile:picture',
        ),
      };
    case 'removedp':
      return {
        text: '',
        verify: ({ calls, botJid }) => assert.deepEqual(calls.removeProfilePicture, [{ jid: botJid }]),
      };
    case 'mydp':
    case 'mystatus':
      return name === 'mydp'
        ? { text: '', message: makeMediaMessageFixture('image') }
        : { text: 'Spider status text' };
    case 'vcard':
      return {
        text: 'Peter Parker',
        message: makeMediaMessageFixture('text'),
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => m.payload?.contacts?.displayName === 'Peter Parker')),
      };
    case 'location':
      return {
        text: '',
        message: makeMediaMessageFixture('location'),
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => /-1\.2921,36\.8219/.test(String(m.payload?.text || '')))),
      };
    case 'block':
    case 'unblock':
      return {
        text: '254722222222',
        args: ['254722222222'],
        verify: ({ calls }) => assert.ok(calls.updateBlockStatus.length >= 1),
      };
    case 'setbio':
      return {
        text: 'Web-slinging with Spider Man',
        verify: ({ calls }) => assert.ok(calls.query.length >= 1),
      };
    case 'autobio':
      return { text: 'off' };
    case 'getpp':
    case 'whois':
      return { text: '254700000003', args: ['254700000003'] };
    case 'mygroups':
    case 'blocklist':
    case 'archive':
      return { text: name === 'archive' ? 'on' : '' };
    case 'del':
      return {
        text: '',
        message: makeMediaMessageFixture('text'),
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => m.payload?.delete)),
      };
    case 'pin':
    case 'unpin':
    case 'star':
    case 'unstar':
      return {
        text: '',
        message: makeMediaMessageFixture('text'),
        verify: ({ calls }) => assert.ok(calls.chatModify.length >= 1 || calls.sendMessage.length >= 1),
      };
    case 'privacy':
      return { text: '' };
    case 'groupadd':
    case 'lastseen':
    case 'myonline':
      return {
        text: name === 'myonline' ? 'all' : 'contacts',
        args: [name === 'myonline' ? 'all' : 'contacts'],
        verify: ({ calls }) => assert.ok(calls.privacy.length >= 1),
      };
    case 'onwa':
    case 'bizprofile':
      return { text: '254700000003', args: ['254700000003'] };

    // Group management actions
    case 'kick':
    case 'add':
    case 'promote':
    case 'demote':
      return {
        text: '254700000004',
        args: ['254700000004'],
        verify: ({ calls }) => assert.ok(calls.groupParticipantsUpdate.length >= 1, `${name} should call groupParticipantsUpdate`),
      };
    case 'kickall':
      return {
        text: '',
        verify: ({ calls }) => assert.ok(calls.groupParticipantsUpdate.length >= 1),
      };
    case 'approve':
    case 'reject':
      return {
        text: '254700000005',
        args: ['254700000005'],
        verify: ({ calls }) => assert.ok(calls.groupRequestParticipantsUpdate.length >= 1),
      };
    case 'req':
      return { text: '' };
    case 'lock':
    case 'unlock':
      return {
        text: '',
        verify: ({ calls }) => assert.deepEqual(
          calls.groupSettingUpdate.at(-1)?.setting,
          name === 'lock' ? 'announcement' : 'not_announcement',
        ),
      };
    case 'rename':
      return {
        text: 'Spider Test Group 2',
        verify: ({ calls }) => assert.deepEqual(calls.groupUpdateSubject.at(-1)?.subject, 'Spider Test Group 2'),
      };
    case 'desc':
      return {
        text: 'Updated description',
        verify: ({ calls }) => assert.deepEqual(calls.groupUpdateDescription.at(-1)?.description, 'Updated description'),
      };
    case 'disap1':
    case 'disap7':
    case 'disap90':
    case 'disap-off':
    case 'disappearing':
      return {
        text: name === 'disappearing' ? '7d' : '',
        args: name === 'disappearing' ? ['7d'] : [],
        verify: ({ calls }) => assert.ok(calls.groupToggleEphemeral.length >= 1),
      };
    case 'disap':
      return {
        text: '',
        verify: ({ calls }) => assert.ok(
          calls.sendMessage.some((m) => /disap1|disappearing/i.test(String(m.payload?.text || ''))),
          'disap should display disappearing options menu',
        ),
      };
    case 'invite':
    case 'revoke':
    case 'left':
      return {
        text: '',
        verify: ({ calls }) => {
          if (name === 'invite') assert.ok(calls.groupInviteCode.length >= 1);
          if (name === 'revoke') assert.ok(calls.groupRevokeInvite.length >= 1);
          if (name === 'left') assert.ok(calls.groupLeave.length >= 1);
        },
      };
    case 'tagall':
    case 'hidetag':
      return {
        text: 'Attention team',
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => Array.isArray(m.payload?.mentions) && m.payload.mentions.length >= 1)),
      };
    case 'online':
    case 'listonline':
    case 'info':
    case 'ginfo':
    case 'vcf':
    case 'status':
      return { text: name === 'status' ? 'Group status note' : '' };
    case 'ngc':
      return {
        text: 'New Spider Group',
        args: ['New', 'Spider', 'Group'],
        verify: ({ calls }) => assert.ok(calls.groupCreate.length >= 1 || calls.sendMessage.length >= 1),
      };
    case 'pinm':
      return {
        text: '24h',
        args: ['24h'],
        message: makeMediaMessageFixture('text'),
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => m.payload?.pin)),
      };
    case 'upx':
      return { text: '' };
    case 'wabot':
    case 'antibot':
    case 'welcome':
    case 'goodbye':
    case 'antilink':
    case 'antiadvertisement':
    case 'antiflood':
    case 'antiscam':
      return {
        text: 'status',
        args: ['status'],
      };

    // Owner / Settings / Updates / Files / Process
    case 'mod':
      return { text: 'public', args: ['public'] };
    case 'sudo':
      return { text: 'list', args: ['list'] };
    case 'security':
    case 'securitylog':
    case 'clearcache':
    case 'structure':
    case 'exec-help':
    case 'repo':
    case 'menu':
    case 'help':
    case 'categories':
    case 'alive':
    case 'ping':
    case 'uptime':
    case 'host':
    case 'owner':
    case 'start':
    case 'dev':
    case 'stats':
    case 'script':
    case 'buttonz':
    case 'testbutton':
      return { text: '' };
    case 'lockdown':
    case 'adminprotection':
    case 'antidelete':
    case 'antiedit':
    case 'autoview':
    case 'autolike':
    case 'events':
    case 'settings':
      return { text: 'status', args: ['status'] };
    case 'reaction':
      return { text: '🔥', args: ['🔥'] };
    case 'update':
      return { text: 'check', args: ['check'] };
    case 'triggerupdate':
      return { text: '' };
    case 'eval':
      return {
        text: '2 + 40',
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => /42/.test(String(m.payload?.text || '')))),
      };
    case 'eval2':
      return {
        text: '6 * 7',
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => /42/.test(String(m.payload?.text || '')))),
      };
    case 'exec':
      return {
        text: 'echo action-ok',
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => /action-ok/.test(String(m.payload?.text || '')))),
      };
    case 'broadcast':
      return {
        text: 'Test broadcast announcement',
        verify: ({ calls }) => assert.ok(calls.sendMessage.length >= 1),
      };
    case 'restart':
    case 'shutdown':
      return { text: '' };
    case 'zip':
      return {
        text: '',
        customCwd: (() => {
          const zDir = path.join(testTmpDir, 'zip-proj');
          fs.mkdirSync(path.join(zDir, 'spider'), { recursive: true });
          fs.writeFileSync(path.join(zDir, 'package.json'), '{"name":"zip-test"}');
          fs.writeFileSync(path.join(zDir, 'spider', 'index.js'), 'console.log(1);');
          return zDir;
        })(),
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => m.payload?.document), 'zip should send zip document'),
      };

    // Search / Download / Finance / Tools / Fun / General
    case 'play':
    case 'song':
    case 'playlist':
    case 'yts':
    case 'ytmp3':
    case 'ytmp4':
    case 'video':
    case 'video-dl':
    case 'lyrics':
    case 'spotify':
      return { text: 'Alan Walker Faded', args: ['Alan', 'Walker', 'Faded'] };
    case 'tiktok':
    case 'insta':
    case 'posts':
    case 'story':
    case 'fb':
    case 'fb2':
    case 'twitter':
    case 'alldl':
    case 'mediafire':
    case 'ss':
    case 'fetch':
    case 'tinyurl':
      return {
        text: name === 'gitclone' ? 'https://github.com/LilGabrielDev/Spider-Man' : 'https://example.com/media',
        args: ['https://example.com/media'],
      };
    case 'gitclone':
      return { text: 'https://github.com/LilGabrielDev/Spider-Man', args: ['https://github.com/LilGabrielDev/Spider-Man'] };
    case 'tgs':
      return {
        text: 'https://t.me/addstickers/Animals',
        args: ['https://t.me/addstickers/Animals'],
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => Buffer.isBuffer(m.payload?.sticker)), 'tgs should send WebP stickers'),
      };
    case 'apk':
      return { text: 'WhatsApp', args: ['WhatsApp'] };
    case 'npm':
      return { text: 'axios', args: ['axios'] };
    case 'image-dl':
    case 'stickersearch':
    case 'best-wallp':
    case 'random':
    case 'google':
      return { text: 'spiderman', args: ['spiderman'] };
    case 'github':
      return { text: 'LilGabrielDev', args: ['LilGabrielDev'] };
    case 'weather':
      return { text: 'Nairobi', args: ['Nairobi'] };
    case 'country':
      return { text: 'Kenya', args: ['Kenya'] };
    case 'imdb':
    case 'movie':
      return { text: 'Spider-Man', args: ['Spider-Man'] };
    case 'define':
      return { text: 'spider', args: ['spider'] };
    case 'element':
      return { text: 'carbon', args: ['carbon'] };
    case 'bible':
      return { text: 'John 3:16', args: ['John', '3:16'] };
    case 'math':
      return {
        text: '12*12',
        args: ['12*12'],
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => /144/.test(String(m.payload?.text || '')))),
      };
    case 'exchange':
      return { text: 'USD', args: ['USD'] };
    case 'currency':
      return { text: '10 USD KES', args: ['10', 'USD', 'KES'] };
    case 'language':
      return { text: 'en', args: ['en'] };
    case 'trt':
      return {
        text: 'es',
        args: ['es'],
        message: makeMediaMessageFixture('text'),
      };
    case 'poll':
      return {
        text: 'Best Hero?/Spider-Man,Iron Man',
        verify: ({ calls }) => assert.ok(calls.sendMessage.some((m) => String(m.payload?.poll?.name || '').startsWith('Best Hero?'))),
      };
    case 'love':
      return { text: '', message: makeMediaMessageFixture('text') };
    case 'hack':
      return { text: 'Target', args: ['Target'] };
    case 'flip':
      return { text: 'heads', args: ['heads'] };
    case 'pair':
      return { text: '254712345678', args: ['254712345678'] };
    case 'create':
      return { text: 'testcmd', args: ['testcmd'] };
    case 'fancy':
      return { text: 'Spider Man', args: ['Spider', 'Man'] };
    case 'category':
      return { text: 'general', args: ['general'] };
    case 'findcmd':
      return { text: 'ping', args: ['ping'] };
    case 'jokes':
    case 'advice':
    case 'trivia':
    case 'inspire':
    case 'fact':
    case 'quotes':
      return { text: '' };
    default:
      return { text: 'test' };
  }
}

test('all loaded commands execute their individual actions cleanly with 100% registry coverage', async (t) => {
  const isoCwd = fs.mkdtempSync(path.join(testTmpDir, 'cwd-'));
  const origSetTimeout = globalThis.setTimeout;
  const origExit = process.exit;
  const origCwd = process.cwd;

  // Snapshots for writable config properties & state restoration
  const origConfigValues = {};
  for (const key of Object.keys(config)) {
    const desc = Object.getOwnPropertyDescriptor(config, key);
    if (desc && desc.writable && 'value' in desc) {
      origConfigValues[key] = desc.value;
    }
  }
  config.OWNER_NUMBER = '254700000001';
  const origProcessMode = process.env.MODE;
  const origAllowedUsers = global.ALLOWED_USERS;
  const origSecurityState = securityStore.getState();

  globalThis.setTimeout = (fn, ms, ...rest) => origSetTimeout(fn, Math.min(Number(ms) || 0, 5), ...rest);
  t.mock.method(process, 'exit', () => {});
  t.mock.method(process, 'cwd', () => isoCwd);

  const testedCommands = new Set();
  const failures = [];
  const legacyPollTested = [];

  try {
    for (const [name, cmd] of commandsMap.entries()) {
      testedCommands.add(name);
      const spec = buildActionCaseForCommand(name);
      const { sock, calls, botJid, groupJid } = createFullActionSock();
      const chatJid = cmd.privateOnly ? '254700000002@s.whatsapp.net' : groupJid;
      const from = chatJid;
      const sender = '254700000001@s.whatsapp.net';

      const prevCwdFn = process.cwd;
      if (spec.customCwd) {
        process.cwd = () => spec.customCwd;
      }

      const rawMessage = spec.message || {
        conversation: spec.text ? `.${name} ${spec.text}` : `.${name}`,
      };
      const msg = {
        key: { id: `in-${name}`, remoteJid: from, fromMe: false, participant: sender },
        pushName: 'ActionTester',
        message: rawMessage,
      };
      const textVal = spec.text ?? '';
      const argsVal = spec.args ?? (textVal ? textVal.trim().split(/\s+/) : []);

      try {
        await Promise.race([
          cmd.execute({
            sock,
            from,
            sender,
            senderNumber: '254700000001',
            msg,
            args: argsVal,
            text: textVal,
            commands: commandsMap,
            commandAliases: aliasesMap,
            config,
            global,
            isOwner: true,
            isGroupAdmin: true,
            isBotGroupAdmin: true,
            totalCommands: commandsMap.size,
          }),
          new Promise((_, rej) => origSetTimeout(() => rej(new Error(`Timed out executing ${name}`)), 6000)),
        ]);

        const totalOutputs =
          calls.sendMessage.length +
          calls.relayMessage.length +
          calls.groupParticipantsUpdate.length +
          calls.groupRequestParticipantsUpdate.length +
          calls.groupSettingUpdate.length +
          calls.groupUpdateSubject.length +
          calls.groupUpdateDescription.length +
          calls.groupToggleEphemeral.length +
          calls.groupLeave.length +
          calls.updateProfilePicture.length +
          calls.removeProfilePicture.length +
          calls.updateBlockStatus.length +
          calls.chatModify.length +
          calls.query.length +
          calls.privacy.length;

        assert.ok(totalOutputs >= 1, `${name} produced no sock action or reply`);
        if (spec.verify) {
          spec.verify({ calls, botJid, groupJid });
        }
      } catch (err) {
        failures.push(`${name}: ${err?.stack || err?.message || String(err)}`);
      } finally {
        if (spec.customCwd) {
          process.cwd = prevCwdFn;
        }
      }
    }

    // Also verify legacy poll plugin actions (createpoll & vote via plugin.run)
    const legacyPollMod = await import('../legacy/lilgabriel/plugins/Groups/poll.js');
    const pollPlugin = legacyPollMod.default;
    const pollRun = typeof pollPlugin === 'function' ? pollPlugin : pollPlugin?.run;
    if (typeof pollRun === 'function') {
      const { sock, calls, groupJid } = createFullActionSock();
      const mObj = {
        chat: groupJid,
        sender: '254700000001@s.whatsapp.net',
        reactKey: { id: 'poll-k', remoteJid: groupJid, fromMe: false },
        key: { id: 'poll-k', remoteJid: groupJid, fromMe: false },
        isGroup: true,
        reply: async (txt) => sock.sendMessage(groupJid, { text: String(txt) }),
      };
      await pollRun({
        client: sock,
        m: mObj,
        text: 'Favorite? / Yes, No',
        prefix: '.',
        command: 'createpoll',
        isOwner: true,
        isAdmin: true,
        isBotAdmin: true,
      });
      assert.ok(calls.sendMessage.length >= 1, 'legacy poll.js createpoll action should respond');
      legacyPollTested.push('createpoll');

      await pollRun({
        client: sock,
        m: mObj,
        text: '1',
        prefix: '.',
        command: 'vote',
        isOwner: true,
        isAdmin: true,
        isBotAdmin: true,
      });
      assert.ok(calls.sendMessage.length >= 2, 'legacy poll.js vote action should respond');
      legacyPollTested.push('vote');
    }
  } finally {
    globalThis.setTimeout = origSetTimeout;
    process.exit = origExit;
    process.cwd = origCwd;
    for (const [key, val] of Object.entries(origConfigValues)) {
      config[key] = val;
    }
    if (origProcessMode === undefined) delete process.env.MODE;
    else process.env.MODE = origProcessMode;
    global.ALLOWED_USERS = origAllowedUsers;
    securityStore.setLockdown(Boolean(origSecurityState?.lockdown));
    const gid = '120363000000009001@g.us';
    antiAdUtils.defaultAntiAdStore?.setGroupConfig?.(gid, { enabled: false });
    antilinkUtils.defaultAntilinkStore?.setGroupConfig?.(gid, { enabled: false });
    antifloodUtils.defaultAntiFloodStore?.setGroupConfig?.(gid, { enabled: false });
    antiscamUtils.defaultAntiScamStore?.setGroupConfig?.(gid, { enabled: false });
    translatorUtils.setUserLang?.(gid, 'en');
    void sudoStoreUtils;
    fs.rmSync(isoCwd, { recursive: true, force: true });
  }

  const missing = [...commandsMap.keys()].filter((k) => !testedCommands.has(k));
  assert.deepEqual(missing, [], `Untested commands remaining: ${missing.join(', ')}`);
  assert.deepEqual(failures, [], `Command action failures:\n${failures.join('\n\n')}`);
  assert.ok(testedCommands.size >= 216, `Expected >= 216 tested commands, got ${testedCommands.size}`);
  assert.deepEqual(legacyPollTested, ['createpoll', 'vote']);
});
