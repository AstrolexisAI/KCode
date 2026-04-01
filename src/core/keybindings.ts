// KCode - Configurable Keybindings
// Legacy interface — delegates to the new keybindings/ module.
// Kept for backward compatibility with existing imports.

import { loadUserBindings } from "./keybindings/loader.js";
import { kcodePath } from "./paths.js";

export interface KeybindingConfig {
  /** Enable vim-style normal/insert mode toggle */
  vimMode?: boolean;
  /** Custom key bindings: action -> key combo */
  bindings?: Record<string, string>;
}

export type VimMode = "insert" | "normal";

const KEYBINDINGS_PATH = kcodePath("keybindings.json");

let config: KeybindingConfig | null = null;

export function loadKeybindings(): KeybindingConfig {
  if (config) return config;
  try {
    const { readFileSync } = require("node:fs");
    config = JSON.parse(readFileSync(KEYBINDINGS_PATH, "utf-8"));
    return config!;
  } catch {
    config = {};
    return config;
  }
}

export function isVimModeEnabled(): boolean {
  return loadKeybindings().vimMode === true;
}

export type {
  BindingContext,
  BindingSource,
  KeyBinding,
  KeyChord,
  KeyCombo,
  ValidationResult,
} from "./keybindings/index.js";
// Re-export new module for consumers that want the advanced system
export {
  DEFAULT_BINDINGS,
  formatKeyChord,
  KeybindingResolver,
  loadUserBindings,
  parseKeyChord,
  parseKeyCombo,
  RESERVED_KEYS,
  serializeChord,
  serializeCombo,
  validateBindings,
} from "./keybindings/index.js";
