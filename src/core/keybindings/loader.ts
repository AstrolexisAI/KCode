// KCode - User keybindings loader
// Reads ~/.kcode/keybindings.json and converts entries to KeyBinding objects.

import { existsSync, readFileSync } from "node:fs";
import { kcodePath } from "../paths.js";
import { parseKeyChord } from "./parser.js";
import type { KeyBinding, KeybindingsFileFormat } from "./types.js";

const KEYBINDINGS_PATH = kcodePath("keybindings.json");

/**
 * Load user-defined keybindings from ~/.kcode/keybindings.json.
 * Returns an empty array if the file does not exist or is invalid.
 */
export function loadUserBindings(path?: string): KeyBinding[] {
  const filePath = path ?? KEYBINDINGS_PATH;
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf-8");
    const data: KeybindingsFileFormat = JSON.parse(raw);
    if (!data.bindings || !Array.isArray(data.bindings)) return [];

    return data.bindings.map((entry) => ({
      action: entry.action,
      chord: parseKeyChord(entry.key),
      source: "user" as const,
      description: entry.description,
      context: entry.context,
    }));
  } catch {
    return [];
  }
}
