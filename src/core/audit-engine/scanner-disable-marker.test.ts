// kcode-disable: audit
//
// P-audit polish (v2.10.394) — tests for the opt-in audit-disable
// marker. The directive lets fixture / training / intentionally-
// vulnerable files skip the pattern pre-pass without affecting the
// global skip lists.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasAuditDisableMarker, scanProject } from "./scanner";

let TMP: string;

beforeEach(() => { TMP = mkdtempSync(join(tmpdir(), "kcode-marker-")); });
afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

describe("hasAuditDisableMarker", () => {
  test("matches // kcode-disable: audit at file top", () => {
    expect(hasAuditDisableMarker("// kcode-disable: audit\nconst x = 1;")).toBe(true);
  });
  test("matches # kcode-disable: audit (Python / shell)", () => {
    expect(hasAuditDisableMarker("# kcode-disable: audit\nimport os")).toBe(true);
  });
  test("matches /* kcode-disable: audit */", () => {
    expect(hasAuditDisableMarker("/* kcode-disable: audit */\nint main() {}")).toBe(true);
  });
  test("matches when nested in the first 1KB", () => {
    const padding = "// header\n".repeat(20);
    expect(hasAuditDisableMarker(padding + "// kcode-disable: audit\n")).toBe(true);
  });
  test("does NOT match when the marker is past the first 1 KB", () => {
    const padding = "// header line that is exactly some bytes long\n".repeat(40);
    expect(padding.length).toBeGreaterThan(1024);
    expect(hasAuditDisableMarker(padding + "// kcode-disable: audit\n")).toBe(false);
  });
  test("does NOT match similar strings without the directive", () => {
    expect(hasAuditDisableMarker("// kcode-enabled: audit\n")).toBe(false);
    expect(hasAuditDisableMarker("// audit:disable\n")).toBe(false);
    expect(hasAuditDisableMarker("kcode-disable audit (no colon)\n")).toBe(false);
  });
});

describe("scanProject respects kcode-disable: audit", () => {
  test("file with the marker is excluded from candidates", async () => {
    // A file that WOULD trip a pattern (eval of req.body) — but is
    // marked disabled. Result: zero candidates.
    writeFileSync(join(TMP, "fixture.js"), `// kcode-disable: audit
const x = eval(req.body.code);
`);
    const result = await scanProject(TMP);
    expect(result.candidates.length).toBe(0);
  });

  test("file WITHOUT the marker is scanned normally", async () => {
    writeFileSync(join(TMP, "real.js"), `const x = eval(req.body.code);`);
    const result = await scanProject(TMP);
    // The express-004-eval-of-req pattern should hit this.
    const hit = result.candidates.find((c) => c.pattern_id === "express-004-eval-of-req");
    expect(hit).toBeDefined();
  });

  test("marker applies per-file, not per-project", async () => {
    writeFileSync(join(TMP, "fixture.js"), `// kcode-disable: audit
eval(req.body.code);
`);
    writeFileSync(join(TMP, "real.js"), `eval(req.body.code);`);
    const result = await scanProject(TMP);
    const realFile = result.candidates.find((c) => c.file.endsWith("real.js"));
    const fixtureFile = result.candidates.find((c) => c.file.endsWith("fixture.js"));
    expect(realFile).toBeDefined();
    expect(fixtureFile).toBeUndefined();
  });
});
