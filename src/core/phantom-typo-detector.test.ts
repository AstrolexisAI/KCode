// Phase 32 — phantom-typo detector unit tests
//
// The detector exists because NEXUS Telemetry mark6 (Gemma abliterated)
// invented phantom typos like "setProperty en lugar de setProperty"
// and rode them into failed Edits. These tests pin the regex behavior
// so a future refactor can't silently break the detection and let the
// failure mode back in.

import { describe, expect, test } from "bun:test";
import { detectPhantomTypoClaim } from "./phantom-typo-detector";

describe("detectPhantomTypoClaim — true positives", () => {
  test("Spanish: 'setProperty en lugar de setProperty' (exact mark6 case)", () => {
    const text =
      "He analizado el código. El error es setProperty en lugar de setProperty en la línea 394.";
    const match = detectPhantomTypoClaim(text);
    expect(match).not.toBeNull();
    expect(match!.token).toBe("setProperty");
    expect(match!.phrase).toContain("setProperty");
    expect(match!.phrase).toContain("en lugar de");
  });

  test("Spanish: 'getContext en lugar de getContext'", () => {
    const match = detectPhantomTypoClaim("debería ser getContext en lugar de getContext aquí");
    expect(match).not.toBeNull();
    expect(match!.token).toBe("getContext");
  });

  test("Spanish: 'en vez de' variant", () => {
    const match = detectPhantomTypoClaim("usa parseInt en vez de parseInt para esto");
    expect(match).not.toBeNull();
    expect(match!.token).toBe("parseInt");
  });

  test("English: 'X instead of X'", () => {
    const match = detectPhantomTypoClaim("you should use renderChart instead of renderChart");
    expect(match).not.toBeNull();
    expect(match!.token).toBe("renderChart");
  });

  test("English: 'rather than'", () => {
    const match = detectPhantomTypoClaim("Math.PI rather than Math.PI is the correct identifier");
    expect(match).not.toBeNull();
    expect(match!.token).toBe("Math.PI");
  });

  test("English: 'in place of'", () => {
    const match = detectPhantomTypoClaim("use foo in place of foo throughout");
    expect(match).not.toBeNull();
    expect(match!.token).toBe("foo");
  });

  test("strips backticks from tokens", () => {
    const match = detectPhantomTypoClaim("use `setProperty` en lugar de `setProperty`");
    expect(match).not.toBeNull();
    expect(match!.token).toBe("setProperty");
  });

  test("strips trailing punctuation", () => {
    const match = detectPhantomTypoClaim("cambio: getContext en lugar de getContext.");
    expect(match).not.toBeNull();
    expect(match!.token).toBe("getContext");
  });

  test("strips mixed quote styles", () => {
    const match = detectPhantomTypoClaim(`use "reverse" en lugar de 'reverse'`);
    expect(match).not.toBeNull();
    expect(match!.token).toBe("reverse");
  });

  test("handles dot-notation identifiers", () => {
    const match = detectPhantomTypoClaim("Math.PI instead of Math.PI is the bug");
    expect(match).not.toBeNull();
    expect(match!.token).toBe("Math.PI");
  });

  test("handles parens in identifier (parens stripped as boundary punct)", () => {
    const match = detectPhantomTypoClaim("setProperty() en lugar de setProperty()");
    expect(match).not.toBeNull();
    // Parens are stripped as boundary punctuation, so the returned
    // token is the bare identifier. The match still fires correctly
    // because both sides strip to the same thing.
    expect(match!.token).toBe("setProperty");
  });
});

describe("detectPhantomTypoClaim — true negatives", () => {
  test("returns null for legitimate replacement (different tokens)", () => {
    expect(detectPhantomTypoClaim("use setProperty en lugar de getAttribute")).toBeNull();
    expect(detectPhantomTypoClaim("use Math.PI instead of 3.14")).toBeNull();
    expect(detectPhantomTypoClaim("renderChart rather than drawChart")).toBeNull();
  });

  test("returns null for empty or short input", () => {
    expect(detectPhantomTypoClaim("")).toBeNull();
    expect(detectPhantomTypoClaim("short")).toBeNull();
    expect(detectPhantomTypoClaim("a en lugar de a")).toBeNull(); // too short token
  });

  test("returns null when the phrase is missing the replacement marker", () => {
    expect(detectPhantomTypoClaim("use setProperty for this setProperty thing")).toBeNull();
    expect(detectPhantomTypoClaim("setProperty setProperty setProperty")).toBeNull();
  });

  test("returns null when tokens differ by case (likely real fix)", () => {
    // Math.Pi → Math.PI is a REAL fix in JavaScript. Phase 32 must not
    // flag legitimate case-sensitive corrections as phantoms.
    const match = detectPhantomTypoClaim("use Math.PI instead of Math.Pi — case matters");
    expect(match).toBeNull();
  });

  test("returns null when left has punctuation that makes it semantically different", () => {
    // "setProperty()" vs "setProperty" — one is a call, one is a
    // reference. Different. Not a phantom.
    const match = detectPhantomTypoClaim("setProperty() en lugar de setProperty");
    // Both will be stripped of (), so they ARE equal after stripping.
    // We accept this as a near-match: the detector prefers false
    // positives here because the underlying claim IS suspicious
    // (a fix that's just adding/removing parens is usually wrong).
    // Document the decision: left === right after stripping -> flagged.
    expect(match).not.toBeNull();
  });

  test("ignores unrelated English 'instead' phrasing", () => {
    expect(
      detectPhantomTypoClaim(
        "I checked the file instead of guessing, and the bug is on line 12",
      ),
    ).toBeNull();
  });
});

describe("detectPhantomTypoClaim — robustness", () => {
  test("finds the first match when multiple phantom claims are present", () => {
    const text =
      "El bug es setProperty en lugar de setProperty. También getContext en lugar de getContext.";
    const match = detectPhantomTypoClaim(text);
    expect(match).not.toBeNull();
    expect(match!.token).toBe("setProperty");
  });

  test("survives weird whitespace between marker words", () => {
    const match = detectPhantomTypoClaim("renderChart     en    lugar    de     renderChart");
    expect(match).not.toBeNull();
    expect(match!.token).toBe("renderChart");
  });

  test("case-insensitive marker matching (Spanish)", () => {
    const match = detectPhantomTypoClaim("renderChart En Lugar De renderChart");
    expect(match).not.toBeNull();
  });

  test("does not confuse a phrase that spans the marker at a distance", () => {
    // "X then Y en lugar de Y" — the regex should match (Y, Y), not (X, Y)
    const match = detectPhantomTypoClaim("cambio renderChart: drawChart en lugar de drawChart");
    expect(match).not.toBeNull();
    expect(match!.token).toBe("drawChart");
  });

  test("handles multi-paragraph text", () => {
    const text = `
First paragraph about something else.

Segundo párrafo con el análisis:
El problema es getContext en lugar de getContext, claramente.

Third paragraph wrapping up.
    `;
    const match = detectPhantomTypoClaim(text);
    expect(match).not.toBeNull();
    expect(match!.token).toBe("getContext");
  });
});
