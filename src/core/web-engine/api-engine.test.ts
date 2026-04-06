import { describe, test, expect } from "bun:test";
import { createApiProject } from "./api-engine";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("api-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-api-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates Express API with entities", () => {
    withTmp((dir) => {
      const r = createApiProject("API for users and products", dir);
      expect(r.files.length).toBeGreaterThan(3);
      expect(existsSync(join(r.projectPath, "package.json"))).toBe(true);
      const pkg = JSON.parse(readFileSync(join(r.projectPath, "package.json"), "utf-8"));
      expect(pkg.dependencies).toBeDefined();
    });
  });

  test("detects entity names from description", () => {
    withTmp((dir) => {
      const r = createApiProject("REST API with users, orders, and tasks", dir);
      expect(r.files.length).toBeGreaterThan(5);
    });
  });

  test("creates API with auth entities", () => {
    withTmp((dir) => {
      const r = createApiProject("API with authentication and posts", dir);
      expect(r.files.length).toBeGreaterThan(3);
    });
  });

  test("creates basic API without specific entities", () => {
    withTmp((dir) => {
      const r = createApiProject("simple REST API", dir);
      expect(r.files.length).toBeGreaterThan(2);
      expect(existsSync(r.projectPath)).toBe(true);
    });
  });
});
