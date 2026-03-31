// KCode - Keybinding types
// Interfaces for key combos, chords, and bindings

export interface KeyCombo {
  /** Base key: 'a', 'enter', 'escape', 'f5', etc. */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Cmd on macOS, Win on Windows */
  meta: boolean;
}

export interface KeyChord {
  /** Sequence of combos (1 = simple combo, 2+ = chord) */
  sequence: KeyCombo[];
}

export type BindingSource = "default" | "user" | "plugin";

export type BindingContext = "global" | "input" | "vim-normal" | "vim-insert";

export interface KeyBinding {
  /** Action to execute */
  action: string;
  /** Full chord */
  chord: KeyChord;
  /** Source: 'default' | 'user' | 'plugin' */
  source: BindingSource;
  /** Description for help */
  description?: string;
  /** Context where it applies */
  context?: BindingContext;
}

export interface ConflictInfo {
  chord: string;
  bindings: KeyBinding[];
  resolution: string;
}

export interface ReservedViolation {
  binding: KeyBinding;
  reason: string;
}

export interface ValidationResult {
  valid: boolean;
  conflicts: ConflictInfo[];
  reservedViolations: ReservedViolation[];
}

export interface KeybindingsFileFormat {
  bindings?: Array<{
    action: string;
    key: string;
    context?: BindingContext;
    description?: string;
  }>;
  vimMode?: boolean;
}
