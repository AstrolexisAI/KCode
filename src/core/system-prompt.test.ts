// KCode - System Prompt Builder Tests
// Tests for the static section builders and the overall build() flow

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { SystemPromptBuilder } from "./system-prompt";
import type { KCodeConfig } from "./types";

// ─── Helpers ────────────────────────────────────────────────────

function minimalConfig(overrides: Partial<KCodeConfig> = {}): KCodeConfig {
  return {
    model: "test-model",
    maxTokens: 4096,
    systemPrompt: "",
    workingDirectory: "/tmp/kcode-test-nonexistent",
    permissionMode: "ask",
    contextWindowSize: 1_000_000,
    ...overrides,
  };
}

// ─── Static section builders (pure, no side effects) ────────────

describe("SystemPromptBuilder: buildIdentity", () => {
  test("includes version string", () => {
    const result = SystemPromptBuilder.buildIdentity("1.2.3");
    expect(result).toContain("1.2.3");
  });

  test("includes KCode branding", () => {
    const result = SystemPromptBuilder.buildIdentity("0.0.0");
    expect(result).toContain("KCode");
    expect(result).toContain("Astrolexis");
  });

  test("includes capabilities overview", () => {
    const result = SystemPromptBuilder.buildIdentity("1.0.0");
    expect(result).toContain("What you can do");
    expect(result).toContain("Read, write, and edit files");
  });

  test("includes limitations section", () => {
    const result = SystemPromptBuilder.buildIdentity("1.0.0");
    expect(result).toContain("Your limitations");
  });
});

describe("SystemPromptBuilder: buildToolInstructions", () => {
  test("contains critical tool usage header", () => {
    const result = SystemPromptBuilder.buildToolInstructions();
    expect(result).toContain("Tool Usage");
    expect(result).toContain("CRITICAL");
  });

  test("documents core tools", () => {
    const result = SystemPromptBuilder.buildToolInstructions();
    expect(result).toContain("## Read");
    expect(result).toContain("## Edit");
    expect(result).toContain("## Write");
    expect(result).toContain("## Bash");
    expect(result).toContain("## Grep");
    expect(result).toContain("## Glob");
  });

  test("mentions parallel tool calls", () => {
    const result = SystemPromptBuilder.buildToolInstructions();
    expect(result).toContain("Parallel Tool Calls");
  });
});

describe("SystemPromptBuilder: buildCodeGuidelines", () => {
  test("contains verification guidance", () => {
    const result = SystemPromptBuilder.buildCodeGuidelines();
    expect(result).toContain("Verification");
    expect(result).toContain("verify");
  });
});

describe("SystemPromptBuilder: buildGitInstructions", () => {
  test("includes commit and safety protocols", () => {
    const result = SystemPromptBuilder.buildGitInstructions();
    expect(result).toContain("Commit Protocol");
    expect(result).toContain("Git Safety");
    expect(result).toContain("NEVER");
  });
});

describe("SystemPromptBuilder: buildToneAndOutput", () => {
  test("returns non-empty string", () => {
    const result = SystemPromptBuilder.buildToneAndOutput();
    expect(result.length).toBeGreaterThan(50);
  });
});

// ─── build() integration-level tests ────────────────────────────
// Note: build() loads real files from ~/.kcode/ and applies a 24K token budget.
// CRITICAL sections (identity, tools) are guaranteed to survive the budget.
// HIGH sections may be truncated when awareness modules fill the budget.

describe("SystemPromptBuilder: build()", () => {
  test("systemPromptOverride bypasses all section assembly", async () => {
    const cfg = minimalConfig({ systemPromptOverride: "CUSTOM OVERRIDE" });
    const result = await SystemPromptBuilder.build(cfg);
    expect(result).toBe("CUSTOM OVERRIDE");
  });

  test("includes identity section (CRITICAL priority, never dropped)", async () => {
    const cfg = minimalConfig();
    const result = await SystemPromptBuilder.build(cfg);
    expect(result).toContain("KCode");
    expect(result).toContain("Astrolexis");
  });

  test("includes tool instructions section (CRITICAL priority, never dropped)", async () => {
    const cfg = minimalConfig();
    const result = await SystemPromptBuilder.build(cfg);
    expect(result).toContain("Tool Usage");
    expect(result).toContain("## Read");
    expect(result).toContain("## Bash");
  });

  test("includes version in identity when provided", async () => {
    const cfg = minimalConfig();
    const result = await SystemPromptBuilder.build(cfg, "9.8.7");
    expect(result).toContain("9.8.7");
  });

  test("no thinking config omits reasoning section", async () => {
    const cfg = minimalConfig({ thinking: false });
    const result = await SystemPromptBuilder.build(cfg);
    expect(result).not.toContain("Extended Reasoning");
  });

  test("returns non-empty string with default config", async () => {
    const cfg = minimalConfig();
    const result = await SystemPromptBuilder.build(cfg);
    expect(result.length).toBeGreaterThan(1000);
  });
});
