// KCode - Hooks System Tests
// Tests for hook matching, execution, trust enforcement, and HTTP hooks

import { describe, expect, test } from "bun:test";
import type { HookAction, HookConfig, HookEntry, HookEvent, HookMatcher } from "./hooks";
import { HookManager, isWorkspaceTrusted, setTrustPromptCallback, trustWorkspace } from "./hooks";

// ─── HookEntry Type Tests ─────────────────────────────────────────

describe("HookEntry types", () => {
  test("command hook entry shape", () => {
    const entry: HookEntry = {
      type: "command",
      command: "echo hello",
      timeout: 5000,
    };
    expect(entry.type).toBe("command");
    expect(entry.command).toBe("echo hello");
    expect(entry.timeout).toBe(5000);
  });

  test("prompt hook entry shape", () => {
    const entry: HookEntry = {
      type: "prompt",
      prompt: "Always use TypeScript strict mode",
    };
    expect(entry.type).toBe("prompt");
    expect(entry.prompt).toBe("Always use TypeScript strict mode");
  });

  test("http hook entry shape", () => {
    const entry: HookEntry = {
      type: "http",
      url: "https://hooks.example.com/kcode",
      method: "POST",
      headers: { "X-Custom": "value" },
      auth: "secret-token-123",
      timeout: 5000,
    };
    expect(entry.type).toBe("http");
    expect(entry.url).toBe("https://hooks.example.com/kcode");
    expect(entry.method).toBe("POST");
    expect(entry.headers!["X-Custom"]).toBe("value");
    expect(entry.auth).toBe("secret-token-123");
  });

  test("http hook entry with matcher", () => {
    const entry: HookEntry = {
      type: "http",
      url: "https://audit.example.com/tool-log",
      matcher: { toolName: "Bash" },
    };
    expect(entry.matcher?.toolName).toBe("Bash");
  });
});

// ─── HookAction (legacy) Type Tests ──────────────────────────────

describe("HookAction legacy types", () => {
  test("command action shape", () => {
    const action: HookAction = {
      type: "command",
      command: "jq .tool_name",
      timeout: 30000,
    };
    expect(action.type).toBe("command");
    expect(action.command).toBe("jq .tool_name");
  });

  test("http action shape", () => {
    const action: HookAction = {
      type: "http",
      url: "https://webhook.example.com/notify",
      method: "POST",
      headers: { Authorization: "Bearer token" },
    };
    expect(action.type).toBe("http");
    expect(action.url).toBe("https://webhook.example.com/notify");
    expect(action.method).toBe("POST");
  });
});

// ─── HookMatcher Tests ───────────────────────────────────────────

describe("HookMatcher", () => {
  test("empty matcher matches everything", () => {
    const matcher: HookMatcher = {};
    // Empty matcher should match — tested implicitly by hook execution
    expect(matcher.toolName).toBeUndefined();
  });

  test("toolName glob pattern", () => {
    const matcher: HookMatcher = { toolName: "Bash" };
    expect(matcher.toolName).toBe("Bash");
  });

  test("wildcard tool pattern", () => {
    const matcher: HookMatcher = { toolName: "mcp__*" };
    expect(matcher.toolName).toBe("mcp__*");
  });

  test("arbitrary key-value properties", () => {
    const matcher: HookMatcher = {
      toolName: "Edit",
      file_path: "/src/**",
    };
    expect(matcher.toolName).toBe("Edit");
    expect(matcher.file_path).toBe("/src/**");
  });
});

// ─── HookEvent Type Tests ────────────────────────────────────────

describe("HookEvent types", () => {
  test("all standard events are valid", () => {
    const events: HookEvent[] = [
      "SessionStart",
      "SessionEnd",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PreCompact",
      "PostCompact",
      "UserPromptSubmit",
      "PermissionRequest",
      "Stop",
      "Notification",
      "ConfigChange",
      "InstructionsLoaded",
      "SubagentStart",
      "SubagentStop",
      "TaskCompleted",
      "WorktreeCreate",
      "WorktreeRemove",
      "PreEdit",
      "PostEdit",
      "PreBash",
      "PostBash",
      "PreWrite",
      "PostWrite",
      "ModelSwitch",
      "ContextOverflow",
      "TaskComplete",
      "ErrorRecovery",
    ];
    expect(events.length).toBe(28);
    // All should be strings
    for (const event of events) {
      expect(typeof event).toBe("string");
    }
  });

  test("SubagentStart and SubagentStop are valid events", () => {
    const start: HookEvent = "SubagentStart";
    const stop: HookEvent = "SubagentStop";
    expect(start).toBe("SubagentStart");
    expect(stop).toBe("SubagentStop");
  });
});

// ─── Workspace Trust ─────────────────────────────────────────────

describe("Workspace trust", () => {
  test("workspace starts untrusted", () => {
    expect(isWorkspaceTrusted("/some/random/path")).toBe(false);
  });

  test("trustWorkspace makes it trusted", () => {
    trustWorkspace("/tmp/test-hooks-workspace");
    expect(isWorkspaceTrusted("/tmp/test-hooks-workspace")).toBe(true);
  });

  test("normalizes trailing slashes", () => {
    trustWorkspace("/tmp/test-hooks-normalize/");
    expect(isWorkspaceTrusted("/tmp/test-hooks-normalize")).toBe(true);
    expect(isWorkspaceTrusted("/tmp/test-hooks-normalize/")).toBe(true);
  });

  test("different paths are not trusted", () => {
    trustWorkspace("/tmp/test-hooks-a");
    expect(isWorkspaceTrusted("/tmp/test-hooks-b")).toBe(false);
  });
});

// ─── HookManager ─────────────────────────────────────────────────

describe("HookManager", () => {
  test("can be instantiated", () => {
    const manager = new HookManager("/tmp/test-hooks-manager");
    expect(manager).toBeDefined();
  });

  test("hasHooks returns false for no settings", () => {
    const manager = new HookManager("/tmp/nonexistent-hooks-dir");
    expect(manager.hasHooks("SessionStart")).toBe(false);
    expect(manager.hasHooks("PreToolUse")).toBe(false);
    expect(manager.hasHooks("SubagentStart")).toBe(false);
  });

  test("runPreToolUse returns allowed when no hooks", async () => {
    const manager = new HookManager("/tmp/nonexistent-hooks-dir");
    const result = await manager.runPreToolUse({
      type: "tool_use",
      id: "test-1",
      name: "Read",
      input: { file_path: "/tmp/test.txt" },
    });
    expect(result.allowed).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  test("runPostToolUse returns no warnings when no hooks", async () => {
    const manager = new HookManager("/tmp/nonexistent-hooks-dir");
    const result = await manager.runPostToolUse(
      { type: "tool_use", id: "test-2", name: "Read", input: {} },
      { tool_use_id: "test-2", content: "file contents", is_error: false },
    );
    expect(result.warnings).toHaveLength(0);
  });

  test("runPostToolUseFailure returns no warnings when no hooks", async () => {
    const manager = new HookManager("/tmp/nonexistent-hooks-dir");
    const result = await manager.runPostToolUseFailure(
      { type: "tool_use", id: "test-3", name: "Bash", input: {} },
      "command failed",
    );
    expect(result.warnings).toHaveLength(0);
  });

  test("runEventHook returns no warnings when no hooks", async () => {
    const manager = new HookManager("/tmp/nonexistent-hooks-dir");
    const result = await manager.runEventHook("SessionStart", { session_id: "test" });
    expect(result.warnings).toHaveLength(0);
  });

  test("runEventHook works for SubagentStart", async () => {
    const manager = new HookManager("/tmp/nonexistent-hooks-dir");
    const result = await manager.runEventHook("SubagentStart", {
      agent_id: "abc123",
      agent_type: "explore",
    });
    expect(result.warnings).toHaveLength(0);
  });

  test("runEventHook works for SubagentStop", async () => {
    const manager = new HookManager("/tmp/nonexistent-hooks-dir");
    const result = await manager.runEventHook("SubagentStop", {
      agent_id: "abc123",
      status: "completed",
      duration_ms: 1234,
    });
    expect(result.warnings).toHaveLength(0);
  });

  test("runPreAction returns allowed when no hooks", async () => {
    const manager = new HookManager("/tmp/nonexistent-hooks-dir");
    const result = await manager.runPreAction("PreEdit", "Edit", { file_path: "/tmp/test.txt" });
    expect(result.allowed).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  test("fireAndForget does not throw when no hooks", () => {
    const manager = new HookManager("/tmp/nonexistent-hooks-dir");
    // Should not throw
    manager.fireAndForget("Notification", { message: "test" });
    manager.fireAndForget("SubagentStart", { agent_id: "test" });
    manager.fireAndForget("SubagentStop", { agent_id: "test", status: "completed" });
  });

  test("reload resets loaded state", () => {
    const manager = new HookManager("/tmp/nonexistent-hooks-dir");
    // Call load implicitly
    manager.hasHooks("SessionStart");
    // Reload should not throw
    manager.reload();
    expect(manager.hasHooks("SessionStart")).toBe(false);
  });
});

// ─── HookConfig (legacy) shape tests ─────────────────────────────

describe("HookConfig legacy format", () => {
  test("basic legacy hook config shape", () => {
    const config: HookConfig = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "echo blocked", timeout: 5000 }],
    };
    expect(config.matcher).toBe("Bash");
    expect(config.hooks).toHaveLength(1);
    expect(config.hooks[0]!.type).toBe("command");
  });

  test("legacy config with http action", () => {
    const config: HookConfig = {
      matcher: ".*",
      hooks: [
        {
          type: "http",
          url: "https://audit.example.com/log",
          method: "POST",
          headers: { "X-Org-Id": "acme" },
        },
      ],
    };
    expect(config.hooks[0]!.type).toBe("http");
    expect(config.hooks[0]!.url).toBe("https://audit.example.com/log");
  });

  test("legacy config with multiple actions", () => {
    const config: HookConfig = {
      matcher: "Edit",
      hooks: [
        { type: "command", command: "echo pre-edit" },
        { type: "http", url: "https://notify.example.com" },
      ],
    };
    expect(config.hooks).toHaveLength(2);
  });
});

// ─── Stop Hook Tests ─────────────────────────────────────────────

describe("Stop hook", () => {
  test("runStopHook returns not blocked when no hooks", async () => {
    const manager = new HookManager("/tmp/nonexistent-hooks-dir");
    const result = await manager.runStopHook("Stop", { stopReason: "end_turn" });
    expect(result.blocked).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  test("runStopHook returns not blocked for SubagentStop when no hooks", async () => {
    const manager = new HookManager("/tmp/nonexistent-hooks-dir");
    const result = await manager.runStopHook("SubagentStop", {
      agent_id: "abc",
      status: "completed",
    });
    expect(result.blocked).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  test("runStopHook blocks when hook returns block decision", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const testDir = "/tmp/kcode-hooks-stop-test-" + Date.now();
    mkdirSync(testDir + "/.kcode", { recursive: true });
    writeFileSync(
      testDir + "/.kcode/settings.json",
      JSON.stringify({
        hooks: {
          Stop: [
            {
              type: "command",
              command: 'echo \'{"decision":"block","reason":"task not complete"}\' && exit 2',
            },
          ],
        },
      }),
    );
    trustWorkspace(testDir);

    const manager = new HookManager(testDir);
    const result = await manager.runStopHook("Stop", { stopReason: "end_turn" });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("task not complete");

    rmSync(testDir, { recursive: true, force: true });
  });

  test("runStopHook allows when hook returns allow decision", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const testDir = "/tmp/kcode-hooks-stop-allow-test-" + Date.now();
    mkdirSync(testDir + "/.kcode", { recursive: true });
    writeFileSync(
      testDir + "/.kcode/settings.json",
      JSON.stringify({
        hooks: {
          Stop: [
            {
              type: "command",
              command: 'echo \'{"decision":"allow"}\'',
            },
          ],
        },
      }),
    );
    trustWorkspace(testDir);

    const manager = new HookManager(testDir);
    const result = await manager.runStopHook("Stop", { stopReason: "end_turn" });
    expect(result.blocked).toBe(false);

    rmSync(testDir, { recursive: true, force: true });
  });
});

// ─── Agent Hook Entry shape tests ─────────────────────────────────

describe("Agent hook entries", () => {
  test("agent hook entry for SubagentStart", () => {
    // This is the shape used in CustomAgentDef.hooks
    const hook = {
      event: "SubagentStart",
      actions: [{ type: "command" as const, command: "echo agent started" }],
    };
    expect(hook.event).toBe("SubagentStart");
    expect(hook.actions).toHaveLength(1);
  });

  test("agent hook entry for SubagentStop with http", () => {
    const hook = {
      event: "SubagentStop",
      actions: [
        { type: "http" as const, url: "https://notify.example.com/agent-done", timeout: 5000 },
      ],
    };
    expect(hook.event).toBe("SubagentStop");
    expect(hook.actions[0]!.url).toBe("https://notify.example.com/agent-done");
  });

  test("agent hook with matcher", () => {
    const hook = {
      event: "PreToolUse",
      matcher: "Bash",
      actions: [{ type: "command" as const, command: "echo checking bash" }],
    };
    expect(hook.matcher).toBe("Bash");
  });
});

// ─── Integration-like tests (with real command hooks) ─────────────

describe("Hook execution with real commands", () => {
  test("PreToolUse with echo command hook (via settings file)", async () => {
    // Create a temporary workspace with hooks config
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const testDir = "/tmp/kcode-hooks-test-" + Date.now();
    mkdirSync(testDir + "/.kcode", { recursive: true });
    writeFileSync(
      testDir + "/.kcode/settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [{ type: "command", command: "echo ok" }],
        },
      }),
    );
    trustWorkspace(testDir);

    const manager = new HookManager(testDir);
    expect(manager.hasHooks("PreToolUse")).toBe(true);

    const result = await manager.runPreToolUse({
      type: "tool_use",
      id: "test-exec",
      name: "Read",
      input: { file_path: "/tmp/test.txt" },
    });
    expect(result.allowed).toBe(true);

    // Cleanup
    rmSync(testDir, { recursive: true, force: true });
  });

  test("PreToolUse with blocking command (exit 2)", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const testDir = "/tmp/kcode-hooks-block-test-" + Date.now();
    mkdirSync(testDir + "/.kcode", { recursive: true });
    writeFileSync(
      testDir + "/.kcode/settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              type: "command",
              command: 'echo \'{"decision":"deny","reason":"blocked by test"}\' && exit 2',
            },
          ],
        },
      }),
    );
    trustWorkspace(testDir);

    const manager = new HookManager(testDir);
    const result = await manager.runPreToolUse({
      type: "tool_use",
      id: "test-block",
      name: "Bash",
      input: { command: "rm -rf /" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked by test");

    rmSync(testDir, { recursive: true, force: true });
  });

  test("PostToolUse hook executes without blocking", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const testDir = "/tmp/kcode-hooks-post-test-" + Date.now();
    mkdirSync(testDir + "/.kcode", { recursive: true });
    writeFileSync(
      testDir + "/.kcode/settings.json",
      JSON.stringify({
        hooks: {
          PostToolUse: [{ type: "command", command: "echo post-hook-ran" }],
        },
      }),
    );
    trustWorkspace(testDir);

    const manager = new HookManager(testDir);
    const result = await manager.runPostToolUse(
      { type: "tool_use", id: "test-post", name: "Read", input: {} },
      { tool_use_id: "test-post", content: "ok", is_error: false },
    );
    expect(result.warnings).toHaveLength(0);

    rmSync(testDir, { recursive: true, force: true });
  });

  test("event hook with matcher filtering", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const testDir = "/tmp/kcode-hooks-matcher-test-" + Date.now();
    mkdirSync(testDir + "/.kcode", { recursive: true });
    writeFileSync(
      testDir + "/.kcode/settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              type: "command",
              command: "echo matched",
              matcher: { toolName: "Bash" },
            },
          ],
        },
      }),
    );
    trustWorkspace(testDir);

    const manager = new HookManager(testDir);
    // Should match — tool is Bash
    const result1 = await manager.runPreToolUse({
      type: "tool_use",
      id: "t1",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(result1.allowed).toBe(true);
    expect(result1.contextOutput).toBeDefined(); // "matched" should be in context

    // Should NOT match — tool is Read
    const result2 = await manager.runPreToolUse({
      type: "tool_use",
      id: "t2",
      name: "Read",
      input: { file_path: "/tmp/x" },
    });
    expect(result2.allowed).toBe(true);
    expect(result2.contextOutput).toBeUndefined(); // No hooks matched

    rmSync(testDir, { recursive: true, force: true });
  });

  test("prompt hook injects text into context", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const testDir = "/tmp/kcode-hooks-prompt-test-" + Date.now();
    mkdirSync(testDir + "/.kcode", { recursive: true });
    writeFileSync(
      testDir + "/.kcode/settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              type: "prompt",
              prompt: "Remember: always use safe patterns",
            },
          ],
        },
      }),
    );
    trustWorkspace(testDir);

    const manager = new HookManager(testDir);
    const result = await manager.runPreToolUse({
      type: "tool_use",
      id: "t1",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(result.allowed).toBe(true);
    expect(result.contextOutput).toBeDefined();
    expect(result.contextOutput![0]).toBe("Remember: always use safe patterns");

    rmSync(testDir, { recursive: true, force: true });
  });

  test("legacy hook format with regex matcher", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const testDir = "/tmp/kcode-hooks-legacy-test-" + Date.now();
    mkdirSync(testDir + "/.kcode", { recursive: true });
    writeFileSync(
      testDir + "/.kcode/settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash|Edit",
              hooks: [{ type: "command", command: "echo legacy-matched" }],
            },
          ],
        },
      }),
    );
    trustWorkspace(testDir);

    const manager = new HookManager(testDir);
    const result = await manager.runPreToolUse({
      type: "tool_use",
      id: "t1",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(result.allowed).toBe(true);

    rmSync(testDir, { recursive: true, force: true });
  });
});
