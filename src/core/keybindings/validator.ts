// KCode - Keybinding conflict validator
// Detects reserved key violations, duplicate chord conflicts, and prefix conflicts.

import { RESERVED_KEYS } from "./defaults.js";
import { serializeChord, serializeCombo } from "./parser.js";
import type { ConflictInfo, KeyBinding, ReservedViolation, ValidationResult } from "./types.js";

/**
 * Validate a set of keybindings for conflicts and reserved key violations.
 *
 * Rules:
 * 1. Non-default bindings cannot use reserved keys (ctrl+c, ctrl+d, ctrl+z).
 * 2. Two bindings with the same chord+context are a conflict; the last-loaded wins.
 * 3. A single-combo binding that matches the first combo of a chord blocks the chord.
 */
export function validateBindings(bindings: KeyBinding[]): ValidationResult {
  const conflicts: ConflictInfo[] = [];
  const reservedViolations: ReservedViolation[] = [];

  // 1. Check reserved keys
  for (const binding of bindings) {
    if (binding.source !== "default") {
      const serialized = serializeChord(binding.chord);
      if (RESERVED_KEYS[serialized]) {
        reservedViolations.push({
          binding,
          reason: `${serialized} is reserved: ${RESERVED_KEYS[serialized]}`,
        });
      }
    }
  }

  // 2. Check duplicate chord+context conflicts
  const chordMap = new Map<string, KeyBinding[]>();
  for (const binding of bindings) {
    const key = serializeChord(binding.chord) + ":" + (binding.context ?? "global");
    const arr = chordMap.get(key);
    if (arr) {
      arr.push(binding);
    } else {
      chordMap.set(key, [binding]);
    }
  }

  for (const [chord, bindingsForChord] of chordMap) {
    if (bindingsForChord.length > 1) {
      conflicts.push({
        chord,
        bindings: bindingsForChord,
        resolution: `${bindingsForChord[bindingsForChord.length - 1]!.source} wins (last loaded)`,
      });
    }
  }

  // 3. Check prefix conflicts: a single-combo binding blocks any chord starting with it
  for (const binding of bindings) {
    if (binding.chord.sequence.length === 1) {
      const prefix = serializeCombo(binding.chord.sequence[0]!);
      for (const other of bindings) {
        if (
          other !== binding &&
          other.chord.sequence.length > 1 &&
          serializeCombo(other.chord.sequence[0]!) === prefix &&
          (binding.context ?? "global") === (other.context ?? "global")
        ) {
          conflicts.push({
            chord: prefix,
            bindings: [binding, other],
            resolution: `Simple binding "${binding.action}" blocks chord "${other.action}"`,
          });
        }
      }
    }
  }

  return {
    valid:
      reservedViolations.length === 0 &&
      conflicts.filter((c) => c.bindings.some((b) => b.source === "user")).length === 0,
    conflicts,
    reservedViolations,
  };
}
