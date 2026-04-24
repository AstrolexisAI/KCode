// Tests for closeout-renderer turn-mode classification (v2.10.306).

import { describe, expect, it } from "bun:test";
import {
  classifyTurnMode,
  renderCloseoutFromScope,
} from "./closeout-renderer";
import type { TaskScope } from "./task-scope";

function makeScope(overrides: Partial<TaskScope> = {}): TaskScope {
  const base = {
    phase: "partial" as const,
    type: "implement" as const,
    sessionPrompt: "",
    userInstructions: [],
    goals: [],
    subgoals: [],
    projectRoot: { path: "", status: "unknown" as const },
    verification: {
      filesWritten: [],
      filesEdited: [],
      runtimeCommands: [],
      packageManagerOps: [],
      rerunAttempts: 0,
    },
    completion: {
      mayClaimReady: false,
      mayClaimImplemented: false,
      mustUsePartialLanguage: true,
      reasons: ["example reason"],
    },
    reasons: [],
    commitments: [],
    progress: { plannedSteps: [], completedSteps: [], currentStep: undefined },
    secrets: { detected: [] },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
  } as any;
  return { ...base, ...overrides } as TaskScope;
}

describe("classifyTurnMode", () => {
  it("informational when no writes and no runtime", () => {
    expect(classifyTurnMode(makeScope())).toBe("informational");
  });

  it("mutation when files were written but no runtime", () => {
    const scope = makeScope({
      verification: {
        filesWritten: ["/tmp/foo.ts"],
        filesEdited: [],
        runtimeCommands: [],
        packageManagerOps: [],
        rerunAttempts: 0,
        // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      } as any,
    });
    expect(classifyTurnMode(scope)).toBe("mutation");
  });

  it("execution when runtime commands ran but nothing was written", () => {
    const scope = makeScope({
      verification: {
        filesWritten: [],
        filesEdited: [],
        runtimeCommands: [
          // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
          { status: "verified", command: "ls", output: "", exitCode: 0 } as any,
        ],
        packageManagerOps: [],
        rerunAttempts: 0,
        // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      } as any,
    });
    expect(classifyTurnMode(scope)).toBe("execution");
  });

  it("mixed when both writes and runtime", () => {
    const scope = makeScope({
      verification: {
        filesWritten: ["/tmp/a.ts"],
        filesEdited: [],
        runtimeCommands: [
          // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
          { status: "verified", command: "ls", output: "", exitCode: 0 } as any,
        ],
        packageManagerOps: [],
        rerunAttempts: 0,
        // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      } as any,
    });
    expect(classifyTurnMode(scope)).toBe("mixed");
  });
});

describe("renderCloseoutFromScope — informational mode", () => {
  it("does NOT mention scaffold or MVP", () => {
    const scope = makeScope(); // informational
    const out = renderCloseoutFromScope(scope);
    expect(out).not.toBeNull();
    expect(out).not.toContain("scaffold");
    expect(out).not.toContain("MVP");
  });

  it("does NOT render 'Files: none created' bullet for informational turns", () => {
    const scope = makeScope();
    const out = renderCloseoutFromScope(scope)!;
    expect(out).not.toContain("Files: **none created");
  });

  it("does NOT render 'Runtime: not verified' bullet for informational turns", () => {
    const scope = makeScope();
    const out = renderCloseoutFromScope(scope)!;
    expect(out).not.toContain("Runtime: **not verified");
  });

  it("uses informational status language", () => {
    const scope = makeScope();
    const out = renderCloseoutFromScope(scope)!;
    expect(out).toMatch(/Evidence was gathered from external sources/);
    expect(out).toMatch(/references \/ claims were not independently verified/);
  });
});

describe("renderCloseoutFromScope — mutation/execution modes keep scaffold wording", () => {
  it("mutation-mode keeps 'scaffold / MVP' wording", () => {
    const scope = makeScope({
      verification: {
        filesWritten: ["/tmp/app.ts"],
        filesEdited: [],
        runtimeCommands: [],
        packageManagerOps: [],
        rerunAttempts: 0,
        // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      } as any,
    });
    const out = renderCloseoutFromScope(scope)!;
    expect(out).toContain("scaffold");
  });

  it("execution-mode still renders runtime failure / verified bullet", () => {
    const scope = makeScope({
      verification: {
        filesWritten: [],
        filesEdited: [],
        runtimeCommands: [
          // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
          { status: "verified", command: "ls", output: "ok", exitCode: 0 } as any,
        ],
        packageManagerOps: [],
        rerunAttempts: 0,
        // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      } as any,
    });
    const out = renderCloseoutFromScope(scope)!;
    expect(out).toMatch(/Runtime:/);
  });
});
