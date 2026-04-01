import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Point KCODE_HOME to a temp directory so we don't pollute the real config
const TEST_HOME = join(tmpdir(), `kcode-marketplace-test-${Date.now()}`);

describe("plugin-marketplace", () => {
  beforeEach(() => {
    process.env.KCODE_HOME = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_HOME, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    delete process.env.KCODE_HOME;
  });

  test("searchPlugins returns MarketplacePlugin[] with correct shape", async () => {
    const { searchPlugins } = await import("./plugin-marketplace");
    const results = await searchPlugins("");
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    const first = results[0]!;
    expect(typeof first.name).toBe("string");
    expect(typeof first.version).toBe("string");
    expect(typeof first.description).toBe("string");
    expect(typeof first.author).toBe("string");
    expect(typeof first.downloads).toBe("number");
    expect(typeof first.rating).toBe("number");
    expect(Array.isArray(first.categories)).toBe(true);
  });

  test("searchPlugins filters by query", async () => {
    const { searchPlugins } = await import("./plugin-marketplace");
    const results = await searchPlugins("docker");
    expect(results.length).toBeGreaterThan(0);
    const hasDocker = results.some(
      (p) =>
        p.name.toLowerCase().includes("docker") ||
        p.description.toLowerCase().includes("docker"),
    );
    expect(hasDocker).toBe(true);
  });

  test("searchPlugins returns empty for unmatched query", async () => {
    const { searchPlugins } = await import("./plugin-marketplace");
    const results = await searchPlugins("zzz_nonexistent_xyz_plugin_12345");
    expect(results).toEqual([]);
  });

  test("installPlugin throws for empty name", async () => {
    const { installPlugin } = await import("./plugin-marketplace");
    expect(installPlugin("")).rejects.toThrow("Plugin name is required");
  });

  test("installPlugin throws for unknown plugin", async () => {
    const { installPlugin } = await import("./plugin-marketplace");
    expect(installPlugin("nonexistent-plugin-xyz")).rejects.toThrow("not found in marketplace");
  });

  test("installPlugin creates plugin directory and manifest", async () => {
    const { installPlugin } = await import("./plugin-marketplace");
    await installPlugin("kcode-docker");

    const pluginDir = join(TEST_HOME, "plugins", "kcode-docker");
    expect(existsSync(pluginDir)).toBe(true);
    expect(existsSync(join(pluginDir, "plugin.json"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf-8"));
    expect(manifest.name).toBe("kcode-docker");
    expect(typeof manifest.version).toBe("string");
  });

  test("installPlugin throws for already-installed plugin", async () => {
    const { installPlugin } = await import("./plugin-marketplace");
    await installPlugin("kcode-database");
    expect(installPlugin("kcode-database")).rejects.toThrow("already installed");
  });

  test("checkPluginUpdates returns PluginUpdate[] shape", async () => {
    const { checkPluginUpdates } = await import("./plugin-marketplace");
    const updates = await checkPluginUpdates();
    expect(Array.isArray(updates)).toBe(true);
    for (const u of updates) {
      expect(typeof u.name).toBe("string");
      expect(typeof u.currentVersion).toBe("string");
      expect(typeof u.latestVersion).toBe("string");
    }
  });

  test("checkPluginUpdates detects version mismatch", async () => {
    const { checkPluginUpdates } = await import("./plugin-marketplace");
    // Manually write a config with an old version
    const configPath = join(TEST_HOME, "marketplace.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        installed: { "kcode-docker": { version: "0.0.1", installedAt: new Date().toISOString() } },
      }),
      "utf-8",
    );

    const updates = await checkPluginUpdates();
    const dockerUpdate = updates.find((u) => u.name === "kcode-docker");
    expect(dockerUpdate).toBeDefined();
    expect(dockerUpdate!.currentVersion).toBe("0.0.1");
    expect(dockerUpdate!.latestVersion).toBeTruthy();
  });

  test("listRemotePlugins returns all available plugins", async () => {
    const { listRemotePlugins } = await import("./plugin-marketplace");
    const plugins = await listRemotePlugins();
    expect(plugins.length).toBeGreaterThan(0);
  });

  test("formatMarketplaceResults formats output", async () => {
    const { formatMarketplaceResults } = await import("./plugin-marketplace");

    const empty = formatMarketplaceResults([]);
    expect(empty).toContain("No plugins found");

    const formatted = formatMarketplaceResults([
      {
        name: "test-plugin",
        version: "1.0.0",
        description: "A test plugin",
        author: "Tester",
        downloads: 100,
        rating: 4.5,
        categories: ["testing"],
      },
    ]);
    expect(formatted).toContain("test-plugin");
    expect(formatted).toContain("1.0.0");
    expect(formatted).toContain("Tester");
  });

  test("MarketplacePlugin interface has categories (not tags)", async () => {
    const { searchPlugins } = await import("./plugin-marketplace");
    const results = await searchPlugins("");
    for (const p of results) {
      expect(Array.isArray(p.categories)).toBe(true);
      expect((p as any).tags).toBeUndefined();
    }
  });
});
