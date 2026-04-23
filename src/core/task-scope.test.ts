import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  classifyIntent,
  createTaskScopeManager,
  getTaskScopeManager,
  shouldOpenNewScope,
} from "./task-scope";

describe("classifyIntent", () => {
  test("detects scaffold intent", () => {
    expect(
      classifyIntent(
        "Necesito crear un proyecto nuevo, quiero un dashboard de TUI de bitcoin",
      ),
    ).toBe("scaffold");
    expect(classifyIntent("Build a new Rust CLI from scratch")).toBe("scaffold");
    expect(classifyIntent("scaffold a Next.js app")).toBe("scaffold");
  });

  test("detects audit intent", () => {
    expect(classifyIntent("auditá el código de /tmp/foo.py")).toBe("audit");
    expect(classifyIntent("security review of the auth module")).toBe("audit");
    expect(classifyIntent("revisar todo el backend")).toBe("audit");
  });

  test("detects implement intent", () => {
    expect(classifyIntent("añadí un endpoint /users a la API")).toBe("implement");
    expect(classifyIntent("implement JWT authentication")).toBe("implement");
    expect(classifyIntent("agregá paginación al listing")).toBe("implement");
  });

  test("detects operate intent", () => {
    expect(classifyIntent("corré los tests")).toBe("operate");
    expect(classifyIntent("debug the crash in prod")).toBe("operate");
    expect(classifyIntent("deployar a staging")).toBe("operate");
  });

  test("detects analyze intent", () => {
    expect(classifyIntent("explicá cómo funciona este módulo")).toBe("analyze");
    expect(classifyIntent("por qué está fallando el cache?")).toBe("analyze");
  });

  test("defaults to implement when nothing matches", () => {
    expect(classifyIntent("hola")).toBe("implement");
    expect(classifyIntent("can you help?")).toBe("implement");
  });
});

describe("shouldOpenNewScope", () => {
  test("true when no current scope", () => {
    expect(shouldOpenNewScope(null, "scaffold")).toBe(true);
  });

  test("true when intent type differs", () => {
    const mgr = createTaskScopeManager();
    const s = mgr.beginNewScope({ type: "audit", userPrompt: "audit X" });
    expect(shouldOpenNewScope(s, "scaffold")).toBe(true);
  });

  test("false when intent type is same", () => {
    const mgr = createTaskScopeManager();
    const s = mgr.beginNewScope({ type: "scaffold", userPrompt: "crear X" });
    expect(shouldOpenNewScope(s, "scaffold")).toBe(false);
  });
});

describe("TaskScopeManager", () => {
  let mgr: ReturnType<typeof createTaskScopeManager>;

  beforeEach(() => {
    mgr = createTaskScopeManager();
  });

  test("starts with no current scope", () => {
    expect(mgr.current()).toBeNull();
  });

  test("beginNewScope creates a scope with sane defaults", () => {
    const s = mgr.beginNewScope({ type: "scaffold", userPrompt: "crear X" });
    expect(s.type).toBe("scaffold");
    expect(s.phase).toBe("planning");
    expect(s.audit.enabled).toBe(false);
    expect(s.completion.mayClaimReady).toBe(true);
    expect(s.verification.filesWritten).toHaveLength(0);
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("audit type auto-enables audit guards", () => {
    const s = mgr.beginNewScope({ type: "audit", userPrompt: "audit X" });
    expect(s.audit.enabled).toBe(true);
    expect(s.audit.reportRequired).toBe(true);
  });

  test("beginNewScope archives the prior scope to history", () => {
    mgr.beginNewScope({ type: "audit", userPrompt: "a" });
    mgr.beginNewScope({ type: "scaffold", userPrompt: "b" });
    expect(mgr.current()?.type).toBe("scaffold");
    expect(mgr.history()).toHaveLength(1);
    expect(mgr.history()[0]?.type).toBe("audit");
  });

  test("update merges patches deeply", () => {
    const s = mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.update({ progress: { currentStep: "writing main.py" } });
    expect(mgr.current()?.progress.currentStep).toBe("writing main.py");
    // Other progress fields preserved
    expect(mgr.current()?.progress.plannedSteps).toEqual(s.progress.plannedSteps);
  });

  test("recordMutation adds to mutationsSucceeded and moves phase", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.recordMutation({ tool: "Write", path: "/tmp/app.py", at: Date.now() });
    expect(mgr.current()?.verification.mutationsSucceeded).toHaveLength(1);
    expect(mgr.current()?.verification.filesWritten).toEqual(["/tmp/app.py"]);
    expect(mgr.current()?.phase).toBe("writing");
  });

  test("recordMutation after runtime failure sets patchAppliedAfterFailure", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.recordMutation({ tool: "Write", path: "/tmp/app.py", at: 1 });
    mgr.recordRuntimeCommand({
      command: "python3 app.py",
      exitCode: 1,
      output: "ModuleNotFoundError",
      runtimeFailed: true,
      timestamp: 2,
    });
    expect(mgr.current()?.phase).toBe("failed");
    expect(mgr.current()?.completion.mayClaimReady).toBe(false);

    mgr.recordMutation({ tool: "Edit", path: "/tmp/app.py", at: 3 });
    expect(mgr.current()?.verification.patchAppliedAfterFailure).toBe(true);
    expect(mgr.current()?.verification.rerunPassedAfterPatch).toBe(false);
  });

  test("successful rerun after patch clears patchAppliedAfterFailure", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.recordMutation({ tool: "Write", path: "/tmp/app.py", at: 1 });
    mgr.recordRuntimeCommand({
      command: "python3 app.py",
      exitCode: 1,
      output: "ModuleNotFoundError",
      runtimeFailed: true,
      timestamp: 2,
    });
    mgr.recordMutation({ tool: "Edit", path: "/tmp/app.py", at: 3 });
    mgr.recordRuntimeCommand({
      command: "python3 app.py",
      exitCode: 0,
      output: "Server running",
      runtimeFailed: false,
      timestamp: 4,
    });
    expect(mgr.current()?.verification.rerunPassedAfterPatch).toBe(true);
    expect(mgr.current()?.verification.patchAppliedAfterFailure).toBe(false);
    expect(mgr.current()?.verification.lastRuntimeFailure).toBeUndefined();
  });

  test("recordRuntimeCommand with failure flips completion flags", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.recordRuntimeCommand({
      command: "python3 app.py",
      exitCode: 1,
      output: "Traceback",
      runtimeFailed: true,
      timestamp: 1,
    });
    const s = mgr.current()!;
    expect(s.completion.mayClaimReady).toBe(false);
    expect(s.completion.mustUsePartialLanguage).toBe(true);
    expect(s.completion.reasons).toContain("runtime failure");
  });

  test("recordSecret deduplicates same kind+source", () => {
    mgr.beginNewScope({ type: "configure", userPrompt: "x" });
    mgr.recordSecret({ kind: "rpcpassword", source: "~/.bitcoin/bitcoin.conf" });
    mgr.recordSecret({ kind: "rpcpassword", source: "~/.bitcoin/bitcoin.conf" });
    mgr.recordSecret({ kind: "api_key", source: "assistant-prose" });
    expect(mgr.current()?.secrets.detected).toHaveLength(2);
  });

  test("closeScope archives to history and clears current", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.closeScope("user moved on");
    expect(mgr.current()).toBeNull();
    expect(mgr.history()).toHaveLength(1);
    expect(mgr.history()[0]?.completion.reasons).toContain("scope closed: user moved on");
  });

  test("reset clears everything (tests only)", () => {
    mgr.beginNewScope({ type: "scaffold", userPrompt: "x" });
    mgr.beginNewScope({ type: "audit", userPrompt: "y" });
    expect(mgr.history()).toHaveLength(1);
    mgr.reset();
    expect(mgr.current()).toBeNull();
    expect(mgr.history()).toHaveLength(0);
  });

  test("update on null current scope is a no-op", () => {
    mgr.update({ phase: "done" });
    expect(mgr.current()).toBeNull();
  });
});

describe("getTaskScopeManager singleton", () => {
  afterEach(() => {
    getTaskScopeManager().reset();
  });

  test("returns the same instance across calls", () => {
    const a = getTaskScopeManager();
    const b = getTaskScopeManager();
    expect(a).toBe(b);
  });

  test("singleton persists state across getters", () => {
    getTaskScopeManager().beginNewScope({ type: "audit", userPrompt: "x" });
    expect(getTaskScopeManager().current()?.type).toBe("audit");
  });
});

describe("#100 repro — scope reset on intent shift", () => {
  test("audit → scaffold flow no longer inherits audit policy", () => {
    const mgr = createTaskScopeManager();
    // User's first prompt: audit a project
    const intent1 = classifyIntent("auditá el código de SmartSolar");
    expect(intent1).toBe("audit");
    mgr.beginNewScope({ type: intent1, userPrompt: "audit SmartSolar" });
    expect(mgr.current()?.audit.enabled).toBe(true);

    // User's second prompt: create a new project
    const intent2 = classifyIntent(
      "Necesito crear un proyecto nuevo, quiero un dashboard de TUI de bitcoin",
    );
    expect(intent2).toBe("scaffold");
    expect(shouldOpenNewScope(mgr.current(), intent2)).toBe(true);

    // Opening the new scope archives the audit one and disables audit guards
    mgr.beginNewScope({ type: intent2, userPrompt: "crear dashboard btc" });
    expect(mgr.current()?.type).toBe("scaffold");
    expect(mgr.current()?.audit.enabled).toBe(false);
    expect(mgr.current()?.audit.reportRequired).toBe(false);
    expect(mgr.history()[0]?.type).toBe("audit");
  });
});
