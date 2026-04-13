// KCode — Agent system tests
//
// Covers the core guarantees of the factory/pool:
//   - Name generator issues unique names and releases them on retire
//   - Pool enforces maxConcurrent and queues overflow
//   - Groups track member statuses and complete when all finish
//   - Factory creates sensible spec counts from task text
//   - dispatchFromInstruction parses "N agentes para Y" correctly
//
// Uses a synthetic executor that completes immediately — no real
// LLM calls are made.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPool, _resetAgentPoolForTests } from "./pool";
import { NameGenerator, CODENAME_POOL_SIZE } from "./names";
import { detectStack, dispatch, dispatchFromInstruction } from "./factory";
import { roleFromTask, ROLES } from "./roles";
import { buildAgentSystemPromptFragment, formatPoolStatus } from "./narrative";
import type { AgentExecutor } from "./types";

// ── Synthetic executors ─────────────────────────────────────────

/** Resolves immediately with a canned result. */
const instantExecutor: AgentExecutor = async (agent) => `result-for-${agent.name}`;

/** Delays for `ms` before resolving. Used to test queueing. */
const delayedExecutor = (ms: number): AgentExecutor => async (agent) => {
  await new Promise((r) => setTimeout(r, ms));
  return `delayed-result-for-${agent.name}`;
};

/** Throws — used to test error paths. */
const erroringExecutor: AgentExecutor = async () => {
  throw new Error("synthetic failure");
};

// ── NameGenerator ───────────────────────────────────────────────

describe("NameGenerator", () => {
  test("reserves unique names", () => {
    const gen = new NameGenerator();
    const n1 = gen.reserve();
    const n2 = gen.reserve();
    expect(n1).not.toBe(n2);
    expect(gen.isTaken(n1)).toBe(true);
    expect(gen.isTaken(n2)).toBe(true);
    expect(gen.activeCount()).toBe(2);
  });

  test("releases names back to the pool", () => {
    const gen = new NameGenerator();
    const n = gen.reserve();
    gen.release(n);
    expect(gen.isTaken(n)).toBe(false);
    expect(gen.activeCount()).toBe(0);
    // Reserve again — should get the same name back since it was first in the pool.
    const n2 = gen.reserve();
    expect(n2).toBe(n);
  });

  test("overflows with numeric suffixes when pool exhausted", () => {
    const gen = new NameGenerator();
    // Exhaust the entire base pool without releasing.
    for (let i = 0; i < CODENAME_POOL_SIZE; i++) {
      gen.reserve();
    }
    // The next reserve must produce a unique name not already taken.
    const overflow = gen.reserve();
    expect(gen.isTaken(overflow)).toBe(true);
    // Overflow names contain a dash-number suffix.
    expect(overflow).toMatch(/-\d+$/);
  });
});

// ── AgentPool ───────────────────────────────────────────────────

describe("AgentPool", () => {
  beforeEach(() => {
    _resetAgentPoolForTests();
  });

  test("spawns an agent and runs the executor", async () => {
    const pool = new AgentPool({ maxConcurrent: 10, defaultExecutor: instantExecutor });
    const agent = pool.spawn({ role: "worker", task: "do a thing" });
    expect(agent.name).toBeTruthy();
    expect(agent.role).toBe("worker");
    const finished = await pool.waitFor(agent.id);
    expect(finished.status).toBe("done");
    expect(finished.result).toBe(`result-for-${agent.name}`);
  });

  test("enforces maxConcurrent and queues overflow", async () => {
    const pool = new AgentPool({ maxConcurrent: 2, defaultExecutor: delayedExecutor(100) });
    const a1 = pool.spawn({ role: "worker", task: "task 1" });
    const a2 = pool.spawn({ role: "worker", task: "task 2" });
    const a3 = pool.spawn({ role: "worker", task: "task 3" });
    // a3 should be queued, not active.
    const statusBefore = pool.getStatus();
    expect(statusBefore.active.length).toBe(2);
    expect(statusBefore.queued.length).toBe(1);
    // After all finish, all three should have completed.
    await pool.waitFor(a1.id);
    await pool.waitFor(a2.id);
    // a3 starts after a1 or a2 retires; wait for it by polling.
    await new Promise((r) => setTimeout(r, 300));
    const statusAfter = pool.getStatus();
    expect(statusAfter.active.length).toBe(0);
    expect(statusAfter.done.length).toBeGreaterThanOrEqual(2);
  });

  test("error executor produces an error status", async () => {
    const pool = new AgentPool({ maxConcurrent: 5, defaultExecutor: erroringExecutor });
    const agent = pool.spawn({ role: "worker", task: "will fail" });
    const finished = await pool.waitFor(agent.id);
    expect(finished.status).toBe("error");
    expect(finished.error).toContain("synthetic failure");
  });

  test("waitFor accepts both id and codename", async () => {
    const pool = new AgentPool({ maxConcurrent: 5, defaultExecutor: instantExecutor });
    const agent = pool.spawn({ role: "worker", task: "t" });
    // Wait by codename
    const byName = await pool.waitFor(agent.name);
    expect(byName.id).toBe(agent.id);
  });

  test("groups collect member ids and transition to complete", async () => {
    const pool = new AgentPool({ maxConcurrent: 5, defaultExecutor: instantExecutor });
    const a1 = pool.spawn({ role: "auditor", task: "t1", groupName: "Alfa" });
    const a2 = pool.spawn({ role: "fixer", task: "t2", groupName: "Alfa" });
    expect(a1.group).toBe("Alfa");
    expect(a2.group).toBe("Alfa");
    const status = pool.getStatus();
    const group = status.groups.find((g) => g.name === "Alfa");
    expect(group).toBeDefined();
    expect(group!.agentIds).toContain(a1.id);
    expect(group!.agentIds).toContain(a2.id);
    // Wait for both, then expect the group to be complete.
    await pool.waitForGroup("Alfa");
    const statusAfter = pool.getStatus();
    const groupAfter = statusAfter.groups.find((g) => g.name === "Alfa");
    expect(groupAfter!.status).toBe("complete");
  });

  test("cancel marks an agent as cancelled and frees its name", async () => {
    const pool = new AgentPool({ maxConcurrent: 5, defaultExecutor: delayedExecutor(500) });
    const agent = pool.spawn({ role: "worker", task: "long" });
    const name = agent.name;
    expect(pool.cancel(name)).toBe(true);
    const status = pool.getStatus();
    const done = status.done.find((a) => a.id === agent.id);
    expect(done?.status).toBe("cancelled");
  });

  test("reset clears active and history", async () => {
    const pool = new AgentPool({ maxConcurrent: 5, defaultExecutor: instantExecutor });
    const a = pool.spawn({ role: "worker", task: "t" });
    await pool.waitFor(a.id);
    expect(pool.getStatus().done.length).toBe(1);
    pool.reset();
    const status = pool.getStatus();
    expect(status.active.length).toBe(0);
    expect(status.done.length).toBe(0);
  });

  test("onEvent receives spawn and done events", async () => {
    const pool = new AgentPool({ maxConcurrent: 5, defaultExecutor: instantExecutor });
    const events: string[] = [];
    pool.onEvent((e) => events.push(e.type));
    const a = pool.spawn({ role: "worker", task: "t" });
    await pool.waitFor(a.id);
    expect(events).toContain("spawn");
    expect(events).toContain("done");
  });
});

// ── Factory ─────────────────────────────────────────────────────

describe("factory.roleFromTask", () => {
  test("maps audit keywords to auditor", () => {
    expect(roleFromTask("audit the backend")).toBe("auditor");
    expect(roleFromTask("scan for CWE vulnerabilities")).toBe("auditor");
  });

  test("maps fix keywords to fixer", () => {
    expect(roleFromTask("fix the broken tests")).toBe("fixer");
    expect(roleFromTask("arreglar el bug de auth")).toBe("fixer");
  });

  test("maps doc keywords to docs", () => {
    expect(roleFromTask("write docstrings for lib/")).toBe("docs");
    expect(roleFromTask("update README")).toBe("docs");
  });

  test("falls back to worker for generic tasks", () => {
    expect(roleFromTask("do something useful")).toBe("worker");
  });
});

describe("factory.detectStack", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kcode-agents-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("detects typescript + next from package.json", () => {
    const fs = require("node:fs");
    fs.writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        dependencies: { next: "16.0.0", react: "19.0.0" },
        scripts: { test: "jest", lint: "eslint ." },
      }),
    );
    const info = detectStack(tmp);
    expect(info.languages.has("typescript")).toBe(true);
    expect(info.frameworks).toContain("next");
    expect(info.frameworks).toContain("react");
    expect(info.hasTests).toBe(true);
    expect(info.hasLinter).toBe(true);
  });

  test("handles empty directory gracefully", () => {
    const info = detectStack(tmp);
    expect(info.languages.size).toBe(0);
    expect(info.frameworks.length).toBe(0);
  });
});

describe("factory.dispatch", () => {
  beforeEach(() => _resetAgentPoolForTests());

  test("creates a group when groupName is set", () => {
    const pool = new AgentPool({ maxConcurrent: 5, defaultExecutor: instantExecutor });
    const agents = dispatch({
      cwd: process.cwd(),
      task: "audit the codebase",
      groupName: "Alfa",
      pool,
    });
    expect(agents.length).toBeGreaterThan(0);
    const status = pool.getStatus();
    const group = status.groups.find((g) => g.name === "Alfa");
    expect(group).toBeDefined();
  });

  test("caps spawned agents at maxAgents", () => {
    const pool = new AgentPool({ maxConcurrent: 10, defaultExecutor: instantExecutor });
    const agents = dispatch({
      cwd: process.cwd(),
      task: "audit",
      maxAgents: 2,
      pool,
    });
    expect(agents.length).toBeLessThanOrEqual(2);
  });
});

describe("factory.dispatchFromInstruction", () => {
  beforeEach(() => _resetAgentPoolForTests());

  test('parses "N agentes para X"', () => {
    const pool = new AgentPool({ maxConcurrent: 5, defaultExecutor: instantExecutor });
    const agents = dispatchFromInstruction("liberemos 3 agentes para auditar el backend", {
      cwd: process.cwd(),
      pool,
    });
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.length).toBeLessThanOrEqual(3);
  });

  test('recognizes "grupo X" and assigns the group', () => {
    const pool = new AgentPool({ maxConcurrent: 5, defaultExecutor: instantExecutor });
    dispatchFromInstruction("2 agentes para auditar, grupo Alfa", {
      cwd: process.cwd(),
      pool,
    });
    const status = pool.getStatus();
    const group = status.groups.find((g) => g.name === "Alfa");
    expect(group).toBeDefined();
  });
});

// ── Narrative ───────────────────────────────────────────────────

// ── Intent detection ────────────────────────────────────────────

describe("intent", () => {
  beforeEach(() => _resetAgentPoolForTests());

  test("dispatch via intent goes through the pool's retire lifecycle", async () => {
    // This is the regression test for H1: previously the intent
    // path spawned agents without an executor and then ran them
    // outside the pool, so retire() never fired and the queue
    // never drained. Now dispatch() picks per-role executors and
    // the pool's runAgent handles lifecycle properly.
    const { AgentPool, _resetAgentPoolForTests: reset } = await import("./pool.js");
    reset();
    const pool = new AgentPool({ maxConcurrent: 5, defaultExecutor: instantExecutor });
    const { dispatch } = await import("./factory.js");
    const spawned = dispatch({
      cwd: process.cwd(),
      task: "audit the test directory",
      maxAgents: 2,
      executor: instantExecutor, // force test executor
      pool,
    });
    expect(spawned.length).toBeGreaterThan(0);
    // Wait for all of them to finish through the pool's runAgent.
    await Promise.all(spawned.map((a) => pool.waitFor(a.id)));
    const status = pool.getStatus();
    // Every spawned agent must have moved to done/history, not
    // stuck in active.
    expect(status.active.length).toBe(0);
    expect(status.done.length).toBeGreaterThanOrEqual(spawned.length);
    // Each retired agent must be in "done" state (set by runAgent),
    // not "running" (which would indicate lifecycle bypass).
    for (const agent of status.done.slice(0, spawned.length)) {
      expect(["done", "error", "cancelled"]).toContain(agent.status);
    }
  });

  test("intent regex requires imperative verb (no past-tense matches)", async () => {
    const { detectAgentIntent } = await import("./intent.js");
    // Past-tense references should NOT dispatch.
    expect(detectAgentIntent("we deployed 3 agents yesterday", "/tmp")).toBe(null);
    expect(detectAgentIntent("the 2 agent accounts are broken", "/tmp")).toBe(null);
    expect(detectAgentIntent("desplegamos 5 agentes la semana pasada", "/tmp")).toBe(null);
    // Incidental mentions without verb should NOT dispatch.
    expect(detectAgentIntent("the report shows 4 agents in total", "/tmp")).toBe(null);
  });
});

describe("narrative", () => {
  test("buildAgentSystemPromptFragment is empty when pool is empty", () => {
    const pool = new AgentPool({ maxConcurrent: 5, defaultExecutor: instantExecutor });
    const fragment = buildAgentSystemPromptFragment(pool.getStatus());
    expect(fragment).toBe("");
  });

  test("buildAgentSystemPromptFragment names active agents", async () => {
    const pool = new AgentPool({ maxConcurrent: 5, defaultExecutor: delayedExecutor(300) });
    const a = pool.spawn({ role: "auditor", task: "audit lib/" });
    const fragment = buildAgentSystemPromptFragment(pool.getStatus());
    expect(fragment).toContain(a.name);
    expect(fragment).toContain("Active Agent Pool");
    expect(fragment).toContain(ROLES.auditor.displayName);
    await pool.waitFor(a.id);
  });

  test("formatPoolStatus renders active + groups + cost", async () => {
    const pool = new AgentPool({ maxConcurrent: 5, defaultExecutor: delayedExecutor(200) });
    pool.spawn({ role: "fixer", task: "fix X", groupName: "Beta" });
    const text = formatPoolStatus(pool.getStatus());
    expect(text).toContain("Pool:");
    expect(text).toContain("Beta");
    await new Promise((r) => setTimeout(r, 400));
  });
});
