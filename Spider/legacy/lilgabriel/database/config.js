import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getCachedSettingsSync, invalidateSettings } from '../lib/settingsCache.js';

const DEFAULT_DATA = {
  settings: {
    device: process.env.DEVICE || 'default',
    prefix: process.env.PREFIX || process.env.BOT_PREFIX || '.',
    mode: process.env.MODE || 'public',
    autolike: false,
    autoview: false,
    autoread: false,
    autolikeemoji: '❤️',
    autobio: false,
    anticall: false,
    chatbotpm: false,
    presence: 'off',
    antidelete: true,
    antiedit: false,
    packname: process.env.BOT_NAME || 'SPIDER-MAN-MD',
    startmessage: true,
    multiprefix: false,
    autoai: false,
    antiviewonce: false,
    stealth: false,
    events: false,
  },
  sudoUsers: [],
  bannedUsers: [],
  groups: {},
};

let lastCwd = null;
let resolvedStorePath = null;
let memoryStore = null;

function ensureCwdCache() {
  const cwd = process.cwd();
  if (lastCwd !== cwd) {
    lastCwd = cwd;
    resolvedStorePath = null;
    memoryStore = null;
  }
}

function resolveStorePath() {
  ensureCwdCache();
  if (resolvedStorePath !== null) return resolvedStorePath;
  const candidates = [
    path.join(process.cwd(), 'data', 'legacy-config.json'),
    path.join(os.tmpdir(), 'spider-man-md', 'legacy-config.json'),
  ];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      const probe = path.join(path.dirname(candidate), `.probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.unlinkSync(probe);
      resolvedStorePath = candidate;
      return resolvedStorePath;
    } catch {
      // try next fallback location (for read-only serverless/container roots)
    }
  }
  resolvedStorePath = '';
  return resolvedStorePath;
}

function loadStore() {
  ensureCwdCache();
  if (memoryStore) return memoryStore;
  const cachedDefaults = getCachedSettingsSync() || {};
  const base = {
    settings: { ...DEFAULT_DATA.settings, ...cachedDefaults },
    sudoUsers: [],
    bannedUsers: [],
    groups: {},
  };
  const storePath = resolveStorePath();
  if (storePath && fs.existsSync(storePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      memoryStore = {
        settings: { ...base.settings, ...(parsed?.settings || {}) },
        sudoUsers: Array.isArray(parsed?.sudoUsers) ? parsed.sudoUsers : [],
        bannedUsers: Array.isArray(parsed?.bannedUsers) ? parsed.bannedUsers : [],
        groups: parsed?.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
      };
      return memoryStore;
    } catch {
      // fall through to initialized store
    }
  }
  memoryStore = base;
  return memoryStore;
}

function persistStore(store) {
  const storePath = resolveStorePath();
  if (!storePath) return false;
  try {
    const dir = path.dirname(storePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${storePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmpPath, storePath);
    return true;
  } catch {
    return false;
  }
}

export function getSettingsSync() {
  return { ...loadStore().settings };
}

export async function getSettings() {
  return getSettingsSync();
}

export function updateSettingSync(key, value) {
  const store = loadStore();
  store.settings[key] = value;
  persistStore(store);
  invalidateSettings();
  return { ...store.settings };
}

export async function updateSetting(key, value) {
  return updateSettingSync(key, value);
}

export function getGroupSettingsSync(groupJid) {
  const store = loadStore();
  const id = String(groupJid || '').trim();
  const current = store.groups[id] || {};
  return {
    welcome: false,
    goodbye: false,
    events: false,
    antibot: false,
    antilink: 'off',
    ...current,
  };
}

export async function getGroupSettings(groupJid) {
  return getGroupSettingsSync(groupJid);
}

export function updateGroupSettingSync(groupJid, key, value) {
  const store = loadStore();
  const id = String(groupJid || '').trim();
  if (!id) return getGroupSettingsSync(id);
  if (!store.groups[id] || typeof store.groups[id] !== 'object') {
    store.groups[id] = {};
  }
  store.groups[id][key] = value;
  persistStore(store);
  return getGroupSettingsSync(id);
}

export async function updateGroupSetting(groupJid, key, value) {
  return updateGroupSettingSync(groupJid, key, value);
}

export async function getSudoUsers() {
  const store = loadStore();
  const fromEnv = String(process.env.SUDO_NUMBERS || process.env.SUDO || '')
    .split(/[,;\s]+/)
    .map((n) => n.replace(/\D/g, ''))
    .filter(Boolean);
  let fromFile = [];
  try {
    const sudoFile = path.join(process.cwd(), 'data', 'sudo.json');
    if (fs.existsSync(sudoFile)) {
      const parsed = JSON.parse(fs.readFileSync(sudoFile, 'utf8'));
      if (Array.isArray(parsed)) {
        fromFile = parsed.map((n) => String(n).replace(/\D/g, '')).filter(Boolean);
      }
    }
  } catch {
    // ignore
  }
  return [...new Set([...(store.sudoUsers || []), ...fromEnv, ...fromFile])];
}

export async function getBannedUsers() {
  const store = loadStore();
  return Array.isArray(store.bannedUsers) ? [...store.bannedUsers] : [];
}

export default {
  getSettings,
  getSettingsSync,
  updateSetting,
  updateSettingSync,
  getGroupSettings,
  getGroupSettingsSync,
  updateGroupSetting,
  updateGroupSettingSync,
  setGroupSetting: updateGroupSettingSync,
  getSudoUsers,
  getBannedUsers,
};
