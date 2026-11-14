import fs from 'node:fs';
import os from 'node:os';

const EXPLICIT_PROVIDER_ALIASES = {
  katabump: 'Katabump.com',
  'katabump.com': 'Katabump.com',
  'bot-hosting': 'Bot-Hosting.net',
  bothosting: 'Bot-Hosting.net',
  'bot-hosting.net': 'Bot-Hosting.net',
  optiklink: 'Optiklink.com',
  'optiklink.com': 'Optiklink.com',
  heroku: 'Heroku',
  railway: 'Railway',
  koyeb: 'Koyeb',
  render: 'Render',
  fly: 'Fly.io',
  'fly.io': 'Fly.io',
  flyio: 'Fly.io',
  replit: 'Replit',
  glitch: 'Glitch',
  github: 'GitHub Actions',
  'github actions': 'GitHub Actions',
  vercel: 'Vercel',
  docker: 'Docker',
  termux: 'Termux',
};

export function normalizeExplicitHostProvider(rawValue) {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) return '';
  const lowered = trimmed.toLowerCase();
  if (lowered === 'auto' || lowered === 'unknown' || lowered === 'unknown host') {
    return '';
  }
  return EXPLICIT_PROVIDER_ALIASES[lowered] || trimmed;
}

function readTextSafe(fsImpl, filePath) {
  try {
    if (!fsImpl.existsSync(filePath)) return '';
    return String(fsImpl.readFileSync(filePath, 'utf8'));
  } catch {
    return '';
  }
}

export function detectHostingProvider({
  env = process.env,
  config = null,
  probeSystem = env === process.env,
  fsImpl = fs,
  osImpl = os,
} = {}) {
  const safeEnv = env || {};
  const explicitRaw = safeEnv.HOST_PROVIDER || safeEnv.HOSTING_PROVIDER || '';
  const isLegacySampleDefault = String(explicitRaw).trim().toLowerCase() === 'bothosting';
  const explicit = normalizeExplicitHostProvider(explicitRaw);

  // Respect non-sample explicit overrides right away (e.g., HOST_PROVIDER=katabump).
  if (explicit && !isLegacySampleDefault) {
    return explicit;
  }

  // 1. Dedicated PaaS / Bot hosting markers
  if (
    safeEnv.DYNO ||
    safeEnv.HEROKU_APP_NAME ||
    (safeEnv.HEROKU_API_KEY && safeEnv.HEROKU_APP_NAME)
  ) {
    return 'Heroku';
  }

  const hostHints = [
    safeEnv.HOSTNAME,
    safeEnv.HOST,
    safeEnv.HOSTING_URL,
    safeEnv.P_SERVER_LOCATION,
    safeEnv.SERVER_NAME,
    safeEnv.APP_URL,
  ]
    .filter(Boolean)
    .join(' ');

  if (safeEnv.KATABUMP || /katabump/i.test(hostHints)) {
    return 'Katabump.com';
  }
  if (safeEnv.BOTHOSTING || /bot-?hosting/i.test(hostHints)) {
    return 'Bot-Hosting.net';
  }
  if (safeEnv.OPTIKLINK || /optiklink/i.test(hostHints)) {
    return 'Optiklink.com';
  }

  if (
    safeEnv.RAILWAY_ENVIRONMENT ||
    safeEnv.RAILWAY_PROJECT_ID ||
    safeEnv.RAILWAY_STATIC_URL ||
    safeEnv.RAILWAY_SERVICE_NAME
  ) {
    return 'Railway';
  }

  if (
    safeEnv.RENDER ||
    safeEnv.RENDER_SERVICE_ID ||
    safeEnv.RENDER_EXTERNAL_URL ||
    safeEnv.RENDER_INSTANCE_ID
  ) {
    return 'Render';
  }

  if (
    safeEnv.KOYEB_ENV ||
    safeEnv.KOYEB_SERVICE_ID ||
    safeEnv.KOYEB_APP_NAME ||
    safeEnv.KOYEB_REGION
  ) {
    return 'Koyeb';
  }

  if (safeEnv.FLY_APP_NAME || safeEnv.FLY_MACHINE_ID || safeEnv.FLY_REGION) {
    return 'Fly.io';
  }

  if (safeEnv.K_SERVICE || safeEnv.CLOUD_RUN_JOB) {
    return 'Google Cloud Run';
  }
  if (safeEnv.FUNCTION_TARGET || safeEnv.GAE_APPLICATION) {
    return 'Google Cloud';
  }

  if (
    safeEnv.REPL_ID ||
    safeEnv.REPLIT_DEPLOYMENT ||
    safeEnv.REPL_OWNER ||
    safeEnv.REPLIT_DB_URL
  ) {
    return 'Replit';
  }

  if (safeEnv.PROJECT_DOMAIN || safeEnv.PROJECT_REMIX_CHAIN || safeEnv.GLITCH_DEBUGGER) {
    return 'Glitch';
  }

  if (safeEnv.VERCEL || safeEnv.VERCEL_ENV || safeEnv.NOW_REGION) {
    return 'Vercel';
  }

  if (safeEnv.AWS_LAMBDA_FUNCTION_NAME) {
    return 'AWS Lambda';
  }
  if (safeEnv.ECS_CONTAINER_METADATA_URI || safeEnv.ECS_CONTAINER_METADATA_URI_V4) {
    return 'AWS ECS';
  }

  if (safeEnv.WEBSITE_SITE_NAME || safeEnv.CONTAINER_APP_NAME) {
    return 'Azure';
  }

  if (safeEnv.DIGITALOCEAN_APP_ID) {
    return 'DigitalOcean';
  }

  if (safeEnv.CODESPACES) {
    return 'GitHub Codespaces';
  }
  if (safeEnv.GITHUB_WORKFLOW || safeEnv.GITHUB_ACTIONS) {
    return 'GitHub Actions';
  }

  if (safeEnv.TERMUX_VERSION || /com\.termux/i.test(`${safeEnv.PREFIX || ''} ${safeEnv.HOME || ''}`)) {
    return 'Termux';
  }

  // Pterodactyl / Katabump / Game & Bot Panel eggs
  if (
    safeEnv.P_SERVER_UUID ||
    safeEnv.P_SERVER_LOCATION ||
    safeEnv.SERVER_PORT ||
    safeEnv.SERVER_MEMORY ||
    safeEnv.STARTUP ||
    (safeEnv.USER === 'container' && safeEnv.HOME === '/home/container')
  ) {
    return 'Katabump / Panel';
  }

  // Live OS / container probes when running on the real host (not synthetic env tests)
  if (probeSystem) {
    const sysHostname = String(osImpl.hostname?.() || '');
    if (/katabump/i.test(sysHostname)) return 'Katabump.com';
    if (/bot-?hosting/i.test(sysHostname)) return 'Bot-Hosting.net';
    if (/optiklink/i.test(sysHostname)) return 'Optiklink.com';

    try {
      if (fsImpl.existsSync('/home/container')) {
        return 'Katabump / Panel';
      }
    } catch {}

    const cgroupText = readTextSafe(fsImpl, '/proc/1/cgroup');
    const isDocker =
      (() => {
        try {
          return fsImpl.existsSync('/.dockerenv');
        } catch {
          return false;
        }
      })() || /docker|containerd|kubepods|lxc/i.test(cgroupText);

    if (isDocker) {
      return 'Docker';
    }

    const platform = String(osImpl.platform?.() || process.platform || '');
    if (platform === 'linux') return 'Linux VPS';
    if (platform === 'darwin') return 'macOS';
    if (platform === 'win32') return 'Windows';
  }

  const configFallback = normalizeExplicitHostProvider(config?.HOSTING_PROVIDER);
  if (configFallback && configFallback !== 'Bot-Hosting.net') {
    return configFallback;
  }

  if (explicit) {
    return explicit;
  }

  return 'Panel';
}
