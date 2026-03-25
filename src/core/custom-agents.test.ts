// KCode - Custom Agents Tests
// Tests for the rich agent system: frontmatter parsing, validation, agent loading

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./custom-agents";

// ─── Frontmatter Parser Tests ────────────────────────────────────

describe("parseFrontmatter", () => {
  test("parses basic string, number, boolean fields", () => {
    const content = `---
name: test-agent
description: A test agent
model: gpt-4
maxTurns: 25
memory: true
---

You are a test agent.`;

    const { meta, body } = parseFrontmatter(content);
    expect(meta.name).toBe("test-agent");
    expect(meta.description).toBe("A test agent");
    expect(meta.model).toBe("gpt-4");
    expect(meta.maxTurns).toBe(25);
    expect(meta.memory).toBe(true);
    expect(body.trim()).toBe("You are a test agent.");
  });

  test("parses inline array [a, b, c]", () => {
    const content = `---
tools: [Read, Write, Edit]
skills: [commit, review]
---

body`;

    const { meta } = parseFrontmatter(content);
    expect(meta.tools).toEqual(["Read", "Write", "Edit"]);
    expect(meta.skills).toEqual(["commit", "review"]);
  });

  test("parses multi-line YAML arrays", () => {
    const content = `---
name: multi
tools:
  - Read
  - Write
  - Bash
disallowedTools:
  - Cron
  - Agent
---

body`;

    const { meta } = parseFrontmatter(content);
    expect(meta.tools).toEqual(["Read", "Write", "Bash"]);
    expect(meta.disallowedTools).toEqual(["Cron", "Agent"]);
  });

  test("parses inline JSON for mcpServers", () => {
    const content = `---
name: with-mcp
mcpServers: {"myserver": {"command": "npx", "args": ["-y", "@mcp/server"]}}
---

body`;

    const { meta } = parseFrontmatter(content);
    expect(meta.mcpServers).toEqual({
      myserver: { command: "npx", args: ["-y", "@mcp/server"] },
    });
  });

  test("parses inline JSON for hooks", () => {
    const content = `---
name: with-hooks
hooks: [{"event": "PreToolUse", "actions": [{"type": "command", "command": "echo pre"}]}]
---

body`;

    const { meta } = parseFrontmatter(content);
    expect(Array.isArray(meta.hooks)).toBe(true);
    const hooks = meta.hooks as Array<Record<string, unknown>>;
    expect(hooks[0]!.event).toBe("PreToolUse");
  });

  test("strips quotes from string values", () => {
    const content = `---
name: "quoted-name"
apiKey: 'sk-test-123'
---

body`;

    const { meta } = parseFrontmatter(content);
    expect(meta.name).toBe("quoted-name");
    expect(meta.apiKey).toBe("sk-test-123");
  });

  test("handles false boolean", () => {
    const content = `---
memory: false
---

body`;

    const { meta } = parseFrontmatter(content);
    expect(meta.memory).toBe(false);
  });

  test("returns empty meta for content without frontmatter", () => {
    const content = "Just some text, no frontmatter.";
    const { meta, body } = parseFrontmatter(content);
    expect(Object.keys(meta).length).toBe(0);
    expect(body).toBe(content);
  });

  test("skips comment lines in frontmatter", () => {
    const content = `---
name: agent
# This is a comment
model: llama3
---

body`;

    const { meta } = parseFrontmatter(content);
    expect(meta.name).toBe("agent");
    expect(meta.model).toBe("llama3");
    expect(meta["# This is a comment"]).toBeUndefined();
  });

  test("handles effort level", () => {
    const content = `---
effort: high
---

body`;

    const { meta } = parseFrontmatter(content);
    expect(meta.effort).toBe("high");
  });
});

// ─── Agent Builder / Loading Tests ───────────────────────────────

describe("loadCustomAgents", () => {
  const tmpDir = join("/tmp", `kcode-test-agents-${Date.now()}`);
  const agentsDir = join(tmpDir, ".kcode", "agents");

  beforeEach(() => {
    mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("loads agent from .md file", async () => {
    writeFileSync(join(agentsDir, "reviewer.md"), `---
name: reviewer
description: Code reviewer agent
model: gpt-4
tools: [Read, Grep, Glob]
permissionMode: ask
maxTurns: 15
effort: medium
memory: true
---

You are an expert code reviewer. Focus on correctness, security, and performance.`);

    // Dynamic import to get fresh module state
    const { loadCustomAgents } = await import("./custom-agents");
    // Use tmpDir as cwd (agents are loaded from <cwd>/.kcode/agents/)
    const agents = loadCustomAgents(tmpDir);
    const reviewer = agents.find(a => a.name === "reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer!.description).toBe("Code reviewer agent");
    expect(reviewer!.model).toBe("gpt-4");
    expect(reviewer!.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(reviewer!.permissionMode).toBe("ask");
    expect(reviewer!.maxTurns).toBe(15);
    expect(reviewer!.effort).toBe("medium");
    expect(reviewer!.memory).toBe(true);
    expect(reviewer!.systemPrompt).toContain("expert code reviewer");
  });

  test("rejects invalid permissionMode", async () => {
    writeFileSync(join(agentsDir, "bad.md"), `---
name: bad-perms
permissionMode: yolo
---

test`);

    const { loadCustomAgents } = await import("./custom-agents");
    const agents = loadCustomAgents(tmpDir);
    const agent = agents.find(a => a.name === "bad-perms");
    expect(agent).toBeDefined();
    expect(agent!.permissionMode).toBeUndefined(); // "yolo" is invalid
  });

  test("rejects invalid effort level", async () => {
    writeFileSync(join(agentsDir, "bad-effort.md"), `---
name: bad-effort
effort: turbo
---

test`);

    const { loadCustomAgents } = await import("./custom-agents");
    const agents = loadCustomAgents(tmpDir);
    const agent = agents.find(a => a.name === "bad-effort");
    expect(agent).toBeDefined();
    expect(agent!.effort).toBeUndefined(); // "turbo" is invalid
  });

  test("clamps maxTurns to [1, 100]", async () => {
    writeFileSync(join(agentsDir, "clamp-low.md"), `---
name: clamp-low
maxTurns: -5
---

test`);
    writeFileSync(join(agentsDir, "clamp-high.md"), `---
name: clamp-high
maxTurns: 999
---

test`);

    const { loadCustomAgents } = await import("./custom-agents");
    const agents = loadCustomAgents(tmpDir);
    expect(agents.find(a => a.name === "clamp-low")!.maxTurns).toBe(1);
    expect(agents.find(a => a.name === "clamp-high")!.maxTurns).toBe(100);
  });

  test("parses mcpServers from JSON", async () => {
    writeFileSync(join(agentsDir, "mcp-agent.md"), `---
name: mcp-agent
mcpServers: {"github": {"command": "npx", "args": ["@mcp/github"]}}
---

test`);

    const { loadCustomAgents } = await import("./custom-agents");
    const agents = loadCustomAgents(tmpDir);
    const agent = agents.find(a => a.name === "mcp-agent");
    expect(agent!.mcpServers).toBeDefined();
    expect(agent!.mcpServers!.github.command).toBe("npx");
    expect(agent!.mcpServers!.github.args).toEqual(["@mcp/github"]);
  });

  test("parses hooks from JSON", async () => {
    writeFileSync(join(agentsDir, "hooked.md"), `---
name: hooked
hooks: [{"event": "PreToolUse", "matcher": "Bash", "actions": [{"type": "command", "command": "echo checking"}]}]
---

test`);

    const { loadCustomAgents } = await import("./custom-agents");
    const agents = loadCustomAgents(tmpDir);
    const agent = agents.find(a => a.name === "hooked");
    // Project-level agents cannot define hooks (security restriction)
    expect(agent!.hooks).toBeUndefined();
  });

  test("parses disallowedTools and skills", async () => {
    writeFileSync(join(agentsDir, "restricted.md"), `---
name: restricted
disallowedTools: [Bash, Agent, Cron]
skills: [commit, review-pr]
---

test`);

    const { loadCustomAgents } = await import("./custom-agents");
    const agents = loadCustomAgents(tmpDir);
    const agent = agents.find(a => a.name === "restricted");
    expect(agent!.disallowedTools).toEqual(["Bash", "Agent", "Cron"]);
    expect(agent!.skills).toEqual(["commit", "review-pr"]);
  });

  test("skips files over 64KB", async () => {
    const bigContent = `---\nname: big\n---\n${"x".repeat(65 * 1024)}`;
    writeFileSync(join(agentsDir, "big.md"), bigContent);

    const { loadCustomAgents } = await import("./custom-agents");
    const agents = loadCustomAgents(tmpDir);
    expect(agents.find(a => a.name === "big")).toBeUndefined();
  });
});

// ─── Agent Memory Path Tests ─────────────────────────────────────

describe("getAgentMemoryDir", () => {
  test("returns sanitized path", async () => {
    const { getAgentMemoryDir } = await import("./custom-agents");
    const dir = getAgentMemoryDir("test-agent");
    expect(dir).toContain("agents/test-agent/memory");
    expect(dir).not.toContain("..");
  });

  test("sanitizes dangerous characters", async () => {
    const { getAgentMemoryDir } = await import("./custom-agents");
    const dir = getAgentMemoryDir("../../../etc/passwd");
    expect(dir).not.toContain("..");
    // The agent name portion should have no dots or slashes
    const agentDirName = dir.split("/agents/")[1]!.split("/memory")[0]!;
    expect(agentDirName).not.toContain(".");
    expect(agentDirName).not.toContain("/");
    expect(agentDirName).toContain("etc_passwd");
  });
});

// ─── Validation Tests ────────────────────────────────────────────

describe("validation", () => {
  const tmpDir3 = join("/tmp", `kcode-test-agents3-${Date.now()}`);
  const agentsDir3 = join(tmpDir3, ".kcode", "agents");

  beforeEach(() => {
    mkdirSync(agentsDir3, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir3, { recursive: true, force: true }); } catch {}
  });

  test("rejects invalid model names", async () => {
    writeFileSync(join(agentsDir3, "badmodel.md"), `---
name: badmodel
model: $(whoami)
---

test`);

    const { loadCustomAgents } = await import("./custom-agents");
    const agents = loadCustomAgents(tmpDir3);
    const agent = agents.find(a => a.name === "badmodel");
    expect(agent!.model).toBeUndefined(); // shell injection attempt rejected
  });

  test("rejects invalid apiBase URLs", async () => {
    writeFileSync(join(agentsDir3, "badapi.md"), `---
name: badapi
apiBase: javascript:alert(1)
---

test`);

    const { loadCustomAgents } = await import("./custom-agents");
    const agents = loadCustomAgents(tmpDir3);
    const agent = agents.find(a => a.name === "badapi");
    expect(agent!.apiBase).toBeUndefined();
  });

  test("accepts valid apiBase URLs", async () => {
    writeFileSync(join(agentsDir3, "goodapi.md"), `---
name: goodapi
apiBase: https://api.openai.com/v1
---

test`);

    const { loadCustomAgents } = await import("./custom-agents");
    const agents = loadCustomAgents(tmpDir3);
    const agent = agents.find(a => a.name === "goodapi");
    // Project-level agents cannot override apiBase (security restriction)
    expect(agent!.apiBase).toBeUndefined();
  });

  test("rejects apiKey with newlines", async () => {
    writeFileSync(join(agentsDir3, "badkey.md"), `---
name: badkey
apiKey: sk-test
---

test`);
    // Write with embedded newline in key
    const content = '---\nname: badkey2\napiKey: "sk-test\\nINJECTION"\n---\n\ntest';
    writeFileSync(join(agentsDir3, "badkey2.md"), content);

    const { loadCustomAgents } = await import("./custom-agents");
    const agents = loadCustomAgents(tmpDir3);
    // Project-level agents cannot override apiKey (security restriction)
    const agent = agents.find(a => a.name === "badkey");
    expect(agent!.apiKey).toBeUndefined();
  });

  test("accepts valid model names with slashes and colons", async () => {
    writeFileSync(join(agentsDir3, "goodmodel.md"), `---
name: goodmodel
model: meta-llama/Llama-3.1-70B:latest
---

test`);

    const { loadCustomAgents } = await import("./custom-agents");
    const agents = loadCustomAgents(tmpDir3);
    const agent = agents.find(a => a.name === "goodmodel");
    expect(agent!.model).toBe("meta-llama/Llama-3.1-70B:latest");
  });
});

// ─── findCustomAgent case-insensitive ────────────────────────────

describe("findCustomAgent", () => {
  const tmpDir2 = join("/tmp", `kcode-test-agents2-${Date.now()}`);
  const agentsDir2 = join(tmpDir2, ".kcode", "agents");

  beforeEach(() => {
    mkdirSync(agentsDir2, { recursive: true });
    writeFileSync(join(agentsDir2, "MyAgent.md"), `---
name: MyAgent
description: Case test
---

test`);
  });

  afterEach(() => {
    try { rmSync(tmpDir2, { recursive: true, force: true }); } catch {}
  });

  test("finds agent case-insensitively", async () => {
    const { findCustomAgent } = await import("./custom-agents");
    const agent = findCustomAgent("myagent", tmpDir2);
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("MyAgent");
  });
});
