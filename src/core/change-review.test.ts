// KCode - Change Review Tests

import { describe, expect, it } from "bun:test";
import {
  assessRisk,
  type ChangeReview,
  classifyChanges,
  type FileChange,
  formatReview,
  generateSuggestions,
} from "./change-review";

// ─── Helper ─────────────────────────────────────────────────────

function makeChange(path: string, overrides?: Partial<FileChange>): FileChange {
  return {
    path,
    type: "modified",
    linesAdded: 10,
    linesRemoved: 5,
    ...overrides,
  };
}

// ─── classifyChanges ────────────────────────────────────────────

describe("classifyChanges", () => {
  it("classifies test-only changes", () => {
    const files = [makeChange("src/core/foo.test.ts"), makeChange("src/tools/__tests__/bar.ts")];
    const result = classifyChanges(files);
    expect(result.category).toBe("test");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("classifies docs-only changes", () => {
    const files = [makeChange("README.md"), makeChange("docs/guide.md")];
    const result = classifyChanges(files);
    expect(result.category).toBe("docs");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("classifies dependency changes", () => {
    const files = [makeChange("package.json"), makeChange("bun.lockb")];
    const result = classifyChanges(files);
    expect(result.category).toBe("dependency");
  });

  it("classifies config-only changes", () => {
    const files = [makeChange("tsconfig.json"), makeChange(".eslintrc.json")];
    const result = classifyChanges(files);
    expect(result.category).toBe("config");
  });

  it("classifies migration changes", () => {
    const files = [makeChange("db/migrations/001_create_users.sql")];
    const result = classifyChanges(files);
    expect(result.category).toBe("migration");
  });

  it("classifies security-dominant changes", () => {
    const files = [makeChange("src/core/auth.ts"), makeChange("src/core/permissions.ts")];
    const result = classifyChanges(files);
    expect(result.category).toBe("security");
  });

  it("classifies source + test as fix", () => {
    const files = [makeChange("src/core/config.ts"), makeChange("src/core/config.test.ts")];
    const result = classifyChanges(files);
    expect(["fix", "feature"]).toContain(result.category);
  });

  it("classifies new source files as feature", () => {
    const files = [makeChange("src/core/new-module.ts", { type: "created", linesAdded: 100 })];
    const result = classifyChanges(files);
    expect(result.category).toBe("feature");
  });

  it("classifies source-only modifications as refactor", () => {
    const files = [makeChange("src/core/conversation.ts"), makeChange("src/core/system-prompt.ts")];
    const result = classifyChanges(files);
    expect(result.category).toBe("refactor");
  });

  it("returns low confidence for empty changes", () => {
    const result = classifyChanges([]);
    expect(result.confidence).toBeLessThan(0.2);
  });
});

// ─── assessRisk ─────────────────────────────────────────────────

describe("assessRisk", () => {
  it("flags .env files as critical", () => {
    const files = [makeChange(".env")];
    const result = assessRisk(files);
    expect(result.level).toBe("critical");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("flags Dockerfile as critical", () => {
    const files = [makeChange("Dockerfile")];
    const result = assessRisk(files);
    expect(result.level).toBe("critical");
  });

  it("flags CI/CD pipelines as critical", () => {
    const files = [makeChange(".github/workflows/deploy.yml")];
    const result = assessRisk(files);
    expect(result.level).toBe("critical");
  });

  it("flags migration files as high risk", () => {
    const files = [makeChange("db/migration_001.sql")];
    const result = assessRisk(files);
    expect(["high", "critical"]).toContain(result.level);
  });

  it("flags many files as medium risk", () => {
    const files = Array.from({ length: 7 }, (_, i) =>
      makeChange(`src/ui/component-${i}.tsx`, { linesAdded: 5, linesRemoved: 2 }),
    );
    const result = assessRisk(files);
    expect(["medium", "high", "critical"]).toContain(result.level);
  });

  it("rates tests-only as low risk", () => {
    const files = [makeChange("src/core/foo.test.ts"), makeChange("src/core/bar.spec.ts")];
    const result = assessRisk(files);
    expect(result.level).toBe("low");
  });

  it("rates docs-only as low risk", () => {
    const files = [makeChange("README.md")];
    const result = assessRisk(files);
    expect(result.level).toBe("low");
  });
});

// ─── generateSuggestions ────────────────────────────────────────

describe("generateSuggestions", () => {
  it("suggests tests when source changed without tests", () => {
    const files = [makeChange("src/core/config.ts")];
    const classification = classifyChanges(files);
    const risk = assessRisk(files);
    const suggestions = generateSuggestions(files, classification, risk);
    expect(suggestions.some((s) => s.message.includes("test"))).toBe(true);
  });

  it("warns about public API changes", () => {
    const files = [makeChange("src/tools/edit.ts")];
    const classification = classifyChanges(files);
    const risk = assessRisk(files);
    const suggestions = generateSuggestions(files, classification, risk);
    expect(suggestions.some((s) => s.message.includes("API"))).toBe(true);
  });

  it("suggests docs update when config changed", () => {
    const files = [makeChange("tsconfig.json")];
    const classification = classifyChanges(files);
    const risk = assessRisk(files);
    const suggestions = generateSuggestions(files, classification, risk);
    expect(suggestions.some((s) => s.message.includes("documentation"))).toBe(true);
  });

  it("warns about security-sensitive files", () => {
    const files = [makeChange("src/core/auth.ts")];
    const classification = classifyChanges(files);
    const risk = assessRisk(files);
    const suggestions = generateSuggestions(files, classification, risk);
    expect(suggestions.some((s) => s.message.includes("Security"))).toBe(true);
  });

  it("suggests splitting large changes", () => {
    const files = [makeChange("src/core/big.ts", { linesAdded: 200, linesRemoved: 150 })];
    const classification = classifyChanges(files);
    const risk = assessRisk(files);
    const suggestions = generateSuggestions(files, classification, risk);
    expect(suggestions.some((s) => s.message.includes("splitting"))).toBe(true);
  });

  it("returns empty suggestions for simple doc changes", () => {
    const files = [makeChange("README.md", { linesAdded: 5, linesRemoved: 2 })];
    const classification = classifyChanges(files);
    const risk = assessRisk(files);
    const suggestions = generateSuggestions(files, classification, risk);
    // Should have no warnings about tests/API/security
    expect(
      suggestions.some(
        (s) =>
          s.message.includes("test") || s.message.includes("API") || s.message.includes("Security"),
      ),
    ).toBe(false);
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles empty file list", () => {
    const classification = classifyChanges([]);
    const risk = assessRisk([]);
    const suggestions = generateSuggestions([], classification, risk);
    expect(classification.confidence).toBeLessThan(0.2);
    expect(risk.level).toBe("low");
    expect(suggestions).toEqual([]);
  });

  it("handles single renamed file", () => {
    const files = [makeChange("src/old-name.ts", { type: "renamed" })];
    const classification = classifyChanges(files);
    expect(classification.category).toBeDefined();
    const risk = assessRisk(files);
    expect(risk.level).toBeDefined();
  });
});

// ─── formatReview ───────────────────────────────────────────────

describe("formatReview", () => {
  it("returns no-changes message for empty review", () => {
    const review: ChangeReview = {
      files: [],
      classification: { category: "refactor", confidence: 0 },
      risk: { level: "low", reasons: [] },
      suggestions: [],
      summary: "No changes found.",
    };
    const output = formatReview(review);
    expect(output).toContain("No changes to review");
  });

  it("includes all sections in formatted output", () => {
    const files = [makeChange("src/core/config.ts")];
    const classification = classifyChanges(files);
    const risk = assessRisk(files);
    const suggestions = generateSuggestions(files, classification, risk);
    const review: ChangeReview = {
      files,
      classification,
      risk,
      suggestions,
      summary: "1 file changed",
    };
    const output = formatReview(review);
    expect(output).toContain("Change Review");
    expect(output).toContain("Category:");
    expect(output).toContain("Risk:");
    expect(output).toContain("Files");
    expect(output).toContain("config.ts");
  });
});
