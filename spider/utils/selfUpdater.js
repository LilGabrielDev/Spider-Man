import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { detectHostingProvider, detectHostingProviderAsync } from './hostDetector.js';

export const DEFAULT_REPOSITORY = 'LilGabrielDev/Spider-Man';
export const UPDATE_STATE_FILENAME = '.spider-update.json';
export const REQUIRED_REPO_FILES = [
  'package.json',
  'spider/index.js',
  'spider/config.js',
  'Spider/commands/Admin.js',
];

const PRESERVED_EXACT_PATHS = new Set([
  '.env',
  'sudo.json',
  'spider-security.log',
  UPDATE_STATE_FILENAME,
]);

const PRESERVED_TOP_DIRS = new Set([
  'node_modules',
  '.git',
  'auth',
  'auth_info_baileys',
  'sessions',
  'data',
  'logs',
  'tmp',
  'temp',
]);

export function normalizeRepository(rawRepo, config) {
  const candidate = String(
    rawRepo || process.env.UPDATE_REPOSITORY || config?.GITHUB_REPO || DEFAULT_REPOSITORY,
  )
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '')
    .trim();

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) {
    throw new Error('The configured GitHub repository is invalid.');
  }
  return candidate;
}

export function detectHostingEnvironment(env = process.env) {
  if (env.HEROKU_API_KEY && env.HEROKU_APP_NAME) {
    return { mode: 'heroku', label: 'Heroku' };
  }

  const explicit = String(env.HOST_PROVIDER || env.HOSTING_PROVIDER || '')
    .trim()
    .toLowerCase();

  const deployHookUrl = String(
    env.DEPLOY_HOOK_URL || env.RENDER_DEPLOY_HOOK_URL || '',
  ).trim();
  if (deployHookUrl) {
    const label = env.RENDER || explicit === 'render' ? 'Render' : 'Deploy Hook';
    return { mode: 'deploy_hook', label, deployHookUrl };
  }

  const label = detectHostingProvider({
    env,
    probeSystem: env === process.env,
  });

  return { mode: 'self', label };
}

export async function detectHostingEnvironmentAsync(env = process.env) {
  if (env.HEROKU_API_KEY && env.HEROKU_APP_NAME) {
    return { mode: 'heroku', label: 'Heroku' };
  }

  const explicit = String(env.HOST_PROVIDER || env.HOSTING_PROVIDER || '')
    .trim()
    .toLowerCase();

  const deployHookUrl = String(
    env.DEPLOY_HOOK_URL || env.RENDER_DEPLOY_HOOK_URL || '',
  ).trim();
  if (deployHookUrl) {
    const label = env.RENDER || explicit === 'render' ? 'Render' : 'Deploy Hook';
    return { mode: 'deploy_hook', label, deployHookUrl };
  }

  const label = await detectHostingProviderAsync({
    env,
    probeSystem: env === process.env,
    probeNetwork: env === process.env,
  });

  return { mode: 'self', label };
}

export function shouldPreserveRelativePath(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return true;

  const segments = normalized.split('/');
  const top = segments[0];

  if (PRESERVED_EXACT_PATHS.has(normalized)) return true;
  if (top.startsWith('.env.') && top !== '.env-sample') return true;
  if (PRESERVED_TOP_DIRS.has(top)) return true;
  if (segments.includes('auth') || segments.includes('auth_info_baileys')) return true;
  if (/\.(?:db|db-journal|sqlite|sqlite3|log)$/i.test(normalized)) return true;

  return false;
}

export function readUpdateState(rootDir = process.cwd()) {
  const statePath = path.join(rootDir, UPDATE_STATE_FILENAME);
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Missing or unreadable state file falls back to env/git detection.
  }
  return null;
}

export function writeUpdateState(rootDir, state) {
  const statePath = path.join(rootDir, UPDATE_STATE_FILENAME);
  const tmpPath = path.join(rootDir, `${UPDATE_STATE_FILENAME}.tmp-${process.pid}`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, statePath);
}

export function getCurrentCommitSha({ rootDir = process.cwd(), env = process.env, execImpl = execFileSync } = {}) {
  const state = readUpdateState(rootDir);
  if (state?.commitSha && /^[a-f0-9]{40}$/i.test(state.commitSha)) {
    return state.commitSha.toLowerCase();
  }

  const envSha = String(
    env.HEROKU_SLUG_COMMIT ||
      env.SOURCE_VERSION ||
      env.GITHUB_SHA ||
      env.RAILWAY_GIT_COMMIT_SHA ||
      env.RENDER_GIT_COMMIT ||
      env.KOYEB_GIT_SHA ||
      '',
  ).trim();

  if (/^[a-f0-9]{7,40}$/i.test(envSha)) {
    return envSha.toLowerCase();
  }

  try {
    if (fs.existsSync(path.join(rootDir, '.git'))) {
      const gitSha = String(execImpl('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' })).trim();
      if (/^[a-f0-9]{40}$/i.test(gitSha)) {
        return gitSha.toLowerCase();
      }
    }
  } catch {
    // Non-git deployments (Katabump, panels, archives) do not require .git.
  }

  return '';
}

function isSameCommit(currentSha, targetSha) {
  if (!currentSha || !targetSha) return false;
  const a = currentSha.toLowerCase();
  const b = targetSha.toLowerCase();
  return a === b || (a.length >= 7 && b.startsWith(a)) || (b.length >= 7 && a.startsWith(b));
}

export async function fetchVerifiedLatestCommit(repo, { fetchImpl = fetch } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'SPIDER-MAN-MD-updater',
  };

  const commitRes = await fetchImpl(`https://api.github.com/repos/${repo}/commits/main`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!commitRes.ok) {
    throw new Error(`GitHub returned HTTP ${commitRes.status}`);
  }

  const commitJson = await commitRes.json();
  const sha = String(commitJson?.sha || '').trim();
  if (!/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error('GitHub did not return a valid commit SHA.');
  }

  const treeRes = await fetchImpl(
    `https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`,
    {
      headers,
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!treeRes.ok) {
    throw new Error(
      `Could not verify the primary repository source tree (GitHub HTTP ${treeRes.status}).`,
    );
  }

  const treeJson = await treeRes.json();
  const treePaths = new Set((treeJson?.tree || []).map((entry) => entry?.path));
  const missingFiles = REQUIRED_REPO_FILES.filter((filePath) => !treePaths.has(filePath));
  if (missingFiles.length > 0) {
    throw new Error(
      `The configured primary repository (${repo}) is missing required Spider Man files: ${missingFiles.join(', ')}.`,
    );
  }

  return {
    sha: sha.toLowerCase(),
    message: String(commitJson?.commit?.message || 'Spider Man update').split('\n')[0],
    author: String(commitJson?.commit?.author?.name || 'Unknown'),
    date: commitJson?.commit?.author?.date || null,
  };
}

export function applyZipArchiveToWorkspace(zipBuffer, rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const zip = new AdmZip(Buffer.from(zipBuffer));
  const entries = zip.getEntries();

  const fileEntries = [];
  const relativePaths = new Set();

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const rawName = String(entry.entryName || '').replace(/\\/g, '/');
    const parts = rawName.split('/').filter(Boolean);
    if (rawName.startsWith('/') || parts.some((seg) => seg === '..' || seg === '.')) {
      throw new Error(`Unsafe archive path rejected: ${rawName}`);
    }
    if (parts.length < 2) continue;

    const relPath = parts.slice(1).join('/');
    relativePaths.add(relPath);
    fileEntries.push({ relPath, entry });
  }

  const missingRequired = REQUIRED_REPO_FILES.filter((reqFile) => !relativePaths.has(reqFile));
  if (missingRequired.length > 0) {
    throw new Error(
      `Downloaded update archive is missing required files: ${missingRequired.join(', ')}.`,
    );
  }

  const pkgPath = path.join(resolvedRoot, 'package.json');
  const previousPackageJson = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : null;

  let updatedCount = 0;
  let preservedCount = 0;

  for (const { relPath, entry } of fileEntries) {
    if (shouldPreserveRelativePath(relPath)) {
      preservedCount += 1;
      continue;
    }

    const destPath = path.resolve(resolvedRoot, relPath);
    if (destPath !== resolvedRoot && !destPath.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`Archive path escapes workspace root: ${relPath}`);
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, entry.getData());
    updatedCount += 1;
  }

  const nextPackageJson = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : null;
  const packageJsonChanged = previousPackageJson !== nextPackageJson;

  return {
    updatedCount,
    preservedCount,
    packageJsonChanged,
  };
}

export async function runBotUpdate({
  repo,
  config,
  checkOnly = false,
  force = false,
  rootDir = process.cwd(),
  env = process.env,
  fetchImpl = fetch,
  execImpl = execFileSync,
  skipNpmInstall = false,
} = {}) {
  const repository = normalizeRepository(repo, config);
  const host = await detectHostingEnvironmentAsync(env);
  const latest = await fetchVerifiedLatestCommit(repository, { fetchImpl });
  const currentSha = getCurrentCommitSha({ rootDir, env, execImpl });
  const upToDate = !force && isSameCommit(currentSha, latest.sha);

  if (checkOnly) {
    return {
      status: upToDate ? 'up_to_date' : 'update_available',
      repository,
      host,
      currentSha,
      latest,
      restartRecommended: false,
    };
  }

  if (upToDate) {
    return {
      status: 'up_to_date',
      repository,
      host,
      currentSha,
      latest,
      restartRecommended: false,
    };
  }

  if (host.mode === 'heroku') {
    const buildRes = await fetchImpl(
      `https://api.heroku.com/apps/${encodeURIComponent(env.HEROKU_APP_NAME)}/builds`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.HEROKU_API_KEY}`,
        },
        body: JSON.stringify({
          source_blob: {
            url: `https://github.com/${repository}/archive/${latest.sha}.tar.gz`,
            version: latest.sha,
            version_description: latest.message || 'Spider Man update',
          },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!buildRes.ok) {
      throw new Error(
        `Heroku returned HTTP ${buildRes.status}. Check the app name, token permissions, and deployment logs.`,
      );
    }

    const buildJson = await buildRes.json();
    return {
      status: 'heroku_triggered',
      repository,
      host,
      currentSha,
      latest,
      buildId: buildJson?.id || 'pending',
      buildStatus: String(buildJson?.status || 'pending').toUpperCase(),
      restartRecommended: false,
    };
  }

  if (host.mode === 'deploy_hook') {
    const hookRes = await fetchImpl(host.deployHookUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
    });
    if (!hookRes.ok) {
      throw new Error(`Deploy hook returned HTTP ${hookRes.status}.`);
    }
    return {
      status: 'deploy_hook_triggered',
      repository,
      host,
      currentSha,
      latest,
      restartRecommended: false,
    };
  }

  // Direct self-update for Katabump, Bot-Hosting, Pterodactyl/Panels, VPS, Docker, etc.
  const archiveRes = await fetchImpl(
    `https://github.com/${repository}/archive/${latest.sha}.zip`,
    {
      headers: { 'User-Agent': 'SPIDER-MAN-MD-updater' },
      signal: AbortSignal.timeout(120000),
    },
  );
  if (!archiveRes.ok) {
    throw new Error(`Failed to download update archive (GitHub HTTP ${archiveRes.status}).`);
  }

  const zipArrayBuffer = await archiveRes.arrayBuffer();
  const applied = applyZipArchiveToWorkspace(zipArrayBuffer, rootDir);

  let npmWarning = null;
  if (applied.packageJsonChanged && !skipNpmInstall) {
    try {
      execImpl('npm', ['install', '--legacy-peer-deps'], {
        cwd: rootDir,
        stdio: 'pipe',
        timeout: 120000,
      });
    } catch (err) {
      npmWarning = String(err?.message || 'npm install failed').slice(0, 200);
    }
  }

  writeUpdateState(rootDir, {
    commitSha: latest.sha,
    repository,
    platform: host.label,
    updatedAt: new Date().toISOString(),
  });

  return {
    status: 'updated_self',
    repository,
    host,
    currentSha,
    latest,
    updatedCount: applied.updatedCount,
    preservedCount: applied.preservedCount,
    packageJsonChanged: applied.packageJsonChanged,
    npmWarning,
    restartRecommended: true,
  };
}
