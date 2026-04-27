// KCode - Resolver tests for keybinding matching and chord handling

import { beforeEach, describe, expect, test } from "bun:test";
import { parseKeyChord, parseKeyCombo } from "./parser.js";
import { KeybindingResolver } from "./resolver.js";
import type { KeyBinding } from "./types.js";

function makeBinding(
  action: string,
  key: string,
  source: "default" | "user" = "default",
  context?: string,
): KeyBinding {
  return {
    action,
    chord: parseKeyChord(key),
    source,
    context: context as KeyBinding["context"],
  };
}

describe("KeybindingResolver", () => {
  let resolver: KeybindingResolver;

  beforeEach(() => {
    resolver = new KeybindingResolver([
      makeBinding("submit", "enter"),
      makeBinding("clear", "ctrl+l"),
      makeBinding("toggle.theme", "ctrl+k ctrl+t"),
      makeBinding("toggle.vim", "ctrl+k ctrl+v"),
      makeBinding("help", "f1"),
    ]);
  });

  test("matches a simple single-combo binding", () => {
    const result = resolver.processKeyPress(parseKeyCombo("enter"));
    expect(result).toBe("submit");
  });

  test("matches a simple modifier combo", () => {
    const result = resolver.processKeyPress(parseKeyCombo("ctrl+l"));
    expect(result).toBe("clear");
  });

  test("returns null for unbound key", () => {
    const result = resolver.processKeyPress(parseKeyCombo("ctrl+x"));
    expect(result).toBeNull();
  });

  test("matches a function key", () => {
    const result = resolver.processKeyPress(parseKeyCombo("f1"));
    expect(result).toBe("help");
  });

  describe("chord handling", () => {
    test("first key of chord returns null (pending)", () => {
      const result = resolver.processKeyPress(parseKeyCombo("ctrl+k"));
      expect(result).toBeNull();
      expect(resolver.isPending()).toBe(true);
    });

    test("completing a chord returns the action", () => {
      resolver.processKeyPress(parseKeyCombo("ctrl+k"));
      const result = resolver.processKeyPress(parseKeyCombo("ctrl+t"));
      expect(result).toBe("toggle.theme");
      expect(resolver.isPending()).toBe(false);
    });

    test("wrong second key resets chord", () => {
      resolver.processKeyPress(parseKeyCombo("ctrl+k"));
      const result = resolver.processKeyPress(parseKeyCombo("ctrl+x"));
      expect(result).toBeNull();
      expect(resolver.isPending()).toBe(false);
    });

    test("can complete different chords with same prefix", () => {
      resolver.processKeyPress(parseKeyCombo("ctrl+k"));
      const r1 = resolver.processKeyPress(parseKeyCombo("ctrl+v"));
      expect(r1).toBe("toggle.vim");

      // Second chord
      resolver.processKeyPress(parseKeyCombo("ctrl+k"));
      const r2 = resolver.processKeyPress(parseKeyCombo("ctrl+t"));
      expect(r2).toBe("toggle.theme");
    });

    test("cancelChord resets pending state", () => {
      resolver.processKeyPress(parseKeyCombo("ctrl+k"));
      expect(resolver.isPending()).toBe(true);
      resolver.cancelChord();
      expect(resolver.isPending()).toBe(false);
    });

    test("getPendingChord returns the current sequence", () => {
      expect(resolver.getPendingChord()).toHaveLength(0);
      resolver.processKeyPress(parseKeyCombo("ctrl+k"));
      expect(resolver.getPendingChord()).toHaveLength(1);
      expect(resolver.getPendingChord()[0]!.key).toBe("k");
    });
  });

  describe("events", () => {
    test("emits action event on match", () => {
      let emitted = null as string | null;
      resolver.on("action", (action: string) => {
        emitted = action;
      });
      resolver.processKeyPress(parseKeyCombo("ctrl+l"));
      expect(emitted).toBe("clear");
    });

    test("emits chord-pending when waiting for more keys", () => {
      let pending = false;
      resolver.on("chord-pending", () => {
        pending = true;
      });
      resolver.processKeyPress(parseKeyCombo("ctrl+k"));
      expect(pending).toBe(true);
    });

    test("emits chord-cancelled on cancelChord", () => {
      let cancelled = false;
      resolver.on("chord-cancelled", () => {
        cancelled = true;
      });
      resolver.processKeyPress(parseKeyCombo("ctrl+k"));
      resolver.cancelChord();
      expect(cancelled).toBe(true);
    });
  });

  describe("user overrides", () => {
    test("user binding replaces default for same action", () => {
      const r = new KeybindingResolver(
        [makeBinding("submit", "enter")],
        [makeBinding("submit", "ctrl+enter", "user")],
      );

      expect(r.processKeyPress(parseKeyCombo("ctrl+enter"))).toBe("submit");
      // Old binding should be gone
      const r2 = new KeybindingResolver(
        [makeBinding("submit", "enter")],
        [makeBinding("submit", "ctrl+enter", "user")],
      );
      expect(r2.processKeyPress(parseKeyCombo("enter"))).toBeNull();
    });

    test("user binding replaces default on same chord", () => {
      const r = new KeybindingResolver(
        [makeBinding("clear", "ctrl+l")],
        [makeBinding("custom.action", "ctrl+l", "user")],
      );
      expect(r.processKeyPress(parseKeyCombo("ctrl+l"))).toBe("custom.action");
    });

    test("user can add new bindings", () => {
      const r = new KeybindingResolver(
        [makeBinding("submit", "enter")],
        [makeBinding("custom.deploy", "ctrl+k ctrl+d", "user")],
      );
      r.processKeyPress(parseKeyCombo("ctrl+k"));
      expect(r.processKeyPress(parseKeyCombo("ctrl+d"))).toBe("custom.deploy");
    });
  });

  describe("getBindingForAction", () => {
    test("returns binding for known action", () => {
      const binding = resolver.getBindingForAction("clear");
      expect(binding).toBeDefined();
      expect(binding!.action).toBe("clear");
    });

    test("returns undefined for unknown action", () => {
      expect(resolver.getBindingForAction("nonexistent")).toBeUndefined();
    });
  });

  describe("getBindings", () => {
    test("returns all bindings", () => {
      expect(resolver.getBindings().length).toBe(5);
    });
  });
});
