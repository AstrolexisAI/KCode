import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RulesManager, getRulesManager } from "./rules.ts";

let tempDir: string;
let rm_: RulesManager;

function makeTempDir(): string {
  const dir = join("/tmp", `kcode-rules-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createRule(baseDir: string, filename: string, content: string): void {
  const rulesDir = join(baseDir, ".kcode", "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, filename), content);
}

describe("RulesManager", () => {
  beforeEach(() => {
    tempDir = makeTempDir();
    rm_ = new RulesManager();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("load() with no rules dirs does not crash", () => {
    const nonExistent = join(tempDir, "nope");
    expect(() => rm_.load(nonExistent)).not.toThrow();
    expect(rm_.getMatchingRules("any/file.ts")).toEqual([]);
  });

  test("loading rules from .md files without frontmatter", () => {
    createRule(tempDir, "general.md", "Always use semicolons.");

    rm_.load(tempDir);
    const rules = rm_.getMatchingRules("anything.ts");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.name).toBe("general");
    expect(rules[0]!.content).toBe("Always use semicolons.");
    expect(rules[0]!.paths).toEqual([]);
  });

  test("loading rules from .md files with YAML frontmatter", () => {
    createRule(tempDir, "api-rules.md", `---
name: API Guidelines
paths:
  - src/api/**
  - src/routes/**
---
Use REST conventions.`);

    rm_.load(tempDir);
    const rules = rm_.getMatchingRules("src/api/users.ts");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.name).toBe("API Guidelines");
    expect(rules[0]!.content).toBe("Use REST conventions.");
    expect(rules[0]!.paths).toEqual(["src/api/**", "src/routes/**"]);
  });

  test("formatForPrompt() returns null with no global rules", () => {
    // Only path-specific rules
    createRule(tempDir, "scoped.md", `---
name: Scoped
paths:
  - src/**
---
Scoped content.`);

    rm_.load(tempDir);
    expect(rm_.formatForPrompt()).toBeNull();
  });

  test("formatForPrompt() returns global rules (no paths)", () => {
    createRule(tempDir, "global.md", "Always write tests.");

    rm_.load(tempDir);
    const result = rm_.formatForPrompt();
    expect(result).not.toBeNull();
    expect(result).toContain("# Project Rules");
    expect(result).toContain("### global");
    expect(result).toContain("Always write tests.");
  });

  test("formatForPath() matches glob patterns", () => {
    createRule(tempDir, "test-rules.md", `---
name: Test Rules
paths:
  - "*.test.ts"
  - src/tests/**
---
Use describe/test blocks.`);

    rm_.load(tempDir);

    const matched = rm_.formatForPath("foo.test.ts");
    expect(matched).not.toBeNull();
    expect(matched).toContain("Test Rules");
    expect(matched).toContain("Use describe/test blocks.");

    const matched2 = rm_.formatForPath("src/tests/unit.ts");
    expect(matched2).not.toBeNull();

    const notMatched = rm_.formatForPath("src/main.ts");
    expect(notMatched).toBeNull();
  });

  test("formatForPath() returns null when no path-specific rules match", () => {
    createRule(tempDir, "global-only.md", "Global rule with no paths.");

    rm_.load(tempDir);
    // Global rules have no paths, so formatForPath filters them out
    expect(rm_.formatForPath("any/file.ts")).toBeNull();
  });

  test("getMatchingRules() returns global rules for any file", () => {
    createRule(tempDir, "always.md", "Always active rule.");

    rm_.load(tempDir);
    expect(rm_.getMatchingRules("anything.ts")).toHaveLength(1);
    expect(rm_.getMatchingRules("deeply/nested/file.py")).toHaveLength(1);
  });

  test("non-.md files are ignored", () => {
    const rulesDir = join(tempDir, ".kcode", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "notes.txt"), "This should be ignored.");
    writeFileSync(join(rulesDir, "actual.md"), "This should be loaded.");

    rm_.load(tempDir);
    const rules = rm_.getMatchingRules("any.ts");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.name).toBe("actual");
  });
});

describe("getRulesManager singleton", () => {
  test("getRulesManager() returns a RulesManager instance", () => {
    const mgr = getRulesManager();
    expect(mgr).toBeInstanceOf(RulesManager);
  });

  test("getRulesManager() returns same instance on subsequent calls", () => {
    const first = getRulesManager();
    const second = getRulesManager();
    expect(second).toBe(first);
  });
});
