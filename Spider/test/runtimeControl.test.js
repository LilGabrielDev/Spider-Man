import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import AdmZip from 'adm-zip';
import {
  RESTART_EXIT_CODE,
  applyPostUpdateReload,
  isSupervisedProcess,
  registerRuntimeHandlers,
  reloadCommandsFromDisk,
  resetRuntimeHandlers,
} from '../../spider/utils/runtimeControl.js';
import { commands as adminCommands } from '../commands/Admin.js';

function createArchiveBuffer(filesMap, rootFolder = 'LilGabrielDev-Spider-Man-abcdef1') {
  const zip = new AdmZip();
  for (const [relPath, content] of Object.entries(filesMap)) {
    zip.addFile(`${rootFolder}/${relPath}`, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

test('isSupervisedProcess detects SPIDER_SUPERVISED env and IPC channel', () => {
  assert.equal(isSupervisedProcess({ SPIDER_SUPERVISED: '1' }, false), true);
  assert.equal(isSupervisedProcess({}, true), true);
  assert.equal(isSupervisedProcess({ SPIDER_SUPERVISED: '0' }, false), false);
  assert.equal(isSupervisedProcess({}, false), false);
});

test('reloadCommandsFromDisk reloads updated command modules without process restart', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-reload-cmds-'));
  try {
    const cmdFile = path.join(tmpDir, 'Sample.js');
    fs.writeFileSync(
      cmdFile,
      "export const commands = [{ name: 'hello', aliases: ['hi'], execute: async () => 'v1' }];\n",
    );

    const commandsMap = new Map();
    const aliasesMap = new Map();

    const firstStats = await reloadCommandsFromDisk({
      commandsDir: tmpDir,
      commandsMap,
      aliasesMap,
      pathToFileUrlFn: pathToFileURL,
      cacheBust: 1001,
    });

    assert.equal(firstStats.commandCount, 1);
    assert.equal(firstStats.aliasCount, 1);
    assert.equal(await commandsMap.get('hello').execute(), 'v1');
    assert.equal(aliasesMap.get('hi'), 'hello');

    fs.writeFileSync(
      cmdFile,
      "export const commands = [{ name: 'hello', aliases: ['hey'], execute: async () => 'v2' }];\n",
    );

    const secondStats = await reloadCommandsFromDisk({
      commandsDir: tmpDir,
      commandsMap,
      aliasesMap,
      pathToFileUrlFn: pathToFileURL,
      cacheBust: 1002,
    });

    assert.equal(secondStats.commandCount, 1);
    assert.equal(secondStats.aliasCount, 1);
    assert.equal(await commandsMap.get('hello').execute(), 'v2');
    assert.equal(aliasesMap.has('hi'), false);
    assert.equal(aliasesMap.get('hey'), 'hello');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('applyPostUpdateReload chooses in-place reload when unsupervised and shutdownForRestart when supervised', async () => {
  resetRuntimeHandlers();
  let reloadCalls = 0;
  let restartCalls = 0;

  registerRuntimeHandlers({
    reloadCommands: async () => {
      reloadCalls += 1;
      return { commandCount: 42, aliasCount: 15 };
    },
    shutdownForRestart: async () => {
      restartCalls += 1;
    },
  });

  try {
    const unsupervised = await applyPostUpdateReload({ env: {}, hasIpc: false });
    assert.deepEqual(unsupervised, { mode: 'in_place_reload', commandCount: 42, aliasCount: 15 });
    assert.equal(reloadCalls, 1);
    assert.equal(restartCalls, 0);

    const forcedReload = await applyPostUpdateReload({
      env: { SPIDER_SUPERVISED: '1' },
      hasIpc: true,
      forceReloadOnly: true,
    });
    assert.deepEqual(forcedReload, { mode: 'in_place_reload', commandCount: 42, aliasCount: 15 });
    assert.equal(reloadCalls, 2);
    assert.equal(restartCalls, 0);

    const supervised = await applyPostUpdateReload({ env: { SPIDER_SUPERVISED: '1' }, hasIpc: true });
    assert.deepEqual(supervised, { mode: 'supervised_restart', commandCount: 0, aliasCount: 0 });
    assert.equal(reloadCalls, 2);
    assert.equal(restartCalls, 1);
  } finally {
    resetRuntimeHandlers();
  }
});

test('Admin .update command keeps unsupervised panel processes online without calling process.exit', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-admin-update-'));
  const originalFetch = globalThis.fetch;
  const originalSupervised = process.env.SPIDER_SUPERVISED;
  const exitCalls = [];
  const sentMessages = [];
  let reloadCalls = 0;

  const packageJsonContent = JSON.stringify({ name: 'spider-man-md', version: '1.0.0' });
  fs.writeFileSync(path.join(tmpDir, 'package.json'), packageJsonContent);

  const commitSha = 'b'.repeat(40);
  const archiveBuffer = createArchiveBuffer({
    'package.json': packageJsonContent,
    'spider/index.js': '// updated worker\n',
    'spider/config.js': 'export default { VERSION: "1.0.0" };\n',
    'Spider/commands/Admin.js': 'export const commands = [];\n',
  });

  t.mock.method(process, 'cwd', () => tmpDir);
  t.mock.method(process, 'exit', (code) => {
    exitCalls.push(code);
  });

  delete process.env.SPIDER_SUPERVISED;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/commits/main')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sha: commitSha,
          commit: { message: 'Keep panel bot online on update', author: { name: 'LilGabrielDev' } },
        }),
      };
    }
    if (String(url).includes('/git/trees/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tree: [
            { path: 'package.json' },
            { path: 'spider/index.js' },
            { path: 'spider/config.js' },
            { path: 'Spider/commands/Admin.js' },
          ],
        }),
      };
    }
    if (String(url).endsWith('.zip')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => archiveBuffer,
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  registerRuntimeHandlers({
    reloadCommands: async () => {
      reloadCalls += 1;
      return { commandCount: 55, aliasCount: 12 };
    },
    shutdownForRestart: async () => {
      throw new Error('shutdownForRestart should not run when unsupervised');
    },
  });

  try {
    const updateCommand = adminCommands.find((cmd) => cmd.name === 'update');
    assert.ok(updateCommand, 'update command must exist in Admin.js');

    await updateCommand.execute({
      sock: {
        sendMessage: async (_jid, payload) => {
          sentMessages.push(payload.text);
        },
      },
      from: '254700000000@s.whatsapp.net',
      msg: { key: { id: 'msg-0' }, message: { conversation: '.updatecheck' } },
      text: '',
      isOwner: true,
      config: { UPDATE_REPOSITORY: 'LilGabrielDev/Spider-Man' },
    });

    assert.match(sentMessages[0], /Spider Man Update Available/);
    assert.doesNotMatch(sentMessages[0], /\bcommit\b/i);
    assert.doesNotMatch(sentMessages[0], new RegExp(commitSha.slice(0, 7)));
    assert.doesNotMatch(sentMessages[0], /Keep panel bot online on update/);

    await updateCommand.execute({
      sock: {
        sendMessage: async (_jid, payload) => {
          sentMessages.push(payload.text);
        },
      },
      from: '254700000000@s.whatsapp.net',
      msg: { key: { id: 'msg-1' }, message: { conversation: '.update force' } },
      text: 'force',
      isOwner: true,
      config: { UPDATE_REPOSITORY: 'LilGabrielDev/Spider-Man' },
    });

    assert.equal(exitCalls.length, 0);
    assert.equal(reloadCalls, 1);
    assert.equal(sentMessages.length, 2);
    assert.match(sentMessages[1], /Spider Man UPDATED/);
    assert.match(sentMessages[1], /Reloaded 55 commands live — bot stayed online/);
    assert.doesNotMatch(sentMessages[1], /\bcommit\b/i);
    assert.doesNotMatch(sentMessages[1], new RegExp(commitSha.slice(0, 7)));
    assert.doesNotMatch(sentMessages[1], /Files updated/i);
    assert.doesNotMatch(sentMessages[1], /Runtime files preserved/i);

    await updateCommand.execute({
      sock: {
        sendMessage: async (_jid, payload) => {
          sentMessages.push(payload.text);
        },
      },
      from: '254700000000@s.whatsapp.net',
      msg: { key: { id: 'msg-1b' }, message: { conversation: '.updatecheck' } },
      text: '',
      isOwner: true,
      config: { UPDATE_REPOSITORY: 'LilGabrielDev/Spider-Man' },
    });

    assert.match(sentMessages[2], /Spider Man is up to date/);
    assert.doesNotMatch(sentMessages[2], /\bcommit\b/i);
    assert.doesNotMatch(sentMessages[2], new RegExp(commitSha.slice(0, 7)));
  } finally {
    resetRuntimeHandlers();
    globalThis.fetch = originalFetch;
    if (originalSupervised === undefined) {
      delete process.env.SPIDER_SUPERVISED;
    } else {
      process.env.SPIDER_SUPERVISED = originalSupervised;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Admin .update command triggers supervised worker restart handler without calling process.exit directly', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-admin-supervised-'));
  const originalFetch = globalThis.fetch;
  const originalSupervised = process.env.SPIDER_SUPERVISED;
  const exitCalls = [];
  const sentMessages = [];
  let restartCalls = 0;

  const packageJsonContent = JSON.stringify({ name: 'spider-man-md', version: '1.0.0' });
  fs.writeFileSync(path.join(tmpDir, 'package.json'), packageJsonContent);

  const commitSha = 'c'.repeat(40);
  const archiveBuffer = createArchiveBuffer({
    'package.json': packageJsonContent,
    'spider/index.js': '// updated worker\n',
    'spider/config.js': 'export default { VERSION: "1.0.0" };\n',
    'Spider/commands/Admin.js': 'export const commands = [];\n',
  });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(process, 'cwd', () => tmpDir);
  t.mock.method(process, 'exit', (code) => {
    exitCalls.push(code);
  });

  process.env.SPIDER_SUPERVISED = '1';
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/commits/main')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sha: commitSha,
          commit: { message: 'Supervised panel restart', author: { name: 'LilGabrielDev' } },
        }),
      };
    }
    if (String(url).includes('/git/trees/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tree: [
            { path: 'package.json' },
            { path: 'spider/index.js' },
            { path: 'spider/config.js' },
            { path: 'Spider/commands/Admin.js' },
          ],
        }),
      };
    }
    if (String(url).endsWith('.zip')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => archiveBuffer,
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  registerRuntimeHandlers({
    reloadCommands: async () => {
      throw new Error('reloadCommands should not run when supervised');
    },
    shutdownForRestart: async () => {
      restartCalls += 1;
    },
  });

  try {
    const updateCommand = adminCommands.find((cmd) => cmd.name === 'update');
    await updateCommand.execute({
      sock: {
        sendMessage: async (_jid, payload) => {
          sentMessages.push(payload.text);
        },
      },
      from: '254700000000@s.whatsapp.net',
      msg: { key: { id: 'msg-2' }, message: { conversation: '.update force' } },
      text: 'force',
      isOwner: true,
      config: { UPDATE_REPOSITORY: 'LilGabrielDev/Spider-Man' },
    });

    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0], /Reloading the bot process cleanly in-place/);
    assert.doesNotMatch(sentMessages[0], /\bcommit\b/i);
    assert.doesNotMatch(sentMessages[0], new RegExp(commitSha.slice(0, 7)));
    assert.doesNotMatch(sentMessages[0], /Files updated/i);
    assert.doesNotMatch(sentMessages[0], /Runtime files preserved/i);
    assert.equal(restartCalls, 0);

    t.mock.timers.tick(1500);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(restartCalls, 1);
    assert.equal(exitCalls.length, 0);
  } finally {
    t.mock.timers.reset();
    resetRuntimeHandlers();
    globalThis.fetch = originalFetch;
    if (originalSupervised === undefined) {
      delete process.env.SPIDER_SUPERVISED;
    } else {
      process.env.SPIDER_SUPERVISED = originalSupervised;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('index.js supervisor keeps parent process alive and shuts down cleanly on SIGTERM', async () => {
  const testPort = String(34900 + Math.floor(Math.random() * 500));
  const rootDir = process.cwd();
  const child = spawn(process.execPath, [path.join(rootDir, 'index.js')], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: testPort,
      SESSION: '',
      SESSION_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const deadline = Date.now() + 10000;
    let body = '';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${testPort}/`);
        if (res.ok) {
          body = await res.text();
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    assert.match(body, /is Running/, `Expected HTTP server response, got stdout=${stdout} stderr=${stderr}`);

    const exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const exitResult = await exitPromise;
    assert.equal(exitResult.code, 0);
  } finally {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
  }
});

test('RESTART_EXIT_CODE uses a dedicated non-zero restart signal code', () => {
  assert.equal(RESTART_EXIT_CODE, 75);
});
