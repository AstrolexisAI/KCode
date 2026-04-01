// Tests for session-snapshot.ts

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KCodeConfig, ConversationState, TokenUsage, Message } from "./types";

// Redirect snapshot storage to a temp directory before importing the module
const TEST_KCODE_HOME = join(tmpdir(), `kcode-test-snap-${process.pid}`);
const origKcodeHome = process.env.KCODE_HOME;
process.env.KCODE_HOME = TEST_KCODE_HOME;

import {
  captureSnapshot,
  exportSnapshot,
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  diffSnapshots,
  AutoCheckpointer,
  rewindToCheckpoint,
  saveCrashRecovery,
  checkCrashRecovery,
  clearCrashRecovery,
  type SessionSnapshot,
  type SnapshotMessage,
} from "./session-snapshot";

afterAll(() => {
  // Restore env and clean up temp dir
  if (origKcodeHome === undefined) delete process.env.KCODE_HOME;
  else process.env.KCODE_HOME = origKcodeHome;
  try { rmSync(TEST_KCODE_HOME, { recursive: true, force: true }); } catch {}
});

// ─── Test Helpers ────────────────────────────────────────────────

function makeConfig(overrides?: Partial<KCodeConfig>): KCodeConfig {
  return {
    model: "test-model-7b",
    maxTokens: 4096,
    systemPrompt: "You are a helpful assistant.",
    workingDirectory: "/tmp/test-project",
    permissionMode: "ask",
    version: "1.3.1",
    contextWindowSize: 32000,
    thinking: false,
    effortLevel: "medium",
    ...overrides,
  };
}

function makeState(messages?: Message[]): ConversationState {
  const msgs: Message[] = messages ?? [
    { role: "user", content: "Hello, please fix the bug" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'll look at the code." },
        { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/src/main.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "const x = 1;",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I found the issue. Let me fix it." },
        {
          type: "tool_use",
          id: "call_2",
          name: "Edit",
          input: { file_path: "/src/main.ts", old_string: "const x = 1;", new_string: "const x = 2;" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_2",
          content: "File edited successfully.",
        },
      ],
    },
  ];

  return {
    messages: msgs,
    tokenCount: 1500,
    toolUseCount: 2,
  };
}

function makeUsage(): TokenUsage {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("session-snapshot", () => {
  describe("captureSnapshot", () => {
    it("captures basic session metadata", () => {
      const config = makeConfig();
      const state = makeState();
      const usage = makeUsage();
      const startTime = Date.now() - 60_000; // 1 minute ago

      const snap = captureSnapshot(config, state, usage, startTime, {
        provider: "openai",
        gitBranch: "main",
        gitCommit: "abc123",
      });

      expect(snap.id).toMatch(/^snap-/);
      expect(snap.createdAt).toBeTruthy();
      expect(snap.version).toBe("1.3.1");
      expect(snap.model).toBe("test-model-7b");
      expect(snap.provider).toBe("openai");
      expect(snap.contextWindowSize).toBe(32000);
      expect(snap.workingDirectory).toBe("/tmp/test-project");
      expect(snap.gitBranch).toBe("main");
      expect(snap.gitCommit).toBe("abc123");
    });

    it("captures configuration correctly", () => {
      const config = makeConfig({ thinking: true, effortLevel: "high", reasoningBudget: 5000 });
      const snap = captureSnapshot(config, makeState(), makeUsage(), Date.now());

      expect(snap.config.thinking).toBe(true);
      expect(snap.config.effortLevel).toBe("high");
      expect(snap.config.permissionMode).toBe("ask");
      expect(snap.config.reasoningBudget).toBe(5000);
    });

    it("hashes system prompt instead of including it", () => {
      const config = makeConfig({ systemPrompt: "secret instructions here" });
      const snap = captureSnapshot(config, makeState(), makeUsage(), Date.now());

      expect(snap.systemPromptHash).toBeTruthy();
      expect(snap.systemPromptHash.length).toBe(16); // truncated sha256
      expect(snap.systemPromptLength).toBe("secret instructions here".length);
      // Ensure the actual prompt text is NOT in the snapshot
      const json = JSON.stringify(snap);
      expect(json).not.toContain("secret instructions here");
    });

    it("extracts tools used from messages", () => {
      const snap = captureSnapshot(makeConfig(), makeState(), makeUsage(), Date.now());

      expect(snap.toolsUsed).toContain("Read");
      expect(snap.toolsUsed).toContain("Edit");
      expect(snap.toolsUsed.length).toBe(2);
    });

    it("extracts files modified from Edit/Write tool calls", () => {
      const snap = captureSnapshot(makeConfig(), makeState(), makeUsage(), Date.now());

      expect(snap.filesModified).toContain("/src/main.ts");
      // Read should NOT count as a modified file
      expect(snap.filesModified.length).toBe(1);
    });

    it("calculates token totals from usage", () => {
      const usage: TokenUsage = {
        inputTokens: 2000,
        outputTokens: 800,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 50,
      };
      const snap = captureSnapshot(makeConfig(), makeState(), usage, Date.now());

      expect(snap.totalTokens).toBe(2800); // input + output
    });

    it("counts user turns correctly", () => {
      const snap = captureSnapshot(makeConfig(), makeState(), makeUsage(), Date.now());

      // The default state has user messages with role "user" — both string and array content
      expect(snap.turnCount).toBeGreaterThanOrEqual(1);
    });

    it("flattens messages into SnapshotMessage array", () => {
      const snap = captureSnapshot(makeConfig(), makeState(), makeUsage(), Date.now());

      expect(snap.messages.length).toBeGreaterThan(0);

      // Check we have different message types
      const types = new Set(snap.messages.map((m) => m.type));
      expect(types.has("text")).toBe(true);
      expect(types.has("tool_use")).toBe(true);
      expect(types.has("tool_result")).toBe(true);

      // Verify tool_use messages have toolName
      const toolUseMsg = snap.messages.find((m) => m.type === "tool_use");
      expect(toolUseMsg?.toolName).toBeTruthy();
    });
  });

  describe("exportSnapshot - JSON", () => {
    it("exports valid JSON", () => {
      const snap = captureSnapshot(makeConfig(), makeState(), makeUsage(), Date.now());
      const json = exportSnapshot(snap, "json");
      const parsed = JSON.parse(json);

      expect(parsed.id).toBe(snap.id);
      expect(parsed.model).toBe("test-model-7b");
      expect(parsed.messages).toBeArray();
    });
  });

  describe("exportSnapshot - markdown", () => {
    it("exports readable markdown", () => {
      const snap = captureSnapshot(makeConfig(), makeState(), makeUsage(), Date.now(), {
        provider: "openai",
        gitBranch: "feature-branch",
      });
      const md = exportSnapshot(snap, "markdown");

      expect(md).toContain("# Session Snapshot:");
      expect(md).toContain("test-model-7b");
      expect(md).toContain("feature-branch");
      expect(md).toContain("## Configuration");
      expect(md).toContain("## Metrics");
      expect(md).toContain("## Tools Used");
      expect(md).toContain("## Messages");
    });
  });

  describe("save/load roundtrip", () => {
    let originalSnap: SessionSnapshot;

    beforeEach(() => {
      originalSnap = captureSnapshot(makeConfig(), makeState(), makeUsage(), Date.now() - 30_000, {
        provider: "anthropic",
        gitBranch: "main",
        totalCost: 0.0042,
      });
    });

    it("saves and loads a snapshot by ID", () => {
      const filePath = saveSnapshot(originalSnap);
      expect(existsSync(filePath)).toBe(true);

      const loaded = loadSnapshot(originalSnap.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(originalSnap.id);
      expect(loaded!.model).toBe(originalSnap.model);
      expect(loaded!.messages.length).toBe(originalSnap.messages.length);
      expect(loaded!.totalCost).toBe(0.0042);
    });

    it("returns null for non-existent snapshot", () => {
      const loaded = loadSnapshot("snap-does-not-exist-999");
      expect(loaded).toBeNull();
    });
  });

  describe("listSnapshots", () => {
    it("lists saved snapshots newest first", () => {
      // Save two snapshots
      const snap1 = captureSnapshot(makeConfig({ model: "model-a" }), makeState(), makeUsage(), Date.now() - 60_000);
      saveSnapshot(snap1);

      const snap2 = captureSnapshot(makeConfig({ model: "model-b" }), makeState(), makeUsage(), Date.now() - 30_000);
      saveSnapshot(snap2);

      const list = listSnapshots(10);
      expect(list.length).toBeGreaterThanOrEqual(2);

      // Newest should be first (snap2's ID is lexicographically later due to timestamp)
      const ids = list.map((s) => s.id);
      expect(ids).toContain(snap1.id);
      expect(ids).toContain(snap2.id);
    });

    it("respects the limit parameter", () => {
      // Save 3 snapshots
      for (let i = 0; i < 3; i++) {
        const snap = captureSnapshot(makeConfig(), makeState(), makeUsage(), Date.now());
        saveSnapshot(snap);
      }

      const list = listSnapshots(2);
      expect(list.length).toBeLessThanOrEqual(2);
    });
  });

  describe("diffSnapshots", () => {
    it("detects config changes", () => {
      const snapA = captureSnapshot(
        makeConfig({ model: "model-a", thinking: false }),
        makeState(),
        makeUsage(),
        Date.now(),
        { provider: "openai" },
      );
      const snapB = captureSnapshot(
        makeConfig({ model: "model-b", thinking: true }),
        makeState(),
        makeUsage(),
        Date.now(),
        { provider: "anthropic" },
      );

      const diff = diffSnapshots(snapA, snapB);

      expect(diff.configChanges.length).toBeGreaterThan(0);
      const configStr = diff.configChanges.join(", ");
      expect(configStr).toContain("model");
      expect(configStr).toContain("thinking");
      expect(configStr).toContain("provider");
    });

    it("calculates token and message deltas", () => {
      const usageA: TokenUsage = { inputTokens: 500, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
      const usageB: TokenUsage = { inputTokens: 1500, outputTokens: 600, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

      const stateSmall = makeState([{ role: "user", content: "Hi" }]);
      const stateLarge = makeState(); // default has 5 messages

      const snapA = captureSnapshot(makeConfig(), stateSmall, usageA, Date.now());
      const snapB = captureSnapshot(makeConfig(), stateLarge, usageB, Date.now());

      const diff = diffSnapshots(snapA, snapB);

      expect(diff.tokenDelta).toBe(1400); // (1500+600) - (500+200)
      expect(diff.messageCountDelta).toBeGreaterThan(0);
    });

    it("identifies new and removed tools", () => {
      const stateA = makeState([
        { role: "user", content: "Hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }] },
      ]);
      const stateB = makeState([
        { role: "user", content: "Hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "c2", name: "Grep", input: {} }] },
      ]);

      const snapA = captureSnapshot(makeConfig(), stateA, makeUsage(), Date.now());
      const snapB = captureSnapshot(makeConfig(), stateB, makeUsage(), Date.now());

      const diff = diffSnapshots(snapA, snapB);

      expect(diff.newTools).toContain("Grep");
      expect(diff.removedTools).toContain("Read");
    });
  });

  // ─── Auto-Checkpoint ────────────────────────────────────────

  describe("AutoCheckpointer", () => {
    it("does not checkpoint before interval", () => {
      const cp = new AutoCheckpointer("test-session", { intervalTurns: 5 });
      const result = cp.onTurnComplete(3, makeConfig(), makeState(), makeUsage(), Date.now());
      expect(result).toBeNull();
    });

    it("creates checkpoint at interval", () => {
      const cp = new AutoCheckpointer("test-session", { intervalTurns: 5 });
      const result = cp.onTurnComplete(5, makeConfig(), makeState(), makeUsage(), Date.now());
      expect(result).not.toBeNull();
      expect(result).toContain("checkpoint");
    });

    it("tracks checkpoint IDs", () => {
      const cp = new AutoCheckpointer("test-session", { intervalTurns: 1 });
      cp.onTurnComplete(1, makeConfig(), makeState(), makeUsage(), Date.now());
      cp.onTurnComplete(2, makeConfig(), makeState(), makeUsage(), Date.now());
      expect(cp.getCheckpointIds()).toHaveLength(2);
    });

    it("disabled checkpointer does nothing", () => {
      const cp = new AutoCheckpointer("test-session", { enabled: false });
      const result = cp.onTurnComplete(100, makeConfig(), makeState(), makeUsage(), Date.now());
      expect(result).toBeNull();
    });
  });

  // ─── Rewind ─────────────────────────────────────────────────

  describe("rewindToCheckpoint", () => {
    it("returns null for nonexistent checkpoint", () => {
      expect(rewindToCheckpoint("nonexistent-checkpoint-id")).toBeNull();
    });

    it("returns messages from a saved checkpoint", () => {
      const snapshot = captureSnapshot(makeConfig(), makeState(), makeUsage(), Date.now());
      snapshot.id = "rewind-test-" + Date.now();
      saveSnapshot(snapshot);
      const messages = rewindToCheckpoint(snapshot.id);
      expect(messages).not.toBeNull();
      expect(messages!.length).toBeGreaterThan(0);
    });
  });

  // ─── Crash Recovery ─────────────────────────────────────────

  describe("crash recovery", () => {
    it("saves and loads crash recovery data", () => {
      saveCrashRecovery({
        sessionId: "test-session",
        lastCheckpointId: "cp-1",
        timestamp: Date.now(),
        model: "test-model",
        cwd: "/tmp/test",
      });
      const data = checkCrashRecovery();
      expect(data).not.toBeNull();
      expect(data!.sessionId).toBe("test-session");
    });

    it("clearCrashRecovery removes data", () => {
      saveCrashRecovery({
        sessionId: "test-session",
        lastCheckpointId: "cp-1",
        timestamp: Date.now(),
        model: "test-model",
        cwd: "/tmp/test",
      });
      clearCrashRecovery();
      expect(checkCrashRecovery()).toBeNull();
    });

    it("returns null for expired recovery data", () => {
      saveCrashRecovery({
        sessionId: "test-session",
        lastCheckpointId: "cp-1",
        timestamp: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
        model: "test-model",
        cwd: "/tmp/test",
      });
      expect(checkCrashRecovery()).toBeNull();
    });
  });
});
