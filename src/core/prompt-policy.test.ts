// KCode - Prompt Policy & Truncation Path Tests
// Validates: no-tools policy, language matching, and truncation on tool_use stopReason

import { describe, test, expect } from "bun:test";
import { SystemPromptBuilder } from "./system-prompt";
import { looksIncomplete, looksTheoretical } from "./conversation";
import type { KCodeConfig } from "./types";

// ─── Minimal config for prompt generation ───────────────────────

function minConfig(overrides?: Partial<KCodeConfig>): KCodeConfig {
  return {
    model: "test-model",
    maxTokens: 4096,
    systemPrompt: "",
    workingDirectory: "/tmp/test-project",
    permissionMode: "ask",
    version: "1.4.0",
    ...overrides,
  };
}

// ─── System Prompt Policy Sections ──────────────────────────────

describe("System prompt policy sections", () => {
  test("contains 'When NOT to use tools' section", async () => {
    const prompt = await SystemPromptBuilder.build(minConfig());
    expect(prompt).toContain("When NOT to use tools");
    expect(prompt).toContain("theoretical");
    expect(prompt).toContain("respond directly with text");
  });

  test("contains 'Respond in the user's language' section", async () => {
    const prompt = await SystemPromptBuilder.build(minConfig());
    expect(prompt).toContain("user's language");
    expect(prompt).toContain("Spanish");
  });

  test("contains workspace-scoped Glob guidance", async () => {
    const prompt = await SystemPromptBuilder.build(minConfig());
    expect(prompt).toContain("within the project workspace only");
    expect(prompt).toContain("Start with specific subdirectories");
  });
});

// ─── Truncation Detection on tool_use Path ──────────────────────

describe("looksIncomplete — tool_use path coverage", () => {
  // These simulate text that would appear before tool calls
  // where stopReason is "tool_use" but text is truncated
  const pad = (s: string) => "x".repeat(60) + " " + s;

  test("detects 'with' at end (common tool_use truncation)", () => {
    expect(looksIncomplete(pad("The algorithm works best with"))).toBe(true);
  });

  test("detects 'the' at end before tool calls", () => {
    expect(looksIncomplete(pad("I need to read the"))).toBe(true);
  });

  test("detects hyphen at end before tool calls", () => {
    expect(looksIncomplete(pad("Let me check the configura-"))).toBe(true);
  });

  test("detects open paren before tool calls", () => {
    expect(looksIncomplete(pad("The complexity is O("))).toBe(true);
  });

  test("does not trigger on clean text before tools", () => {
    expect(looksIncomplete(pad("Let me check the file."))).toBe(false);
  });

  test("does not trigger on text ending with colon (valid before tools)", () => {
    expect(looksIncomplete(pad("Here is what I found:"))).toBe(false);
  });
});

// ─── looksTheoretical — auto-detect formal prompts ──────────────

describe("looksTheoretical", () => {
  test("detects Spanish formal proof request", () => {
    expect(looksTheoretical("Demuestra formalmente que no existe un algoritmo")).toBe(true);
  });

  test("detects English formal proof request", () => {
    expect(looksTheoretical("Prove that the problem is reducible to reachability")).toBe(true);
  });

  test("detects transition system language", () => {
    expect(looksTheoretical("sistema de transición de estados con variables infinitas")).toBe(true);
  });

  test("detects multiple formal keywords", () => {
    expect(looksTheoretical("decidability of compaction with idempotent tool calls and equivalence")).toBe(true);
  });

  test("does not trigger on normal coding request", () => {
    expect(looksTheoretical("fix the bug in src/index.ts")).toBe(false);
  });

  test("does not trigger on simple questions", () => {
    expect(looksTheoretical("what does this function do?")).toBe(false);
  });

  test("detects the exact KCode test prompt", () => {
    const prompt = "Dado un programa arbitrario P que recibe como entrada una secuencia de tool calls con efectos secundarios sobre un filesystem, demuestra que el problema de determinar si existe una subsecuencia de compaction que preserve la equivalencia observacional del estado final del filesystem es reducible al problema de alcanzabilidad";
    expect(looksTheoretical(prompt)).toBe(true);
  });
});
