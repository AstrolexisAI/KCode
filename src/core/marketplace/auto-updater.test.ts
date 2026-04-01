import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoUpdatePlugins,
  isNewerVersion,
  readLastCheckTimestamp,
  writeLastCheckTimestamp,
} from "./auto-updater";
import type { CatalogEntry } from "./types";

let tempDir: string;
let cacheDir: string;

describe("auto-updater", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-auto-updater-test-"));
    cacheDir = join(tempDir, "cache");
    mkdirSync(cacheDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── isNewerVersion ────────────────────────────────────────

  test("isNewerVersion: major bump", () => {
    expect(isNewerVersion("2.0.0", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "2.0.0")).toBe(false);
  });

  test("isNewerVersion: minor bump", () => {
    expect(isNewerVersion("1.2.0", "1.1.0")).toBe(true);
    expect(isNewerVersion("1.1.0", "1.2.0")).toBe(false);
  });

  test("isNewerVersion: patch bump", () => {
    expect(isNewerVersion("1.0.2", "1.0.1")).toBe(true);
    expect(isNewerVersion("1.0.1", "1.0.2")).toBe(false);
  });

  test("isNewerVersion: same version", () => {
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
  });

  test("isNewerVersion: handles v prefix", () => {
    expect(isNewerVersion("v2.0.0", "v1.0.0")).toBe(true);
  });

  test("isNewerVersion: handles two-part versions", () => {
    expect(isNewerVersion("1.1", "1.0")).toBe(true);
  });

  // ─── Timestamp persistence ─────────────────────────────────

  test("readLastCheckTimestamp returns 0 when no file exists", () => {
    const ts = readLastCheckTimestamp(join(tempDir, "nonexistent"));
    expect(ts).toBe(0);
  });

  test("writeLastCheckTimestamp and readLastCheckTimestamp roundtrip", () => {
    const now = Date.now();
    writeLastCheckTimestamp(cacheDir, now);
    const read = readLastCheckTimestamp(cacheDir);
    expect(read).toBe(now);
  });

  // ─── autoUpdatePlugins ─────────────────────────────────────

  test("skips if not enabled", async () => {
    const report = await autoUpdatePlugins({ enabled: false }, cacheDir, []);
    expect(report.skipped).toBe(true);
    expect(report.updated).toHaveLength(0);
  });

  test("skips if check interval has not elapsed", async () => {
    // Write a recent timestamp
    writeLastCheckTimestamp(cacheDir, Date.now());

    const report = await autoUpdatePlugins(
      { enabled: true, checkIntervalMs: 86_400_000, marketplaces: ["test"] },
      cacheDir,
      [{ name: "plugin-a", version: "1.0.0" }],
    );

    expect(report.skipped).toBe(true);
  });

  test("checks for updates when interval has elapsed", async () => {
    // Write an old timestamp (2 days ago)
    writeLastCheckTimestamp(cacheDir, Date.now() - 2 * 86_400_000);

    const catalog: CatalogEntry[] = [{ name: "plugin-a", version: "2.0.0", sha256: "abc" }];

    let fetchCalled = false;
    const mockFetchCatalog = async (_url: string) => {
      fetchCalled = true;
      return catalog;
    };

    let downloadedPlugin = "";
    const mockFetcher = {
      fetchPlugin: async (name: string, _version?: string) => {
        downloadedPlugin = name;
        return { pluginDir: "/tmp/test", version: "2.0.0", sha256: "abc", fromCache: false };
      },
      getSHATracker: () => ({
        getStoredSHA: () => null,
        setSHA: () => {},
        needsUpdate: () => true,
        invalidate: () => {},
      }),
    };

    const report = await autoUpdatePlugins(
      { enabled: true, checkIntervalMs: 86_400_000, marketplaces: ["test"] },
      cacheDir,
      [{ name: "plugin-a", version: "1.0.0" }],
      { fetchCatalog: mockFetchCatalog, cdnFetcher: mockFetcher as any },
    );

    expect(report.skipped).toBe(false);
    expect(fetchCalled).toBe(true);
    expect(downloadedPlugin).toBe("plugin-a");
    expect(report.updated).toHaveLength(1);
    expect(report.updated[0]!.name).toBe("plugin-a");
    expect(report.updated[0]!.from).toBe("1.0.0");
    expect(report.updated[0]!.to).toBe("2.0.0");
  });

  test("does not update if remote version is not newer", async () => {
    writeLastCheckTimestamp(cacheDir, Date.now() - 2 * 86_400_000);

    const catalog: CatalogEntry[] = [{ name: "plugin-a", version: "1.0.0", sha256: "abc" }];

    const report = await autoUpdatePlugins(
      { enabled: true, checkIntervalMs: 86_400_000, marketplaces: ["test"] },
      cacheDir,
      [{ name: "plugin-a", version: "1.0.0" }],
      { fetchCatalog: async () => catalog },
    );

    expect(report.skipped).toBe(false);
    expect(report.updated).toHaveLength(0);
  });

  test("records failed updates without breaking other plugins", async () => {
    writeLastCheckTimestamp(cacheDir, Date.now() - 2 * 86_400_000);

    const catalog: CatalogEntry[] = [
      { name: "plugin-a", version: "2.0.0", sha256: "abc" },
      { name: "plugin-b", version: "3.0.0", sha256: "def" },
    ];

    let callCount = 0;
    const mockFetcher = {
      fetchPlugin: async (name: string, _version?: string) => {
        callCount++;
        if (name === "plugin-a") throw new Error("download failed");
        return { pluginDir: "/tmp/test", version: "3.0.0", sha256: "def", fromCache: false };
      },
      getSHATracker: () => ({
        getStoredSHA: () => null,
        setSHA: () => {},
        needsUpdate: () => true,
        invalidate: () => {},
      }),
    };

    const report = await autoUpdatePlugins(
      { enabled: true, checkIntervalMs: 86_400_000, marketplaces: ["test"] },
      cacheDir,
      [
        { name: "plugin-a", version: "1.0.0" },
        { name: "plugin-b", version: "2.0.0" },
      ],
      { fetchCatalog: async () => catalog, cdnFetcher: mockFetcher as any },
    );

    expect(callCount).toBe(2);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.name).toBe("plugin-a");
    expect(report.updated).toHaveLength(1);
    expect(report.updated[0]!.name).toBe("plugin-b");
  });

  test("writes new timestamp after check", async () => {
    writeLastCheckTimestamp(cacheDir, Date.now() - 2 * 86_400_000);

    const beforeCheck = Date.now();
    await autoUpdatePlugins(
      { enabled: true, checkIntervalMs: 86_400_000, marketplaces: ["test"] },
      cacheDir,
      [],
      { fetchCatalog: async () => [] },
    );

    const ts = readLastCheckTimestamp(cacheDir);
    expect(ts).toBeGreaterThanOrEqual(beforeCheck);
  });

  test("handles catalog fetch failure gracefully", async () => {
    writeLastCheckTimestamp(cacheDir, Date.now() - 2 * 86_400_000);

    const report = await autoUpdatePlugins(
      { enabled: true, checkIntervalMs: 86_400_000, marketplaces: ["test"] },
      cacheDir,
      [{ name: "plugin-a", version: "1.0.0" }],
      {
        fetchCatalog: async () => {
          throw new Error("network error");
        },
      },
    );

    expect(report.skipped).toBe(false);
    expect(report.updated).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
  });
});
