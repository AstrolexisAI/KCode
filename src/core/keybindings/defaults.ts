// KCode - Default keybindings and reserved keys
// Defines the built-in keybinding set and system-reserved keys that cannot be reassigned.

import { parseKeyChord } from "./parser.js";
import type { KeyBinding } from "./types.js";

/** Keys reserved by the system that cannot be reassigned by users */
export const RESERVED_KEYS: Record<string, string> = {
  "ctrl+c": "Interrupt/Cancel (system)",
  "ctrl+d": "Exit/EOF (system)",
  "ctrl+z": "Suspend (system)",
};

/** Default keybindings shipped with KCode */
export const DEFAULT_BINDINGS: KeyBinding[] = [
  // Navigation
  { action: "history.prev", chord: parseKeyChord("up"), source: "default", description: "Previous command", context: "input" },
  { action: "history.next", chord: parseKeyChord("down"), source: "default", description: "Next command", context: "input" },
  { action: "submit", chord: parseKeyChord("enter"), source: "default", description: "Submit prompt", context: "input" },
  { action: "newline", chord: parseKeyChord("shift+enter"), source: "default", description: "New line", context: "input" },

  // Editing
  { action: "clear", chord: parseKeyChord("ctrl+l"), source: "default", description: "Clear screen" },

  // Chords
  { action: "toggle.theme", chord: parseKeyChord("ctrl+k ctrl+t"), source: "default", description: "Toggle theme" },
  { action: "toggle.vim", chord: parseKeyChord("ctrl+k ctrl+v"), source: "default", description: "Toggle vim mode" },
  { action: "toggle.verbose", chord: parseKeyChord("ctrl+k ctrl+d"), source: "default", description: "Toggle verbose" },
  { action: "search.messages", chord: parseKeyChord("ctrl+k ctrl+f"), source: "default", description: "Search messages" },
  { action: "pin.file", chord: parseKeyChord("ctrl+k ctrl+p"), source: "default", description: "Pin file" },
  { action: "show.cost", chord: parseKeyChord("ctrl+k ctrl+c"), source: "default", description: "Show cost summary" },
  { action: "model.switch", chord: parseKeyChord("ctrl+k ctrl+m"), source: "default", description: "Switch model" },

  // Function keys
  { action: "help", chord: parseKeyChord("f1"), source: "default", description: "Help" },
  { action: "compact", chord: parseKeyChord("f2"), source: "default", description: "Force compact" },

  // Toggle
  { action: "toggle.thinking", chord: parseKeyChord("alt+t"), source: "default", description: "Toggle thinking mode", context: "input" },
  { action: "cancel", chord: parseKeyChord("escape"), source: "default", description: "Cancel response" },
  { action: "permission.cycle", chord: parseKeyChord("shift+tab"), source: "default", description: "Cycle permission mode" },
];
