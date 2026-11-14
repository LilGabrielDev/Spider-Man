import fs from "node:fs";
import path from "node:path";

const SUDO_PATH = path.join(process.cwd(), "data", "sudo.json");

export function loadSudoList(filePath = SUDO_PATH) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const entries = Array.isArray(value) ? value : value?.users ?? value?.sudo ?? [];
    return new Set(entries.map((entry) => String(entry).trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}
