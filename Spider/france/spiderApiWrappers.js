import * as api from './api.js';
import getTikTokMediaLegacy from './Tok.js';
import { getInstaMedia as getInstaMediaLegacy } from './Insta.js';
import { API_CONFIG as BASE_API_CONFIG } from './config.js';
import {
  BASE_URL,
  getApiKey,
  requestJson,
  extractDownload,
  extractTitle,
  isHttpUrl,
  summarizeError,
} from './spiderApiClient.js';

const ytAudioEndpoint = new URL('/api/download/ytaudio', BASE_URL);
ytAudioEndpoint.searchParams.set('apikey', getApiKey());

export const API_CONFIG = {
  ...BASE_API_CONFIG,
  nayanApi: {
    ...BASE_API_CONFIG.nayanApi,
    youtube: ytAudioEndpoint.toString(),
  },
};

async function knightResult(apiPath, params) {
  const res = await requestJson(apiPath, params, { timeout: 20_000 });
  const result = res.result ?? res.data ?? {};
  const url = extractDownload(result);
  if (!url) {
    throw new Error('KnightBotAPI returned no media URL.');
  }
  return {
    result,
    url,
    title: extractTitle(result, params.url || 'Downloaded media'),
  };
}

export async function videoDownload(url, ...rest) {
  try {
    if (!isHttpUrl(url)) throw new Error('A public URL is required.');
    const { result, url: mediaUrl, title } = await knightResult('/api/download', {
      url,
      type: 'mp4',
    });
    return {
      success: true,
      title,
      thumbnail: result.thumbnail || result.thumb || '',
      links: { high: mediaUrl, sd: mediaUrl },
    };
  } catch (err) {
    console.warn('KnightBotAPI videoDownload fallback:', summarizeError(err));
    return api.videoDownload(url, ...rest);
  }
}

export async function getTikTokMedia(url, ...rest) {
  try {
    if (!isHttpUrl(url)) throw new Error('A public URL is required.');
    const { result, url: videoUrl, title } = await knightResult('/api/download/tiktok', { url });
    return {
      ...result,
      success: true,
      video: videoUrl,
      title,
    };
  } catch (err) {
    console.warn('KnightBotAPI TikTok fallback:', summarizeError(err));
    return getTikTokMediaLegacy(url, ...rest);
  }
}

export async function getInstaMedia(url, ...rest) {
  try {
    if (!isHttpUrl(url)) throw new Error('A public URL is required.');
    const res = await requestJson('/api/download/instagram', { url }, { timeout: 20_000 });
    const raw = res.result ?? res.data ?? {};
    const items = Array.isArray(raw)
      ? raw
      : ['videos', 'images', 'media', 'items', 'data'].flatMap((key) =>
          Array.isArray(raw?.[key]) ? raw[key] : [],
        );

    const mediaItems = items
      .map((item) => {
        const mediaUrl = typeof item === 'string' ? item : extractDownload(item);
        if (!isHttpUrl(mediaUrl)) return null;
        const type =
          item?.type === 'video' || item?.isVideo || /\.mp4(?:[?#]|$)/i.test(mediaUrl)
            ? 'video'
            : 'image';
        return { url: mediaUrl, type };
      })
      .filter(Boolean);

    if (!mediaItems.length) {
      const fallbackUrl = extractDownload(raw);
      if (isHttpUrl(fallbackUrl)) {
        mediaItems.push({
          url: fallbackUrl,
          type: /\.mp4(?:[?#]|$)/i.test(fallbackUrl) ? 'video' : 'image',
        });
      }
    }

    if (!mediaItems.length) {
      throw new Error('KnightBotAPI returned no Instagram media.');
    }

    return { error: null, data: mediaItems };
  } catch (err) {
    console.warn('KnightBotAPI Instagram fallback:', summarizeError(err));
    return getInstaMediaLegacy(url, ...rest);
  }
}

export async function facebookDownload(url, ...rest) {
  try {
    if (!isHttpUrl(url)) throw new Error('A public URL is required.');
    const { result, url: mediaUrl, title } = await knightResult('/api/download/facebook', { url });
    const thumbnail = [result.thumbnail, result.thumb, result.image].find(isHttpUrl);
    if (!thumbnail) {
      throw new Error('KnightBotAPI returned no Facebook thumbnail; trying the existing provider.');
    }
    return {
      ...result,
      title,
      url: result.originalUrl || url,
      thumbnail,
      hd: result.hd || result.high || mediaUrl,
      sd: result.sd || result.low || mediaUrl,
    };
  } catch (err) {
    console.warn('KnightBotAPI Facebook fallback:', summarizeError(err));
    return api.facebookDownload(url, ...rest);
  }
}

export async function spotifySearch(query, ...rest) {
  if (!/https?:\/\/(?:open\.)?spotify\.com\//i.test(String(query || ''))) {
    return api.spotifySearch(query, ...rest);
  }
  try {
    const { result, url: audioUrl, title } = await knightResult('/api/download/spotify', {
      url: query,
    });
    const thumbnail = result.thumbnail || result.image;
    if (!isHttpUrl(thumbnail)) {
      throw new Error('KnightBotAPI returned no Spotify artwork; trying the existing provider.');
    }
    return {
      success: true,
      data: {
        title,
        artist: result.artist || result.author || 'Unknown artist',
        duration: result.duration || 'N/A',
        popularity: result.popularity || 'N/A',
        thumbnail,
        url: result.url || query,
        audio: audioUrl,
      },
    };
  } catch (err) {
    console.warn('KnightBotAPI Spotify fallback:', summarizeError(err));
    return api.spotifySearch(query, ...rest);
  }
}
