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
  const commandCandidates = [];
  const collisions = [];

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
      commandCandidates.push({
        name: cmdName,
        command: cmd,
        source: file,
        aliases: Array.isArray(cmd.aliases) ? cmd.aliases : [],
        isLegacy: false,
      });
    }
  }

  if (typeof loadLegacyFn === 'function') {
    const legacyCommands = await loadLegacyFn();
    for (const legacyCommand of legacyCommands || []) {
      const name = String(legacyCommand?.name || '').toLowerCase();
      if (!name) continue;
      commandCandidates.push({
        name,
        command: legacyCommand,
        source: 'legacy',
        aliases: Array.isArray(legacyCommand.aliases) ? legacyCommand.aliases : [],
        isLegacy: true,
      });
    }
  }

  const nextCommands = new Map();
  const registeredCommands = [];
  for (const candidate of commandCandidates) {
    const { name, source, command } = candidate;
    if (nextCommands.has(name)) {
      const kept = registeredCommands.find((entry) => entry.name === name);
      collisions.push({
        type: 'duplicate-canonical-name',
        name,
        kept: `${kept.source}:${kept.name}`,
        rejected: `${source}:${name}`,
      });
      continue;
    }
    nextCommands.set(name, command);
    registeredCommands.push(candidate);
  }

  const nextAliases = new Map();
  const firstAliasSource = new Map();
  for (const candidate of registeredCommands) {
    const { name: cmdName, source, aliases } = candidate;
    const acceptedLegacyAliases = [];
    for (const alias of aliases) {
      const cleanAlias = String(alias || '').toLowerCase();
      if (!cleanAlias) continue;

      const aliasSource = `${source}:${cmdName}`;
      if (nextCommands.has(cleanAlias)) {
        const canonical = registeredCommands.find((entry) => entry.name === cleanAlias);
        collisions.push({
          type: 'alias-canonical-collision',
          name: cleanAlias,
          canonical: `${canonical.source}:${canonical.name}`,
          alias: aliasSource,
        });
        continue;
      }

      if (firstAliasSource.has(cleanAlias)) {
        collisions.push({
          type: 'duplicate-alias',
          name: cleanAlias,
          kept: firstAliasSource.get(cleanAlias),
          rejected: aliasSource,
        });
        continue;
      }

      firstAliasSource.set(cleanAlias, aliasSource);
      nextAliases.set(cleanAlias, cmdName);
      if (candidate.isLegacy) acceptedLegacyAliases.push(alias);
    }
    if (candidate.isLegacy) candidate.command.aliases = acceptedLegacyAliases;
  }

  if (collisions.length > 0) {
    console.warn('[COMMAND LOADER] Command collisions detected:', collisions);
  }

  const legacyRegistered = registeredCommands.filter((candidate) => candidate.isLegacy).length;

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
    collisions,
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
