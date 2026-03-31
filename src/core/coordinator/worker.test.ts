import { test, expect, describe } from "bun:test";
import {
  getWorkerTools,
  WORKER_TOOLS,
  COORDINATOR_ONLY_TOOLS,
  buildWorkerPrompt,
  buildWorkerArgs,
  buildWorkerEnv,
  createWorkerHandle,
} from "./worker";
import type { WorkerConfig, WorkerSpawnConfig } from "./types";

function makeWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    id: "w1",
    mode: "simple",
    task: "Fix the bug in auth.ts",
    ...overrides,
  };
}

function makeSpawnConfig(overrides: Partial<WorkerSpawnConfig> = {}): WorkerSpawnConfig {
  return {
    id: "w1",
    mode: "simple",
    task: "Fix the bug",
    allowedTools: ["Bash", "Read", "Edit"],
    scratchpadDir: "/tmp/scratchpad",
    messageBusDir: "/tmp/scratchpad/.messages",
    coordinatorId: "coordinator",
    ...overrides,
  };
}

describe("Worker Tool Restrictions", () => {
  // ─── Simple Mode Tools ──────────────────────────────────────

  test("simple mode returns basic tool set", () => {
    const tools = getWorkerTools(makeWorkerConfig({ mode: "simple" }));
    expect(tools).toEqual(WORKER_TOOLS.simple);
    expect(tools).toContain("Bash");
    expect(tools).toContain("Read");
    expect(tools).toContain("Edit");
    expect(tools).toContain("Write");
    expect(tools).toContain("Glob");
    expect(tools).toContain("Grep");
  });

  test("simple mode does NOT include complex-only tools", () => {
    const tools = getWorkerTools(makeWorkerConfig({ mode: "simple" }));
    expect(tools).not.toContain("GrepReplace");
    expect(tools).not.toContain("GitCommit");
    expect(tools).not.toContain("TestRunner");
  });

  // ─── Complex Mode Tools ─────────────────────────────────────

  test("complex mode returns extended tool set", () => {
    const tools = getWorkerTools(makeWorkerConfig({ mode: "complex" }));
    expect(tools).toEqual(WORKER_TOOLS.complex);
    expect(tools).toContain("GrepReplace");
    expect(tools).toContain("GitStatus");
    expect(tools).toContain("GitCommit");
    expect(tools).toContain("TestRunner");
  });

  // ─── Coordinator-Only Tools Never Assigned ──────────────────

  test("COORDINATOR_ONLY_TOOLS are never assigned to simple workers", () => {
    const tools = getWorkerTools(makeWorkerConfig({ mode: "simple" }));
    for (const t of COORDINATOR_ONLY_TOOLS) {
      expect(tools).not.toContain(t);
    }
  });

  test("COORDINATOR_ONLY_TOOLS are never assigned to complex workers", () => {
    const tools = getWorkerTools(makeWorkerConfig({ mode: "complex" }));
    for (const t of COORDINATOR_ONLY_TOOLS) {
      expect(tools).not.toContain(t);
    }
  });

  test("COORDINATOR_ONLY_TOOLS are blocked even via extraTools", () => {
    const tools = getWorkerTools(makeWorkerConfig({
      mode: "simple",
      extraTools: ["Agent", "SendMessage", "Skill", "Plan", "TestRunner"],
    }));
    expect(tools).not.toContain("Agent");
    expect(tools).not.toContain("SendMessage");
    expect(tools).not.toContain("Skill");
    expect(tools).not.toContain("Plan");
    // But TestRunner should be added
    expect(tools).toContain("TestRunner");
  });

  // ─── Extra Tools ────────────────────────────────────────────

  test("extraTools are added to the tool list", () => {
    const tools = getWorkerTools(makeWorkerConfig({
      mode: "simple",
      extraTools: ["DiffViewer", "Rename"],
    }));
    expect(tools).toContain("DiffViewer");
    expect(tools).toContain("Rename");
  });

  test("extraTools are deduplicated", () => {
    const tools = getWorkerTools(makeWorkerConfig({
      mode: "simple",
      extraTools: ["Bash", "Read"], // Already in simple mode
    }));
    const bashCount = tools.filter(t => t === "Bash").length;
    expect(bashCount).toBe(1);
  });

  // ─── Blocked Tools ──────────────────────────────────────────

  test("blockedTools are removed from the final list", () => {
    const tools = getWorkerTools(makeWorkerConfig({
      mode: "simple",
      blockedTools: ["Bash"],
    }));
    expect(tools).not.toContain("Bash");
    // Other tools remain
    expect(tools).toContain("Read");
    expect(tools).toContain("Edit");
  });

  test("blockedTools and extraTools interact correctly", () => {
    const tools = getWorkerTools(makeWorkerConfig({
      mode: "simple",
      extraTools: ["TestRunner"],
      blockedTools: ["TestRunner", "Bash"],
    }));
    expect(tools).not.toContain("TestRunner");
    expect(tools).not.toContain("Bash");
  });

  // ─── MCP Tools ──────────────────────────────────────────────

  test("MCP tools are added in complex mode", () => {
    const tools = getWorkerTools(
      makeWorkerConfig({ mode: "complex" }),
      ["mcp__server__tool1", "mcp__server__tool2"],
    );
    expect(tools).toContain("mcp__server__tool1");
    expect(tools).toContain("mcp__server__tool2");
  });

  test("MCP tools are NOT added in simple mode", () => {
    const tools = getWorkerTools(
      makeWorkerConfig({ mode: "simple" }),
      ["mcp__server__tool1"],
    );
    expect(tools).not.toContain("mcp__server__tool1");
  });

  test("MCP tools that match coordinator-only names are excluded", () => {
    const tools = getWorkerTools(
      makeWorkerConfig({ mode: "complex" }),
      ["Agent", "custom_tool"],
    );
    expect(tools).not.toContain("Agent");
    expect(tools).toContain("custom_tool");
  });

  // ─── Deduplication ──────────────────────────────────────────

  test("result list has no duplicates", () => {
    const tools = getWorkerTools(
      makeWorkerConfig({
        mode: "complex",
        extraTools: ["Bash", "Read", "GrepReplace"],
      }),
      ["Bash"],
    );
    const unique = new Set(tools);
    expect(tools.length).toBe(unique.size);
  });
});

describe("buildWorkerPrompt", () => {
  test("includes task and scratchpad instructions", () => {
    const prompt = buildWorkerPrompt(makeSpawnConfig({ task: "Fix auth bug" }));
    expect(prompt).toContain("Fix auth bug");
    expect(prompt).toContain("Scratchpad");
    expect(prompt).toContain("/tmp/scratchpad");
    expect(prompt).toContain("worker-w1.md");
  });

  test("includes allowed tools list", () => {
    const prompt = buildWorkerPrompt(makeSpawnConfig({
      allowedTools: ["Bash", "Read", "Edit"],
    }));
    expect(prompt).toContain("Bash, Read, Edit");
  });

  test("includes focus files when provided", () => {
    const prompt = buildWorkerPrompt(makeSpawnConfig({
      files: ["src/auth.ts", "src/auth.test.ts"],
    }));
    expect(prompt).toContain("Focus Files");
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("src/auth.test.ts");
  });

  test("omits focus files section when no files", () => {
    const prompt = buildWorkerPrompt(makeSpawnConfig({ files: undefined }));
    expect(prompt).not.toContain("Focus Files");
  });
});

describe("buildWorkerArgs", () => {
  test("includes basic flags", () => {
    const args = buildWorkerArgs(makeSpawnConfig());
    expect(args).toContain("--print");
    expect(args).toContain("--permission");
    expect(args).toContain("deny");
    expect(args).toContain("--allowed-tools");
  });

  test("includes model flag when set", () => {
    const args = buildWorkerArgs(makeSpawnConfig({ model: "qwen2.5-coder" }));
    expect(args).toContain("-m");
    expect(args).toContain("qwen2.5-coder");
  });

  test("omits model flag when not set", () => {
    const args = buildWorkerArgs(makeSpawnConfig({ model: undefined }));
    expect(args).not.toContain("-m");
  });
});

describe("buildWorkerEnv", () => {
  test("sets coordinator mode env vars", () => {
    const env = buildWorkerEnv(makeSpawnConfig({ id: "w1" }));
    expect(env.KCODE_WORKER_ID).toBe("w1");
    expect(env.KCODE_COORDINATOR_MODE).toBe("worker");
    expect(env.KCODE_SCRATCHPAD_DIR).toBe("/tmp/scratchpad");
    expect(env.KCODE_MESSAGE_BUS_DIR).toBe("/tmp/scratchpad/.messages");
  });

  test("inherits process.env", () => {
    const env = buildWorkerEnv(makeSpawnConfig());
    expect(env.PATH).toBeDefined();
  });
});

describe("createWorkerHandle", () => {
  test("creates a handle with running status", () => {
    const handle = createWorkerHandle(makeSpawnConfig({ id: "w42" }));
    expect(handle.id).toBe("w42");
    expect(handle.status).toBe("running");
    expect(handle.process).toBeNull();
    expect(handle.startedAt).toBeGreaterThan(0);
  });
});
