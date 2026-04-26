// Tests for the F9 --pack filter (v2.10.370).
//
// Two angles:
//   1. runAudit({ pack }) loads only patterns tagged with that pack.
//   2. The result carries a pack_breakdown of confirmed findings.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "./audit-engine";

let TMP: string;

beforeEach(() => {
  TMP = `/tmp/kcode-pack-filter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(TMP, { recursive: true });
});
afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const llmConfirm = async () =>
  JSON.stringify({
    verdict: "confirmed",
    reasoning: "test fixture",
    evidence: { sink: "test" },
  });

describe("--pack filter", () => {
  test("pack: 'ai-ml' loads only ai-ml-tagged patterns", async () => {
    // ai-ml positive: trust_remote_code=True
    writeFileSync(
      join(TMP, "loader.py"),
      `from transformers import AutoModel\nm = AutoModel.from_pretrained("x", trust_remote_code=True)\n`,
    );
    // web positive: eval(req.body) — should NOT fire under --pack ai-ml.
    writeFileSync(
      join(TMP, "server.js"),
      `app.post("/x", (req, res) => { const r = eval(req.body.code); });\n`,
    );

    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: llmConfirm,
      skipVerification: true,
      pack: "ai-ml",
    });

    // ai-ml finding present.
    expect(result.findings.some((f) => f.pattern_id === "ai-001-trust-remote-code")).toBe(true);
    // No JS findings — js-001-eval, js-002-innerhtml, etc. are
    // outside the ai-ml pack so they didn't run.
    expect(result.findings.some((f) => f.pattern_id.startsWith("js-"))).toBe(false);
    // scoped_pack reflects the filter so the report can label it.
    expect(result.scoped_pack).toBe("ai-ml");
  });

  test("absent pack runs every pattern (legacy behavior)", async () => {
    writeFileSync(
      join(TMP, "server.js"),
      `app.post("/x", (req, res) => { const r = eval(req.body.code); });\n`,
    );
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: llmConfirm,
      skipVerification: true,
    });
    // js-001-eval (web) found.
    expect(result.findings.some((f) => f.pattern_id === "js-001-eval")).toBe(true);
    expect(result.scoped_pack).toBeUndefined();
  });

  test("pack_breakdown counts findings by pack", async () => {
    writeFileSync(
      join(TMP, "a.py"),
      `import pickle\ndata = pickle.loads(b)\n`, // py-003-pickle-deserialize → ai-ml
    );
    writeFileSync(
      join(TMP, "b.js"),
      `eval(x)\n`, // js-001-eval → no pack (general)
    );

    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: llmConfirm,
      skipVerification: true,
    });

    expect(result.pack_breakdown).toBeDefined();
    expect(result.pack_breakdown!["ai-ml"]).toBeGreaterThanOrEqual(1);
    // js-001-eval lacks a pack tag → "general" bucket.
    expect(result.pack_breakdown!["general"]).toBeGreaterThanOrEqual(1);
  });
});
