// Tests for the "code files written without runtime validation"
// gate landed in post-turn. Issue #111 v278 repro: Bitcoin TUI
// scaffold created index.ts + edited package.json, never ran
// bun run / bun run --check, closed with "Proyecto creado..." prose.
//
// Unit-level behavior: the scope state, after such a turn, must
// reflect mayClaimReady=false so the closeout renderer kicks in.
// The post-turn gate itself is integration-level; here we simulate
// the state it produces and verify renderCloseoutFromScope renders
// the authoritative unverified-artifact line.

import { beforeEach, describe, expect, test } from "bun:test";
import { needsClosewoutCorrection, renderCloseoutFromScope } from "./closeout-renderer";
import { getTaskScopeManager } from "./task-scope";

describe("unverified artifact (code without runtime)", () => {
  beforeEach(() => getTaskScopeManager().reset());

  test("scope with files written + no runtime + mustUsePartialLanguage → closeout corrects", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordDirectoryVerified("/proj/bitcoin-tui-dashboard");
    mgr.recordMutation({
      tool: "Write",
      path: "/proj/bitcoin-tui-dashboard/index.ts",
      at: Date.now(),
    });
    mgr.recordMutation({
      tool: "Edit",
      path: "/proj/bitcoin-tui-dashboard/package.json",
      at: Date.now(),
    });
    // Post-turn would flag this state via flagScope.
    mgr.update({
      phase: "partial",
      completion: {
        mayClaimReady: false,
        mustUsePartialLanguage: true,
        reasons: [
          ...mgr.current()!.completion.reasons,
          "code files were written/edited this turn but no runtime validation was executed — the artifact is unverified",
        ],
      },
    });

    const scope = mgr.current()!;
    expect(needsClosewoutCorrection(scope)).toBe(true);
    const out = renderCloseoutFromScope(scope)!;
    expect(out).toContain("Runtime: **not verified**");
    expect(out).toContain("was not executed this turn");
    expect(out).toMatch(/no runtime validation was executed/);
  });

  test("scope with runtime command (even failing) does NOT satisfy the unverified-artifact gate", () => {
    // Reasoning for this test: a FAILED runtime is still an attempt
    // at verification — that path is handled by phase=failed. The
    // unverified-artifact gate is specifically for the "never
    // attempted" case.
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordMutation({ tool: "Write", path: "/proj/index.ts", at: Date.now() });
    mgr.recordRuntimeCommand({
      command: "bun run index.ts",
      exitCode: 1,
      output: "ReferenceError: foo is not defined",
      runtimeFailed: true,
      status: "failed_traceback",
      timestamp: Date.now(),
    });
    const scope = mgr.current()!;
    // The runtime DID fail, so mayClaimReady is false anyway — closeout corrects.
    expect(needsClosewoutCorrection(scope)).toBe(true);
    // But for a different reason than the unverified-artifact case.
    expect(scope.completion.reasons.some((r) => /runtime failure/i.test(r))).toBe(true);
  });

  test("audit scope with no runtime is fine (audits don't need to run code)", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "audit", userPrompt: "audita" });
    mgr.recordMutation({ tool: "Write", path: "/proj/AUDIT_REPORT.md", at: Date.now() });
    const scope = mgr.current()!;
    // Audit scope in default state: mayClaimReady=true, no reasons.
    // The closeout renderer returns null when nothing's wrong.
    expect(needsClosewoutCorrection(scope)).toBe(false);
    expect(renderCloseoutFromScope(scope)).toBeNull();
  });

  test("docs-only edits don't trigger the unverified-artifact gate semantically", () => {
    // Simulate what the post-turn gate does: only flag when CODE
    // files were written. Here we write only a .md — the gate does
    // NOT run, so scope stays default.
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordMutation({ tool: "Write", path: "/proj/README.md", at: Date.now() });
    const scope = mgr.current()!;
    expect(scope.completion.mayClaimReady).toBe(true);
    expect(needsClosewoutCorrection(scope)).toBe(false);
  });
});
