import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeProject } from "./node-engine";

describe("node-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-node-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("creates CLI project with TypeScript by default", () => {
    withTmp((dir) => {
      const r = createNodeProject("CLI tool called mytool", dir);
      expect(r.config.type).toBe("cli");
      expect(r.config.name).toBe("mytool");
      expect(r.config.useTs).toBe(true);
      expect(existsSync(join(dir, "mytool", "package.json"))).toBe(true);
      expect(existsSync(join(dir, "mytool", "tsconfig.json"))).toBe(true);
      expect(existsSync(join(dir, "mytool", "src/cli.ts"))).toBe(true);
    });
  });

  test("creates JavaScript project when requested", () => {
    withTmp((dir) => {
      const r = createNodeProject("javascript CLI tool", dir);
      expect(r.config.useTs).toBe(false);
      expect(existsSync(join(dir, "myapp", "src/cli.js"))).toBe(true);
    });
  });

  test("detects library type", () => {
    withTmp((dir) => {
      const r = createNodeProject("npm package library", dir);
      expect(r.config.type).toBe("library");
    });
  });

  test("detects Discord bot", () => {
    withTmp((dir) => {
      const r = createNodeProject("Discord bot", dir);
      expect(r.config.type).toBe("bot");
      expect(r.config.deps).toContain("discord.js");
    });
  });

  test("detects worker type with bullmq", () => {
    withTmp((dir) => {
      const r = createNodeProject("worker with Redis queue", dir);
      expect(r.config.type).toBe("worker");
      expect(r.config.deps).toContain("bullmq");
    });
  });

  test("adds prisma for database keyword", () => {
    withTmp((dir) => {
      const r = createNodeProject("CLI with database", dir);
      expect(r.config.deps).toContain("prisma");
    });
  });
});
