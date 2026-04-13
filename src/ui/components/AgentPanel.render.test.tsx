// KCode — AgentPanel render tests
//
// Verifies the component hides when the pool is empty and renders
// live agents when the pool has spawned some. Uses ink-testing-library
// to capture the rendered frame as plain text.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext.js";
import { _resetAgentPoolForTests, getAgentPool } from "../../core/agents/pool.js";
import type { AgentExecutor } from "../../core/agents/types.js";
import AgentPanel from "./AgentPanel.js";

/** Synthetic executor that hangs forever — keeps agents in "running" state. */
const hangingExecutor: AgentExecutor = () => new Promise(() => {});
/** Synthetic executor that resolves immediately. */
const instantExecutor: AgentExecutor = async (agent) => `done-${agent.name}`;

const wrap = (node: React.ReactElement) => (
  <ThemeProvider>{node}</ThemeProvider>
);

describe("AgentPanel", () => {
  beforeEach(() => {
    _resetAgentPoolForTests();
  });

  afterEach(() => {
    _resetAgentPoolForTests();
  });

  test("renders nothing when pool is completely empty", () => {
    const { lastFrame } = render(wrap(<AgentPanel />));
    // Empty frame is empty string or contains no panel text
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Agents");
    expect(frame).not.toContain("active");
  });

  test("renders header with active count when agents are running", () => {
    const pool = getAgentPool({ maxConcurrent: 10, defaultExecutor: hangingExecutor });
    pool.spawn({ role: "auditor", task: "audit backend" });
    const { lastFrame } = render(wrap(<AgentPanel />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Agents");
    expect(frame).toContain("1/10 active");
    expect(frame).toContain("Auditor");
  });

  test("shows the codename assigned by the name generator", () => {
    const pool = getAgentPool({ maxConcurrent: 10, defaultExecutor: hangingExecutor });
    const agent = pool.spawn({ role: "fixer", task: "patch lib/crypto.ts" });
    const { lastFrame } = render(wrap(<AgentPanel />));
    const frame = lastFrame() ?? "";
    // Name must appear (it's curated, so we check that SOME name is present)
    expect(frame).toContain(agent.name);
    expect(frame).toContain("Fixer");
  });

  test("shows group name when agents belong to a group", () => {
    const pool = getAgentPool({ maxConcurrent: 10, defaultExecutor: hangingExecutor });
    pool.spawn({ role: "auditor", task: "t1", groupName: "Alfa" });
    pool.spawn({ role: "security", task: "t2", groupName: "Alfa" });
    const { lastFrame } = render(wrap(<AgentPanel />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Groups:");
    expect(frame).toContain("Alfa");
    expect(frame).toContain("2/10 active");
  });

  test("shows target path when agent has one", () => {
    const pool = getAgentPool({ maxConcurrent: 10, defaultExecutor: hangingExecutor });
    pool.spawn({
      role: "tester",
      task: "run tests",
      targetPath: "tests/unit",
    });
    const { lastFrame } = render(wrap(<AgentPanel />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("tests/unit");
  });

  test("shows done count after an agent completes", async () => {
    const pool = getAgentPool({ maxConcurrent: 10, defaultExecutor: instantExecutor });
    const agent = pool.spawn({ role: "scribe", task: "write changelog" });
    await pool.waitFor(agent.id);
    const { lastFrame } = render(wrap(<AgentPanel />));
    const frame = lastFrame() ?? "";
    // After the agent finishes it moves to history and active count drops.
    // The header should show the done count.
    expect(frame).toContain("done");
  });

  test("shows queue indicator when pool is at capacity", () => {
    const pool = getAgentPool({ maxConcurrent: 2, defaultExecutor: hangingExecutor });
    pool.spawn({ role: "worker", task: "t1" });
    pool.spawn({ role: "worker", task: "t2" });
    pool.spawn({ role: "worker", task: "t3" }); // queued
    pool.spawn({ role: "worker", task: "t4" }); // queued
    const { lastFrame } = render(wrap(<AgentPanel />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("2/2 active");
    expect(frame).toContain("queued");
  });
});
