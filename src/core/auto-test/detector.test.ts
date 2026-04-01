// KCode - Auto-Test Detector Tests

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { detectTests, detectFramework, buildTestCommand } from "./detector";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, `__test_autotest_${process.pid}__`);

beforeAll(() => {
  mkdirSync(join(TEST_DIR, "src"), { recursive: true });
  mkdirSync(join(TEST_DIR, "__tests__"), { recursive: true });

  writeFileSync(join(TEST_DIR, "src", "utils.ts"), `export function add(a: number, b: number) { return a + b; }\n`);
  writeFileSync(join(TEST_DIR, "src", "utils.test.ts"), `import { add } from "./utils";\ntest("add", () => expect(add(1,2)).toBe(3));\n`);
  writeFileSync(join(TEST_DIR, "src", "app.ts"), `export function main() {}\n`);
  writeFileSync(join(TEST_DIR, "src", "app.spec.ts"), `import { main } from "./app";\ntest("main", () => {});\n`);
  writeFileSync(join(TEST_DIR, "src", "no-test.ts"), `export const x = 1;\n`);
  writeFileSync(join(TEST_DIR, "src", "already.test.ts"), `test("self", () => {});\n`);
  writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  writeFileSync(join(TEST_DIR, "bun.lockb"), ""); // Signal bun project
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("detectTests", () => {
  test("finds .test.ts file for source", async () => {
    const result = await detectTests(join(TEST_DIR, "src", "utils.ts"), TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.testFiles.length).toBeGreaterThanOrEqual(1);
    expect(result!.testFiles.some((f) => f.includes("utils.test.ts"))).toBe(true);
  });

  test("finds .spec.ts file for source", async () => {
    const result = await detectTests(join(TEST_DIR, "src", "app.ts"), TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.testFiles.some((f) => f.includes("app.spec.ts"))).toBe(true);
  });

  test("returns null for source without tests", async () => {
    const result = await detectTests(join(TEST_DIR, "src", "no-test.ts"), TEST_DIR);
    expect(result).toBeNull();
  });

  test("skips test files themselves", async () => {
    const result = await detectTests(join(TEST_DIR, "src", "already.test.ts"), TEST_DIR);
    expect(result).toBeNull();
  });

  test("includes test command", async () => {
    const result = await detectTests(join(TEST_DIR, "src", "utils.ts"), TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.command).toContain("bun test");
    expect(result!.command).toContain("utils.test.ts");
  });

  test("sets high confidence for direct matches", async () => {
    const result = await detectTests(join(TEST_DIR, "src", "utils.ts"), TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe("detectFramework", () => {
  test("detects bun from bun.lockb", async () => {
    expect(await detectFramework(TEST_DIR)).toBe("bun");
  });

  test("detects bun from package.json scripts", async () => {
    const tempDir = join(TEST_DIR, "__fw_test__");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    expect(await detectFramework(tempDir)).toBe("bun");
    rmSync(tempDir, { recursive: true });
  });

  test("detects vitest from devDependencies", async () => {
    const tempDir = join(TEST_DIR, "__vitest__");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ devDependencies: { vitest: "^1.0" } }));
    expect(await detectFramework(tempDir)).toBe("vitest");
    rmSync(tempDir, { recursive: true });
  });

  test("detects pytest from pytest.ini", async () => {
    const tempDir = join(TEST_DIR, "__pytest__");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "pytest.ini"), "[pytest]");
    expect(await detectFramework(tempDir)).toBe("pytest");
    rmSync(tempDir, { recursive: true });
  });

  test("detects go from go.mod", async () => {
    const tempDir = join(TEST_DIR, "__go__");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "go.mod"), "module example.com");
    expect(await detectFramework(tempDir)).toBe("go");
    rmSync(tempDir, { recursive: true });
  });
});

describe("buildTestCommand", () => {
  test("builds bun test command", () => {
    expect(buildTestCommand("bun", ["a.test.ts"])).toBe("bun test a.test.ts");
  });

  test("builds vitest command", () => {
    expect(buildTestCommand("vitest", ["a.test.ts"])).toBe("npx vitest run a.test.ts");
  });

  test("builds jest command", () => {
    expect(buildTestCommand("jest", ["a.test.ts"])).toBe("npx jest a.test.ts");
  });

  test("builds pytest command", () => {
    expect(buildTestCommand("pytest", ["test_a.py"])).toBe("pytest test_a.py");
  });

  test("builds go test command", () => {
    expect(buildTestCommand("go", ["./pkg/..."])).toBe("go test ./pkg/...");
  });

  test("builds cargo test command", () => {
    expect(buildTestCommand("cargo", [""])).toBe("cargo test");
  });

  test("handles multiple test files", () => {
    expect(buildTestCommand("bun", ["a.test.ts", "b.test.ts"])).toBe("bun test a.test.ts b.test.ts");
  });
});
