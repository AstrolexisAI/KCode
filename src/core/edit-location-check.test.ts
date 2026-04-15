// Tests for phase 27 — edit location mismatch detector.

import { describe, expect, test } from "bun:test";
import {
  buildLocationWarning,
  checkEditLocationMismatch,
  extractLocationHints,
  findSymbolLine,
} from "./edit-location-check";

// ─── extractLocationHints ────────────────────────────────────────

describe("extractLocationHints", () => {
  test("extracts English line number", () => {
    const hints = extractLocationHints(["fix the bug at line 800"]);
    expect(hints.lineHints).toHaveLength(1);
    expect(hints.lineHints[0]!.value).toBe("800");
    expect(hints.lineHints[0]!.kind).toBe("line");
  });

  test("extracts line range", () => {
    const hints = extractLocationHints(["check lines 100-120 for the issue"]);
    expect(hints.lineHints).toHaveLength(1);
    expect(hints.lineHints[0]!.kind).toBe("range");
    expect(hints.lineHints[0]!.value).toBe("100");
    expect(hints.lineHints[0]!.endValue).toBe("120");
  });

  test("extracts Spanish línea", () => {
    const hints = extractLocationHints(["el bug está en la línea 420"]);
    expect(hints.lineHints).toHaveLength(1);
    expect(hints.lineHints[0]!.value).toBe("420");
  });

  test("extracts function/class symbols", () => {
    const hints = extractLocationHints([
      "el bug está en function renderMarsGallery",
      "revisa la class Dashboard",
    ]);
    const names = hints.symbolHints.map((h) => h.value);
    expect(names).toContain("renderMarsGallery");
    expect(names).toContain("Dashboard");
  });

  test("extracts backtick-quoted identifiers", () => {
    const hints = extractLocationHints([
      "`updateMarsChartWithRealData` is broken",
    ]);
    const names = hints.symbolHints.map((h) => h.value);
    expect(names).toContain("updateMarsChartWithRealData");
  });

  test("filters generic identifiers from quoted names", () => {
    const hints = extractLocationHints([
      "`data` is undefined",
      "`error` should be null",
    ]);
    const names = hints.symbolHints.map((h) => h.value);
    expect(names).not.toContain("data");
    expect(names).not.toContain("error");
  });

  test("extracts file paths", () => {
    const hints = extractLocationHints([
      "check orbital.html and server.js for the bug",
    ]);
    expect(hints.fileHints).toContain("orbital.html");
    expect(hints.fileHints).toContain("server.js");
  });

  // ─── Phase 27 audit fix: CDN library filter ───

  test("ignores CDN library mentions (Chart.js via CDN)", () => {
    const nexusPrompt =
      "Crea una aplicación que use Chart.js vía CDN para los gráficos " +
      "y Tailwind CSS vía CDN para el estilo. Genera orbital.html.";
    const hints = extractLocationHints([nexusPrompt]);
    // orbital.html is a real file mention, Chart.js is a library
    expect(hints.fileHints).toContain("orbital.html");
    expect(hints.fileHints).not.toContain("Chart.js");
  });

  test("ignores React.js, Vue.js, jQuery, etc. from blocklist", () => {
    const hints = extractLocationHints([
      "build it with react.js and jquery.js, avoid vue.js",
    ]);
    expect(hints.fileHints).not.toContain("react.js");
    expect(hints.fileHints).not.toContain("jquery.js");
    expect(hints.fileHints).not.toContain("vue.js");
  });

  test("ignores library mentions with 'via CDN' context even if not in blocklist", () => {
    const hints = extractLocationHints([
      "load some-obscure-lib.js via CDN from unpkg",
    ]);
    expect(hints.fileHints).not.toContain("some-obscure-lib.js");
  });

  test("DOES treat path-prefixed mentions as real files even if name matches a library", () => {
    // `./chart.js` or `src/chart.js` are user's own files — not CDN
    const hints = extractLocationHints([
      "the bug is in src/chart.js line 42",
    ]);
    expect(hints.fileHints.some((f) => f.endsWith("chart.js"))).toBe(true);
  });

  test("Nexus Telemetry false-positive regression check", () => {
    // This is the EXACT v2.10.71 failure: user prompt mentions Chart.js
    // as a library; model edits nexus-telemetry.html; phase 27 should
    // NOT fire a file mismatch warning.
    const nexusPrompt =
      "Tecnologías: HTML5 + Tailwind CSS (vía CDN), Chart.js vía CDN, " +
      "Lucide icons vía CDN. Crea nexus-telemetry.html.";
    const hints = extractLocationHints([nexusPrompt]);
    expect(hints.fileHints).toContain("nexus-telemetry.html");
    expect(hints.fileHints).not.toContain("Chart.js");
    // Edit the real file → no file mismatch
    const verdict = checkEditLocationMismatch(
      hints,
      500,
      "/tmp/nexus-telemetry.html",
      "//".repeat(2000),
    );
    expect(verdict.fileMismatch).toBeNull();
  });

  // v2.10.72 regression — brand/acronym filter
  test("ignores short all-caps brand names in quotes (NEXUS, APOD, NASA, ISS)", () => {
    // Nexus Telemetry v2 session: user prompt had `Logo "NEXUS" con icono`
    // which my QUOTED_ID_REGEX was capturing as a code symbol. Every Edit
    // then fired "User mentioned NEXUS at line 6 but Edit is 1000 lines away"
    // because NEXUS appeared in the <title> tag.
    const hints = extractLocationHints([
      'Logo "NEXUS" con icono de satélite. Secciones: "APOD", "ISS", "NASA".',
    ]);
    const names = hints.symbolHints.map((h) => h.value);
    expect(names).not.toContain("NEXUS");
    expect(names).not.toContain("APOD");
    expect(names).not.toContain("NASA");
    expect(names).not.toContain("ISS");
  });

  test("still keeps quoted identifiers with ≥6 chars (Dashboard, renderChart)", () => {
    const hints = extractLocationHints([
      '`Dashboard` and "renderChart" are broken',
    ]);
    const names = hints.symbolHints.map((h) => h.value);
    expect(names).toContain("Dashboard");
    expect(names).toContain("renderChart");
  });

  // v2.10.72 Nexus Telemetry regression — API key filter
  test("ignores high-digit-ratio tokens (API keys, UUIDs, hashes)", () => {
    // The user's NASA API key from the session log. 40 chars, 20% digits.
    // Previously was captured as a bare long identifier and fired
    // location mismatches on every Edit near the input element.
    const nasaKey = "MggS1tgGe29s9KTnR10fCPanURyxOy3QkDpHZsO0";
    const hints = extractLocationHints([
      `esta es la api de la nasa: ${nasaKey}`,
    ]);
    expect(hints.symbolHints.map((h) => h.value)).not.toContain(nasaKey);
  });

  test("still keeps bare long identifiers with few digits (updateMarsChartWithRealData)", () => {
    const hints = extractLocationHints([
      "updateMarsChartWithRealData is broken",
    ]);
    expect(hints.symbolHints.map((h) => h.value)).toContain(
      "updateMarsChartWithRealData",
    );
  });

  test("keeps legit identifiers that happen to contain a single digit (render3DScene)", () => {
    // 1/14 = 7% digit ratio, below 15% threshold
    const hints = extractLocationHints([
      "the bug is in render3DSceneAsync",
    ]);
    expect(hints.symbolHints.map((h) => h.value)).toContain(
      "render3DSceneAsync",
    );
  });

  test("ignores hex hashes and UUIDs (≥20 chars with digit heavy)", () => {
    const hints = extractLocationHints([
      "commit 5f3e2a1b4c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f is broken",
      "uuid 550e8400e29b41d4a716446655440000",
    ]);
    const names = hints.symbolHints.map((h) => h.value);
    // These high-digit tokens should not be treated as symbols
    expect(
      names.some((n) => n.includes("5f3e2a") || n.includes("550e8400")),
    ).toBe(false);
  });

  test("respects lookback window", () => {
    const texts = [
      "first says line 10",
      "second says line 20",
      "third says line 30",
      "fourth says line 40",
      "fifth says line 50",
    ];
    // lookback=3 → only last 3 messages scanned
    const hints = extractLocationHints(texts, 3);
    const values = hints.lineHints.map((h) => h.value);
    expect(values).toEqual(["30", "40", "50"]);
  });

  test("empty input returns empty hints", () => {
    const hints = extractLocationHints([]);
    expect(hints.lineHints).toEqual([]);
    expect(hints.symbolHints).toEqual([]);
    expect(hints.fileHints).toEqual([]);
  });
});

// ─── findSymbolLine ──────────────────────────────────────────────

describe("findSymbolLine", () => {
  test("finds symbol on line 1", () => {
    const content = "function renderMarsGallery() {\n  return 42;\n}";
    expect(findSymbolLine(content, "renderMarsGallery")).toBe(1);
  });

  test("finds symbol on later line", () => {
    const content = [
      "// header",
      "const x = 1;",
      "function updateMarsChart() {",
      "  return null;",
      "}",
    ].join("\n");
    expect(findSymbolLine(content, "updateMarsChart")).toBe(3);
  });

  test("respects word boundaries", () => {
    const content = "const renderingHat = 1;\nfunction render() {}";
    // 'render' should match on line 2, not inside 'renderingHat' on line 1
    expect(findSymbolLine(content, "render")).toBe(2);
  });

  test("returns -1 when symbol not present", () => {
    expect(findSymbolLine("const foo = 1;", "bar")).toBe(-1);
  });

  test("escapes regex metacharacters in symbol name", () => {
    // This would crash if we didn't escape — though unlikely input
    const content = "const x = 1;";
    expect(findSymbolLine(content, "foo.bar")).toBe(-1);
  });
});

// ─── checkEditLocationMismatch ───────────────────────────────────

describe("checkEditLocationMismatch — Orbital chart scenario", () => {
  // The v2.10.67 Orbital session had the user repeat:
  //   "la grafica de Mars Surface Temperature"
  //   "la grafica sigue igual"
  //   "el problema de la grafica, audita"
  // while the model kept editing random CSS 500+ lines away.
  // This is the canonical test case for phase 27.

  const fileContent = [
    "// lines 1-50: CSS styles",
    ...Array.from({ length: 48 }, (_, i) => `  .rule${i} { color: red; }`),
    "",
    "// lines 51-200: header & navigation",
    ...Array.from({ length: 149 }, (_, i) => `  <div class='nav-${i}'>text</div>`),
    "",
    "// line 200: function declaration",
    "function updateMarsChartWithRealData() {",
    "  const canvas = document.getElementById('marsTempChart');",
    "  const ctx = canvas.getContext('2d');",
    "  return new Chart(ctx, {});",
    "}",
  ].join("\n");

  test("flags edit far from mentioned symbol", () => {
    const hints = extractLocationHints([
      "updateMarsChartWithRealData is broken",
      "la grafica sigue igual",
    ]);
    const verdict = checkEditLocationMismatch(
      hints,
      5, // edit line 5 (in CSS) — far from the function at ~200
      "/tmp/orbital.html",
      fileContent,
    );
    expect(verdict.isMismatch).toBe(true);
    expect(verdict.unmatchedSymbolHints.length).toBeGreaterThanOrEqual(1);
    expect(verdict.reason).toContain("updateMarsChartWithRealData");
  });

  test("does NOT flag edit near mentioned symbol", () => {
    const hints = extractLocationHints([
      "updateMarsChartWithRealData is broken",
    ]);
    // Function is at line ~202, edit at line 205 — within 30-line window
    const verdict = checkEditLocationMismatch(
      hints,
      205,
      "/tmp/orbital.html",
      fileContent,
    );
    expect(verdict.isMismatch).toBe(false);
  });
});

describe("checkEditLocationMismatch — line number mismatches", () => {
  test("flags edit far from mentioned line", () => {
    const hints = extractLocationHints(["fix the bug at line 800"]);
    const verdict = checkEditLocationMismatch(
      hints,
      50, // edit line 50, user said 800 → distance 750
      "/tmp/app.ts",
      "//".repeat(1000),
    );
    expect(verdict.isMismatch).toBe(true);
    expect(verdict.reason).toContain("line 800");
    expect(verdict.reason).toContain("750");
  });

  test("does NOT flag edit within proximity window (±50)", () => {
    const hints = extractLocationHints(["fix the bug at line 800"]);
    const verdict = checkEditLocationMismatch(
      hints,
      830, // distance 30, within window
      "/tmp/app.ts",
      "//".repeat(1000),
    );
    expect(verdict.isMismatch).toBe(false);
  });

  test("does NOT fire when at least one line hint is within proximity (lenient matching)", () => {
    // When the user mentions multiple line ranges, landing near ONE
    // of them is enough to satisfy the intent — we don't warn just
    // because the other hints weren't targeted.
    const hints = extractLocationHints([
      "check lines 100 and line 500 for bugs",
    ]);
    const verdict = checkEditLocationMismatch(
      hints,
      105, // close to 100
      "/tmp/app.ts",
      "//".repeat(1000),
    );
    expect(verdict.isMismatch).toBe(false);
  });

  test("fires when edit is far from every mentioned line", () => {
    const hints = extractLocationHints([
      "the bug is at line 100 and line 500",
    ]);
    const verdict = checkEditLocationMismatch(
      hints,
      10, // 90+ away from both
      "/tmp/app.ts",
      "//".repeat(1000),
    );
    expect(verdict.isMismatch).toBe(true);
  });
});

describe("checkEditLocationMismatch — file mismatches", () => {
  test("flags single-file mismatch", () => {
    const hints = extractLocationHints([
      "the bug is in server.js line 42",
    ]);
    const verdict = checkEditLocationMismatch(
      hints,
      42,
      "/tmp/orbital.html", // editing wrong file
      "file content",
    );
    expect(verdict.isMismatch).toBe(true);
    expect(verdict.fileMismatch).toBe("server.js");
    expect(verdict.reason).toContain("server.js");
    expect(verdict.reason).toContain("orbital.html");
  });

  test("does not flag when editing the mentioned file", () => {
    const hints = extractLocationHints([
      "check orbital.html line 42",
    ]);
    const verdict = checkEditLocationMismatch(
      hints,
      42,
      "/tmp/orbital.html",
      "//".repeat(100),
    );
    expect(verdict.isMismatch).toBe(false);
  });

  test("does not flag when user mentioned multiple files (ambiguous)", () => {
    const hints = extractLocationHints([
      "check orbital.html, server.js, and package.json",
    ]);
    const verdict = checkEditLocationMismatch(
      hints,
      42,
      "/tmp/README.md", // none of the mentioned files
      "//".repeat(100),
    );
    // Multiple file mentions → ambiguous → don't warn on file mismatch
    expect(verdict.fileMismatch).toBeNull();
  });
});

describe("checkEditLocationMismatch — negative cases", () => {
  test("returns no mismatch when there are no hints at all", () => {
    const hints = extractLocationHints(["fix the bug"]);
    const verdict = checkEditLocationMismatch(
      hints,
      42,
      "/tmp/app.ts",
      "content",
    );
    expect(verdict.isMismatch).toBe(false);
  });

  test("returns no mismatch when symbol isn't in the file", () => {
    const hints = extractLocationHints([
      "broken in mysteriousUnknownFunction",
    ]);
    const verdict = checkEditLocationMismatch(
      hints,
      42,
      "/tmp/app.ts",
      "// no symbols here",
    );
    expect(verdict.isMismatch).toBe(false);
  });
});

// ─── buildLocationWarning ────────────────────────────────────────

describe("buildLocationWarning", () => {
  test("contains the reason, mismatch label, and actionable guidance", () => {
    const verdict = {
      isMismatch: true,
      editLine: 50,
      unmatchedLineHints: [],
      unmatchedSymbolHints: [
        {
          kind: "symbol" as const,
          value: "updateMarsChartWithRealData",
          phrase: "updateMarsChartWithRealData",
          messageIndex: 0,
          symbolLine: 200,
        },
      ],
      fileMismatch: null,
      reason:
        'User mentioned "updateMarsChartWithRealData" (at line 200) but Edit is ~150 lines away (at line 50).',
    };
    const warning = buildLocationWarning(verdict);
    expect(warning).toContain("EDIT LOCATION MISMATCH");
    expect(warning).toContain("non-blocking");
    expect(warning).toContain("updateMarsChartWithRealData");
    expect(warning).toContain("line 200");
    expect(warning).toContain("line 50");
    expect(warning).toMatch(/re-read/i);
    expect(warning).toContain("fixed");
  });

  test("lists additional unmatched symbols when present", () => {
    const verdict = {
      isMismatch: true,
      editLine: 10,
      unmatchedLineHints: [],
      unmatchedSymbolHints: [
        { kind: "symbol" as const, value: "first", phrase: "first", messageIndex: 0, symbolLine: 100 },
        { kind: "symbol" as const, value: "second", phrase: "second", messageIndex: 0, symbolLine: 200 },
        { kind: "symbol" as const, value: "third", phrase: "third", messageIndex: 0, symbolLine: 300 },
      ],
      fileMismatch: null,
      reason: 'User mentioned "first" (at line 100) but Edit is ~90 lines away (at line 10).',
    };
    const warning = buildLocationWarning(verdict);
    expect(warning).toContain("second@200");
    expect(warning).toContain("third@300");
  });
});
