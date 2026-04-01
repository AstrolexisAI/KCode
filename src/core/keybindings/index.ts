// KCode - Keybindings module re-exports
// Central entry point for the advanced keybinding system with chord support.

export { DEFAULT_BINDINGS, RESERVED_KEYS } from "./defaults.js";
export { loadUserBindings } from "./loader.js";
export {
  chordEquals,
  comboEquals,
  formatKeyChord,
  parseKeyChord,
  parseKeyCombo,
  serializeChord,
  serializeCombo,
} from "./parser.js";

export { KeybindingResolver } from "./resolver.js";
export type {
  BindingContext,
  BindingSource,
  ConflictInfo,
  KeyBinding,
  KeybindingsFileFormat,
  KeyChord,
  KeyCombo,
  ReservedViolation,
  ValidationResult,
} from "./types.js";
export { validateBindings } from "./validator.js";
