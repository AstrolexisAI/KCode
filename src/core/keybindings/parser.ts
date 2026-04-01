// KCode - Key combo and chord parser
// Parses string representations like "ctrl+k ctrl+c" into structured KeyChord objects
// and formats them back to platform-aware display strings.

import type { KeyChord, KeyCombo } from "./types.js";

/** Known modifier names that are stripped from the key portion */
const MODIFIERS = new Set(["ctrl", "alt", "shift", "meta", "cmd"]);

/** Known special key aliases mapped to canonical names */
const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  del: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown",
  cr: "enter",
  return: "enter",
  space: " ",
  spc: " ",
};

/**
 * Parse a key combo string like "ctrl+shift+a" into a KeyCombo.
 */
export function parseKeyCombo(input: string): KeyCombo {
  const parts = input.trim().toLowerCase().split("+");
  const modifiers = new Set<string>();
  let key = "";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!.trim();
    if (i < parts.length - 1 && MODIFIERS.has(part)) {
      modifiers.add(part);
    } else if (i === parts.length - 1) {
      key = KEY_ALIASES[part] ?? part;
    }
  }

  return {
    key,
    ctrl: modifiers.has("ctrl"),
    alt: modifiers.has("alt"),
    shift: modifiers.has("shift"),
    meta: modifiers.has("meta") || modifiers.has("cmd"),
  };
}

/**
 * Parse a keybinding string to a KeyChord.
 *
 * Examples:
 *   "ctrl+c"           -> { sequence: [{ key: 'c', ctrl: true, ... }] }
 *   "ctrl+k ctrl+c"    -> { sequence: [{ key: 'k', ctrl: true }, { key: 'c', ctrl: true }] }
 *   "escape"            -> { sequence: [{ key: 'escape', ctrl: false, ... }] }
 */
export function parseKeyChord(input: string): KeyChord {
  const parts = input.trim().split(/\s+/);
  return {
    sequence: parts.map(parseKeyCombo),
  };
}

/**
 * Serialize a KeyCombo to a canonical lowercase string like "ctrl+shift+a".
 * Modifier order is always: ctrl, alt, shift, meta.
 */
export function serializeCombo(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push("ctrl");
  if (combo.alt) parts.push("alt");
  if (combo.shift) parts.push("shift");
  if (combo.meta) parts.push("meta");
  parts.push(combo.key);
  return parts.join("+");
}

/**
 * Serialize a KeyChord to a canonical string like "ctrl+k ctrl+c".
 */
export function serializeChord(chord: KeyChord): string {
  return chord.sequence.map(serializeCombo).join(" ");
}

/**
 * Format a KeyChord to a human-readable, platform-aware display string.
 * Uses symbols on macOS (e.g. ⌃K ⌃T) and text on Linux/Windows (e.g. Ctrl+K Ctrl+T).
 */
export function formatKeyChord(
  chord: KeyChord,
  platform: "darwin" | "linux" | "win32" = process.platform as "darwin" | "linux" | "win32",
): string {
  const isDarwin = platform === "darwin";
  return chord.sequence
    .map((combo) => {
      const parts: string[] = [];
      if (combo.ctrl) parts.push(isDarwin ? "\u2303" : "Ctrl");
      if (combo.alt) parts.push(isDarwin ? "\u2325" : "Alt");
      if (combo.shift) parts.push(isDarwin ? "\u21E7" : "Shift");
      if (combo.meta) parts.push(isDarwin ? "\u2318" : "Win");
      parts.push(formatKeyName(combo.key));
      return parts.join(isDarwin ? "" : "+");
    })
    .join(" ");
}

/** Capitalize a key name for display */
function formatKeyName(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  // F-keys, named keys
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Check if two KeyCombo values are equal.
 */
export function comboEquals(a: KeyCombo, b: KeyCombo): boolean {
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.meta === b.meta
  );
}

/**
 * Check if two KeyChord values are equal.
 */
export function chordEquals(a: KeyChord, b: KeyChord): boolean {
  if (a.sequence.length !== b.sequence.length) return false;
  return a.sequence.every((combo, i) => comboEquals(combo, b.sequence[i]!));
}
