// KCode - Configurable Keybindings
// Supports readline-style shortcuts and vim normal mode

import { kcodePath } from "./paths";

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
