import fs from 'node:fs';
import os from 'node:os';
import dns from 'node:dns';

const CACHE_TTL_MS = 60 * 60 * 1000;
const ERROR_CACHE_TTL_MS = 60 * 1000;
const NETWORK_TIMEOUT_MS = 2000;

let networkProbeCache = {
  resolvedAt: 0,
  ttlMs: 0,
  hint: null,
};
let inFlightNetworkProbe = null;

const EXPLICIT_PROVIDER_ALIASES = {
  katabump: 'Katabump.com',
  'katabump.com': 'Katabump.com',
  'bot-hosting': 'Bot-Hosting.net',
  bothosting: 'Bot-Hosting.net',
  'bot-hosting.net': 'Bot-Hosting.net',
  optiklink: 'Optiklink.com',
  'optiklink.com': 'Optiklink.com',
  cybrancee: 'Cybrancee',
  pella: 'Pella.app',
  'pella.app': 'Pella.app',
  solarhosting: 'SolarHosting',
  witherhosting: 'WitherHosting',
  bisecthosting: 'BisectHosting',
  falix: 'FalixNodes',
  falixnodes: 'FalixNodes',
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
  hetzner: 'Hetzner',
  ovh: 'OVHcloud',
  ovhcloud: 'OVHcloud',
  contabo: 'Contabo',
  digitalocean: 'DigitalOcean',
  vultr: 'Vultr',
  linode: 'Linode',
  oracle: 'Oracle Cloud',
  'oracle cloud': 'Oracle Cloud',
  aws: 'AWS',
  azure: 'Azure',
  gcp: 'Google Cloud',
  'google cloud': 'Google Cloud',
};

const SECRET_OR_PROMO_ENV_RE =
  /^(?:SESSION.*|HOSTING_URL|CHANNEL_.*|BOT_PIC|MENU_IMAGES|GITHUB_REPO|UPDATE_REPOSITORY|AUTO_JOIN_GROUP_LINK|OWNER_.*|USER_LID|.*(?:KEY|SECRET|TOKEN|PASS|PWD_HASH|COOKIE|AUTH|DSN|DATABASE_URL).*)$/i;

const KNOWN_BRAND_PATTERNS = [
  { pattern: /\bkatabump\b|katabump\.com|\bkatabamp\b/i, label: 'Katabump.com', isBotHost: true },
  { pattern: /bot-?hosting\.net|\bbot-?hosting\b/i, label: 'Bot-Hosting.net', isBotHost: true },
  { pattern: /\boptiklink\b|optiklink\.com/i, label: 'Optiklink.com', isBotHost: true },
  { pattern: /\bcybrancee\b/i, label: 'Cybrancee', isBotHost: true },
  { pattern: /\bpella\.app\b/i, label: 'Pella.app', isBotHost: true },
  { pattern: /\bsolarhosting\b/i, label: 'SolarHosting', isBotHost: true },
  { pattern: /\bwitherhosting\b/i, label: 'WitherHosting', isBotHost: true },
  { pattern: /\bbisecthosting\b/i, label: 'BisectHosting', isBotHost: true },
  { pattern: /\bfalixnodes\b|\bfalix\b/i, label: 'FalixNodes', isBotHost: true },
  { pattern: /\bherokuapp\.com\b|\bheroku\b/i, label: 'Heroku', isBotHost: true },
  { pattern: /\brailway\.app\b|\brailway\.internal\b/i, label: 'Railway', isBotHost: true },
  { pattern: /\bonrender\.com\b|\brender\.com\b/i, label: 'Render', isBotHost: true },
  { pattern: /\bkoyeb\.app\b|\bkoyeb\b/i, label: 'Koyeb', isBotHost: true },
  { pattern: /\bfly\.dev\b|\bfly\.io\b|\bflyio\b/i, label: 'Fly.io', isBotHost: true },
  { pattern: /\breplit\.co\b|\brepl\.co\b|\breplit\.dev\b/i, label: 'Replit', isBotHost: true },
  { pattern: /\bglitch\.me\b|\bglitch\.com\b/i, label: 'Glitch', isBotHost: true },
  { pattern: /\bvercel\.app\b|\bvercel\.com\b/i, label: 'Vercel', isBotHost: true },
  { pattern: /\bgoogle(?:\s+llc|\s+cloud)?\b|googleusercontent\.com|\bgoogle\.internal\b|\bcloud\.goog\b/i, label: 'Google Cloud', isBotHost: false },
  { pattern: /\bamazon(?:\.com|\s+web\s+services|\s+ec2)?\b|amazonaws\.com|\bec2\.internal\b/i, label: 'AWS', isBotHost: false },
  { pattern: /\bmicrosoft\s+(?:corporation|azure)\b|\bazure\b/i, label: 'Azure', isBotHost: false },
  { pattern: /\bdigitalocean\b/i, label: 'DigitalOcean', isBotHost: false },
  { pattern: /\bhetzner\b/i, label: 'Hetzner', isBotHost: false },
  { pattern: /\bovh(?:cloud|\s+sas|\s+hosting)?\b|\.ovh\.(?:net|ca|us)\b/i, label: 'OVHcloud', isBotHost: false },
  { pattern: /\bcontabo\b/i, label: 'Contabo', isBotHost: false },
  { pattern: /\bvultr\b|\bchoopa\b/i, label: 'Vultr', isBotHost: false },
  { pattern: /\blinode\b|\bakamai\s+connected\s+cloud\b/i, label: 'Linode', isBotHost: false },
  { pattern: /\boracle(?:\s+cloud|\s+corporation)?\b|\boraclecloud\b/i, label: 'Oracle Cloud', isBotHost: false },
  { pattern: /\bscaleway\b|\bonline\s+sas\b/i, label: 'Scaleway', isBotHost: false },
  { pattern: /\bcloudflare\b/i, label: 'Cloudflare', isBotHost: false },
];

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
    if (!fsImpl?.existsSync?.(filePath)) return '';
    return String(fsImpl.readFileSync(filePath, 'utf8'));
  } catch {
    return '';
  }
}

function fileExistsSafe(fsImpl, filePath) {
  try {
    return Boolean(fsImpl?.existsSync?.(filePath));
  } catch {
    return false;
  }
}

function matchProviderFromText(text, { includeDatacenters = true } = {}) {
  const input = String(text || '').trim();
  if (!input) return null;
  for (const entry of KNOWN_BRAND_PATTERNS) {
    if (!includeDatacenters && !entry.isBotHost) continue;
    if (entry.pattern.test(input)) {
      return { label: entry.label, isBotHost: entry.isBotHost };
    }
  }
  return null;
}

function collectSafeEnvHints(safeEnv) {
  const parts = [];
  for (const [key, value] of Object.entries(safeEnv)) {
    if (!value || typeof value !== 'string') continue;
    if (SECRET_OR_PROMO_ENV_RE.test(key)) continue;
    if (/^(?:HOST_PROVIDER|HOSTING_PROVIDER)$/i.test(key)) continue;
    parts.push(`${key}=${value}`);
  }
  return parts.join(' ');
}

function collectSystemProbeText(fsImpl, osImpl) {
  const parts = [
    String(osImpl?.hostname?.() || ''),
    readTextSafe(fsImpl, '/etc/hostname'),
    readTextSafe(fsImpl, '/etc/resolv.conf'),
    readTextSafe(fsImpl, '/etc/hosts'),
    readTextSafe(fsImpl, '/sys/class/dmi/id/sys_vendor'),
    readTextSafe(fsImpl, '/sys/class/dmi/id/product_name'),
    readTextSafe(fsImpl, '/sys/class/dmi/id/bios_vendor'),
    readTextSafe(fsImpl, '/sys/class/dmi/id/board_vendor'),
  ];
  return parts.filter(Boolean).join('\n');
}

function isPterodactylPanelEnv(safeEnv, probeSystem, fsImpl) {
  if (
    safeEnv.P_SERVER_UUID ||
    safeEnv.P_SERVER_LOCATION ||
    safeEnv.P_SERVER_ALLOCATION_LIMIT ||
    safeEnv.SERVER_PORT ||
    safeEnv.SERVER_MEMORY ||
    safeEnv.STARTUP ||
    (safeEnv.USER === 'container' && safeEnv.HOME === '/home/container')
  ) {
    return true;
  }
  if (probeSystem && fileExistsSafe(fsImpl, '/home/container')) {
    return true;
  }
  return false;
}

function formatPanelOrHostMatch(match, isPanel) {
  if (!match) return '';
  if (match.isBotHost || !isPanel) {
    return match.label;
  }
  return `Panel (${match.label})`;
}

export function resetHostDetectorCache() {
  networkProbeCache = { resolvedAt: 0, ttlMs: 0, hint: null };
  inFlightNetworkProbe = null;
}

export function resolveNetworkHostHint({ ip, ptrHostnames = [], isp = '', org = '', domain = '' } = {}) {
  const combined = [...ptrHostnames, domain, org, isp].filter(Boolean).join(' ');
  const brandMatch = matchProviderFromText(combined, { includeDatacenters: true });
  if (brandMatch) {
    return brandMatch;
  }
  const cleanOrg = String(org || isp || '')
    .replace(/\s+(?:LLC|Inc\.?|Ltd\.?|GmbH|SAS|B\.V\.|S\.A\.|Corp\.?|Limited)$/i, '')
    .trim();
  if (cleanOrg && !/^(?:unknown|none|n\/a)$/i.test(cleanOrg)) {
    return { label: cleanOrg, isBotHost: false };
  }
  return null;
}

async function fetchJsonWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer?.unref?.();
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res?.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function reverseDnsWithTimeout(dnsImpl, ip, timeoutMs) {
  if (!ip || typeof dnsImpl?.reverse !== 'function') return [];
  let timer;
  try {
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve([]), timeoutMs);
      timer?.unref?.();
    });
    const lookupPromise = Promise.resolve(dnsImpl.reverse(ip)).catch(() => []);
    const result = await Promise.race([lookupPromise, timeoutPromise]);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function warmHostingProviderCache({
  force = false,
  timeoutMs = NETWORK_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  dnsImpl = dns.promises,
} = {}) {
  const now = Date.now();
  if (!force && networkProbeCache.resolvedAt && now - networkProbeCache.resolvedAt < networkProbeCache.ttlMs) {
    return networkProbeCache.hint;
  }
  if (!force && inFlightNetworkProbe) {
    return inFlightNetworkProbe;
  }
  if (typeof fetchImpl !== 'function') {
    return null;
  }

  inFlightNetworkProbe = (async () => {
    try {
      let ip = '';
      let isp = '';
      let org = '';
      let domain = '';

      const ipwho = await fetchJsonWithTimeout(fetchImpl, 'https://ipwho.is/', timeoutMs);
      if (ipwho && ipwho.success !== false) {
        ip = String(ipwho.ip || '');
        isp = String(ipwho.connection?.isp || '');
        org = String(ipwho.connection?.org || '');
        domain = String(ipwho.connection?.domain || '');
      }

      if (!ip && !org && !isp) {
        const ipinfo = await fetchJsonWithTimeout(fetchImpl, 'https://ipinfo.io/json', timeoutMs);
        if (ipinfo) {
          ip = String(ipinfo.ip || '');
          org = String(ipinfo.org || '').replace(/^AS\d+\s+/i, '');
          domain = String(ipinfo.hostname || '');
        }
      }

      const ptrHostnames = ip ? await reverseDnsWithTimeout(dnsImpl, ip, Math.min(timeoutMs, 1200)) : [];
      const hint = resolveNetworkHostHint({ ip, ptrHostnames, isp, org, domain });
      networkProbeCache = {
        resolvedAt: Date.now(),
        ttlMs: hint ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS,
        hint,
      };
      return hint;
    } catch {
      networkProbeCache = {
        resolvedAt: Date.now(),
        ttlMs: ERROR_CACHE_TTL_MS,
        hint: null,
      };
      return null;
    } finally {
      inFlightNetworkProbe = null;
    }
  })();

  return inFlightNetworkProbe;
}

export function detectHostingProvider({
  env = process.env,
  config = null,
  probeSystem = env === process.env,
  fsImpl = fs,
  osImpl = os,
  networkHint = undefined,
} = {}) {
  const safeEnv = env || {};
  const explicitRaw = safeEnv.HOST_PROVIDER || safeEnv.HOSTING_PROVIDER || '';
  const isLegacySampleDefault = String(explicitRaw).trim().toLowerCase() === 'bothosting';
  const explicit = normalizeExplicitHostProvider(explicitRaw);

  // Respect non-sample explicit overrides right away (e.g., HOST_PROVIDER=katabump).
  if (explicit && !isLegacySampleDefault) {
    return explicit;
  }

  // 1. Dedicated PaaS / Cloud / CI markers
  if (
    safeEnv.DYNO ||
    safeEnv.HEROKU_APP_NAME ||
    safeEnv.HEROKU_SLUG_COMMIT ||
    safeEnv.HEROKU_RELEASE_VERSION
  ) {
    return 'Heroku';
  }

  if (safeEnv.KATABUMP || safeEnv.KATABUMP_SERVER || safeEnv.KATABAMP) {
    return 'Katabump.com';
  }
  if (safeEnv.BOTHOSTING || safeEnv.BOT_HOSTING) {
    return 'Bot-Hosting.net';
  }
  if (safeEnv.OPTIKLINK) {
    return 'Optiklink.com';
  }
  if (safeEnv.CYBRANCEE) {
    return 'Cybrancee';
  }
  if (safeEnv.PELLA) {
    return 'Pella.app';
  }
  if (safeEnv.SOLARHOSTING) {
    return 'SolarHosting';
  }

  if (
    safeEnv.RAILWAY_ENVIRONMENT ||
    safeEnv.RAILWAY_PROJECT_ID ||
    safeEnv.RAILWAY_STATIC_URL ||
    safeEnv.RAILWAY_SERVICE_NAME ||
    safeEnv.RAILWAY_PUBLIC_DOMAIN
  ) {
    return 'Railway';
  }

  if (
    safeEnv.RENDER ||
    safeEnv.RENDER_SERVICE_ID ||
    safeEnv.RENDER_EXTERNAL_URL ||
    safeEnv.RENDER_INSTANCE_ID ||
    safeEnv.RENDER_GIT_COMMIT
  ) {
    return 'Render';
  }

  if (
    safeEnv.KOYEB_ENV ||
    safeEnv.KOYEB_SERVICE_ID ||
    safeEnv.KOYEB_APP_NAME ||
    safeEnv.KOYEB_REGION ||
    safeEnv.KOYEB_PUBLIC_DOMAIN
  ) {
    return 'Koyeb';
  }

  if (safeEnv.FLY_APP_NAME || safeEnv.FLY_MACHINE_ID || safeEnv.FLY_REGION || safeEnv.FLY_ALLOC_ID) {
    return 'Fly.io';
  }

  if (safeEnv.K_SERVICE || safeEnv.CLOUD_RUN_JOB || safeEnv.K_REVISION) {
    return 'Google Cloud Run';
  }
  if (safeEnv.FUNCTION_TARGET || safeEnv.FUNCTION_NAME || safeEnv.GAE_APPLICATION) {
    return 'Google Cloud';
  }

  if (
    safeEnv.REPL_ID ||
    safeEnv.REPLIT_DEPLOYMENT ||
    safeEnv.REPL_OWNER ||
    safeEnv.REPLIT_DB_URL ||
    safeEnv.REPL_SLUG
  ) {
    return 'Replit';
  }

  if (safeEnv.PROJECT_DOMAIN || safeEnv.PROJECT_REMIX_CHAIN || safeEnv.GLITCH_DEBUGGER) {
    return 'Glitch';
  }

  if (safeEnv.VERCEL || safeEnv.VERCEL_ENV || safeEnv.NOW_REGION) {
    return 'Vercel';
  }

  if (safeEnv.AWS_LAMBDA_FUNCTION_NAME || String(safeEnv.AWS_EXECUTION_ENV || '').includes('AWS_Lambda')) {
    return 'AWS Lambda';
  }
  if (safeEnv.ECS_CONTAINER_METADATA_URI || safeEnv.ECS_CONTAINER_METADATA_URI_V4) {
    return 'AWS ECS';
  }
  if (safeEnv.AWS_EXECUTION_ENV || (safeEnv.AWS_REGION && safeEnv.AWS_DEFAULT_REGION)) {
    return 'AWS';
  }

  if (safeEnv.WEBSITE_SITE_NAME || safeEnv.CONTAINER_APP_NAME || safeEnv.AZURE_FUNCTIONS_ENVIRONMENT) {
    return 'Azure';
  }

  if (safeEnv.DIGITALOCEAN_APP_ID) {
    return 'DigitalOcean';
  }

  if (safeEnv.OCI_RESOURCE_PRINCIPAL_VERSION || safeEnv.ORACLE_CLOUD_REGION) {
    return 'Oracle Cloud';
  }

  if (safeEnv.CODESPACES) {
    return 'GitHub Codespaces';
  }
  if (safeEnv.GITHUB_WORKFLOW || safeEnv.GITHUB_ACTIONS) {
    return 'GitHub Actions';
  }

  if (safeEnv.TERMUX_VERSION || safeEnv.TERMUX_APK_RELEASE || /com\.termux/i.test(`${safeEnv.PREFIX || ''} ${safeEnv.HOME || ''}`)) {
    return 'Termux';
  }

  const isPanel = isPterodactylPanelEnv(safeEnv, probeSystem, fsImpl);

  // 2. Scan non-secret env vars for hosting provider hints (excluding HOSTING_URL sample URL)
  const safeEnvHints = collectSafeEnvHints(safeEnv);
  const envBrandMatch = matchProviderFromText(safeEnvHints, { includeDatacenters: true });
  if (envBrandMatch) {
    return formatPanelOrHostMatch(envBrandMatch, isPanel);
  }

  // 3. System files, hostname, resolver search domains, DMI hardware vendor, & cached IP/PTR probe
  if (probeSystem) {
    const sysText = collectSystemProbeText(fsImpl, osImpl);
    const sysMatch = matchProviderFromText(sysText, { includeDatacenters: true });
    if (sysMatch) {
      return formatPanelOrHostMatch(sysMatch, isPanel);
    }

    const activeNetworkHint =
      networkHint !== undefined ? networkHint : networkProbeCache.hint;
    if (activeNetworkHint?.label) {
      return formatPanelOrHostMatch(activeNetworkHint, isPanel);
    }
  } else if (networkHint?.label) {
    return formatPanelOrHostMatch(networkHint, isPanel);
  }

  // 4. Generic Pterodactyl / Container Panel when no specific brand or PTR was found
  if (isPanel) {
    return 'Pterodactyl Panel';
  }

  if (probeSystem) {
    const cgroupText = readTextSafe(fsImpl, '/proc/1/cgroup');
    const isDocker =
      fileExistsSafe(fsImpl, '/.dockerenv') ||
      /docker|containerd|kubepods|lxc/i.test(cgroupText);

    if (isDocker) {
      return 'Docker';
    }

    const platform = String(osImpl?.platform?.() || process.platform || '');
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

export async function detectHostingProviderAsync({
  env = process.env,
  config = null,
  probeSystem = env === process.env,
  probeNetwork = probeSystem,
  fsImpl = fs,
  osImpl = os,
  fetchImpl = globalThis.fetch,
  dnsImpl = dns.promises,
  timeoutMs = NETWORK_TIMEOUT_MS,
} = {}) {
  let networkHint = null;
  if (probeNetwork) {
    // Only hit external IP/PTR probe when sync signals didn't already find a specific brand or PaaS
    const syncCandidate = detectHostingProvider({
      env,
      config,
      probeSystem,
      fsImpl,
      osImpl,
      networkHint: null,
    });
    const isGenericLabel =
      syncCandidate === 'Pterodactyl Panel' ||
      syncCandidate === 'Docker' ||
      syncCandidate === 'Linux VPS' ||
      syncCandidate === 'Panel';

    if (isGenericLabel) {
      networkHint = await warmHostingProviderCache({
        timeoutMs,
        fetchImpl,
        dnsImpl,
      });
    }
  }

  return detectHostingProvider({
    env,
    config,
    probeSystem,
    fsImpl,
    osImpl,
    networkHint,
  });
}
