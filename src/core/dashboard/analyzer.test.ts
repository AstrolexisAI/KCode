// KCode - Dashboard Analyzer Tests

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProjectAnalyzer } from "./analyzer";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, `__test_project_${process.pid}__`);

beforeAll(() => {
  mkdirSync(join(TEST_DIR, "src"), { recursive: true });
  mkdirSync(join(TEST_DIR, "coverage"), { recursive: true });

  // package.json
  writeFileSync(
    join(TEST_DIR, "package.json"),
    JSON.stringify({
      name: "test-project",
      scripts: { test: "bun test" },
      dependencies: { express: "^4.18.0", zod: "^3.22.0" },
      devDependencies: { typescript: "^5.0.0" },
    }),
  );

  // tsconfig.json
  writeFileSync(join(TEST_DIR, "tsconfig.json"), "{}");

  // Source files
  writeFileSync(
    join(TEST_DIR, "src", "index.ts"),
    `// TODO: implement main entry\nfunction main() {\n  console.log("hello");\n}\n`,
  );
  writeFileSync(
    join(TEST_DIR, "src", "utils.ts"),
    `// FIXME: refactor this\nexport function add(a: number, b: number) {\n  return a + b;\n}\n`,
  );
  writeFileSync(
    join(TEST_DIR, "src", "app.test.ts"),
    `import { test, expect } from "bun:test";\ntest("example", () => { expect(1).toBe(1); });\n`,
  );

  // Coverage summary
  writeFileSync(
    join(TEST_DIR, "coverage", "coverage-summary.json"),
    JSON.stringify({ total: { lines: { pct: 78.5 }, statements: { pct: 80.2 } } }),
  );

  // Git init so git log works
  Bun.spawnSync(["git", "init"], { cwd: TEST_DIR });
  Bun.spawnSync(["git", "add", "."], { cwd: TEST_DIR });
  Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@test.com", "commit", "-m", "init"], { cwd: TEST_DIR });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ProjectAnalyzer", () => {
  const analyzer = new ProjectAnalyzer();

  test("analyze returns complete dashboard", async () => {
    const dashboard = await analyzer.analyze(TEST_DIR);
    expect(dashboard).toBeDefined();
    expect(dashboard.project).toBeDefined();
    expect(dashboard.tests).toBeDefined();
    expect(dashboard.codeQuality).toBeDefined();
    expect(dashboard.activity).toBeDefined();
    expect(dashboard.dependencies).toBeDefined();
  });

  test("detects project name from package.json", async () => {
    const dashboard = await analyzer.analyze(TEST_DIR);
    expect(dashboard.project.name).toBe("test-project");
  });

  test("detects TypeScript language", async () => {
    const dashboard = await analyzer.analyze(TEST_DIR);
    expect(dashboard.project.language).toBe("TypeScript");
  });

  test("counts source files", async () => {
    const dashboard = await analyzer.analyze(TEST_DIR);
    expect(dashboard.project.files).toBeGreaterThanOrEqual(2);
  });

  test("counts lines of code", async () => {
    const dashboard = await analyzer.analyze(TEST_DIR);
    expect(dashboard.project.linesOfCode).toBeGreaterThan(0);
  });

  test("detects test framework", async () => {
    const dashboard = await analyzer.analyze(TEST_DIR);
    expect(dashboard.tests.framework).toContain("bun");
  });

  test("finds test files", async () => {
    const dashboard = await analyzer.analyze(TEST_DIR);
    expect(dashboard.tests.total).toBeGreaterThanOrEqual(1);
  });

  test("parses coverage from coverage-summary.json", async () => {
    const dashboard = await analyzer.analyze(TEST_DIR);
    expect(dashboard.tests.coverage).toBe(79); // Math.round(78.5)
  });

  test("finds TODO and FIXME comments", async () => {
    const dashboard = await analyzer.analyze(TEST_DIR);
    expect(dashboard.codeQuality.todos).toBeGreaterThanOrEqual(2);
    expect(dashboard.codeQuality.todoList.length).toBeGreaterThanOrEqual(2);

    const todoTexts = dashboard.codeQuality.todoList.map(t => t.text);
    expect(todoTexts.some(t => t.includes("TODO"))).toBe(true);
    expect(todoTexts.some(t => t.includes("FIXME"))).toBe(true);
  });

  test("counts dependencies", async () => {
    const dashboard = await analyzer.analyze(TEST_DIR);
    expect(dashboard.dependencies.total).toBe(3); // express + zod + typescript
  });

  test("activity returns defaults when no analytics data", async () => {
    const dashboard = await analyzer.analyze(TEST_DIR);
    expect(dashboard.activity.sessionsLast7Days).toBeGreaterThanOrEqual(0);
    expect(dashboard.activity.tokensLast7Days).toBeGreaterThanOrEqual(0);
    expect(dashboard.activity.costLast7Days).toBeGreaterThanOrEqual(0);
  });

  test("last commit time is valid", async () => {
    const dashboard = await analyzer.analyze(TEST_DIR);
    expect(dashboard.project.lastCommit).not.toBe("unknown");
  });
});

describe("ProjectAnalyzer — error resilience", () => {
  const analyzer = new ProjectAnalyzer();

  test("handles non-existent directory gracefully", async () => {
    const dashboard = await analyzer.analyze("/nonexistent/path/unlikely");
    expect(dashboard).toBeDefined();
    expect(dashboard.project.name).toBeDefined();
    expect(dashboard.project.files).toBe(0);
    expect(dashboard.project.linesOfCode).toBe(0);
  });
});
