import { beforeEach, describe, expect, test } from "bun:test";
import {
  needsClosewoutCorrection,
  renderCloseoutFromScope,
  summarizeScopeForTelemetry,
} from "./closeout-renderer";
import { createTaskScopeManager } from "./task-scope";

let mgr = createTaskScopeManager();

beforeEach(() => {
  mgr = createTaskScopeManager();
});

describe("needsClosewoutCorrection", () => {
  test("returns false for a clean done scope", () => {
    const s = mgr.beginNewScope({ type: "implement", userPrompt: "x" });
    mgr.update({ phase: "done" });
    expect(needsClosewoutCorrection(mgr.current()!)).toBe(false);
  });

  test("returns true when phase is failed", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.update({ phase: "failed" });
    expect(needsClosewoutCorrection(mgr.current()!)).toBe(true);
  });

  test("returns true when mayClaimReady is false", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.update({ completion: { mayClaimReady: false } });
    expect(needsClosewoutCorrection(mgr.current()!)).toBe(true);
  });

  test("returns true when mustUsePartialLanguage is true", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.update({ completion: { mustUsePartialLanguage: true } });
    expect(needsClosewoutCorrection(mgr.current()!)).toBe(true);
  });

  test("returns true when phase is partial", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.update({ phase: "partial" });
    expect(needsClosewoutCorrection(mgr.current()!)).toBe(true);
  });
});

describe("renderCloseoutFromScope", () => {
  test("returns null when no correction is needed", () => {
    mgr.beginNewScope({ type: "implement", userPrompt: "x" });
    mgr.update({ phase: "done" });
    expect(renderCloseoutFromScope(mgr.current()!)).toBeNull();
  });

  test("renders 'none' for zero files written", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    // Push the scope into "execution" mode (a runtime command was issued)
    // so the renderer emits the "none created or edited" line. Informational
    // turns (no files, no runtime) suppress that diagnostic — issue #111
    // v2.10.306. The test name still applies: when execution happened but
    // no files landed, the renderer must explicitly say "none".
    mgr.recordRuntimeCommand({
      command: "echo hello",
      exitCode: 0,
      output: "hello",
      runtimeFailed: false,
      timestamp: 1,
    });
    mgr.update({ phase: "partial" });
    const out = renderCloseoutFromScope(mgr.current()!)!;
    expect(out).toContain("none created or edited");
  });

  test("renders files created with basenames only (not full paths)", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.recordMutation({ tool: "Write", path: "/home/curly/proyectos/bitcoin-tui/main.py", at: 1 });
    mgr.update({ phase: "partial" });
    const out = renderCloseoutFromScope(mgr.current()!)!;
    expect(out).toContain("main.py");
    expect(out).not.toContain("/home/curly/proyectos"); // basename only
  });

  test("renders runtime failure when last command had runtimeFailed=true", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.recordRuntimeCommand({
      command: "python3 app.py",
      exitCode: 1,
      output: "ModuleNotFoundError: No module named 'bitcoin'",
      runtimeFailed: true,
      timestamp: 1,
    });
    const out = renderCloseoutFromScope(mgr.current()!)!;
    expect(out).toContain("Runtime: **failed**");
    expect(out).toContain("ModuleNotFoundError");
  });

  test("renders patch-applied-after-failure state", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.recordMutation({ tool: "Write", path: "/tmp/app.py", at: 1 });
    mgr.recordRuntimeCommand({
      command: "python3 app.py",
      exitCode: 1,
      output: "ImportError",
      runtimeFailed: true,
      timestamp: 2,
    });
    mgr.recordMutation({ tool: "Edit", path: "/tmp/app.py", at: 3 });
    const out = renderCloseoutFromScope(mgr.current()!)!;
    expect(out).toContain("patch applied after earlier failure");
    expect(out).toContain("no successful rerun");
  });

  test("lists reasons when mustUsePartialLanguage is set", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.update({
      phase: "partial",
      completion: {
        mustUsePartialLanguage: true,
        reasons: [
          "placeholder markers in generated code",
          "strong completion claim on broad request",
        ],
      },
    });
    const out = renderCloseoutFromScope(mgr.current()!)!;
    expect(out).toContain("Why this turn is not marked complete");
    expect(out).toContain("placeholder markers");
    expect(out).toContain("strong completion claim");
  });

  test("renders final status 'failed' when phase is failed", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.update({ phase: "failed" });
    const out = renderCloseoutFromScope(mgr.current()!)!;
    expect(out).toContain("Status: failed");
  });

  test("renders final status 'partial' when partial-language required", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.update({ completion: { mustUsePartialLanguage: true } });
    const out = renderCloseoutFromScope(mgr.current()!)!;
    expect(out).toContain("Status: partial");
  });

  test("mentions redacted secrets when any detected", () => {
    mgr.beginNewScope({ type: "configure", userPrompt: "x" });
    mgr.recordSecret({ kind: "rpcpassword", source: "~/.bitcoin/bitcoin.conf" });
    mgr.update({ completion: { mustUsePartialLanguage: true } });
    const out = renderCloseoutFromScope(mgr.current()!)!;
    expect(out).toContain("Secrets detected (redacted): rpcpassword");
  });

  test("renders the EXACT 2026-04-23 #103 + #107 combined turn correctly", () => {
    // Simulate: user asked for bitcoin TUI, model wrote main.py, runtime failed with
    // ModuleNotFoundError, secret was detected, model claimed ready anyway.
    mgr.beginNewScope({
      type: "scaffold",
      userPrompt: "quiero un dashboard de TUI de bitcoin en tiempo real",
      broadRequest: true,
    });
    mgr.recordMutation({ tool: "Write", path: "/home/curly/proyectos/bitcoin-tui/main.py", at: 1 });
    mgr.recordRuntimeCommand({
      command: "python3 app.py",
      exitCode: 0,
      output:
        "Traceback (most recent call last):\n  ModuleNotFoundError: No module named 'bitcoin'",
      runtimeFailed: true,
      timestamp: 2,
    });
    mgr.recordSecret({ kind: "rpcpassword", source: "~/.bitcoin/bitcoin.conf" });
    mgr.update({
      completion: {
        reasons: [
          "runtime failure",
          "readiness claim contradicts 1 tool error(s)",
          "scope overclaim on broad request",
        ],
      },
    });

    const out = renderCloseoutFromScope(mgr.current()!)!;
    expect(out).toContain("main.py");
    expect(out).toContain("Runtime: **failed**");
    expect(out).toContain("ModuleNotFoundError");
    expect(out).toContain("rpcpassword");
    expect(out).toContain("Status: failed");
    expect(out).toContain("runtime failure");
    expect(out).toContain("readiness claim contradicts");
    expect(out).toContain("scope overclaim on broad request");
  });
});

describe("summarizeScopeForTelemetry", () => {
  test("produces a flat object with the key fields", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.recordMutation({ tool: "Write", path: "/tmp/a.py", at: 1 });
    const tel = summarizeScopeForTelemetry(mgr.current()!);
    expect(tel.type).toBe("scaffold");
    expect(tel.filesWritten).toBe(1);
    expect(tel.mayClaimReady).toBe(true);
    expect(tel.phase).toBe("writing");
  });
});
