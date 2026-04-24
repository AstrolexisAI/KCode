import { beforeEach, describe, expect, test } from "bun:test";
import { getTaskScopeManager } from "../core/task-scope";
import { executeAskUser } from "./ask-user";

describe("AskUser grounding feed (v283 #111)", () => {
  beforeEach(() => getTaskScopeManager().reset());

  test("401 in context → scope transitions to configure/blocked (v282 EXACT repro)", async () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "bitcoin tui" });
    mgr.recordDirectoryVerified("/proj");
    mgr.recordMutation({ tool: "Write", path: "/proj/index.ts", at: Date.now() });
    // bun run succeeded (exit 0) — no failure signal in stdout
    mgr.recordRuntimeCommand({
      command: "bun run index.ts",
      exitCode: 0,
      output: "PID: 3357426 (3.0s)",
      runtimeFailed: false,
      status: "verified",
      timestamp: Date.now(),
    });
    expect(mgr.current()!.phase).not.toBe("blocked");

    // Model saw 401 inside the TUI, calls AskUser with it.
    await executeAskUser({
      question:
        "Para conectar al nodo Bitcoin, necesito las credenciales RPC. ¿Cuáles son el usuario y contraseña RPC configurados?",
      context:
        "El dashboard está intentando conectarse al RPC de Bitcoin en localhost:8332, pero recibe error 401 Unauthorized, indicando que necesita autenticación.",
    });

    const scope = mgr.current()!;
    expect(scope.phase).toBe("blocked");
    expect(scope.type).toBe("configure");
    expect(scope.completion.mayClaimReady).toBe(false);
  });

  test("ModuleNotFoundError in context → failed_dependency recorded", async () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    await executeAskUser({
      question: "Do you want me to install the missing dependency?",
      context:
        "The script fails with ModuleNotFoundError: No module named 'bitcoinrpc'. Need to install it.",
    });
    const scope = mgr.current()!;
    const last = scope.verification.runtimeCommands.at(-1);
    expect(last?.status).toBe("failed_dependency");
    expect(scope.phase).toBe("failed");
  });

  test("Plain clarifying question does NOT trigger transition", async () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordDirectoryVerified("/proj");
    await executeAskUser({
      question: "Which port should the dashboard bind to?",
      context: "Default is 8332 but you might want a different one.",
    });
    const scope = mgr.current()!;
    expect(scope.phase).not.toBe("blocked");
    expect(scope.phase).not.toBe("failed");
    expect(scope.verification.runtimeCommands).toHaveLength(0);
  });

  test("No active scope → falls through (no error)", async () => {
    // No beginNewScope called.
    const result = await executeAskUser({
      question: "Need creds?",
      context: "401 Unauthorized",
    });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("USER_INPUT_REQUIRED");
  });

  test("empty question still rejected (legacy behavior preserved)", async () => {
    const result = await executeAskUser({ question: "" });
    expect(result.is_error).toBe(true);
  });

  test("scope with failed/partial state prepends grounded closeout to context (v292)", async () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "bitcoin tui" });
    mgr.recordDirectoryVerified("/proj");
    mgr.recordMutation({ tool: "Write", path: "/proj/index.ts", at: Date.now() });
    // A timeout-killed TUI → phase=partial via v282 downgrade
    mgr.recordRuntimeCommand({
      command: "timeout 5 bun run dashboard.ts",
      exitCode: 124,
      output: "...",
      runtimeFailed: false,
      status: "alive_timeout",
      timestamp: Date.now(),
    });
    const result = await executeAskUser({
      question: "¿Quieres que continúe expandiendo las funcionalidades?",
      context: "Falta añadir vistas más detalladas",
    });
    expect(result.is_error).toBeFalsy();
    // Grounded closeout text should appear in the output before the
    // original context. Look for the 'Verified status' header that
    // renderCloseoutFromScope emits.
    expect(result.content).toMatch(/Verified status/i);
    expect(result.content).toContain("Falta añadir vistas");
    expect(result.content).toContain("Model's stated context");
  });
});
