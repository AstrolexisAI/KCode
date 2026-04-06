import { describe, test, expect } from "bun:test";
import { createFullstackProject } from "./fullstack-engine";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("fullstack-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-full-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates fullstack app with frontend + API", () => {
    withTmp((dir) => {
      const r = createFullstackProject("task management app with users", dir);
      expect(r.totalFiles).toBeGreaterThan(5);
      expect(r.frontend.files).toBeGreaterThan(0);
      expect(r.backend.files).toBeGreaterThan(0);
    });
  });

  test("creates fullstack e-commerce", () => {
    withTmp((dir) => {
      const r = createFullstackProject("e-commerce store with products and orders", dir);
      expect(r.totalFiles).toBeGreaterThan(5);
      expect(r.backend.entities.length).toBeGreaterThan(0);
    });
  });

  test("creates fullstack blog", () => {
    withTmp((dir) => {
      const r = createFullstackProject("blog application with posts and comments", dir);
      expect(r.totalFiles).toBeGreaterThan(4);
    });
  });

  test("returns correct name", () => {
    withTmp((dir) => {
      const r = createFullstackProject("social media app called socialapp", dir);
      expect(r.name).toBe("socialapp");
    });
  });

  test("returns prompt for LLM", () => {
    withTmp((dir) => {
      const r = createFullstackProject("dashboard app", dir);
      expect(r.prompt.length).toBeGreaterThan(10);
    });
  });
});
