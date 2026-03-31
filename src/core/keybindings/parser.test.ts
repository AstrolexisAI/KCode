// KCode - Parser tests for key combos and chords

import { describe, test, expect } from "bun:test";
import {
  parseKeyCombo,
  parseKeyChord,
  serializeCombo,
  serializeChord,
  formatKeyChord,
  comboEquals,
  chordEquals,
} from "./parser.js";

describe("parseKeyCombo", () => {
  test("parses a single character key", () => {
    const combo = parseKeyCombo("a");
    expect(combo.key).toBe("a");
    expect(combo.ctrl).toBe(false);
    expect(combo.alt).toBe(false);
    expect(combo.shift).toBe(false);
    expect(combo.meta).toBe(false);
  });

  test("parses ctrl modifier", () => {
    const combo = parseKeyCombo("ctrl+c");
    expect(combo.key).toBe("c");
    expect(combo.ctrl).toBe(true);
  });

  test("parses alt modifier", () => {
    const combo = parseKeyCombo("alt+enter");
    expect(combo.key).toBe("enter");
    expect(combo.alt).toBe(true);
  });

  test("parses shift modifier", () => {
    const combo = parseKeyCombo("shift+tab");
    expect(combo.key).toBe("tab");
    expect(combo.shift).toBe(true);
  });

  test("parses meta/cmd modifier", () => {
    const combo = parseKeyCombo("cmd+s");
    expect(combo.key).toBe("s");
    expect(combo.meta).toBe(true);
  });

  test("parses meta modifier", () => {
    const combo = parseKeyCombo("meta+a");
    expect(combo.key).toBe("a");
    expect(combo.meta).toBe(true);
  });

  test("parses multiple modifiers", () => {
    const combo = parseKeyCombo("ctrl+shift+a");
    expect(combo.key).toBe("a");
    expect(combo.ctrl).toBe(true);
    expect(combo.shift).toBe(true);
    expect(combo.alt).toBe(false);
  });

  test("parses all modifiers together", () => {
    const combo = parseKeyCombo("ctrl+alt+shift+meta+x");
    expect(combo.key).toBe("x");
    expect(combo.ctrl).toBe(true);
    expect(combo.alt).toBe(true);
    expect(combo.shift).toBe(true);
    expect(combo.meta).toBe(true);
  });

  test("handles uppercase input (normalizes to lowercase)", () => {
    const combo = parseKeyCombo("Ctrl+Shift+A");
    expect(combo.key).toBe("a");
    expect(combo.ctrl).toBe(true);
    expect(combo.shift).toBe(true);
  });

  test("parses special key: escape", () => {
    const combo = parseKeyCombo("escape");
    expect(combo.key).toBe("escape");
    expect(combo.ctrl).toBe(false);
  });

  test("parses special key alias: esc -> escape", () => {
    const combo = parseKeyCombo("esc");
    expect(combo.key).toBe("escape");
  });

  test("parses function keys", () => {
    const combo = parseKeyCombo("f5");
    expect(combo.key).toBe("f5");
  });

  test("parses f-key with modifier", () => {
    const combo = parseKeyCombo("ctrl+f1");
    expect(combo.key).toBe("f1");
    expect(combo.ctrl).toBe(true);
  });

  test("handles whitespace", () => {
    const combo = parseKeyCombo("  ctrl+a  ");
    expect(combo.key).toBe("a");
    expect(combo.ctrl).toBe(true);
  });

  test("parses key alias: return -> enter", () => {
    const combo = parseKeyCombo("return");
    expect(combo.key).toBe("enter");
  });

  test("parses key alias: del -> delete", () => {
    const combo = parseKeyCombo("del");
    expect(combo.key).toBe("delete");
  });

  test("parses key alias: space", () => {
    const combo = parseKeyCombo("ctrl+space");
    expect(combo.key).toBe(" ");
    expect(combo.ctrl).toBe(true);
  });
});

describe("parseKeyChord", () => {
  test("parses a simple combo as a 1-element chord", () => {
    const chord = parseKeyChord("ctrl+c");
    expect(chord.sequence).toHaveLength(1);
    expect(chord.sequence[0]!.key).toBe("c");
    expect(chord.sequence[0]!.ctrl).toBe(true);
  });

  test("parses a two-combo chord", () => {
    const chord = parseKeyChord("ctrl+k ctrl+c");
    expect(chord.sequence).toHaveLength(2);
    expect(chord.sequence[0]!.key).toBe("k");
    expect(chord.sequence[0]!.ctrl).toBe(true);
    expect(chord.sequence[1]!.key).toBe("c");
    expect(chord.sequence[1]!.ctrl).toBe(true);
  });

  test("parses a three-combo chord", () => {
    const chord = parseKeyChord("ctrl+k ctrl+k ctrl+d");
    expect(chord.sequence).toHaveLength(3);
    expect(chord.sequence[2]!.key).toBe("d");
  });

  test("parses a single key chord", () => {
    const chord = parseKeyChord("escape");
    expect(chord.sequence).toHaveLength(1);
    expect(chord.sequence[0]!.key).toBe("escape");
  });

  test("handles extra whitespace between combos", () => {
    const chord = parseKeyChord("ctrl+k   ctrl+t");
    expect(chord.sequence).toHaveLength(2);
    expect(chord.sequence[1]!.key).toBe("t");
  });
});

describe("serializeCombo", () => {
  test("serializes simple key", () => {
    expect(serializeCombo({ key: "a", ctrl: false, alt: false, shift: false, meta: false })).toBe("a");
  });

  test("serializes with ctrl", () => {
    expect(serializeCombo({ key: "c", ctrl: true, alt: false, shift: false, meta: false })).toBe("ctrl+c");
  });

  test("serializes with multiple modifiers in canonical order", () => {
    expect(serializeCombo({ key: "x", ctrl: true, alt: true, shift: true, meta: true })).toBe("ctrl+alt+shift+meta+x");
  });
});

describe("serializeChord", () => {
  test("serializes a simple chord", () => {
    const chord = parseKeyChord("ctrl+c");
    expect(serializeChord(chord)).toBe("ctrl+c");
  });

  test("serializes a multi-combo chord", () => {
    const chord = parseKeyChord("ctrl+k ctrl+t");
    expect(serializeChord(chord)).toBe("ctrl+k ctrl+t");
  });
});

describe("formatKeyChord", () => {
  test("formats for Linux with text modifiers", () => {
    const chord = parseKeyChord("ctrl+k ctrl+t");
    expect(formatKeyChord(chord, "linux")).toBe("Ctrl+K Ctrl+T");
  });

  test("formats for macOS with symbols", () => {
    const chord = parseKeyChord("ctrl+k ctrl+t");
    expect(formatKeyChord(chord, "darwin")).toBe("\u2303K \u2303T");
  });

  test("formats alt on macOS as option symbol", () => {
    const chord = parseKeyChord("alt+enter");
    expect(formatKeyChord(chord, "darwin")).toBe("\u2325Enter");
  });

  test("formats shift on macOS", () => {
    const chord = parseKeyChord("shift+tab");
    expect(formatKeyChord(chord, "darwin")).toBe("\u21E7Tab");
  });

  test("formats meta on macOS as command symbol", () => {
    const chord = parseKeyChord("meta+s");
    expect(formatKeyChord(chord, "darwin")).toBe("\u2318S");
  });

  test("formats meta on Linux as Win", () => {
    const chord = parseKeyChord("meta+s");
    expect(formatKeyChord(chord, "linux")).toBe("Win+S");
  });

  test("formats win32 same as linux", () => {
    const chord = parseKeyChord("ctrl+c");
    expect(formatKeyChord(chord, "win32")).toBe("Ctrl+C");
  });

  test("formats function keys", () => {
    const chord = parseKeyChord("f1");
    expect(formatKeyChord(chord, "linux")).toBe("F1");
  });

  test("formats escape key", () => {
    const chord = parseKeyChord("escape");
    expect(formatKeyChord(chord, "linux")).toBe("Escape");
  });
});

describe("comboEquals", () => {
  test("equal combos return true", () => {
    const a = parseKeyCombo("ctrl+a");
    const b = parseKeyCombo("ctrl+a");
    expect(comboEquals(a, b)).toBe(true);
  });

  test("different keys return false", () => {
    const a = parseKeyCombo("ctrl+a");
    const b = parseKeyCombo("ctrl+b");
    expect(comboEquals(a, b)).toBe(false);
  });

  test("different modifiers return false", () => {
    const a = parseKeyCombo("ctrl+a");
    const b = parseKeyCombo("alt+a");
    expect(comboEquals(a, b)).toBe(false);
  });
});

describe("chordEquals", () => {
  test("equal chords return true", () => {
    const a = parseKeyChord("ctrl+k ctrl+t");
    const b = parseKeyChord("ctrl+k ctrl+t");
    expect(chordEquals(a, b)).toBe(true);
  });

  test("different length chords return false", () => {
    const a = parseKeyChord("ctrl+k");
    const b = parseKeyChord("ctrl+k ctrl+t");
    expect(chordEquals(a, b)).toBe(false);
  });

  test("different second combo returns false", () => {
    const a = parseKeyChord("ctrl+k ctrl+t");
    const b = parseKeyChord("ctrl+k ctrl+c");
    expect(chordEquals(a, b)).toBe(false);
  });
});
