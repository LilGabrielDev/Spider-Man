import fs from 'fs';
import os from 'os';
import path from 'path';
import config from '../config.js';
import { cleanJid } from './groupRoleResolver.js';

export const ANTICALL_MODES = ['reject', 'block'];

function resolveWritableStorePath(fileName = 'anticall.json') {
  const candidates = [
    path.join(process.cwd(), 'data', fileName),
    path.join(os.tmpdir(), 'spider-man-data', fileName),
  ];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.accessSync(path.dirname(candidate), fs.constants.W_OK);
      return candidate;
    } catch {}
  }
  return candidates[1];
}

export function createAnticallStore({ filePath = '' } = {}) {
  let state = null;

  function load() {
    if (state) return state;
    const target = filePath || resolveWritableStorePath();
    try {
      if (fs.existsSync(target)) {
        const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
        state = {
          enabled: typeof parsed?.enabled === 'boolean' ? parsed.enabled : Boolean(config.ANTICALL),
          mode: ANTICALL_MODES.includes(parsed?.mode) ? parsed.mode : 'reject',
        };
        return state;
      }
    } catch {}
    state = {
      enabled: Boolean(config.ANTICALL),
      mode: 'reject',
    };
    return state;
  }

  function save(next) {
    const target = filePath || resolveWritableStorePath();
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(next, null, 2));
    } catch {}
  }

  return {
    getState() {
      return { ...load() };
    },
    setState(patch = {}) {
      const cur = load();
      const next = {
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
        mode: ANTICALL_MODES.includes(patch.mode) ? patch.mode : cur.mode,
      };
      state = next;
      save(next);
      return { ...next };
    },
    reset() {
      state = { enabled: Boolean(config.ANTICALL), mode: 'reject' };
      const target = filePath || resolveWritableStorePath();
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch {}
    },
  };
}

export const defaultAnticallStore = createAnticallStore();

const recentlyNotifiedCallers = new Map();

export function resetAnticallCooldowns() {
  recentlyNotifiedCallers.clear();
}

export async function handleAntiCallEvents({
  calls,
  sock,
  runtimeConfig = config,
  isAllowedCaller = null,
  store = defaultAnticallStore,
  cooldownMs = 60000,
  notify = true,
} = {}) {
  if (!sock || !Array.isArray(calls) || calls.length === 0) {
    return { handled: false, rejected: 0, blocked: 0 };
  }

  const state = store.getState();
  const isEnabled = Boolean(state.enabled || runtimeConfig?.ANTICALL === true);
  if (!isEnabled) {
    return { handled: false, rejected: 0, blocked: 0 };
  }

  let rejected = 0;
  let blocked = 0;
  const now = Date.now();

  for (const call of calls) {
    const callerJid = cleanJid(call?.from || call?.peerJid || call?.chatId || '');
    if (!callerJid) continue;
    if (typeof isAllowedCaller === 'function' && isAllowedCaller(callerJid)) {
      continue;
    }

    try {
      if (typeof sock.rejectCall === 'function' && call?.id) {
        await sock.rejectCall(call.id, callerJid);
        rejected += 1;
      } else if (typeof sock.sendCallOfferAck === 'function' && call?.id) {
        await sock.sendCallOfferAck(call.id, callerJid, 'reject');
        rejected += 1;
      }
    } catch {}

    const key = callerJid.toLowerCase();
    const lastSent = recentlyNotifiedCallers.get(key) || 0;
    if (notify && typeof sock.sendMessage === 'function' && now - lastSent >= cooldownMs) {
      recentlyNotifiedCallers.set(key, now);
      if (recentlyNotifiedCallers.size > 500) {
        for (const [k, ts] of recentlyNotifiedCallers.entries()) {
          if (now - ts >= cooldownMs) recentlyNotifiedCallers.delete(k);
        }
      }
      const noticeText =
        state.mode === 'block'
          ? '📵 *Anti-Call is active.* Incoming calls are automatically rejected and blocked.'
          : '📵 *Anti-Call is active.* Incoming calls are automatically rejected.';
      try {
        await sock.sendMessage(callerJid, { text: noticeText });
      } catch {}
    }

    if (state.mode === 'block' && typeof sock.updateBlockStatus === 'function') {
      try {
        await sock.updateBlockStatus(callerJid, 'block');
        blocked += 1;
      } catch {}
    }
  }

  return { handled: rejected > 0 || blocked > 0, rejected, blocked, mode: state.mode };
}
