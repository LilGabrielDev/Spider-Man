import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  runPlay,
  extractYouTubeId,
  extractAudioCandidates,
} from '../commands/Play.js';

function makeSock() {
  const sent = [];
  return {
    sent,
    async sendMessage(to, payload, opts) {
      sent.push({ to, payload, opts });
      return { key: { id: `msg-${sent.length}` } };
    },
  };
}

function makeFakeMp3Buffer(label = 'MP3') {
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00]), Buffer.from(`fake-${label}-audio-bytes`)]);
}

function makeFakeMp4Buffer(label = 'MP4') {
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]), Buffer.from(label)]);
}

const baseConfig = {
  BOT_NAME: 'Spider Man',
  OWNER_NAME: 'LilTech',
  BOT_PIC: '',
};

const baseMsg = {
  key: { remoteJid: '12345@s.whatsapp.net', id: 'req-1' },
};

test('extractYouTubeId and extractAudioCandidates handle URLs, arrays, objects, and video fallback', () => {
  assert.equal(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://www.youtube.com/shorts/kJQP7kiw5Fk'), 'kJQP7kiw5Fk');
  assert.equal(extractYouTubeId('not a url'), null);

  const audioOnly = extractAudioCandidates(
    {
      audio: ['https://cdn.test/a1.mp3', { url: 'https://cdn.test/a2.mp3' }],
      video: 'https://cdn.test/v1.mp4',
    },
    { allowVideoFallback: false },
  );
  assert.deepEqual(audioOnly, [
    { source: 'https://cdn.test/a1.mp3', kind: 'audio' },
    { source: 'https://cdn.test/a2.mp3', kind: 'audio' },
  ]);

  const withVideo = extractAudioCandidates(
    {
      audio: 'https://cdn.test/a1.mp3',
      video: 'https://cdn.test/v1.mp4',
      video_hd: { downloadUrl: 'https://cdn.test/vhd.mp4' },
    },
    { allowVideoFallback: true },
  );
  assert.deepEqual(withVideo, [
    { source: 'https://cdn.test/a1.mp3', kind: 'audio' },
    { source: 'https://cdn.test/v1.mp4', kind: 'video' },
    { source: 'https://cdn.test/vhd.mp4', kind: 'video' },
  ]);
});

test('runPlay never sends broken AUDIO RECOVERY message when hosted sources fail and no local yt-dlp is installed', async () => {
  const sock = makeSock();
  await runPlay(
    { sock, from: '12345@s.whatsapp.net', text: 'Faded', msg: baseMsg, config: baseConfig },
    {
      ffmpegPath: null,
      skipBuiltinFallbacks: true,
      search: async () => ({
        videos: [
          {
            videoId: '60ItHLz5WEA',
            url: 'https://www.youtube.com/watch?v=60ItHLz5WEA',
            title: 'Alan Walker - Faded',
            author: { name: 'Alan Walker' },
            timestamp: '3:32',
            thumbnail: 'https://i.ytimg.com/vi/60ItHLz5WEA/hqdefault.jpg',
          },
        ],
      }),
      http: {
        async get() {
          throw new Error('Request failed with status code 500');
        },
      },
      apiConfig: {
        nayanApi: { youtube: 'https://nayan.test/ytdown', timeout: 5000 },
        noobsApi: 'https://noobs.test',
      },
    },
  );

  const texts = sock.sent
    .map((m) => m.payload.text || m.payload.caption || '')
    .join('\n');
  assert.doesNotMatch(texts, /AUDIO RECOVERY/i);
  assert.doesNotMatch(texts, /Hosted sources are unavailable/i);
  assert.match(texts, /PLAYBACK STATUS/);
});

test('runPlay falls back from failed audio URL to video URL and transcodes to MP3 via ffmpeg', async () => {
  const sock = makeSock();
  const requestedUrls = [];
  let ffmpegArgs = null;

  await runPlay(
    { sock, from: '12345@s.whatsapp.net', text: 'Never Gonna Give You Up', msg: baseMsg, config: baseConfig },
    {
      ffmpegPath: '/usr/bin/ffmpeg',
      skipBuiltinFallbacks: true,
      async execFile(_bin, args) {
        ffmpegArgs = args;
        const outPath = args[args.length - 1];
        fs.writeFileSync(outPath, makeFakeMp3Buffer('transcoded'));
      },
      search: async () => ({
        videos: [
          {
            videoId: 'dQw4w9WgXcQ',
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            title: 'Rick Astley - Never Gonna Give You Up',
            author: { name: 'Rick Astley' },
            timestamp: '3:33',
            thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
          },
        ],
      }),
      http: {
        async get(url) {
          requestedUrls.push(url);
          if (url.includes('nayan.test/ytdown')) {
            return {
              status: 200,
              data: {
                status: true,
                data: {
                  title: 'Rick Astley - Never Gonna Give You Up',
                  audio: 'https://cdn.test/broken-audio.webm',
                  video: 'https://cdn.test/working-video.mp4',
                },
              },
            };
          }
          if (url === 'https://cdn.test/broken-audio.webm') {
            throw new Error('403 Forbidden');
          }
          if (url === 'https://cdn.test/working-video.mp4') {
            return {
              status: 200,
              headers: { 'content-type': 'video/mp4' },
              data: makeFakeMp4Buffer('video'),
            };
          }
          throw new Error('noobs offline');
        },
      },
      apiConfig: {
        nayanApi: { youtube: 'https://nayan.test/ytdown', timeout: 25000 },
        noobsApi: 'https://noobs.test',
      },
    },
  );

  assert.ok(requestedUrls.includes('https://cdn.test/broken-audio.webm'));
  assert.ok(requestedUrls.includes('https://cdn.test/working-video.mp4'));
  assert.ok(ffmpegArgs && ffmpegArgs.includes('-vn'));
  const audioMsg = sock.sent.find((m) => Buffer.isBuffer(m.payload.audio));
  assert.ok(audioMsg, 'expected final audio message to be sent');
  assert.equal(audioMsg.payload.mimetype, 'audio/mpeg');
  assert.match(audioMsg.payload.fileName, /\.mp3$/);
});

test('runPlay rejects HTML/JSON error pages returned with 200 OK before FFmpeg and falls back cleanly', async () => {
  const sock = makeSock();
  let ffmpegInputs = 0;

  await runPlay(
    { sock, from: '12345@s.whatsapp.net', text: 'Test HTML Guard', msg: baseMsg, config: baseConfig },
    {
      ffmpegPath: '/usr/bin/ffmpeg',
      skipBuiltinFallbacks: true,
      async execFile(_bin, args) {
        ffmpegInputs += 1;
        const outPath = args[args.length - 1];
        fs.writeFileSync(outPath, makeFakeMp3Buffer('clean'));
      },
      search: async () => ({
        videos: [
          {
            videoId: 'abc12345678',
            url: 'https://www.youtube.com/watch?v=abc12345678',
            title: 'Test HTML Guard',
            author: { name: 'Tester' },
            timestamp: '2:10',
          },
        ],
      }),
      http: {
        async get(url) {
          if (url.includes('nayan.test/ytdown')) {
            return {
              status: 200,
              data: {
                data: {
                  audio: 'https://cdn.test/fake-error-page.mp3',
                  video: 'https://cdn.test/valid-stream.mp4',
                },
              },
            };
          }
          if (url === 'https://cdn.test/fake-error-page.mp3') {
            return {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              data: Buffer.from('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>'),
            };
          }
          if (url === 'https://cdn.test/valid-stream.mp4') {
            return {
              status: 200,
              headers: { 'content-type': 'video/mp4' },
              data: makeFakeMp4Buffer('valid'),
            };
          }
          throw new Error('noobs unavailable');
        },
      },
      apiConfig: {
        nayanApi: { youtube: 'https://nayan.test/ytdown', timeout: 20000 },
        noobsApi: 'https://noobs.test',
      },
    },
  );

  assert.equal(ffmpegInputs, 1);
  const audioMsg = sock.sent.find((m) => Buffer.isBuffer(m.payload.audio));
  assert.ok(audioMsg);
});

test('runPlay falls back to alternate yt-search result when primary match fails hosted downloaders', async () => {
  const sock = makeSock();
  await runPlay(
    { sock, from: '12345@s.whatsapp.net', text: 'Despacito', msg: baseMsg, config: baseConfig },
    {
      ffmpegPath: null,
      search: async () => ({
        videos: [
          {
            videoId: 'kJQP7kiw5Fk',
            url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
            title: 'Despacito (Official)',
            author: { name: 'Luis Fonsi' },
            timestamp: '4:42',
          },
          {
            videoId: 'alt99999999',
            url: 'https://www.youtube.com/watch?v=alt99999999',
            title: 'Despacito (Audio)',
            author: { name: 'Luis Fonsi' },
            timestamp: '3:48',
          },
        ],
      }),
      http: {
        async get(url) {
          if (url.includes('nayan.test/ytdown') && url.includes('alt99999999')) {
            return {
              status: 200,
              data: { status: true, data: { audio: 'https://cdn.test/alt-despacito.mp3' } },
            };
          }
          if (url === 'https://cdn.test/alt-despacito.mp3') {
            return {
              status: 200,
              headers: { 'content-type': 'audio/mpeg' },
              data: makeFakeMp3Buffer('alt'),
            };
          }
          throw new Error('primary video unavailable');
        },
      },
      apiConfig: {
        nayanApi: { youtube: 'https://nayan.test/ytdown', timeout: 20000 },
        noobsApi: 'https://noobs.test',
      },
    },
  );

  const audioMsg = sock.sent.find((m) => Buffer.isBuffer(m.payload.audio));
  assert.ok(audioMsg);
  assert.equal(audioMsg.payload.mimetype, 'audio/mpeg');
});

test('runPlay resolves direct YouTube URLs even when yt-search returns empty and supports silent yt-dlp fallback', async () => {
  const sock = makeSock();
  let ytDlpCalledWith = null;

  await runPlay(
    {
      sock,
      from: '12345@s.whatsapp.net',
      text: 'https://youtu.be/dQw4w9WgXcQ',
      msg: baseMsg,
      config: baseConfig,
    },
    {
      ffmpegPath: '/usr/bin/ffmpeg',
      skipBuiltinFallbacks: true,
      search: async () => ({ videos: [] }),
      http: {
        async get() {
          throw new Error('hosted API down');
        },
      },
      apiConfig: {
        nayanApi: { youtube: 'https://nayan.test/ytdown', timeout: 5000 },
        noobsApi: 'https://noobs.test',
      },
      async downloadWithYtDlp(videoUrl, tmpDir) {
        ytDlpCalledWith = videoUrl;
        const filePath = path.join(tmpDir, 'yt-dlp-source.m4a');
        fs.writeFileSync(filePath, Buffer.from('fake-m4a-data'));
        return filePath;
      },
      async execFile(_bin, args) {
        const outPath = args[args.length - 1];
        fs.writeFileSync(outPath, makeFakeMp3Buffer('local'));
      },
    },
  );

  assert.equal(ytDlpCalledWith, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const texts = sock.sent
    .map((m) => m.payload.text || m.payload.caption || '')
    .join('\n');
  assert.doesNotMatch(texts, /AUDIO RECOVERY/i);
  const audioMsg = sock.sent.find((m) => Buffer.isBuffer(m.payload.audio));
  assert.ok(audioMsg);
});
