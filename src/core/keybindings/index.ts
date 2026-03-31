// KCode - Keybindings module re-exports
// Central entry point for the advanced keybinding system with chord support.

export type {
  KeyCombo,
  KeyChord,
  KeyBinding,
  BindingSource,
  BindingContext,
  ConflictInfo,
  ReservedViolation,
  ValidationResult,
  KeybindingsFileFormat,
} from "./types.js";

export {
  parseKeyCombo,
  parseKeyChord,
  serializeCombo,
  serializeChord,
  formatKeyChord,
  comboEquals,
  chordEquals,
} from "./parser.js";

export { RESERVED_KEYS, DEFAULT_BINDINGS } from "./defaults.js";

export { KeybindingResolver } from "./resolver.js";

export { validateBindings } from "./validator.js";

export { loadUserBindings } from "./loader.js";
