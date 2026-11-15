import fs from "node:fs";
import path from "node:path";
import { normalizeSudoTarget } from "./userJid.js";

function getDefaultSudoPath() {
  return path.join(process.cwd(), "data", "sudo.json");
}

function getLegacySudoPath() {
  return path.join(process.cwd(), "sudo.json");
}

function normalizeEntry(value) {
  return normalizeSudoTarget(value) || "";
}

export function loadSudoList(filePath) {
  const resolvedPath = filePath || getDefaultSudoPath();
  const isDefault = !filePath;
  const tryRead = (target) => {
    try {
      const value = JSON.parse(fs.readFileSync(target, "utf8"));
      const entries = Array.isArray(value) ? value : value?.users ?? value?.sudo ?? [];
      return new Set(entries.map((entry) => normalizeEntry(entry)).filter(Boolean));
    } catch {
      return null;
    }
  };
  return (
    tryRead(resolvedPath) ||
    (isDefault ? tryRead(getLegacySudoPath()) : null) ||
    new Set()
  );
}

export function saveSudoList(listOrSet, filePath) {
  const resolvedPath = filePath || getDefaultSudoPath();
  const entries = Array.from(listOrSet || [])
    .map((entry) => normalizeEntry(entry))
    .filter(Boolean);
  const unique = Array.from(new Set(entries));
  try {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const tmpPath = `${resolvedPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(unique, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, resolvedPath);
  } catch {
    // Best-effort persistence on read-only hosts
  }
  return unique;
}

export function isSudoNumber(jidOrPhone, filePath) {
  const target = normalizeEntry(jidOrPhone);
  if (!target) return false;
  if (globalThis.ALLOWED_USERS instanceof Set) {
    for (const entry of globalThis.ALLOWED_USERS) {
      if (normalizeEntry(entry) === target) return true;
    }
  }
  const stored = loadSudoList(filePath);
  for (const entry of stored) {
    if (normalizeEntry(entry) === target) return true;
  }
  return false;
}

export function addSudoNumber(jidOrPhone, filePath) {
  const target = normalizeEntry(jidOrPhone);
  if (!target) return false;
  if (!(globalThis.ALLOWED_USERS instanceof Set)) {
    globalThis.ALLOWED_USERS = loadSudoList(filePath);
  }
  globalThis.ALLOWED_USERS.add(target);
  const next = loadSudoList(filePath);
  next.add(target);
  saveSudoList(next, filePath);
  return true;
}

export function removeSudoNumber(jidOrPhone, filePath) {
  const target = normalizeEntry(jidOrPhone);
  if (!target) return false;
  if (globalThis.ALLOWED_USERS instanceof Set) {
    for (const entry of Array.from(globalThis.ALLOWED_USERS)) {
      if (normalizeEntry(entry) === target || String(entry) === String(jidOrPhone)) {
        globalThis.ALLOWED_USERS.delete(entry);
      }
    }
  }
  const next = loadSudoList(filePath);
  for (const entry of Array.from(next)) {
    if (normalizeEntry(entry) === target || String(entry) === String(jidOrPhone)) {
      next.delete(entry);
    }
  }
  saveSudoList(next, filePath);
  return true;
}
