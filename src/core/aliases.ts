// KCode - Custom Alias Manager
// Persistent user-defined aliases for slash commands stored in ~/.kcode/aliases.json

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { kcodeHome, kcodePath } from "./paths";

const ALIASES_PATH = kcodePath("aliases.json");

export interface AliasEntry {
  shortcut: string;
  expansion: string;
}

function ensureDir(): void {
  const dir = kcodeHome();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadAliases(): AliasEntry[] {
  if (!existsSync(ALIASES_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(ALIASES_PATH, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveAliases(aliases: AliasEntry[]): void {
  ensureDir();
  writeFileSync(ALIASES_PATH, JSON.stringify(aliases, null, 2), "utf-8");
}

export function addAlias(shortcut: string, expansion: string): AliasEntry {
  const aliases = loadAliases();
  // Upsert — update if exists, insert otherwise
  const idx = aliases.findIndex(a => a.shortcut === shortcut);
  const entry: AliasEntry = { shortcut, expansion };
  if (idx >= 0) {
    aliases[idx] = entry;
  } else {
    aliases.push(entry);
  }
  saveAliases(aliases);
  return entry;
}

export function removeAlias(shortcut: string): boolean {
  const aliases = loadAliases();
  const idx = aliases.findIndex(a => a.shortcut === shortcut);
  if (idx < 0) return false;
  aliases.splice(idx, 1);
  saveAliases(aliases);
  return true;
}

export function resolveAlias(input: string): string | null {
  const aliases = loadAliases();
  // Match /shortcut at start of input
  const trimmed = input.trim();
  for (const { shortcut, expansion } of aliases) {
    const prefix = "/" + shortcut;
    if (trimmed === prefix || trimmed.startsWith(prefix + " ")) {
      const rest = trimmed.slice(prefix.length);
      return expansion + rest;
    }
  }
  return null;
}
