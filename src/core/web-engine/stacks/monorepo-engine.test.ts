import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMonorepoProject } from "./monorepo-engine";

describe("monorepo-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-mono-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("creates Turborepo project with web + api", () => {
    withTmp((dir) => {
      const r = createMonorepoProject("web frontend and API backend called myproj", dir);
      expect(r.config.tool).toBe("turborepo");
      expect(r.config.name).toBe("myproj");
      expect(existsSync(join(dir, "myproj", "turbo.json"))).toBe(true);
      expect(existsSync(join(dir, "myproj", "package.json"))).toBe(true);
      expect(existsSync(join(dir, "myproj", "packages/shared/src/index.ts"))).toBe(true);
    });
  });

  test("creates Nx monorepo", () => {
    withTmp((dir) => {
      const r = createMonorepoProject("Nx monorepo with web", dir);
      expect(r.config.tool).toBe("nx");
      const pkg = JSON.parse(readFileSync(join(r.projectPath, "package.json"), "utf-8"));
      expect(pkg.devDependencies.nx).toBeDefined();
    });
  });

  test("detects pnpm/bun package manager", () => {
    withTmp((dir) => {
      const r = createMonorepoProject("monorepo with bun", dir);
      expect(r.config.packageManager).toBe("bun");
    });
  });

  test("adds UI package when requested", () => {
    withTmp((dir) => {
      const r = createMonorepoProject("web + api + ui components", dir);
      expect(r.config.packages.some((p) => p.type === "ui")).toBe(true);
    });
  });

  test("always includes shared and tsconfig packages", () => {
    withTmp((dir) => {
      const r = createMonorepoProject("web app", dir);
      expect(r.config.packages.some((p) => p.type === "shared")).toBe(true);
      expect(r.config.packages.some((p) => p.type === "config")).toBe(true);
    });
  });

  test("has pnpm-workspace.yaml for pnpm", () => {
    withTmp((dir) => {
      const r = createMonorepoProject("monorepo", dir);
      expect(r.config.packageManager).toBe("pnpm");
      expect(existsSync(join(r.projectPath, "pnpm-workspace.yaml"))).toBe(true);
    });
  });
});
