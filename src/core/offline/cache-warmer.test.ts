import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheWarmer } from "./cache-warmer";

describe("CacheWarmer", () => {
  let tempHome: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "kcode-cache-warmer-test-"));
    origHome = process.env.HOME;
    // CacheWarmer uses homedir() which reads HOME env var
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  // ─── Configuration ───────────────────────────────────────────

  describe("configuration", () => {
    test("defaults to enabled with 500MB limit", () => {
      const warmer = new CacheWarmer();
      expect(warmer.isEnabled()).toBe(true);
      expect(warmer.shouldWarmOnStartup()).toBe(true);
    });

    test("respects enabled=false", () => {
      const warmer = new CacheWarmer({ enabled: false });
      expect(warmer.isEnabled()).toBe(false);
    });

    test("respects warmupOnStartup=false", () => {
      const warmer = new CacheWarmer({ warmupOnStartup: false });
      expect(warmer.isEnabled()).toBe(true);
      expect(warmer.shouldWarmOnStartup()).toBe(false);
    });
  });

  // ─── warmup ──────────────────────────────────────────────────

  describe("warmup", () => {
    test("returns empty report when disabled", async () => {
      const warmer = new CacheWarmer({ enabled: false });
      const report = await warmer.warmup();
      expect(report.cached).toEqual([]);
      expect(report.errors).toEqual([]);
      expect(report.totalSizeMb).toBe(0);
    });

    test("creates cache directories on warmup", async () => {
      const warmer = new CacheWarmer();
      await warmer.warmup();

      const dirs = warmer.getCacheDirs();
      expect(existsSync(dirs.base)).toBe(true);
      expect(existsSync(dirs.docs)).toBe(true);
      expect(existsSync(dirs.models)).toBe(true);
      expect(existsSync(dirs.search)).toBe(true);
      expect(existsSync(dirs.fetch)).toBe(true);
    });

    test("reports errors gracefully (no crash on network failure)", async () => {
      const warmer = new CacheWarmer();
      // This will try to fetch from servers that are not running and from remote CDN
      // It should not throw, just log errors
      const report = await warmer.warmup();
      expect(report).toHaveProperty("cached");
      expect(report).toHaveProperty("errors");
      expect(report).toHaveProperty("totalSizeMb");
      expect(typeof report.totalSizeMb).toBe("number");
    });
  });

  // ─── getCacheDirs ────────────────────────────────────────────

  describe("getCacheDirs", () => {
    test("returns correct directory structure", () => {
      const warmer = new CacheWarmer();
      const dirs = warmer.getCacheDirs();
      expect(dirs.base).toContain(".kcode/cache");
      expect(dirs.docs).toContain("docs");
      expect(dirs.models).toContain("models");
      expect(dirs.search).toContain("search");
      expect(dirs.fetch).toContain("fetch");
      expect(dirs.plugins).toContain("marketplace-cache");
    });
  });
});
