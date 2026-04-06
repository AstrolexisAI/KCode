import { describe, test, expect } from "bun:test";
import { createWebProject } from "./web-engine";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("web-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-web-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates Next.js landing page", () => {
    withTmp((dir) => {
      const r = createWebProject("landing page for a SaaS product", dir);
      expect(r.machineFiles + r.llmFiles).toBeGreaterThan(3);
      expect(existsSync(join(r.projectPath, "package.json"))).toBe(true);
    });
  });

  test("creates Astro blog", () => {
    withTmp((dir) => {
      const r = createWebProject("blog with Astro", dir);
      expect(r.machineFiles + r.llmFiles).toBeGreaterThan(2);
      expect(existsSync(r.projectPath)).toBe(true);
    });
  });

  test("creates SvelteKit app", () => {
    withTmp((dir) => {
      const r = createWebProject("dashboard with SvelteKit", dir);
      expect(r.machineFiles + r.llmFiles).toBeGreaterThan(2);
      expect(existsSync(r.projectPath)).toBe(true);
    });
  });

  test("creates plain HTML site", () => {
    withTmp((dir) => {
      const r = createWebProject("simple HTML landing page", dir);
      expect(r.machineFiles + r.llmFiles).toBeGreaterThan(1);
      expect(existsSync(r.projectPath)).toBe(true);
    });
  });

  test("creates e-commerce site", () => {
    withTmp((dir) => {
      const r = createWebProject("e-commerce store", dir);
      expect(r.machineFiles + r.llmFiles).toBeGreaterThan(3);
    });
  });

  test("creates portfolio site", () => {
    withTmp((dir) => {
      const r = createWebProject("portfolio website", dir);
      expect(r.machineFiles + r.llmFiles).toBeGreaterThan(2);
    });
  });

  test("returns prompt for LLM customization", () => {
    withTmp((dir) => {
      const r = createWebProject("SaaS dashboard", dir);
      expect(r.prompt.length).toBeGreaterThan(10);
    });
  });

  test("detects intent correctly", () => {
    withTmp((dir) => {
      const r = createWebProject("blog called myblog", dir);
      expect(r.intent).toBeDefined();
      expect(r.intent.name).toBe("myblog");
    });
  });
});
