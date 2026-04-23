// KCode - Task Scope Integration Tests (Phase 2)
//
// Verifies that the legacy isAuditSession()/setAuditIntent() API now
// reads/writes the TaskScope singleton correctly, and that recordUserText
// opens a fresh scope on intent shift. These are the behavioral
// guarantees that make #100 / #104 / #108 no longer reproducible at the
// architectural level.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkMutationAllowed,
} from "./audit-guards";
import {
  detectAuditIntent,
  isAuditSession,
  recordUserText,
  resetReads,
  setAuditIntent,
} from "./session-tracker";
import { getTaskScopeManager } from "./task-scope";

beforeEach(() => {
  resetReads();
  getTaskScopeManager().reset();
});

afterEach(() => {
  resetReads();
  getTaskScopeManager().reset();
});

describe("session-tracker ↔ TaskScope integration", () => {
  test("recordUserText on scaffold prompt opens scaffold scope", () => {
    recordUserText("Necesito crear un proyecto nuevo, quiero un dashboard de bitcoin");
    const scope = getTaskScopeManager().current();
    expect(scope).not.toBeNull();
    expect(scope?.type).toBe("scaffold");
    expect(scope?.audit.enabled).toBe(false);
  });

  test("recordUserText on audit prompt opens audit scope + enables guards", () => {
    recordUserText("auditá el código de /tmp/foo");
    const scope = getTaskScopeManager().current();
    expect(scope?.type).toBe("audit");
    expect(scope?.audit.enabled).toBe(true);
    expect(scope?.audit.reportRequired).toBe(true);
  });

  test("isAuditSession() reads from scope when scope is active", () => {
    recordUserText("auditá el código");
    expect(isAuditSession()).toBe(true);

    // Now the user pivots to scaffold — scope closes audit one, opens scaffold.
    recordUserText("Necesito crear un proyecto nuevo");
    expect(isAuditSession()).toBe(false);
  });

  test("isAuditSession() falls back to legacy flag when no scope set", () => {
    // Simulate test environment where scope manager is reset but
    // legacy _auditIntent is still being driven directly.
    getTaskScopeManager().reset();
    setAuditIntent(true);
    // setAuditIntent without an active scope updates only the legacy flag.
    expect(isAuditSession()).toBe(true);

    setAuditIntent(false);
    expect(isAuditSession()).toBe(false);
  });

  test("the EXACT #100 repro: audit → scaffold no longer inherits guards", () => {
    // Turn 1: user audits a project
    recordUserText("auditá el proyecto SmartSolar");
    expect(isAuditSession()).toBe(true);
    expect(getTaskScopeManager().current()?.type).toBe("audit");

    // Turn 2: user pivots to create a new project
    recordUserText(
      "Necesito crear un proyecto nuevo, quiero un dashboard de TUI de bitcoin",
    );
    expect(isAuditSession()).toBe(false);
    expect(getTaskScopeManager().current()?.type).toBe("scaffold");
    // The prior audit scope is archived to history
    expect(getTaskScopeManager().history()).toHaveLength(1);
    expect(getTaskScopeManager().history()[0]?.type).toBe("audit");
  });

  test("broadRequest flag is set when the prompt has broad-scope markers", () => {
    recordUserText(
      "crear un proyecto nuevo para analizar completamente la blockchain en tiempo real",
    );
    const scope = getTaskScopeManager().current();
    expect(scope?.broadRequest).toBe(true);
  });

  test("broadRequest flag is false for narrow requests", () => {
    recordUserText("crear un proyecto nuevo de Python");
    const scope = getTaskScopeManager().current();
    expect(scope?.broadRequest).toBe(false);
  });

  test("resetReads() clears both legacy flag and scope", () => {
    recordUserText("auditá el proyecto");
    expect(isAuditSession()).toBe(true);
    resetReads();
    expect(isAuditSession()).toBe(false);
    expect(getTaskScopeManager().current()).toBeNull();
  });

  test("detectAuditIntent still works as a pure predicate (legacy callers)", () => {
    expect(detectAuditIntent("auditá el código")).toBe(true);
    expect(detectAuditIntent("crear un proyecto nuevo")).toBe(false);
  });
});

describe("checkMutationAllowed — unified policy (Phase 2)", () => {
  test("allowed when no scope is active (legacy behavior)", () => {
    const result = checkMutationAllowed("/tmp/foo.py", "Edit");
    expect(result.allowed).toBe(true);
  });

  test("allowed when scope is scaffold (non-audit)", () => {
    recordUserText("crear un proyecto nuevo");
    const result = checkMutationAllowed("/tmp/new-project/app.py", "Write");
    expect(result.allowed).toBe(true);
  });

  test("blocks Edit/Write/GrepReplace/Bash-sed-i consistently when in audit scope", () => {
    recordUserText("auditá el código en /home/curly/SmartSolar");
    const paths = ["/home/curly/SmartSolar/app.py"];
    const kinds = ["Edit", "Write", "MultiEdit", "GrepReplace", "Bash-sed-i"] as const;
    for (const path of paths) {
      for (const kind of kinds) {
        const result = checkMutationAllowed(path, kind);
        // All mutation kinds should produce the same verdict.
        expect(result.allowed).toBe(false);
        expect(result.reason).toBeDefined();
        expect(result.reason).toContain("BLOCKED");
        expect(result.reason).toContain(kind);
      }
    }
  });

  test("allows non-source-file mutation even in audit scope (e.g. AUDIT_REPORT.md)", () => {
    recordUserText("auditá el código");
    // .md is not in SOURCE_EXTS
    const result = checkMutationAllowed("/tmp/AUDIT_REPORT.md", "Write");
    expect(result.allowed).toBe(true);
  });

  test("decorated reason identifies the mutation tool that attempted bypass", () => {
    recordUserText("audita /tmp/app.py");
    const result = checkMutationAllowed("/tmp/app.py", "GrepReplace");
    expect(result.reason).toContain("via GrepReplace");
  });
});
