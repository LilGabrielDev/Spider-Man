import test from 'node:test';
import assert from 'node:assert/strict';
import { detectHostingProvider, normalizeExplicitHostProvider } from '../../spider/utils/hostDetector.js';
import { detectPlatform } from '../france/utils.js';

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
    'Katabump / Panel',
  );
  assert.equal(
    detectHostingProvider({ env: { USER: 'container', HOME: '/home/container' }, probeSystem: false }),
    'Katabump / Panel',
  );
  assert.equal(detectHostingProvider({ env: {}, probeSystem: false }), 'Panel');
});

test('detectHostingProvider lets concrete platform signals override legacy Bothosting sample default', () => {
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
    'Katabump / Panel',
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

test('detectHostingProvider probes system hostname, /home/container, Docker, and OS when probeSystem is enabled', () => {
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
      osImpl: { hostname: () => 'panel-node', platform: () => 'linux' },
      fsImpl: createFakeFs(['/home/container']),
    }),
    'Katabump / Panel',
  );

  assert.equal(
    detectHostingProvider({
      env: {},
      probeSystem: true,
      osImpl: { hostname: () => 'app-container', platform: () => 'linux' },
      fsImpl: createFakeFs(['/.dockerenv']),
    }),
    'Docker',
  );

  assert.equal(
    detectHostingProvider({
      env: {},
      probeSystem: true,
      osImpl: { hostname: () => 'k8s-pod', platform: () => 'linux' },
      fsImpl: createFakeFs(['/proc/1/cgroup'], { '/proc/1/cgroup': '12:memory:/kubepods/pod123\n' }),
    }),
    'Docker',
  );

  assert.equal(
    detectHostingProvider({
      env: {},
      probeSystem: true,
      osImpl: { hostname: () => 'vps-01', platform: () => 'linux' },
      fsImpl: createFakeFs(),
    }),
    'Linux VPS',
  );
});

test('detectPlatform resolves a non-empty automatically detected host string', () => {
  const detected = detectPlatform();
  assert.equal(typeof detected, 'string');
  assert.ok(detected.trim().length > 0);
  assert.notEqual(detected, 'Bothosting');
});
