import { describe, expect, test } from "bun:test";
import { buildTestCommand, detectFramework, findRelatedTests } from "./auto-test-detect";

describe("auto-test-detect", () => {
  describe("detectFramework", () => {
    test("detects bun-test in current project", () => {
      const result = detectFramework(process.cwd());
      // This project uses bun
      expect(result.framework).toBe("bun-test");
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.command).toBe("bun test");
    });

    test("returns unknown for empty directory", () => {
      const result = detectFramework("/tmp/nonexistent-dir-" + Date.now());
      expect(result.framework).toBe("unknown");
      expect(result.confidence).toBe(0);
    });
  });

  describe("findRelatedTests", () => {
    test("finds .test.ts for .ts file", () => {
      // In this project, src/core/config.ts → src/core/config.test.ts exists
      const tests = findRelatedTests(process.cwd() + "/src/core/config.ts", process.cwd());
      expect(tests.length).toBeGreaterThan(0);
      expect(tests[0]).toContain("config.test.ts");
    });

    test("returns empty for file without tests", () => {
      const tests = findRelatedTests("/tmp/nonexistent.ts", "/tmp");
      expect(tests).toHaveLength(0);
    });
  });

  describe("buildTestCommand", () => {
    test("builds targeted test command for modified files", () => {
      const mappings = buildTestCommand([process.cwd() + "/src/core/config.ts"], process.cwd());
      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings[0]!.framework).toBe("bun-test");
      expect(mappings[0]!.runCommand).toContain("bun test");
      expect(mappings[0]!.runCommand).toContain("config.test.ts");
    });

    test("returns empty for files without tests", () => {
      const mappings = buildTestCommand(["/tmp/foo.ts"], process.cwd());
      expect(mappings).toHaveLength(0);
    });
  });
});
