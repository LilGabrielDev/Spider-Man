import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  UPDATE_STATE_FILENAME,
  applyZipArchiveToWorkspace,
  detectHostingEnvironment,
  detectHostingEnvironmentAsync,
  getCurrentCommitSha,
  readUpdateState,
  runBotUpdate,
  shouldPreserveRelativePath,
} from '../../spider/utils/selfUpdater.js';

function createArchiveBuffer(filesMap, rootFolder = 'LilGabrielDev-Spider-Man-abcdef1') {
  const zip = new AdmZip();
  for (const [relPath, content] of Object.entries(filesMap)) {
    zip.addFile(`${rootFolder}/${relPath}`, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

const VALID_ARCHIVE_BASE = {
  'package.json': JSON.stringify({ name: 'spider-man-md', version: '1.0.0' }),
  'spider/index.js': '// updated index\n',
  'spider/config.js': 'export default { VERSION: "1.0.0" };\n',
  'Spider/commands/Admin.js': 'export const commands = [];\n',
};

test('detectHostingEnvironment detects Heroku, Deploy Hooks, Katabump, Bot-Hosting, and Panels', () => {
  assert.deepEqual(
    detectHostingEnvironment({ HEROKU_API_KEY: 'key', HEROKU_APP_NAME: 'my-app' }),
    { mode: 'heroku', label: 'Heroku' },
  );

  assert.deepEqual(
    detectHostingEnvironment({ DEPLOY_HOOK_URL: 'https://api.render.com/deploy/srv-123' }),
    {
      mode: 'deploy_hook',
      label: 'Deploy Hook',
      deployHookUrl: 'https://api.render.com/deploy/srv-123',
    },
  );

  assert.deepEqual(detectHostingEnvironment({ KATABUMP: 'true' }), {
    mode: 'self',
    label: 'Katabump',
  });

  assert.deepEqual(detectHostingEnvironment({ HOST_PROVIDER: 'katabump' }), {
    mode: 'self',
    label: 'Katabump',
  });

  assert.deepEqual(detectHostingEnvironment({ P_SERVER_UUID: 'uuid-123' }), {
    mode: 'self',
    label: 'Pterodactyl Panel',
  });

  assert.deepEqual(detectHostingEnvironment({ HOST_PROVIDER: 'bot-hosting' }), {
    mode: 'self',
    label: 'Bot-Hosting',
  });

  assert.deepEqual(detectHostingEnvironment({ RAILWAY_ENVIRONMENT: 'production' }), {
    mode: 'self',
    label: 'Railway',
  });

  assert.deepEqual(detectHostingEnvironment({ KOYEB_ENV: 'prod' }), {
    mode: 'self',
    label: 'Koyeb',
  });

  assert.deepEqual(detectHostingEnvironment({}), {
    mode: 'self',
    label: 'Panel',
  });
});

test('detectHostingEnvironmentAsync ignores HOSTING_URL promo links', async () => {
  assert.deepEqual(
    await detectHostingEnvironmentAsync({
      HOSTING_URL: 'https://cheap.bothosting.lilgabrieltech.top',
      P_SERVER_UUID: 'panel-1',
    }),
    {
      mode: 'self',
      label: 'Pterodactyl Panel',
    },
  );
  assert.deepEqual(
    await detectHostingEnvironmentAsync({
      HOSTING_URL: 'https://cheap.bothosting.lilgabrieltech.top',
      K_SERVICE: 'cloud-run-svc',
    }),
    {
      mode: 'self',
      label: 'Google Cloud Run',
    },
  );
});

test('shouldPreserveRelativePath protects runtime secrets, sessions, databases, and logs', () => {
  assert.equal(shouldPreserveRelativePath('.env'), true);
  assert.equal(shouldPreserveRelativePath('.env.production'), true);
  assert.equal(shouldPreserveRelativePath('.env-sample'), false);
  assert.equal(shouldPreserveRelativePath('auth/creds.json'), true);
  assert.equal(shouldPreserveRelativePath('auth_info_baileys/creds.json'), true);
  assert.equal(shouldPreserveRelativePath('sessions/session.json'), true);
  assert.equal(shouldPreserveRelativePath('node_modules/pkg/index.js'), true);
  assert.equal(shouldPreserveRelativePath('sudo.json'), true);
  assert.equal(shouldPreserveRelativePath('.spider-update.json'), true);
  assert.equal(shouldPreserveRelativePath('bot.sqlite'), true);
  assert.equal(shouldPreserveRelativePath('spider/index.js'), false);
  assert.equal(shouldPreserveRelativePath('Spider/commands/Admin.js'), false);
});

test('applyZipArchiveToWorkspace extracts updates while preserving runtime files and rejecting traversal', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-update-zip-'));
  try {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'OWNER_NUMBER=254700000000\n');
    fs.writeFileSync(path.join(tmpDir, 'sudo.json'), '["254711111111"]\n');
    fs.mkdirSync(path.join(tmpDir, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'auth/creds.json'), '{"me":"saved"}\n');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), VALID_ARCHIVE_BASE['package.json']);

    const zipBuf = createArchiveBuffer({
      ...VALID_ARCHIVE_BASE,
      '.env': 'OVERWRITTEN=true\n',
      'auth/creds.json': '{"me":"wiped"}\n',
      'sudo.json': '[]\n',
      'README.md': '# Updated\n',
    });

    const summary = applyZipArchiveToWorkspace(zipBuf, tmpDir);
    assert.equal(summary.updatedCount, 5);
    assert.equal(summary.preservedCount, 3);
    assert.equal(summary.packageJsonChanged, false);

    assert.equal(fs.readFileSync(path.join(tmpDir, '.env'), 'utf8'), 'OWNER_NUMBER=254700000000\n');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'auth/creds.json'), 'utf8'), '{"me":"saved"}\n');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'sudo.json'), 'utf8'), '["254711111111"]\n');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'README.md'), 'utf8'), '# Updated\n');

    const unsafeZip = new AdmZip(createArchiveBuffer(VALID_ARCHIVE_BASE));
    unsafeZip.addFile('placeholder.txt', Buffer.from('bad'));
    const injectedEntry = unsafeZip.getEntry('placeholder.txt');
    injectedEntry.entryName = 'repo-root/../../escape.txt';
    assert.throws(() => applyZipArchiveToWorkspace(unsafeZip.toBuffer(), tmpDir), /Unsafe archive path rejected/);

    const incompleteZip = createArchiveBuffer({ 'README.md': 'missing core files' });
    assert.throws(() => applyZipArchiveToWorkspace(incompleteZip, tmpDir), /missing required files/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runBotUpdate supports Katabump/Panel direct updates, checkOnly, up_to_date, Heroku, and Deploy Hook', async () => {
  const commitSha = 'a'.repeat(40);
  const treePaths = [
    { path: 'package.json' },
    { path: 'spider/index.js' },
    { path: 'spider/config.js' },
    { path: 'Spider/commands/Admin.js' },
  ];

  const makeFetchMock = ({ archiveFiles = VALID_ARCHIVE_BASE, herokuCalls = [], hookCalls = [] } = {}) => {
    const zipBuffer = createArchiveBuffer(archiveFiles);
    return async (url) => {
      if (url.endsWith('/commits/main')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sha: commitSha,
            commit: { message: 'Enable Katabump updater', author: { name: 'LilGabrielDev' } },
          }),
        };
      }
      if (url.includes('/git/trees/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ tree: treePaths }),
        };
      }
      if (url.endsWith('.zip')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => zipBuffer,
        };
      }
      if (url.includes('api.heroku.com')) {
        herokuCalls.push(url);
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 'build-42', status: 'pending' }),
        };
      }
      if (url.includes('hooks.example.com')) {
        hookCalls.push(url);
        return { ok: true, status: 200 };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-run-update-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'old' }));

    const execCalls = [];
    const execMock = (cmd, args) => {
      execCalls.push([cmd, ...args]);
      return '';
    };

    const fetchMock = makeFetchMock();

    const checkResult = await runBotUpdate({
      checkOnly: true,
      rootDir: tmpDir,
      env: { P_SERVER_UUID: 'kata-123' },
      fetchImpl: fetchMock,
      execImpl: execMock,
    });
    assert.equal(checkResult.status, 'update_available');
    assert.equal(checkResult.host.label, 'Pterodactyl Panel');
    assert.equal(execCalls.length, 0);

    const selfResult = await runBotUpdate({
      rootDir: tmpDir,
      env: { KATABUMP: '1' },
      fetchImpl: fetchMock,
      execImpl: execMock,
    });
    assert.equal(selfResult.status, 'updated_self');
    assert.equal(selfResult.host.label, 'Katabump');
    assert.equal(selfResult.packageJsonChanged, true);
    assert.equal(selfResult.restartRecommended, true);
    assert.deepEqual(execCalls, [['npm', 'install', '--legacy-peer-deps']]);
    assert.equal(readUpdateState(tmpDir)?.commitSha, commitSha);
    assert.equal(getCurrentCommitSha({ rootDir: tmpDir, env: {} }), commitSha);
    assert.equal(fs.existsSync(path.join(tmpDir, UPDATE_STATE_FILENAME)), true);

    const upToDateResult = await runBotUpdate({
      rootDir: tmpDir,
      env: { KATABUMP: '1' },
      fetchImpl: fetchMock,
      execImpl: execMock,
    });
    assert.equal(upToDateResult.status, 'up_to_date');

    const herokuCalls = [];
    const herokuResult = await runBotUpdate({
      rootDir: tmpDir,
      force: true,
      env: { HEROKU_API_KEY: 'secret', HEROKU_APP_NAME: 'spider-bot' },
      fetchImpl: makeFetchMock({ herokuCalls }),
      execImpl: execMock,
    });
    assert.equal(herokuResult.status, 'heroku_triggered');
    assert.equal(herokuResult.buildId, 'build-42');
    assert.equal(herokuCalls.length, 1);

    const hookCalls = [];
    const hookResult = await runBotUpdate({
      rootDir: tmpDir,
      force: true,
      env: { DEPLOY_HOOK_URL: 'https://hooks.example.com/deploy/123' },
      fetchImpl: makeFetchMock({ hookCalls }),
      execImpl: execMock,
    });
    assert.equal(hookResult.status, 'deploy_hook_triggered');
    assert.equal(hookCalls.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
