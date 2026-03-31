// KCode - Configurable Keybindings
// Legacy interface — delegates to the new keybindings/ module.
// Kept for backward compatibility with existing imports.

import { kcodePath } from "./paths.js";
import { loadUserBindings } from "./keybindings/loader.js";

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

// Re-export new module for consumers that want the advanced system
export {
  KeybindingResolver,
  parseKeyChord,
  parseKeyCombo,
  formatKeyChord,
  serializeChord,
  serializeCombo,
  validateBindings,
  DEFAULT_BINDINGS,
  RESERVED_KEYS,
  loadUserBindings,
} from "./keybindings/index.js";

export type {
  KeyCombo,
  KeyChord,
  KeyBinding,
  BindingSource,
  BindingContext,
  ValidationResult,
} from "./keybindings/index.js";
