// P2.4 slice 1 (v2.10.392+) — integration test for SBOM wiring
// into runAudit. Locks in that --deps actually appends findings.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "./audit-engine";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "kcode-sbom-wire-"));
});
afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

describe("runAudit({ includeDeps })", () => {
  test("default (no flag) does NOT scan dependencies", async () => {
    writeFileSync(
      join(TMP, "package.json"),
      JSON.stringify({
        dependencies: { "event-stream": "3.3.6" },
      }),
    );
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () =>
        JSON.stringify({ verdict: "confirmed", reasoning: "x", evidence: { sink: "y" } }),
      skipVerification: true,
    });
    // No SBOM finding present
    const sbomFindings = result.findings.filter((f) => f.pattern_id.startsWith("sbom-"));
    expect(sbomFindings.length).toBe(0);
  });

  test("--deps appends SBOM findings to result.findings[]", async () => {
    writeFileSync(
      join(TMP, "package.json"),
      JSON.stringify({
        dependencies: { "event-stream": "3.3.6", "node-ipc": "10.1.2" },
      }),
    );
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () =>
        JSON.stringify({ verdict: "confirmed", reasoning: "x", evidence: { sink: "y" } }),
      skipVerification: true,
      includeDeps: true,
    });
    const sbomFindings = result.findings.filter((f) => f.pattern_id.startsWith("sbom-"));
    expect(sbomFindings.length).toBeGreaterThanOrEqual(2);
    for (const f of sbomFindings) {
      expect(["critical", "high", "medium", "low"]).toContain(f.severity);
      expect(f.verification.verdict).toBe("confirmed");
      expect(f.fix_support).toBe("manual");
      expect(f.cwe).toBeTruthy();
    }
  });

  test("--deps with no vulnerable packages produces no SBOM findings", async () => {
    writeFileSync(
      join(TMP, "package.json"),
      JSON.stringify({
        dependencies: { lodash: "4.17.21", react: "18.3.0" },
      }),
    );
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () =>
        JSON.stringify({ verdict: "confirmed", reasoning: "x", evidence: { sink: "y" } }),
      skipVerification: true,
      includeDeps: true,
    });
    const sbomFindings = result.findings.filter((f) => f.pattern_id.startsWith("sbom-"));
    expect(sbomFindings.length).toBe(0);
  });

  test("--deps with no package.json doesn't crash", async () => {
    // Empty TMP — no package.json at all
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () =>
        JSON.stringify({ verdict: "confirmed", reasoning: "x", evidence: { sink: "y" } }),
      skipVerification: true,
      includeDeps: true,
    });
    expect(result.project).toBeTruthy();
    const sbomFindings = result.findings.filter((f) => f.pattern_id.startsWith("sbom-"));
    expect(sbomFindings.length).toBe(0);
  });
});
