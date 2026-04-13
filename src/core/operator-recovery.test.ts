// Tests for phase 6 — AUTHORIZED RECOVERY language in operator-mind refusals
// and in the system prompt.

import { describe, expect, test } from "bun:test";
import { runSpawnPreflight } from "./bash-spawn-preflight";
import { buildOperatorRecoveryGuidance } from "./system-prompt-layers";

describe("buildOperatorRecoveryGuidance", () => {
  test("explains how to read AUTHORIZED RECOVERY blocks", () => {
    const out = buildOperatorRecoveryGuidance();
    expect(out).toContain("AUTHORIZED RECOVERY");
    expect(out).toMatch(/execute the steps yourself/i);
    expect(out).toMatch(/do not paste them into[\s\S]*message for the user/i);
  });

  test("tells the model to use the exact command, not a variant", () => {
    const out = buildOperatorRecoveryGuidance();
    expect(out).toMatch(/do not invent your own variations/i);
  });

  test("requires the retry step after recovery", () => {
    const out = buildOperatorRecoveryGuidance();
    expect(out).toMatch(/recovery without retry is incomplete/i);
  });

  test("makes the failure mode it prevents explicit", () => {
    const out = buildOperatorRecoveryGuidance();
    expect(out).toMatch(/options.*user actions/i);
  });

  test("ends with an unambiguous directive", () => {
    const out = buildOperatorRecoveryGuidance();
    expect(out).toContain("You are the operator. Operate.");
  });
});

describe("inotify refusal AUTHORIZED RECOVERY language", () => {
  test("inotify saturation refusal is action-oriented (when system saturated)", () => {
    // This test only checks the SHAPE of the report when the refusal
    // fires. On a healthy host inotify is below threshold and the
    // function returns null — that's fine, we skip the assertion.
    const r = runSpawnPreflight("next dev --port 59123", process.cwd());
    if (!r) return; // host healthy — nothing to assert
    if (!r.report.includes("inotify")) return; // refusal was port not inotify

    expect(r.report).toContain("AUTHORIZED RECOVERY");
    expect(r.report).toContain("WITHOUT asking the user");
    expect(r.report).toMatch(/Step 1[\s\S]*pkill/);
    expect(r.report).toMatch(/Step 2[\s\S]*sleep/);
    expect(r.report).toMatch(/Step 3[\s\S]*retry/);
    expect(r.report).toMatch(/sudo sysctl/);
    expect(r.report).toContain("not destructive");
  });
});
