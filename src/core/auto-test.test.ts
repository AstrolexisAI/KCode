import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRelatedTest, getTestCommand } from "./auto-test";

let tempDir: string;

describe("auto-test", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-autotest-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("finds .test.ts file in same directory", async () => {
    await writeFile(join(tempDir, "utils.ts"), "export const x = 1;");
    await writeFile(join(tempDir, "utils.test.ts"), "test('x', () => {});");

    const result = findRelatedTest(join(tempDir, "utils.ts"));
    expect(result).toBe(join(tempDir, "utils.test.ts"));
  });

  test("finds .spec.ts file in same directory", async () => {
    await writeFile(join(tempDir, "service.ts"), "export class Svc {}");
    await writeFile(join(tempDir, "service.spec.ts"), "test('svc', () => {});");

    const result = findRelatedTest(join(tempDir, "service.ts"));
    expect(result).toBe(join(tempDir, "service.spec.ts"));
  });

  test("finds test in __tests__ directory", async () => {
    await mkdir(join(tempDir, "__tests__"), { recursive: true });
    await writeFile(join(tempDir, "parser.ts"), "export function parse() {}");
    await writeFile(join(tempDir, "__tests__", "parser.test.ts"), "test('parse', () => {});");

    const result = findRelatedTest(join(tempDir, "parser.ts"));
    expect(result).toBe(join(tempDir, "__tests__", "parser.test.ts"));
  });

  test("returns null for test files", () => {
    const result = findRelatedTest("/src/utils.test.ts");
    expect(result).toBeNull();
  });

  test("returns null when no test exists", () => {
    const result = findRelatedTest(join(tempDir, "notest.ts"));
    expect(result).toBeNull();
  });

  test("detects bun test runner", async () => {
    await writeFile(join(tempDir, "bun.lockb"), "");
    const cmd = getTestCommand("src/utils.test.ts", tempDir);
    expect(cmd).toBe("bun test src/utils.test.ts");
  });

  test("detects vitest runner", async () => {
    await writeFile(join(tempDir, "vitest.config.ts"), "");
    const cmd = getTestCommand("src/utils.test.ts", tempDir);
    expect(cmd).toBe("npx vitest run src/utils.test.ts");
  });
});
