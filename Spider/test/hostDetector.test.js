import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectHostingProvider,
  detectHostingProviderAsync,
  normalizeExplicitHostProvider,
  resetHostDetectorCache,
} from '../../spider/utils/hostDetector.js';
import { detectPlatform, detectPlatformAsync } from '../france/utils.js';

function createFakeFs(existingPaths = [], files = {}) {
  const pathSet = new Set(existingPaths);
  return {
    existsSync(targetPath) {
      return pathSet.has(targetPath);
    },
    readFileSync(targetPath) {
      if (!(targetPath in files)) {
        throw new Error(`ENOENT: ${targetPath}`);
      }
      return files[targetPath];
    },
  };
}

test('normalizeExplicitHostProvider normalizes aliases and ignores auto/unknown placeholders', () => {
  assert.equal(normalizeExplicitHostProvider(''), '');
  assert.equal(normalizeExplicitHostProvider('auto'), '');
  assert.equal(normalizeExplicitHostProvider('Unknown'), '');
  assert.equal(normalizeExplicitHostProvider('unknown host'), '');
  assert.equal(normalizeExplicitHostProvider('katabump'), 'Katabump.com');
  assert.equal(normalizeExplicitHostProvider('Bothosting'), 'Bot-Hosting.net');
  assert.equal(normalizeExplicitHostProvider('render'), 'Render');
  assert.equal(normalizeExplicitHostProvider('Custom Cloud'), 'Custom Cloud');
});

test('detectHostingProvider detects all major cloud, PaaS, and panel environments automatically', () => {
  assert.equal(detectHostingProvider({ env: { DYNO: 'web.1' }, probeSystem: false }), 'Heroku');
  assert.equal(detectHostingProvider({ env: { KATABUMP: '1' }, probeSystem: false }), 'Katabump.com');
  assert.equal(
    detectHostingProvider({ env: { HOSTNAME: 'node-katabump-01' }, probeSystem: false }),
    'Katabump.com',
  );
  assert.equal(detectHostingProvider({ env: { BOTHOSTING: '1' }, probeSystem: false }), 'Bot-Hosting.net');
  assert.equal(detectHostingProvider({ env: { OPTIKLINK: '1' }, probeSystem: false }), 'Optiklink.com');
  assert.equal(detectHostingProvider({ env: { RAILWAY_PROJECT_ID: 'proj-1' }, probeSystem: false }), 'Railway');
  assert.equal(detectHostingProvider({ env: { RENDER: 'true' }, probeSystem: false }), 'Render');
  assert.equal(detectHostingProvider({ env: { KOYEB_SERVICE_ID: 'svc-1' }, probeSystem: false }), 'Koyeb');
  assert.equal(detectHostingProvider({ env: { FLY_APP_NAME: 'spider-bot' }, probeSystem: false }), 'Fly.io');
  assert.equal(detectHostingProvider({ env: { K_SERVICE: 'spider-service' }, probeSystem: false }), 'Google Cloud Run');
  assert.equal(detectHostingProvider({ env: { FUNCTION_TARGET: 'handler' }, probeSystem: false }), 'Google Cloud');
  assert.equal(detectHostingProvider({ env: { REPL_ID: 'repl-123' }, probeSystem: false }), 'Replit');
  assert.equal(detectHostingProvider({ env: { PROJECT_DOMAIN: 'my-glitch' }, probeSystem: false }), 'Glitch');
  assert.equal(detectHostingProvider({ env: { VERCEL: '1' }, probeSystem: false }), 'Vercel');
  assert.equal(detectHostingProvider({ env: { AWS_LAMBDA_FUNCTION_NAME: 'fn' }, probeSystem: false }), 'AWS Lambda');
  assert.equal(
    detectHostingProvider({ env: { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4' }, probeSystem: false }),
    'AWS ECS',
  );
  assert.equal(detectHostingProvider({ env: { WEBSITE_SITE_NAME: 'azure-site' }, probeSystem: false }), 'Azure');
  assert.equal(detectHostingProvider({ env: { DIGITALOCEAN_APP_ID: 'do-app' }, probeSystem: false }), 'DigitalOcean');
  assert.equal(detectHostingProvider({ env: { CODESPACES: 'true' }, probeSystem: false }), 'GitHub Codespaces');
  assert.equal(detectHostingProvider({ env: { GITHUB_ACTIONS: 'true' }, probeSystem: false }), 'GitHub Actions');
  assert.equal(
    detectHostingProvider({ env: { TERMUX_VERSION: '0.118.0' }, probeSystem: false }),
    'Termux',
  );
  assert.equal(
    detectHostingProvider({ env: { P_SERVER_UUID: 'uuid-123' }, probeSystem: false }),
    'Pterodactyl Panel',
  );
  assert.equal(
    detectHostingProvider({ env: { USER: 'container', HOME: '/home/container' }, probeSystem: false }),
    'Pterodactyl Panel',
  );
  assert.equal(detectHostingProvider({ env: {}, probeSystem: false }), 'Panel');
});

test('detectHostingProvider ignores HOSTING_URL sample promo link and legacy Bothosting sample default', () => {
  assert.equal(
    detectHostingProvider({
      env: { HOSTING_URL: 'https://cheap.bothosting.lilgabrieltech.top', P_SERVER_UUID: 'srv-1' },
      probeSystem: false,
    }),
    'Pterodactyl Panel',
  );

  assert.equal(
    detectHostingProvider({
      env: { HOSTING_URL: 'https://cheap.bothosting.lilgabrieltech.top', K_SERVICE: 'cloud-run-1' },
      probeSystem: false,
    }),
    'Google Cloud Run',
  );

  assert.equal(
    detectHostingProvider({
      env: { HOSTING_URL: 'https://cheap.bothosting.lilgabrieltech.top' },
      probeSystem: true,
      osImpl: { hostname: () => 'vps-01', platform: () => 'linux' },
      fsImpl: createFakeFs(),
      networkHint: null,
    }),
    'Linux VPS',
  );

  assert.equal(
    detectHostingProvider({
      env: { HOSTING_PROVIDER: 'Bothosting', RENDER: 'true' },
      probeSystem: false,
    }),
    'Render',
  );

  assert.equal(
    detectHostingProvider({
      env: { HOSTING_PROVIDER: 'Bothosting', P_SERVER_UUID: 'srv-1' },
      probeSystem: false,
    }),
    'Pterodactyl Panel',
  );

  assert.equal(
    detectHostingProvider({
      env: { HOSTING_PROVIDER: 'Bothosting' },
      probeSystem: false,
    }),
    'Bot-Hosting.net',
  );

  assert.equal(
    detectHostingProvider({
      env: { HOST_PROVIDER: 'katabump', RENDER: 'true' },
      probeSystem: false,
    }),
    'Katabump.com',
  );
});

test('detectHostingProvider probes system hostname, resolv.conf, DMI vendor, /home/container, Docker, and OS', () => {
  assert.equal(
    detectHostingProvider({
      env: {},
      probeSystem: true,
      osImpl: { hostname: () => 'uk-katabump-02', platform: () => 'linux' },
      fsImpl: createFakeFs(),
    }),
    'Katabump.com',
  );

  assert.equal(
    detectHostingProvider({
      env: {},
      probeSystem: true,
      osImpl: { hostname: () => 'localhost', platform: () => 'linux' },
      fsImpl: createFakeFs(['/etc/resolv.conf'], { '/etc/resolv.conf': 'search google.internal.\n' }),
    }),
    'Google Cloud',
  );

  assert.equal(
    detectHostingProvider({
      env: {},
      probeSystem: true,
      osImpl: { hostname: () => 'server-1', platform: () => 'linux' },
      fsImpl: createFakeFs(['/sys/class/dmi/id/sys_vendor'], {
        '/sys/class/dmi/id/sys_vendor': 'Hetzner\n',
      }),
    }),
    'Hetzner',
  );

  assert.equal(
    detectHostingProvider({
      env: {},
      probeSystem: true,
      osImpl: { hostname: () => 'panel-node', platform: () => 'linux' },
      fsImpl: createFakeFs(['/home/container']),
      networkHint: null,
    }),
    'Pterodactyl Panel',
  );

  assert.equal(
    detectHostingProvider({
      env: {},
      probeSystem: true,
      osImpl: { hostname: () => 'app-container', platform: () => 'linux' },
      fsImpl: createFakeFs(['/.dockerenv']),
      networkHint: null,
    }),
    'Docker',
  );

  assert.equal(
    detectHostingProvider({
      env: {},
      probeSystem: true,
      osImpl: { hostname: () => 'k8s-pod', platform: () => 'linux' },
      fsImpl: createFakeFs(['/proc/1/cgroup'], { '/proc/1/cgroup': '12:memory:/kubepods/pod123\n' }),
      networkHint: null,
    }),
    'Docker',
  );

  assert.equal(
    detectHostingProvider({
      env: {},
      probeSystem: true,
      osImpl: { hostname: () => 'vps-01', platform: () => 'linux' },
      fsImpl: createFakeFs(),
      networkHint: null,
    }),
    'Linux VPS',
  );
});

test('detectHostingProviderAsync resolves PTR/ASN hints for panels and skips network probe on known PaaS', async () => {
  resetHostDetectorCache();

  const katabumpHost = await detectHostingProviderAsync({
    env: { P_SERVER_UUID: 'srv-kata-1' },
    probeSystem: true,
    probeNetwork: true,
    osImpl: { hostname: () => 'panel-node', platform: () => 'linux' },
    fsImpl: createFakeFs(['/home/container']),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        success: true,
        ip: '198.51.100.10',
        connection: { org: 'OVH SAS', isp: 'OVHcloud', domain: 'ovh.net' },
      }),
    }),
    dnsImpl: { reverse: async () => ['node3.katabump.com'] },
  });
  assert.equal(katabumpHost, 'Katabump.com');

  resetHostDetectorCache();
  const bothostingHost = await detectHostingProviderAsync({
    env: { P_SERVER_UUID: 'srv-bh-1' },
    probeSystem: true,
    probeNetwork: true,
    osImpl: { hostname: () => 'panel-node', platform: () => 'linux' },
    fsImpl: createFakeFs(['/home/container']),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        success: true,
        ip: '198.51.100.20',
        connection: { org: 'Hetzner Online GmbH', isp: 'Hetzner' },
      }),
    }),
    dnsImpl: { reverse: async () => ['fi1.bot-hosting.net'] },
  });
  assert.equal(bothostingHost, 'Bot-Hosting.net');

  resetHostDetectorCache();
  const ovhPanelHost = await detectHostingProviderAsync({
    env: { P_SERVER_UUID: 'srv-ovh-1' },
    probeSystem: true,
    probeNetwork: true,
    osImpl: { hostname: () => 'panel-node', platform: () => 'linux' },
    fsImpl: createFakeFs(['/home/container']),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        success: true,
        ip: '198.51.100.30',
        connection: { org: 'OVH SAS', isp: 'OVHcloud', domain: 'ovh.net' },
      }),
    }),
    dnsImpl: { reverse: async () => [] },
  });
  assert.equal(ovhPanelHost, 'Panel (OVHcloud)');

  resetHostDetectorCache();
  let fetchCalled = false;
  const renderHost = await detectHostingProviderAsync({
    env: { RENDER: 'true' },
    probeSystem: true,
    probeNetwork: true,
    osImpl: { hostname: () => 'render-1', platform: () => 'linux' },
    fsImpl: createFakeFs(),
    fetchImpl: async () => {
      fetchCalled = true;
      return { ok: false };
    },
  });
  assert.equal(renderHost, 'Render');
  assert.equal(fetchCalled, false);
  resetHostDetectorCache();
});

test('detectPlatform and detectPlatformAsync resolve non-empty host strings without sample defaults', async () => {
  const detected = detectPlatform();
  assert.equal(typeof detected, 'string');
  assert.ok(detected.trim().length > 0);
  assert.notEqual(detected, 'Bothosting');

  const detectedAsync = await detectPlatformAsync();
  assert.equal(typeof detectedAsync, 'string');
  assert.ok(detectedAsync.trim().length > 0);
  assert.notEqual(detectedAsync, 'Bothosting');
  resetHostDetectorCache();
});

