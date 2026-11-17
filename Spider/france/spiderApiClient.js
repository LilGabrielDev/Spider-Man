import axios from 'axios';

export const BASE_URL = 'https://knightbotapi.stream';

const DEFAULT_TIMEOUT_MS = 14_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const DEFAULT_HEADERS = Object.freeze({
  Accept: 'application/json, image/png, image/jpeg, */*',
  'User-Agent': 'SPIDER-MAN-MD/3.0 (KnightBotAPI integration)',
});

export function getApiKey() {
  return String(process.env.KNIGHTBOT_API_KEY || 'knight').trim() || 'knight';
}

export function assertApiPath(apiPath) {
  if (typeof apiPath !== 'string' || !/^\/api\/[a-z0-9/_-]+$/i.test(apiPath)) {
    throw new Error('Invalid KnightBotAPI route.');
  }
}

export async function request(apiPath, params = {}, options = {}) {
  assertApiPath(apiPath);
  const apiKey = getApiKey();
  const maxBytes = options.maxContentLength || MAX_JSON_BYTES;
  const response = await axios.get(`${BASE_URL}${apiPath}`, {
    params: { ...params, apikey: apiKey },
    headers: { ...DEFAULT_HEADERS, 'X-API-Key': apiKey },
    timeout: options.timeout || DEFAULT_TIMEOUT_MS,
    responseType: options.responseType || 'json',
    maxContentLength: maxBytes,
    maxBodyLength: MAX_JSON_BYTES,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    const errMsg = response.data?.error || response.data?.message;
    throw new Error(
      `KnightBotAPI returned HTTP ${response.status}${typeof errMsg === 'string' ? `: ${errMsg}` : ''}`,
    );
  }
  return response;
}

export async function requestJson(apiPath, params = {}, options = {}) {
  const response = await request(apiPath, params, { ...options, responseType: 'json' });
  const data = response.data;
  if (!data || typeof data !== 'object' || data.success !== true) {
    throw new Error(data?.error || data?.message || 'KnightBotAPI returned no result.');
  }
  return data;
}

export async function requestRaw(apiPath, params = {}, options = {}) {
  return request(apiPath, params, { ...options, responseType: 'arraybuffer' });
}

export function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

export function extractDownload(payload) {
  if (isHttpUrl(payload)) return payload.trim();
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractDownload(item);
      if (found) return found;
    }
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;

  const directKeys = [
    'download',
    'downloadUrl',
    'download_url',
    'mediaUrl',
    'media_url',
    'video',
    'audio',
    'media',
    'url',
    'link',
    'cdn',
    'playUrl',
    'play_url',
  ];
  for (const key of directKeys) {
    const val = payload[key];
    if (isHttpUrl(val)) return val.trim();
    if (val && typeof val === 'object') {
      const nested = extractDownload(val);
      if (nested) return nested;
    }
  }

  const listKeys = ['videos', 'images', 'mediaList', 'items', 'result', 'data'];
  for (const key of listKeys) {
    const nested = extractDownload(payload[key]);
    if (nested) return nested;
  }

  return null;
}

export function extractMediaList(payload, keys = ['videos', 'images', 'media', 'items']) {
  const lists = Array.isArray(payload)
    ? [payload]
    : keys.map((k) => payload?.[k]).filter(Array.isArray);
  const urls = [];
  for (const list of lists) {
    for (const entry of list) {
      const url = typeof entry === 'string' ? entry : extractDownload(entry);
      if (isHttpUrl(url) && !urls.includes(url)) {
        urls.push(url);
      }
    }
  }
  return urls;
}

export function extractTitle(payload, fallback = 'KnightBotAPI media') {
  return String(payload?.title || payload?.name || payload?.caption || fallback).trim();
}

export function summarizeError(err) {
  if (err?.response?.status) {
    return `KnightBotAPI HTTP ${err.response.status}`;
  }
  return err?.message || 'KnightBotAPI request failed';
}
