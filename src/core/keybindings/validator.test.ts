// KCode - Validator tests for keybinding conflict detection

import { describe, test, expect } from "bun:test";
import { validateBindings } from "./validator.js";
import { parseKeyChord } from "./parser.js";
import type { KeyBinding } from "./types.js";

function makeBinding(
  action: string,
  key: string,
  source: "default" | "user" | "plugin" = "default",
  context?: string,
): KeyBinding {
  return {
    action,
    chord: parseKeyChord(key),
    source,
    context: context as KeyBinding["context"],
  };
}

describe("validateBindings", () => {
  describe("reserved key violations", () => {
    test("default bindings on reserved keys are allowed", () => {
      const result = validateBindings([
        makeBinding("interrupt", "ctrl+c", "default"),
      ]);
      expect(result.reservedViolations).toHaveLength(0);
    });

    test("user binding on ctrl+c is a violation", () => {
      const result = validateBindings([
        makeBinding("custom.action", "ctrl+c", "user"),
      ]);
      expect(result.reservedViolations).toHaveLength(1);
      expect(result.reservedViolations[0]!.reason).toContain("ctrl+c");
      expect(result.reservedViolations[0]!.reason).toContain("reserved");
    });

    test("user binding on ctrl+d is a violation", () => {
      const result = validateBindings([
        makeBinding("custom.action", "ctrl+d", "user"),
      ]);
      expect(result.reservedViolations).toHaveLength(1);
    });

    test("user binding on ctrl+z is a violation", () => {
      const result = validateBindings([
        makeBinding("custom.action", "ctrl+z", "user"),
      ]);
      expect(result.reservedViolations).toHaveLength(1);
    });

    test("plugin binding on reserved key is a violation", () => {
      const result = validateBindings([
        makeBinding("plugin.action", "ctrl+c", "plugin"),
      ]);
      expect(result.reservedViolations).toHaveLength(1);
    });

    test("user binding on non-reserved key is fine", () => {
      const result = validateBindings([
        makeBinding("custom.action", "ctrl+l", "user"),
      ]);
      expect(result.reservedViolations).toHaveLength(0);
    });
  });

  describe("chord conflicts", () => {
    test("no conflicts when all chords are unique", () => {
      const result = validateBindings([
        makeBinding("action1", "ctrl+a"),
        makeBinding("action2", "ctrl+b"),
      ]);
      expect(result.conflicts).toHaveLength(0);
    });

    test("detects duplicate chord+context conflict", () => {
      const result = validateBindings([
        makeBinding("action1", "ctrl+l", "default"),
        makeBinding("action2", "ctrl+l", "user"),
      ]);
      expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
      const conflict = result.conflicts.find((c) => c.chord.startsWith("ctrl+l"));
      expect(conflict).toBeDefined();
      expect(conflict!.bindings).toHaveLength(2);
    });

    test("same chord in different contexts is not a conflict", () => {
      const result = validateBindings([
        makeBinding("action1", "ctrl+l", "default", "global"),
        makeBinding("action2", "ctrl+l", "default", "input"),
      ]);
      // No conflict because contexts differ
      const chordConflicts = result.conflicts.filter(
        (c) => c.bindings.length === 2 && c.bindings[0]!.action === "action1" && c.bindings[1]!.action === "action2",
      );
      expect(chordConflicts).toHaveLength(0);
    });
  });

  describe("prefix conflicts", () => {
    test("simple binding blocks chord starting with same combo", () => {
      const result = validateBindings([
        makeBinding("simple", "ctrl+k"),
        makeBinding("chord", "ctrl+k ctrl+t"),
      ]);
      const prefixConflict = result.conflicts.find((c) =>
        c.resolution.includes("blocks chord"),
      );
      expect(prefixConflict).toBeDefined();
      expect(prefixConflict!.resolution).toContain('"simple" blocks chord "chord"');
    });

    test("no prefix conflict when there is no simple binding", () => {
      const result = validateBindings([
        makeBinding("chord1", "ctrl+k ctrl+t"),
        makeBinding("chord2", "ctrl+k ctrl+v"),
      ]);
      const prefixConflicts = result.conflicts.filter((c) =>
        c.resolution.includes("blocks chord"),
      );
      expect(prefixConflicts).toHaveLength(0);
    });

    test("prefix conflict only within same context", () => {
      const result = validateBindings([
        makeBinding("simple", "ctrl+k", "default", "vim-normal"),
        makeBinding("chord", "ctrl+k ctrl+t", "default", "input"),
      ]);
      const prefixConflicts = result.conflicts.filter((c) =>
        c.resolution.includes("blocks chord"),
      );
      expect(prefixConflicts).toHaveLength(0);
    });
  });

  describe("valid flag", () => {
    test("valid when no reserved violations and no user conflicts", () => {
      const result = validateBindings([
        makeBinding("action1", "ctrl+a", "default"),
        makeBinding("action2", "ctrl+b", "default"),
      ]);
      expect(result.valid).toBe(true);
    });

    test("invalid when reserved key violated", () => {
      const result = validateBindings([
        makeBinding("custom", "ctrl+c", "user"),
      ]);
      expect(result.valid).toBe(false);
    });

    test("invalid when user binding has conflict", () => {
      const result = validateBindings([
        makeBinding("action1", "ctrl+l", "default"),
        makeBinding("action2", "ctrl+l", "user"),
      ]);
      expect(result.valid).toBe(false);
    });

    test("valid when only default bindings conflict (no user involvement)", () => {
      const result = validateBindings([
        makeBinding("action1", "ctrl+l", "default"),
        makeBinding("action2", "ctrl+l", "default"),
      ]);
      // Conflicts exist but no user bindings involved, so valid is true
      expect(result.valid).toBe(true);
    });
  });
});
