import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager } from "./plugins.ts";

let tempDir: string;
let userPluginsDir: string;
let pm: PluginManager;

function createPlugin(baseDir: string, name: string, manifest: object, skillFiles?: string[]): void {
  const pluginsDir = join(baseDir, ".kcode", "plugins", name);
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(join(pluginsDir, "plugin.json"), JSON.stringify(manifest));

  if (skillFiles) {
    for (const sf of skillFiles) {
      writeFileSync(join(pluginsDir, sf), `# Skill: ${sf}`);
    }
  }
}

describe("PluginManager", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-plugins-test-"));
    userPluginsDir = join(tempDir, "user-plugins");
    mkdirSync(userPluginsDir, { recursive: true });
    pm = new PluginManager(userPluginsDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("load() with no plugin dirs does not crash", () => {
    const nonExistent = join(tempDir, "nope");
    expect(() => pm.load(nonExistent)).not.toThrow();
    expect(pm.getPlugins()).toEqual([]);
  });

  test("loading a plugin from a directory with plugin.json", () => {
    createPlugin(tempDir, "my-plugin", {
      name: "my-plugin",
      version: "1.0.0",
      description: "A test plugin",
    });

    pm.load(tempDir);
    const plugins = pm.getPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe("my-plugin");
    expect(plugins[0].version).toBe("1.0.0");
    expect(plugins[0].description).toBe("A test plugin");
  });

  test("duplicate plugin name detection skips second", () => {
    // Create two plugins in the same dir with the same name in manifest
    const pluginsBase = join(tempDir, ".kcode", "plugins");

    mkdirSync(join(pluginsBase, "plugin-a"), { recursive: true });
    writeFileSync(join(pluginsBase, "plugin-a", "plugin.json"), JSON.stringify({
      name: "dupe",
      version: "1.0.0",
    }));

    mkdirSync(join(pluginsBase, "plugin-b"), { recursive: true });
    writeFileSync(join(pluginsBase, "plugin-b", "plugin.json"), JSON.stringify({
      name: "dupe",
      version: "2.0.0",
    }));

    pm.load(tempDir);
    const plugins = pm.getPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe("dupe");
  });

  test("getMcpConfigs() prefixes with plugin name", () => {
    createPlugin(tempDir, "mcp-plugin", {
      name: "mcp-plugin",
      version: "0.1.0",
      mcpServers: {
        myServer: {
          command: "node",
          args: ["server.js"],
          env: { FOO: "bar" },
        },
      },
    });

    pm.load(tempDir);
    const configs = pm.getMcpConfigs();
    expect(configs).toHaveProperty("mcp-plugin__myServer");
    expect(configs["mcp-plugin__myServer"].command).toBe("node");
    expect(configs["mcp-plugin__myServer"].args).toEqual(["server.js"]);
    expect(configs["mcp-plugin__myServer"].env).toEqual({ FOO: "bar" });
  });

  test("getHookConfigs() returns proper structure", () => {
    createPlugin(tempDir, "hook-plugin", {
      name: "hook-plugin",
      version: "0.2.0",
      hooks: {
        "pre-commit": {
          command: "lint",
          args: ["--fix"],
        },
        "post-edit": {
          command: "format",
        },
      },
    });

    pm.load(tempDir);
    const hooks = pm.getHookConfigs();
    expect(hooks).toHaveLength(2);
    expect(hooks[0].pluginName).toBe("hook-plugin");
    expect(hooks[0].event).toBe("pre-commit");
    expect(hooks[0].command).toBe("lint");
    expect(hooks[0].args).toEqual(["--fix"]);
    expect(hooks[1].event).toBe("post-edit");
    expect(hooks[1].command).toBe("format");
  });

  test("getSkillPaths() resolves absolute paths", () => {
    createPlugin(tempDir, "skill-plugin", {
      name: "skill-plugin",
      version: "0.3.0",
      skills: ["deploy.md", "review.md"],
    }, ["deploy.md", "review.md"]);

    pm.load(tempDir);
    const paths = pm.getSkillPaths();
    expect(paths).toHaveLength(2);
    for (const p of paths) {
      expect(p.startsWith("/")).toBe(true); // absolute
      expect(p).toContain("skill-plugin");
    }
  });

  test("getSkillPaths() skips non-existent skill files", () => {
    createPlugin(tempDir, "partial-plugin", {
      name: "partial-plugin",
      version: "0.1.0",
      skills: ["exists.md", "missing.md"],
    }, ["exists.md"]); // only create one

    pm.load(tempDir);
    const paths = pm.getSkillPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("exists.md");
  });

  test("formatList() with 0 plugins", () => {
    pm.load(join(tempDir, "empty"));
    const output = pm.formatList();
    expect(output).toContain("No plugins installed");
  });

  test("formatList() with loaded plugins", () => {
    createPlugin(tempDir, "fmt-plugin", {
      name: "fmt-plugin",
      version: "2.0.0",
      description: "Formatter plugin",
      mcpServers: { s1: { command: "x" } },
      hooks: { "pre-save": { command: "fmt" } },
    });

    pm.load(tempDir);
    const output = pm.formatList();
    expect(output).toContain("1 plugin(s) installed");
    expect(output).toContain("fmt-plugin");
    expect(output).toContain("v2.0.0");
    expect(output).toContain("Formatter plugin");
    expect(output).toContain("MCP server(s)");
    expect(output).toContain("hook(s)");
  });
});
