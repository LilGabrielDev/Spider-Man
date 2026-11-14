import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const RESTART_EXIT_CODE = 75;

let registeredHandlers = {
  reloadCommands: null,
  shutdownForRestart: null,
};

export function isSupervisedProcess(
  env = process.env,
  hasIpc = typeof process.send === 'function',
) {
  return Boolean(env?.SPIDER_SUPERVISED === '1' || hasIpc);
}

export function registerRuntimeHandlers({ reloadCommands = null, shutdownForRestart = null } = {}) {
  registeredHandlers = {
    reloadCommands: typeof reloadCommands === 'function' ? reloadCommands : null,
    shutdownForRestart: typeof shutdownForRestart === 'function' ? shutdownForRestart : null,
  };
}

export function resetRuntimeHandlers() {
  registeredHandlers = {
    reloadCommands: null,
    shutdownForRestart: null,
  };
}

export async function reloadCommandsFromDisk({
  commandsDir,
  commandsMap,
  aliasesMap,
  loadLegacyFn = null,
  pathToFileUrlFn = pathToFileURL,
  fsImpl = fs,
  pathImpl = path,
  importFn = (specifier) => import(specifier),
  cacheBust = Date.now(),
} = {}) {
  const nextCommands = new Map();
  const nextAliases = new Map();

  const files = fsImpl
    .readdirSync(commandsDir)
    .filter((file) => file.endsWith('.js'))
    .sort();

  for (const file of files) {
    const filePath = pathImpl.join(commandsDir, file);
    const fileUrl = `${pathToFileUrlFn(filePath).href}?reload=${cacheBust}`;
    const mod = await importFn(fileUrl);
    if (!Array.isArray(mod?.commands)) continue;

    for (const cmd of mod.commands) {
      const cmdName = String(cmd?.name || '').toLowerCase();
      if (!cmdName) continue;
      nextCommands.set(cmdName, cmd);
      if (Array.isArray(cmd.aliases)) {
        for (const alias of cmd.aliases) {
          const cleanAlias = String(alias || '').toLowerCase();
          if (cleanAlias) nextAliases.set(cleanAlias, cmdName);
        }
      }
    }
  }

  let legacyRegistered = 0;
  if (typeof loadLegacyFn === 'function') {
    const legacyCommands = await loadLegacyFn();
    for (const legacyCommand of legacyCommands || []) {
      const name = String(legacyCommand?.name || '').toLowerCase();
      if (!name || nextCommands.has(name)) continue;

      const safeAliases = (legacyCommand.aliases || []).filter((alias) => {
        const cleanAlias = String(alias || '').toLowerCase();
        return cleanAlias && !nextCommands.has(cleanAlias) && !nextAliases.has(cleanAlias);
      });

      legacyCommand.aliases = safeAliases;
      nextCommands.set(name, legacyCommand);
      for (const alias of safeAliases) {
        nextAliases.set(String(alias).toLowerCase(), name);
      }
      legacyRegistered += 1;
    }
  }

  commandsMap.clear();
  for (const [key, value] of nextCommands.entries()) {
    commandsMap.set(key, value);
  }

  aliasesMap.clear();
  for (const [key, value] of nextAliases.entries()) {
    aliasesMap.set(key, value);
  }

  return {
    commandCount: commandsMap.size,
    aliasCount: aliasesMap.size,
    legacyRegistered,
  };
}

export async function applyPostUpdateReload({
  env = process.env,
  hasIpc = typeof process.send === 'function',
  forceReloadOnly = false,
} = {}) {
  if (
    !forceReloadOnly &&
    isSupervisedProcess(env, hasIpc) &&
    typeof registeredHandlers.shutdownForRestart === 'function'
  ) {
    await registeredHandlers.shutdownForRestart();
    return { mode: 'supervised_restart', commandCount: 0, aliasCount: 0 };
  }

  if (typeof registeredHandlers.reloadCommands === 'function') {
    const stats = await registeredHandlers.reloadCommands();
    return {
      mode: 'in_place_reload',
      commandCount: Number(stats?.commandCount || 0),
      aliasCount: Number(stats?.aliasCount || 0),
    };
  }

  return { mode: 'noop', commandCount: 0, aliasCount: 0 };
}
