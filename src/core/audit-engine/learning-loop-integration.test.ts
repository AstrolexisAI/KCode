// CL.3 (v2.10.373) — integration tests for the learning loop.
//
// review-history.ts persistence had unit tests in F5; this file
// exercises the END-TO-END behavior: a pattern demoted ≥10 times in
// the SAME path-glob bucket gets pre-marked needs_context on the next
// runAudit without hitting the verifier.
//
// pathGlob assigns a bucket to every file:
//   *.test.* / *.spec.* / __tests__ → "test:*"
//   src/foo.js, src/bar.js          → "src:*"
//   lib/x.go                        → "lib:*"
// Suppression only fires when the candidate's bucket matches a
// bucket that has ≥10 prior demotions.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "./audit-engine";
import { recordDemotion } from "./review-history";

let TMP: string;
let HOME_TMP: string;
let originalHome: string | undefined;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "kcode-learning-loop-"));
  HOME_TMP = mkdtempSync(join(tmpdir(), "kcode-learning-loop-home-"));
  originalHome = process.env.KCODE_HOME;
  process.env.KCODE_HOME = HOME_TMP;
});

afterEach(() => {
  if (originalHome !== undefined) {
    process.env.KCODE_HOME = originalHome;
  } else {
    delete process.env.KCODE_HOME;
  }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(HOME_TMP, { recursive: true, force: true }); } catch { /* */ }
});

const llmConfirm = async () =>
  JSON.stringify({
    verdict: "confirmed",
    reasoning: "test fixture",
    evidence: { sink: "test" },
  });

describe("learning loop — end-to-end", () => {
  test("pattern demoted >=10 times in same glob gets pre-marked needs_context", async () => {
    // Candidate file lives in src/* so its glob is "src:*".
    mkdirSync(join(TMP, "src"), { recursive: true });
    writeFileSync(join(TMP, "src", "fixture.js"), `eval(userInput);\n`);

    // 12 prior demotions ALSO in the "src:*" glob bucket (no .test.
    // / .spec. suffix; just bare .js files in src/).
    for (let i = 0; i < 12; i++) {
      recordDemotion({
        projectRoot: TMP,
        patternId: "js-001-eval",
        file: join(TMP, "src", `prior${i}.js`),
      });
    }

    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: llmConfirm,
      skipVerification: false,
    });

    // Suppression fires for js-001-eval specifically. Other patterns
    // (des-003-eval-user-input, etc.) that also catch eval() may still
    // emit confirmed findings — the learning loop is per-pattern, not
    // per-line. What matters is that THIS pattern was demoted to
    // needs_context.
    expect(result.learning_loop_suppressed).toBeGreaterThanOrEqual(1);
    const evalConfirmed = result.findings.find(
      (f) => f.pattern_id === "js-001-eval",
    );
    expect(evalConfirmed).toBeUndefined();

    const ncEntry = result.needs_context_detail.find(
      (d) => d.pattern_id === "js-001-eval",
    );
    expect(ncEntry).toBeDefined();
    expect(ncEntry?.verification.reasoning).toContain("learning loop");
    expect(ncEntry?.verification.reasoning).toContain("/review promote");
  });

  test("pattern with <10 demotions is NOT suppressed (still verifies)", async () => {
    mkdirSync(join(TMP, "src"), { recursive: true });
    writeFileSync(join(TMP, "src", "fixture.js"), `eval(userInput);\n`);

    // 5 demotions, all in same "src:*" bucket — below threshold of 10.
    for (let i = 0; i < 5; i++) {
      recordDemotion({
        projectRoot: TMP,
        patternId: "js-001-eval",
        file: join(TMP, "src", `prior${i}.js`),
      });
    }

    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: llmConfirm,
      skipVerification: false,
    });

    expect(result.learning_loop_suppressed ?? 0).toBe(0);
  });

  test("demotions in test:* don't suppress findings in src:*", async () => {
    // Candidate in src:* glob.
    mkdirSync(join(TMP, "src"), { recursive: true });
    writeFileSync(join(TMP, "src", "main.js"), `eval(userInput);\n`);

    // 12 demotions, but the file paths have .test.js suffix → those
    // demotions register in the "test:*" glob bucket, not "src:*".
    // The path doesn't have to physically exist; recordDemotion just
    // hashes the path string.
    for (let i = 0; i < 12; i++) {
      recordDemotion({
        projectRoot: TMP,
        patternId: "js-001-eval",
        file: join(TMP, "src", `prior${i}.test.js`),
      });
    }

    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: llmConfirm,
      skipVerification: false,
    });

    // src/main.js → src:* bucket; no demotions there → no suppression.
    expect(result.learning_loop_suppressed ?? 0).toBe(0);
  });

  test("--skip-verify bypasses the learning loop entirely", async () => {
    mkdirSync(join(TMP, "src"), { recursive: true });
    writeFileSync(join(TMP, "src", "fixture.js"), `eval(userInput);\n`);

    for (let i = 0; i < 12; i++) {
      recordDemotion({
        projectRoot: TMP,
        patternId: "js-001-eval",
        file: join(TMP, "src", `prior${i}.js`),
      });
    }

    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: llmConfirm,
      skipVerification: true,
    });

    // skipVerification path takes the early-return; learning loop
    // intentionally doesn't gate static-only output. The user
    // explicitly opted for "show me everything regex matched."
    expect(result.confirmed_findings).toBeGreaterThanOrEqual(1);
  });
});
