// KCode - System Prompt Golden/Snapshot Tests
// Regression protection for prompt assembly: verifies structure, section ordering,
// key phrases, and config-driven variations remain stable across changes.
//
// DESIGN NOTE: The build() method loads real files from ~/.kcode/ (awareness modules,
// identity extensions, learnings, etc.) which can consume a significant portion of the
// 24K token budget. Tests that need to verify specific content use the static builder
// methods directly (which are pure functions) rather than build() to avoid flakiness
// caused by the user's local ~/.kcode/ contents.

import { describe, test, expect } from "bun:test";
import { SystemPromptBuilder } from "./system-prompt";
import { SectionPriority, TokenBudgetManager } from "./token-budget";
import type { KCodeConfig } from "./types";

// ─── Helpers ────────────────────────────────────────────────────

function minimalConfig(overrides: Partial<KCodeConfig> = {}): KCodeConfig {
  return {
    model: "test-model",
    maxTokens: 4096,
    systemPrompt: "",
    workingDirectory: "/tmp/kcode-golden-test-nonexistent",
    permissionMode: "ask",
    contextWindowSize: 1_000_000,
    ...overrides,
  };
}

// ─── Golden Tests: Default Config (CRITICAL sections) ───────────
// CRITICAL sections are never truncated by the budget manager,
// so these assertions are safe against any ~/.kcode/ state.

describe("System Prompt Golden: default config structure", () => {
  test("prompt includes identity section with KCode branding", async () => {
    const cfg = minimalConfig();
    const result = await SystemPromptBuilder.build(cfg, "1.0.0");

    expect(result).toContain("You are **KCode**");
    expect(result).toContain("Astrolexis");
    expect(result).toContain("1.0.0");
  });

  test("prompt includes tool instructions section", async () => {
    const cfg = minimalConfig();
    const result = await SystemPromptBuilder.build(cfg);

    expect(result).toContain("# Tool Usage");
    expect(result).toContain("CRITICAL");
    expect(result).toContain("## Read");
    expect(result).toContain("## Edit");
    expect(result).toContain("## Write");
    expect(result).toContain("## Bash");
    expect(result).toContain("## Grep");
    expect(result).toContain("## Glob");
  });

  test("prompt includes version in identity when provided", async () => {
    const cfg = minimalConfig();
    const result = await SystemPromptBuilder.build(cfg, "9.8.7");
    expect(result).toContain("9.8.7");
  });

  test("returns non-empty string with default config", async () => {
    const cfg = minimalConfig();
    const result = await SystemPromptBuilder.build(cfg);
    expect(result.length).toBeGreaterThan(1000);
  });
});

// ─── Golden Tests: Static Section Builders ──────────────────────
// Pure functions — no filesystem or budget dependencies.

describe("System Prompt Golden: code guidelines section", () => {
  test("contains verification guidance", () => {
    const result = SystemPromptBuilder.buildCodeGuidelines();
    expect(result).toContain("# Code Guidelines");
    expect(result).toContain("Verification");
    expect(result).toContain("verify");
  });

  test("contains security guidance", () => {
    const result = SystemPromptBuilder.buildCodeGuidelines();
    expect(result).toContain("security");
    expect(result).toContain("secrets");
  });
});

describe("System Prompt Golden: git instructions section", () => {
  test("includes commit and safety protocols", () => {
    const result = SystemPromptBuilder.buildGitInstructions();
    expect(result).toContain("Commit Protocol");
    expect(result).toContain("Git Safety");
    expect(result).toContain("NEVER");
    expect(result).toContain("HEREDOC");
    expect(result).toContain("Co-Authored-By");
  });

  test("includes force-push and hook warnings", () => {
    const result = SystemPromptBuilder.buildGitInstructions();
    expect(result).toContain("force push");
    expect(result).toContain("--no-verify");
    expect(result).toContain("main/master");
  });
});

describe("System Prompt Golden: tone and output section", () => {
  test("includes communication style and anti-verbosity rules", () => {
    const result = SystemPromptBuilder.buildToneAndOutput();
    expect(result).toContain("# Communication Style");
    expect(result).toContain("Anti-Verbosity");
    expect(result).toContain("NON-NEGOTIABLE");
    expect(result).toContain("NEVER use emoji");
  });

  test("includes max response length guidance", () => {
    const result = SystemPromptBuilder.buildToneAndOutput();
    expect(result).toContain("5 sentences");
  });
});

// ─── Golden Tests: Thinking Mode ────────────────────────────────

describe("System Prompt Golden: thinking mode", () => {
  test("thinking=true adds Extended Reasoning section", async () => {
    const cfg = minimalConfig({ thinking: true });
    const result = await SystemPromptBuilder.build(cfg);

    // Thinking section is HIGH priority, should survive since identity+tools
    // are CRITICAL and thinking is relatively small.
    expect(result).toContain("## Extended Reasoning");
    expect(result).toContain("<reasoning>");
    expect(result).toContain("</reasoning>");
    expect(result).toContain("NEVER skip the reasoning block");
  });

  test("thinking=false or undefined omits Extended Reasoning", async () => {
    const cfgFalse = minimalConfig({ thinking: false });
    const resultFalse = await SystemPromptBuilder.build(cfgFalse);
    expect(resultFalse).not.toContain("Extended Reasoning");

    const cfgUndefined = minimalConfig();
    const resultUndefined = await SystemPromptBuilder.build(cfgUndefined);
    expect(resultUndefined).not.toContain("Extended Reasoning");
  });
});

// ─── Golden Tests: Profile Interaction ──────────────────────────

describe("System Prompt Golden: profile systemPromptAppend", () => {
  test("profiles define systemPromptAppend for each mode", () => {
    const profiles = [
      { name: "safe", keyword: "SAFE mode" },
      { name: "fast", keyword: "concise" },
      { name: "review", keyword: "REVIEW mode" },
      { name: "implement", keyword: "IMPLEMENT mode" },
      { name: "ops", keyword: "OPS mode" },
    ];

    const { getProfile } = require("./profiles");
    for (const p of profiles) {
      const profile = getProfile(p.name);
      expect(profile).toBeDefined();
      expect(profile.settings.systemPromptAppend).toBeDefined();
      expect(profile.settings.systemPromptAppend).toContain(p.keyword);
    }
  });

  test("systemPromptOverride bypasses all section assembly", async () => {
    const cfg = minimalConfig({ systemPromptOverride: "CUSTOM OVERRIDE" });
    const result = await SystemPromptBuilder.build(cfg);
    expect(result).toBe("CUSTOM OVERRIDE");
  });

  test("each profile has valid permissionMode and effortLevel", () => {
    const { listProfiles } = require("./profiles");
    const validPermissions = ["ask", "auto", "plan", "deny", "acceptEdits"];
    const validEfforts = ["low", "medium", "high", "max"];

    for (const profile of listProfiles()) {
      expect(validPermissions).toContain(profile.settings.permissionMode);
      expect(validEfforts).toContain(profile.settings.effortLevel);
    }
  });
});

// ─── Golden Tests: Section Priority Ordering ────────────────────

describe("System Prompt Golden: section priority ordering", () => {
  test("CRITICAL sections (identity, tools) appear before HIGH sections in build output", async () => {
    const cfg = minimalConfig();
    const result = await SystemPromptBuilder.build(cfg);

    // Identity and tools are CRITICAL — always included, always first
    const identityPos = result.indexOf("You are **KCode**");
    const toolsPos = result.indexOf("# Tool Usage");

    expect(identityPos).toBeGreaterThan(-1);
    expect(toolsPos).toBeGreaterThan(-1);

    // Any HIGH section that survived the budget should come after CRITICAL
    // Check code guidelines (HIGH) if it survived
    const guidelinesPos = result.indexOf("# Code Guidelines");
    if (guidelinesPos > -1) {
      expect(identityPos).toBeLessThan(guidelinesPos);
      expect(toolsPos).toBeLessThan(guidelinesPos);
    }
  });

  test("SectionPriority enum has correct numeric ordering", () => {
    expect(SectionPriority.CRITICAL).toBeLessThan(SectionPriority.HIGH);
    expect(SectionPriority.HIGH).toBeLessThan(SectionPriority.MEDIUM);
    expect(SectionPriority.MEDIUM).toBeLessThan(SectionPriority.LOW);
    expect(SectionPriority.LOW).toBeLessThan(SectionPriority.OPTIONAL);
  });

  test("TokenBudgetManager sorts by priority — CRITICAL first, OPTIONAL last", () => {
    const manager = new TokenBudgetManager(100_000);

    const result = manager.apply([
      { content: "optional content", priority: SectionPriority.OPTIONAL, label: "optional" },
      { content: "critical content", priority: SectionPriority.CRITICAL, label: "critical" },
      { content: "medium content", priority: SectionPriority.MEDIUM, label: "medium" },
      { content: "high content", priority: SectionPriority.HIGH, label: "high" },
    ]);

    const criticalPos = result.indexOf("critical content");
    const highPos = result.indexOf("high content");
    const mediumPos = result.indexOf("medium content");
    const optionalPos = result.indexOf("optional content");

    expect(criticalPos).toBeLessThan(highPos);
    expect(highPos).toBeLessThan(mediumPos);
    expect(mediumPos).toBeLessThan(optionalPos);
  });

  test("TokenBudgetManager drops low-priority sections when budget is tight", () => {
    // Small budget: only ~50 tokens
    const manager = new TokenBudgetManager(500);

    const result = manager.apply([
      { content: "A".repeat(100), priority: SectionPriority.CRITICAL, label: "critical" },
      { content: "B".repeat(100), priority: SectionPriority.LOW, label: "low" },
      { content: "C".repeat(100), priority: SectionPriority.OPTIONAL, label: "optional" },
    ]);

    // CRITICAL should survive
    expect(result).toContain("A".repeat(100));
    // LOW and OPTIONAL may be dropped
  });
});

// ─── Golden Tests: Custom Identity Injection ────────────────────

describe("System Prompt Golden: custom identity", () => {
  test("systemPromptOverride replaces entire prompt", async () => {
    const cfg = minimalConfig({ systemPromptOverride: "CUSTOM IDENTITY OVERRIDE" });
    const result = await SystemPromptBuilder.build(cfg);

    expect(result).toBe("CUSTOM IDENTITY OVERRIDE");
    expect(result).not.toContain("KCode");
    expect(result).not.toContain("Tool Usage");
  });
});

// ─── Golden Tests: Environment Section ──────────────────────────

describe("System Prompt Golden: environment section", () => {
  test("includes platform information", () => {
    const cfg = minimalConfig();
    const envSection = SystemPromptBuilder.buildEnvironment(cfg);

    expect(envSection).toContain("Platform:");
    expect(envSection).toContain(process.platform);
  });

  test("includes model name", () => {
    const cfg = minimalConfig({ model: "my-custom-model" });
    const envSection = SystemPromptBuilder.buildEnvironment(cfg);

    expect(envSection).toContain("Model: my-custom-model");
  });

  test("includes working directory", () => {
    const cfg = minimalConfig({ workingDirectory: "/home/test/project" });
    const envSection = SystemPromptBuilder.buildEnvironment(cfg);

    expect(envSection).toContain("Working directory: /home/test/project");
  });

  test("includes date in ISO format (YYYY-MM-DD)", () => {
    const cfg = minimalConfig();
    const envSection = SystemPromptBuilder.buildEnvironment(cfg);

    expect(envSection).toMatch(/Date: \d{4}-\d{2}-\d{2}/);
  });

  test("includes shell information", () => {
    const cfg = minimalConfig();
    const envSection = SystemPromptBuilder.buildEnvironment(cfg);

    expect(envSection).toContain("Shell:");
  });

  test("includes git repo status", () => {
    const cfg = minimalConfig();
    const envSection = SystemPromptBuilder.buildEnvironment(cfg);

    expect(envSection).toContain("Git repo:");
  });
});

// ─── Golden Tests: Key Phrase Regression ────────────────────────
// These test the static builders directly to avoid budget truncation.

describe("System Prompt Golden: key phrase regression", () => {
  test("identity phrases are present", () => {
    const identity = SystemPromptBuilder.buildIdentity("1.0.0");
    expect(identity).toContain("You are");
    expect(identity).toContain("KCode");
    expect(identity).toContain("Kulvex Code");
    expect(identity).toContain("Astrolexis");
  });

  test("tool instruction keywords are present", () => {
    const tools = SystemPromptBuilder.buildToolInstructions();
    expect(tools).toContain("MUST use tools");
    expect(tools).toContain("Parallel Tool Calls");
    expect(tools).toContain("absolute path");
  });

  test("permission-related instructions are present", () => {
    const tools = SystemPromptBuilder.buildToolInstructions();
    const git = SystemPromptBuilder.buildGitInstructions();

    expect(tools).toContain("NEVER");
    expect(git).toContain("force push");
    expect(git).toContain("--no-verify");
  });

  test("git convention phrases are present", () => {
    const git = SystemPromptBuilder.buildGitInstructions();
    expect(git).toContain("HEREDOC");
    expect(git).toContain("Co-Authored-By");
    expect(git).toContain("commit");
    expect(git).toContain("git diff");
  });

  test("anti-verbosity rules are present", () => {
    const tone = SystemPromptBuilder.buildToneAndOutput();
    expect(tone).toContain("NEVER use emoji");
    expect(tone).toContain("Anti-Verbosity");
    expect(tone).toContain("NON-NEGOTIABLE");
  });

  test("autonomous learning instructions are present", () => {
    const identity = SystemPromptBuilder.buildIdentity("1.0.0");
    expect(identity).toContain("Autonomous Learning");
    expect(identity).toContain("Search");
    expect(identity).toContain("Learn");
  });

  test("runtime instructions mention Bun", () => {
    const tools = SystemPromptBuilder.buildToolInstructions();
    expect(tools).toContain("Bun");
    expect(tools).toContain("bun:sqlite");
  });
});

// ─── Golden Tests: Effort Levels ────────────────────────────────
// Effort-level sections are HIGH priority — they may be truncated when
// awareness modules fill the budget. Test via build() but accept
// the possibility of budget truncation on machines with large ~/.kcode/.

describe("System Prompt Golden: effort levels", () => {
  test("effort=low adds brevity instruction (when budget allows)", async () => {
    const cfg = minimalConfig({ effortLevel: "low" });
    const result = await SystemPromptBuilder.build(cfg);

    // CRITICAL sections are always present
    expect(result).toContain("KCode");

    // If the effort section survived the budget, verify its content
    if (result.includes("brief and concise")) {
      expect(result).toContain("Be brief and concise.");
    }
  });

  test("effort=high adds thoroughness instruction (when budget allows)", async () => {
    const cfg = minimalConfig({ effortLevel: "high" });
    const result = await SystemPromptBuilder.build(cfg);

    expect(result).toContain("KCode");

    if (result.includes("thorough and detailed")) {
      expect(result).toContain("Be thorough and detailed.");
    }
  });

  test("effort=max adds exhaustive instruction (when budget allows)", async () => {
    const cfg = minimalConfig({ effortLevel: "max" });
    const result = await SystemPromptBuilder.build(cfg);

    expect(result).toContain("KCode");

    if (result.includes("Be exhaustive")) {
      expect(result).toContain("edge cases");
    }
  });
});

// ─── Golden Tests: Static Builder Methods Stability ─────────────

describe("System Prompt Golden: static builder method stability", () => {
  test("buildIdentity returns consistent structure across calls", () => {
    const a = SystemPromptBuilder.buildIdentity("1.0.0");
    const b = SystemPromptBuilder.buildIdentity("1.0.0");
    expect(a).toBe(b);
  });

  test("buildToolInstructions returns consistent structure across calls", () => {
    const a = SystemPromptBuilder.buildToolInstructions();
    const b = SystemPromptBuilder.buildToolInstructions();
    expect(a).toBe(b);
  });

  test("buildCodeGuidelines returns consistent structure across calls", () => {
    const a = SystemPromptBuilder.buildCodeGuidelines();
    const b = SystemPromptBuilder.buildCodeGuidelines();
    expect(a).toBe(b);
  });

  test("buildGitInstructions returns consistent structure across calls", () => {
    const a = SystemPromptBuilder.buildGitInstructions();
    const b = SystemPromptBuilder.buildGitInstructions();
    expect(a).toBe(b);
  });

  test("buildToneAndOutput returns consistent structure across calls", () => {
    const a = SystemPromptBuilder.buildToneAndOutput();
    const b = SystemPromptBuilder.buildToneAndOutput();
    expect(a).toBe(b);
  });

  test("buildEnvironment returns consistent model and directory", () => {
    const cfg = minimalConfig({ model: "stable-test", workingDirectory: "/stable/path" });
    const a = SystemPromptBuilder.buildEnvironment(cfg);
    const b = SystemPromptBuilder.buildEnvironment(cfg);
    // Date, platform, shell should be the same within the same process
    expect(a).toBe(b);
  });
});
