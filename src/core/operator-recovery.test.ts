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

  // Phase 16: recovery must be reactive, not proactive.
  test("phase 16: contains the reactive-not-proactive rule", () => {
    const out = buildOperatorRecoveryGuidance();
    expect(out).toMatch(/reactive, not proactive/i);
  });

  test("phase 16: warns against speculative preemptive pkill", () => {
    const out = buildOperatorRecoveryGuidance();
    expect(out).toMatch(/speculatively/i);
    expect(out).toContain("pkill");
    // The rule should explicitly name the pkill-before-failure antipattern
    expect(out).toMatch(/before any tool has failed is[\s\S]*NOT helpful/i);
  });

  test("phase 16: tells the model what to do when no tool has failed", () => {
    const out = buildOperatorRecoveryGuidance();
    expect(out).toMatch(/do the actual task directly/i);
    expect(out).toMatch(/only after seeing the failure message/i);
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
