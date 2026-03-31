// KCode - Keybinding resolver with chord support
// Processes key presses, matches them against bindings, handles multi-step chords with timeout.

import { EventEmitter } from "node:events";
import { comboEquals, serializeChord } from "./parser.js";
import type { KeyCombo, KeyBinding } from "./types.js";

/** Chord timeout in milliseconds — if a chord is not completed within this time, it resets */
const CHORD_TIMEOUT_MS = 1500;

export class KeybindingResolver extends EventEmitter {
  private bindings: KeyBinding[] = [];
  private pendingChord: KeyCombo[] = [];
  private chordTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(defaults: KeyBinding[], userOverrides: KeyBinding[] = []) {
    super();
    this.bindings = this.merge(defaults, userOverrides);
  }

  /** Get all active bindings */
  getBindings(): readonly KeyBinding[] {
    return this.bindings;
  }

  /** Find the binding for a given action */
  getBindingForAction(action: string): KeyBinding | undefined {
    return this.bindings.find((b) => b.action === action);
  }

  /**
   * Process a key press. Returns the action to execute, or null if:
   * - The key is part of a pending chord (waiting for more keys)
   * - No binding matches
   */
  processKeyPress(combo: KeyCombo, context?: string): string | null {
    this.pendingChord.push(combo);

    // Look for an exact match
    const exactMatch = this.findExactMatch(this.pendingChord, context);
    if (exactMatch) {
      this.resetChord();
      this.emit("action", exactMatch.action);
      return exactMatch.action;
    }

    // Check if any chord starts with this prefix
    const hasPrefix = this.hasPrefixMatch(this.pendingChord, context);
    if (hasPrefix) {
      this.startChordTimeout();
      this.emit("chord-pending", this.pendingChord.slice());
      return null;
    }

    // No match — reset
    this.resetChord();
    return null;
  }

  /** Check if a chord is currently pending (waiting for more keys) */
  isPending(): boolean {
    return this.pendingChord.length > 0;
  }

  /** Get the current pending chord sequence */
  getPendingChord(): readonly KeyCombo[] {
    return this.pendingChord;
  }

  /** Cancel any pending chord */
  cancelChord(): void {
    if (this.pendingChord.length > 0) {
      this.resetChord();
      this.emit("chord-cancelled");
    }
  }

  /**
   * Merge defaults with user overrides.
   * User overrides win on: same action (replaces chord), same chord+context (replaces action).
   */
  private merge(defaults: KeyBinding[], overrides: KeyBinding[]): KeyBinding[] {
    const result = [...defaults];

    for (const override of overrides) {
      // Remove any default with the same action
      const actionIdx = result.findIndex(
        (b) => b.action === override.action && b.source === "default",
      );
      if (actionIdx >= 0) {
        result.splice(actionIdx, 1);
      }

      // Remove any default with the same chord+context
      const chordKey = serializeChord(override.chord) + ":" + (override.context ?? "global");
      const chordIdx = result.findIndex(
        (b) =>
          serializeChord(b.chord) + ":" + (b.context ?? "global") === chordKey &&
          b.source === "default",
      );
      if (chordIdx >= 0 && chordIdx !== actionIdx) {
        result.splice(chordIdx, 1);
      }

      result.push(override);
    }

    return result;
  }

  private findExactMatch(sequence: KeyCombo[], context?: string): KeyBinding | null {
    for (const binding of this.bindings) {
      if (binding.chord.sequence.length !== sequence.length) continue;
      const contextMatch =
        !binding.context ||
        binding.context === "global" ||
        binding.context === context;
      if (!contextMatch) continue;
      if (binding.chord.sequence.every((c, i) => comboEquals(c, sequence[i]!))) {
        return binding;
      }
    }
    return null;
  }

  private hasPrefixMatch(sequence: KeyCombo[], context?: string): boolean {
    for (const binding of this.bindings) {
      if (binding.chord.sequence.length <= sequence.length) continue;
      const contextMatch =
        !binding.context ||
        binding.context === "global" ||
        binding.context === context;
      if (!contextMatch) continue;
      if (sequence.every((c, i) => comboEquals(c, binding.chord.sequence[i]!))) {
        return true;
      }
    }
    return false;
  }

  private startChordTimeout(): void {
    if (this.chordTimeout) {
      clearTimeout(this.chordTimeout);
    }
    this.chordTimeout = setTimeout(() => {
      this.pendingChord = [];
      this.chordTimeout = null;
      this.emit("chord-cancelled");
    }, CHORD_TIMEOUT_MS);
  }

  private resetChord(): void {
    this.pendingChord = [];
    if (this.chordTimeout) {
      clearTimeout(this.chordTimeout);
      this.chordTimeout = null;
    }
  }
}
