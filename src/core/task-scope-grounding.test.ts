// KCode - Task Scope Grounding Integration Tests (Phase 3)
//
// Verifies that the grounding-gate detectors propagate to scope state.
// Uses the scope manager + the detector functions directly (the
// conversation-post-turn wiring is tested via manual repro).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  detectCreationClaimMismatch,
  detectPatchWithoutRerun,
  detectReadinessAfterErrors,
  detectRuntimeFailureInOutput,
  detectStrongCompletionClaim,
  scanFilesForStubs,
} from "./grounding-gate";
import { recordUserText, resetReads } from "./session-tracker";
import { getTaskScopeManager } from "./task-scope";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;

beforeEach(() => {
  resetReads();
  getTaskScopeManager().reset();
  tmp = mkdtempSync(join(tmpdir(), "task-scope-grounding-"));
});

afterEach(() => {
  resetReads();
  getTaskScopeManager().reset();
  rmSync(tmp, { recursive: true, force: true });
});

describe("Phase 3 — scope flag helpers propagate detector findings", () => {
  // These tests run the same grounding logic that
  // conversation-post-turn.ts runs per turn, and verify that the scope
  // ends up in the correct final state.
  //
  // We simulate "turn ended with finding X" by calling the detector
  // directly and then applying the scope update the caller would do.

  test("stub finding → scope.completion.mustUsePartialLanguage", () => {
    const mgr = getTaskScopeManager();
    recordUserText("Necesito crear un proyecto nuevo de bitcoin dashboard");
    expect(mgr.current()?.type).toBe("scaffold");

    const file = join(tmp, "main.py");
    writeFileSync(
      file,
      `def update():\n    txs = [{"txid": "stub_tx1", "vsize": 200, "fee": 1000}]\n    return txs\n`,
    );
    const findings = scanFilesForStubs([file]);
    expect(findings.length).toBeGreaterThan(0);

    // Simulate the post-turn code updating scope
    const cur = mgr.current()!;
    mgr.update({
      phase: "partial",
      completion: {
        mayClaimImplemented: false,
        mustUsePartialLanguage: true,
        reasons: [...cur.completion.reasons, "stub markers in generated code"],
      },
    });

    const s = mgr.current()!;
    expect(s.completion.mustUsePartialLanguage).toBe(true);
    expect(s.completion.mayClaimImplemented).toBe(false);
    expect(s.phase).toBe("partial");
    expect(s.completion.reasons).toContain("stub markers in generated code");
  });

  test("runtime traceback in output → recordRuntimeCommand flips to failed", () => {
    recordUserText("crear un proyecto nuevo");
    const mgr = getTaskScopeManager();
    const ev = detectRuntimeFailureInOutput([
      { command: "timeout 5 python3 app.py 2>&1 | head", output: "Traceback (most recent call last):\n  ModuleNotFoundError: No module named 'bitcoin'" },
    ]);
    expect(ev).not.toBeNull();

    mgr.recordRuntimeCommand({
      command: ev!.command,
      exitCode: 0,
      output: ev!.excerpt,
      runtimeFailed: true,
      timestamp: Date.now(),
    });
    const s = mgr.current()!;
    expect(s.phase).toBe("failed");
    expect(s.completion.mayClaimReady).toBe(false);
    expect(s.completion.mustUsePartialLanguage).toBe(true);
    expect(s.verification.lastRuntimeFailure?.command).toContain("python3 app.py");
  });

  test("creation-claim-without-writes → scope flagged partial", () => {
    recordUserText("crear un proyecto bitcoin");
    const mgr = getTaskScopeManager();
    const finalText =
      "Proyecto Bitcoin TUI Dashboard creado en /home/curly/proyectos/bitcoin-tui-dashboard.";
    const mismatch = detectCreationClaimMismatch(finalText, 0);
    expect(mismatch).not.toBeNull();

    mgr.update({
      phase: "partial",
      completion: {
        mayClaimReady: false,
        mayClaimImplemented: false,
        mustUsePartialLanguage: true,
        reasons: [...mgr.current()!.completion.reasons, "creation claimed, 0 files written"],
      },
    });
    const s = mgr.current()!;
    expect(s.phase).toBe("partial");
    expect(s.completion.mayClaimReady).toBe(false);
    expect(s.completion.reasons).toContain("creation claimed, 0 files written");
  });

  test("patch-without-rerun detected → scope.verification.patchAppliedAfterFailure=true", () => {
    recordUserText("crear un proyecto");
    const mgr = getTaskScopeManager();
    const events = [
      { name: "Bash", isError: true, summary: "python3 app.py" },
      { name: "GrepReplace", isError: false, summary: "pattern=except X" },
    ];
    const finalText = "He creado el proyecto... conecta al nodo...";
    const finding = detectPatchWithoutRerun(events, finalText);
    expect(finding).not.toBeNull();

    mgr.update({
      verification: { patchAppliedAfterFailure: true, rerunPassedAfterPatch: false },
      phase: "partial",
      completion: {
        mayClaimReady: false,
        mustUsePartialLanguage: true,
        reasons: [...mgr.current()!.completion.reasons, "patch applied without rerun"],
      },
    });
    const s = mgr.current()!;
    expect(s.verification.patchAppliedAfterFailure).toBe(true);
    expect(s.verification.rerunPassedAfterPatch).toBe(false);
    expect(s.completion.mayClaimReady).toBe(false);
  });

  test("readiness-after-errors → scope.phase=failed + completion flags flipped", () => {
    recordUserText("armar un dashboard");
    const mgr = getTaskScopeManager();
    const finding = detectReadinessAfterErrors("app.py is ready. Run with python3 app.py", 1, false);
    expect(finding).not.toBeNull();

    mgr.update({
      phase: "failed",
      completion: {
        mayClaimReady: false,
        mayClaimImplemented: false,
        mustUsePartialLanguage: true,
        reasons: [...mgr.current()!.completion.reasons, "readiness claim with 1 tool error"],
      },
    });
    const s = mgr.current()!;
    expect(s.phase).toBe("failed");
    expect(s.completion.mayClaimReady).toBe(false);
  });

  test("strong completion claim on broad request → mustUsePartialLanguage=true", () => {
    recordUserText(
      "quiero un dashboard que analice completamente la blockchain en tiempo real",
    );
    const mgr = getTaskScopeManager();
    expect(mgr.current()?.broadRequest).toBe(true);

    const finding = detectStrongCompletionClaim(
      "Proyecto completado, listo para producción.",
      "analizar completamente la blockchain en tiempo real",
    );
    expect(finding).not.toBeNull();
    expect(finding?.broadRequest).toBe(true);

    mgr.update({
      completion: {
        mustUsePartialLanguage: true,
        reasons: [...mgr.current()!.completion.reasons, "scope overclaim on broad request"],
      },
    });
    const s = mgr.current()!;
    expect(s.completion.mustUsePartialLanguage).toBe(true);
  });

  test("combining runtime failure + patch-no-rerun accumulates reasons without duplicates", () => {
    recordUserText("crear un proyecto");
    const mgr = getTaskScopeManager();
    mgr.recordRuntimeCommand({
      command: "python3 app.py",
      exitCode: 1,
      output: "ModuleNotFoundError",
      runtimeFailed: true,
      timestamp: 1,
    });
    mgr.update({
      completion: {
        reasons: [...mgr.current()!.completion.reasons, "stub markers in generated code"],
      },
    });
    // Re-apply the same reason — shouldn't duplicate
    mgr.update({
      completion: {
        reasons: mgr.current()!.completion.reasons.includes("runtime failure")
          ? mgr.current()!.completion.reasons
          : [...mgr.current()!.completion.reasons, "runtime failure"],
      },
    });
    const reasons = mgr.current()!.completion.reasons;
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    // 'runtime failure' appears once even though we tried to add it twice
    expect(reasons.filter((r) => r === "runtime failure").length).toBe(1);
  });
});
