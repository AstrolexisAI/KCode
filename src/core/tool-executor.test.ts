// KCode - Tool Executor Tests
// Tests for: preFilterToolCalls() — pure filtering of tool calls by managed policy,
// web access, allowed/disallowed lists

import { describe, test, expect } from "bun:test";
import { preFilterToolCalls } from "./tool-executor";
import type { ToolUseBlock, ContentBlock } from "./types";

// ─── Helpers ────────────────────────────────────────────────────

function makeToolCall(name: string, id?: string): ToolUseBlock {
  return { type: "tool_use", id: id ?? `call_${name}`, name, input: {} };
}

function makeGuardState(overrides?: Partial<{
  managedDisallowedSet: Set<string>;
  allowedToolsSet: Set<string> | null;
  disallowedToolsSet: Set<string> | null;
}>): any {
  return {
    managedDisallowedSet: new Set<string>(),
    allowedToolsSet: null,
    disallowedToolsSet: null,
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<{
  managedDisallowedTools: string[];
  disableWebAccess: boolean;
  allowedTools: string[];
  disallowedTools: string[];
}>): any {
  return {
    managedDisallowedTools: undefined,
    disableWebAccess: false,
    allowedTools: undefined,
    disallowedTools: undefined,
    ...overrides,
  };
}

/** Extract blocked result content strings for easy assertions */
function blockedMessages(results: ContentBlock[]): string[] {
  return results
    .filter((b): b is { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean } =>
      b.type === "tool_result")
    .map(b => b.content as string);
}

// ─── No Filtering ───────────────────────────────────────────────

describe("preFilterToolCalls — no restrictions", () => {
  test("all tools pass when no restrictions are configured", () => {
    const tools = [makeToolCall("Read"), makeToolCall("Write"), makeToolCall("Bash")];
    const { filtered, blockedResults } = preFilterToolCalls(tools, makeGuardState(), makeConfig());
    expect(filtered).toHaveLength(3);
    expect(blockedResults).toHaveLength(0);
  });

  test("returns empty blockedResults when all pass", () => {
    const tools = [makeToolCall("Grep")];
    const { blockedResults } = preFilterToolCalls(tools, makeGuardState(), makeConfig());
    expect(blockedResults).toEqual([]);
  });

  test("filtered array contains the original tool calls", () => {
    const tools = [makeToolCall("Edit", "id_1"), makeToolCall("Glob", "id_2")];
    const { filtered } = preFilterToolCalls(tools, makeGuardState(), makeConfig());
    expect(filtered[0]!.name).toBe("Edit");
    expect(filtered[0]!.id).toBe("id_1");
    expect(filtered[1]!.name).toBe("Glob");
    expect(filtered[1]!.id).toBe("id_2");
  });

  test("handles empty tool calls array", () => {
    const { filtered, blockedResults } = preFilterToolCalls([], makeGuardState(), makeConfig());
    expect(filtered).toHaveLength(0);
    expect(blockedResults).toHaveLength(0);
  });
});

// ─── Managed Policy ─────────────────────────────────────────────

describe("preFilterToolCalls — managed policy (org-level)", () => {
  test("blocks tool in managedDisallowedSet", () => {
    const tools = [makeToolCall("Bash")];
    const guard = makeGuardState({ managedDisallowedSet: new Set(["bash"]) });
    const config = makeConfig({ managedDisallowedTools: ["Bash"] });
    const { filtered, blockedResults } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(0);
    expect(blockedResults).toHaveLength(1);
  });

  test("error message says 'blocked by organization policy'", () => {
    const tools = [makeToolCall("Bash", "id_bash")];
    const guard = makeGuardState({ managedDisallowedSet: new Set(["bash"]) });
    const config = makeConfig({ managedDisallowedTools: ["Bash"] });
    const { blockedResults } = preFilterToolCalls(tools, guard, config);
    const msgs = blockedMessages(blockedResults);
    expect(msgs[0]).toBe("Tool 'Bash' is blocked by organization policy");
  });

  test("blocked result has is_error true and correct tool_use_id", () => {
    const tools = [makeToolCall("Bash", "id_xyz")];
    const guard = makeGuardState({ managedDisallowedSet: new Set(["bash"]) });
    const config = makeConfig({ managedDisallowedTools: ["Bash"] });
    const { blockedResults } = preFilterToolCalls(tools, guard, config);
    const result = blockedResults[0] as any;
    expect(result.is_error).toBe(true);
    expect(result.tool_use_id).toBe("id_xyz");
  });

  test("non-blocked tools pass through", () => {
    const tools = [makeToolCall("Bash"), makeToolCall("Read")];
    const guard = makeGuardState({ managedDisallowedSet: new Set(["bash"]) });
    const config = makeConfig({ managedDisallowedTools: ["Bash"] });
    const { filtered } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.name).toBe("Read");
  });

  test("mixed: some blocked by managed policy, some pass", () => {
    const tools = [makeToolCall("Bash"), makeToolCall("Read"), makeToolCall("Write")];
    const guard = makeGuardState({ managedDisallowedSet: new Set(["bash", "write"]) });
    const config = makeConfig({ managedDisallowedTools: ["Bash", "Write"] });
    const { filtered, blockedResults } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.name).toBe("Read");
    expect(blockedResults).toHaveLength(2);
  });

  test("managed policy matching is case-insensitive", () => {
    const tools = [makeToolCall("BASH")];
    const guard = makeGuardState({ managedDisallowedSet: new Set(["bash"]) });
    const config = makeConfig({ managedDisallowedTools: ["Bash"] });
    const { filtered } = preFilterToolCalls(tools, guard, config);
    // call.name.toLowerCase() is "bash" which matches the set
    expect(filtered).toHaveLength(0);
  });
});

// ─── Web Access Disabled ────────────────────────────────────────

describe("preFilterToolCalls — web access disabled", () => {
  test("blocks WebFetch when disableWebAccess is true", () => {
    const tools = [makeToolCall("WebFetch")];
    const config = makeConfig({ disableWebAccess: true });
    const { filtered, blockedResults } = preFilterToolCalls(tools, makeGuardState(), config);
    expect(filtered).toHaveLength(0);
    expect(blockedResults).toHaveLength(1);
  });

  test("blocks WebSearch when disableWebAccess is true", () => {
    const tools = [makeToolCall("WebSearch")];
    const config = makeConfig({ disableWebAccess: true });
    const { filtered, blockedResults } = preFilterToolCalls(tools, makeGuardState(), config);
    expect(filtered).toHaveLength(0);
    expect(blockedResults).toHaveLength(1);
  });

  test("web access error message matches expected format", () => {
    const tools = [makeToolCall("WebFetch", "id_wf")];
    const config = makeConfig({ disableWebAccess: true });
    const { blockedResults } = preFilterToolCalls(tools, makeGuardState(), config);
    const msgs = blockedMessages(blockedResults);
    expect(msgs[0]).toBe("Web access tools are disabled by organization policy");
  });

  test("does not block other tools when disableWebAccess is true", () => {
    const tools = [makeToolCall("Read"), makeToolCall("WebFetch"), makeToolCall("Bash")];
    const config = makeConfig({ disableWebAccess: true });
    const { filtered, blockedResults } = preFilterToolCalls(tools, makeGuardState(), config);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(t => t.name)).toEqual(["Read", "Bash"]);
    expect(blockedResults).toHaveLength(1);
  });

  test("WebFetch passes when disableWebAccess is false", () => {
    const tools = [makeToolCall("WebFetch")];
    const config = makeConfig({ disableWebAccess: false });
    const { filtered } = preFilterToolCalls(tools, makeGuardState(), config);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.name).toBe("WebFetch");
  });

  test("WebSearch passes when disableWebAccess is false", () => {
    const tools = [makeToolCall("WebSearch")];
    const config = makeConfig({ disableWebAccess: false });
    const { filtered } = preFilterToolCalls(tools, makeGuardState(), config);
    expect(filtered).toHaveLength(1);
  });

  test("blocks both WebFetch and WebSearch in the same batch", () => {
    const tools = [makeToolCall("WebFetch", "wf1"), makeToolCall("WebSearch", "ws1")];
    const config = makeConfig({ disableWebAccess: true });
    const { filtered, blockedResults } = preFilterToolCalls(tools, makeGuardState(), config);
    expect(filtered).toHaveLength(0);
    expect(blockedResults).toHaveLength(2);
  });
});

// ─── Allowed Tools List ─────────────────────────────────────────

describe("preFilterToolCalls — allowed tools list", () => {
  test("only tools in allowedToolsSet pass", () => {
    const tools = [makeToolCall("Read"), makeToolCall("Write"), makeToolCall("Bash")];
    const guard = makeGuardState({ allowedToolsSet: new Set(["read", "write"]) });
    const config = makeConfig({ allowedTools: ["Read", "Write"] });
    const { filtered } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(t => t.name)).toEqual(["Read", "Write"]);
  });

  test("tools NOT in allowed list are blocked with correct message", () => {
    const tools = [makeToolCall("Bash", "id_bash")];
    const guard = makeGuardState({ allowedToolsSet: new Set(["read"]) });
    const config = makeConfig({ allowedTools: ["Read"] });
    const { blockedResults } = preFilterToolCalls(tools, guard, config);
    const msgs = blockedMessages(blockedResults);
    expect(msgs[0]).toBe("Tool 'Bash' is not in the allowed tools list");
  });

  test("empty allowedToolsSet blocks everything", () => {
    // Note: config.allowedTools must have length for the filter block to execute,
    // and the LoopGuardState constructor produces null for empty arrays.
    // But we can test with a manually created empty Set.
    const tools = [makeToolCall("Read"), makeToolCall("Write")];
    const guard = makeGuardState({ allowedToolsSet: new Set<string>() });
    const config = makeConfig({ allowedTools: ["anything"] }); // non-empty to enter the block
    const { filtered, blockedResults } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(0);
    expect(blockedResults).toHaveLength(2);
  });

  test("null allowedToolsSet (no restriction) passes everything", () => {
    const tools = [makeToolCall("Read"), makeToolCall("Write")];
    const guard = makeGuardState({ allowedToolsSet: null });
    const config = makeConfig({ allowedTools: undefined });
    const { filtered } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(2);
  });

  test("allowed tools matching is case-insensitive", () => {
    const tools = [makeToolCall("READ")];
    const guard = makeGuardState({ allowedToolsSet: new Set(["read"]) });
    const config = makeConfig({ allowedTools: ["Read"] });
    const { filtered } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(1);
  });
});

// ─── Disallowed Tools List ──────────────────────────────────────

describe("preFilterToolCalls — disallowed tools list", () => {
  test("tools in disallowedToolsSet are blocked", () => {
    const tools = [makeToolCall("Bash")];
    const guard = makeGuardState({ disallowedToolsSet: new Set(["bash"]) });
    const config = makeConfig({ disallowedTools: ["Bash"] });
    const { filtered, blockedResults } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(0);
    expect(blockedResults).toHaveLength(1);
  });

  test("error message says 'in the disallowed tools list'", () => {
    const tools = [makeToolCall("Bash", "id_b")];
    const guard = makeGuardState({ disallowedToolsSet: new Set(["bash"]) });
    const config = makeConfig({ disallowedTools: ["Bash"] });
    const { blockedResults } = preFilterToolCalls(tools, guard, config);
    const msgs = blockedMessages(blockedResults);
    expect(msgs[0]).toBe("Tool 'Bash' is in the disallowed tools list");
  });

  test("tools NOT in disallowed set pass through", () => {
    const tools = [makeToolCall("Read"), makeToolCall("Bash")];
    const guard = makeGuardState({ disallowedToolsSet: new Set(["bash"]) });
    const config = makeConfig({ disallowedTools: ["Bash"] });
    const { filtered } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.name).toBe("Read");
  });

  test("null disallowedToolsSet passes everything", () => {
    const tools = [makeToolCall("Read"), makeToolCall("Bash")];
    const guard = makeGuardState({ disallowedToolsSet: null });
    const config = makeConfig({ disallowedTools: undefined });
    const { filtered } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(2);
  });

  test("disallowed tools matching is case-insensitive", () => {
    const tools = [makeToolCall("BASH")];
    const guard = makeGuardState({ disallowedToolsSet: new Set(["bash"]) });
    const config = makeConfig({ disallowedTools: ["Bash"] });
    const { filtered } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(0);
  });
});

// ─── Combined Filters ───────────────────────────────────────────

describe("preFilterToolCalls — combined filters", () => {
  test("managed policy and allowed list both applied", () => {
    const tools = [
      makeToolCall("Bash", "id_bash"),      // blocked by managed
      makeToolCall("Write", "id_write"),     // blocked by allowed list (not in set)
      makeToolCall("Read", "id_read"),       // passes both
    ];
    const guard = makeGuardState({
      managedDisallowedSet: new Set(["bash"]),
      allowedToolsSet: new Set(["read"]),
    });
    const config = makeConfig({
      managedDisallowedTools: ["Bash"],
      allowedTools: ["Read"],
    });
    const { filtered, blockedResults } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.name).toBe("Read");
    expect(blockedResults).toHaveLength(2);
  });

  test("tool blocked by managed policy does not also produce an allowed list error", () => {
    // Bash is blocked in the first pass (managed), so it never reaches the allowed list filter
    const tools = [makeToolCall("Bash", "id_bash")];
    const guard = makeGuardState({
      managedDisallowedSet: new Set(["bash"]),
      allowedToolsSet: new Set(["read"]),  // Bash would also fail this, but should not
    });
    const config = makeConfig({
      managedDisallowedTools: ["Bash"],
      allowedTools: ["Read"],
    });
    const { blockedResults } = preFilterToolCalls(tools, guard, config);
    expect(blockedResults).toHaveLength(1);
    expect(blockedMessages(blockedResults)[0]).toContain("organization policy");
  });

  test("managed policy and disallowed list both applied", () => {
    const tools = [
      makeToolCall("Bash", "id_bash"),      // blocked by managed
      makeToolCall("Write", "id_write"),     // blocked by disallowed
      makeToolCall("Read", "id_read"),       // passes both
    ];
    const guard = makeGuardState({
      managedDisallowedSet: new Set(["bash"]),
      disallowedToolsSet: new Set(["write"]),
    });
    const config = makeConfig({
      managedDisallowedTools: ["Bash"],
      disallowedTools: ["Write"],
    });
    const { filtered, blockedResults } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.name).toBe("Read");
    expect(blockedResults).toHaveLength(2);
  });

  test("web access disabled combined with disallowed list", () => {
    const tools = [
      makeToolCall("WebFetch", "id_wf"),    // blocked by web access
      makeToolCall("Bash", "id_bash"),       // blocked by disallowed
      makeToolCall("Read", "id_read"),       // passes
    ];
    const guard = makeGuardState({
      disallowedToolsSet: new Set(["bash"]),
    });
    const config = makeConfig({
      disableWebAccess: true,
      disallowedTools: ["Bash"],
    });
    const { filtered, blockedResults } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.name).toBe("Read");
    expect(blockedResults).toHaveLength(2);
  });

  test("all three filters: managed + web access + disallowed", () => {
    const tools = [
      makeToolCall("Edit", "id_edit"),          // blocked by managed
      makeToolCall("WebSearch", "id_ws"),        // blocked by web access
      makeToolCall("Bash", "id_bash"),           // blocked by disallowed
      makeToolCall("Read", "id_read"),           // passes all
    ];
    const guard = makeGuardState({
      managedDisallowedSet: new Set(["edit"]),
      disallowedToolsSet: new Set(["bash"]),
    });
    const config = makeConfig({
      managedDisallowedTools: ["Edit"],
      disableWebAccess: true,
      disallowedTools: ["Bash"],
    });
    const { filtered, blockedResults } = preFilterToolCalls(tools, guard, config);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.name).toBe("Read");
    expect(blockedResults).toHaveLength(3);
  });

  test("does not mutate the original toolCalls array", () => {
    const tools = [makeToolCall("Bash"), makeToolCall("Read")];
    const original = [...tools];
    const guard = makeGuardState({ managedDisallowedSet: new Set(["bash"]) });
    const config = makeConfig({ managedDisallowedTools: ["Bash"] });
    preFilterToolCalls(tools, guard, config);
    expect(tools).toEqual(original);
    expect(tools).toHaveLength(2);
  });

  test("each blocked result has type tool_result and is_error true", () => {
    const tools = [
      makeToolCall("Bash", "id_1"),
      makeToolCall("WebFetch", "id_2"),
    ];
    const guard = makeGuardState({ managedDisallowedSet: new Set(["bash"]) });
    const config = makeConfig({
      managedDisallowedTools: ["Bash"],
      disableWebAccess: true,
    });
    const { blockedResults } = preFilterToolCalls(tools, guard, config);
    for (const result of blockedResults) {
      expect(result.type).toBe("tool_result");
      expect((result as any).is_error).toBe(true);
    }
  });

  test("blocked results preserve the correct tool_use_id for each call", () => {
    const tools = [
      makeToolCall("Bash", "unique_id_1"),
      makeToolCall("Write", "unique_id_2"),
    ];
    const guard = makeGuardState({
      managedDisallowedSet: new Set(["bash"]),
      disallowedToolsSet: new Set(["write"]),
    });
    const config = makeConfig({
      managedDisallowedTools: ["Bash"],
      disallowedTools: ["Write"],
    });
    const { blockedResults } = preFilterToolCalls(tools, guard, config);
    const ids = blockedResults.map((b: any) => b.tool_use_id);
    expect(ids).toContain("unique_id_1");
    expect(ids).toContain("unique_id_2");
  });
});
