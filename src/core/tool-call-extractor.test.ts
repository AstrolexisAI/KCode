// KCode - Tool Call Extractor Tests
// Tests for text-based tool call extraction patterns

import { describe, test, expect } from "bun:test";
import { extractToolCallsFromText } from "./tool-call-extractor";
import { ToolRegistry } from "./tool-registry";
import type { ToolDefinition } from "./types";

// ─── Helpers ────────────────────────────────────────────────────

/** Create a ToolRegistry with a set of mock tool definitions. */
function createMockRegistry(names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) {
    const def: ToolDefinition = {
      name,
      description: `Mock ${name} tool`,
      input_schema: { type: "object", properties: {} },
    };
    registry.register(name, def, async () => ({ tool_use_id: "", content: "ok" }));
  }
  return registry;
}

const defaultTools = createMockRegistry(["Bash", "Read", "Edit", "Grep", "Glob", "Write"]);

// ─── Pattern 1: JSON code blocks ────────────────────────────────

describe("extractToolCallsFromText: JSON code blocks", () => {
  test("extracts tool call from ```json code block", () => {
    const text = `Let me read that file.
\`\`\`json
{"name": "Read", "arguments": {"file_path": "/src/index.ts"}}
\`\`\``;
    const results = extractToolCallsFromText(text, defaultTools);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Read");
    expect(results[0]!.input).toEqual({ file_path: "/src/index.ts" });
  });

  test("extracts tool call from ``` code block (no json label)", () => {
    const text = `\`\`\`
{"name": "Bash", "arguments": {"command": "ls -la"}}
\`\`\``;
    const results = extractToolCallsFromText(text, defaultTools);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Bash");
    expect(results[0]!.input).toEqual({ command: "ls -la" });
  });

  test("handles 'parameters' key as alias for 'arguments'", () => {
    const text = `\`\`\`json
{"name": "Edit", "parameters": {"file_path": "/x.ts", "old_string": "a", "new_string": "b"}}
\`\`\``;
    const results = extractToolCallsFromText(text, defaultTools);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Edit");
    expect(results[0]!.input.old_string).toBe("a");
  });

  test("captures prefix text before the tool call", () => {
    const text = `I'll check the file now.\n\`\`\`json\n{"name": "Read", "arguments": {"file_path": "/x"}}\n\`\`\``;
    const results = extractToolCallsFromText(text, defaultTools);
    expect(results).toHaveLength(1);
    expect(results[0]!.prefixText).toContain("I'll check the file now.");
  });
});

// ─── Pattern 2: Raw JSON ────────────────────────────────────────

describe("extractToolCallsFromText: raw JSON", () => {
  test("extracts raw JSON tool call without code block", () => {
    const text = `Sure, here: {"name": "Grep", "arguments": {"pattern": "TODO"}}`;
    const results = extractToolCallsFromText(text, defaultTools);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Grep");
    expect(results[0]!.input).toEqual({ pattern: "TODO" });
  });

  test("handles 'function' key as alias for 'name'", () => {
    const text = `{"function": "Bash", "arguments": {"command": "pwd"}}`;
    // Raw JSON pattern uses "name" or "function" or "tool"
    const results = extractToolCallsFromText(text, defaultTools);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Bash");
  });
});

// ─── Pattern 3: Bash code blocks ────────────────────────────────

describe("extractToolCallsFromText: bash code blocks", () => {
  test("extracts single-line bash code block as Bash tool call", () => {
    const text = `Let me run this:\n\`\`\`bash\nls -la /tmp\n\`\`\``;
    const results = extractToolCallsFromText(text, defaultTools);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Bash");
    expect(results[0]!.input.command).toBe("ls -la /tmp");
  });

  test("ignores multiline bash blocks (explanation, not a command)", () => {
    const text = `\`\`\`bash\nfirst line\nsecond line\n\`\`\``;
    const results = extractToolCallsFromText(text, defaultTools);
    expect(results).toHaveLength(0);
  });

  test("ignores comments in bash blocks", () => {
    const text = `\`\`\`bash\n# This is a comment\n\`\`\``;
    const results = extractToolCallsFromText(text, defaultTools);
    expect(results).toHaveLength(0);
  });
});

// ─── No tool calls / edge cases ─────────────────────────────────

describe("extractToolCallsFromText: edge cases", () => {
  test("returns empty for plain text with no tool patterns", () => {
    const results = extractToolCallsFromText("Just a regular message with no tools.", defaultTools);
    expect(results).toHaveLength(0);
  });

  test("returns empty for unknown tool names", () => {
    const text = `\`\`\`json\n{"name": "UnknownTool", "arguments": {}}\n\`\`\``;
    const results = extractToolCallsFromText(text, defaultTools);
    expect(results).toHaveLength(0);
  });

  test("handles case-insensitive tool name matching", () => {
    const text = `\`\`\`json\n{"name": "bash", "arguments": {"command": "echo hi"}}\n\`\`\``;
    const results = extractToolCallsFromText(text, defaultTools);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Bash"); // Normalized to canonical case
  });

  test("returns empty for empty text", () => {
    const results = extractToolCallsFromText("", defaultTools);
    expect(results).toHaveLength(0);
  });
});
