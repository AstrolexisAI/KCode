import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createPlugin } from "./create";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PluginScaffoldConfig } from "../../../core/plugin-sdk/types";

describe("createPlugin", () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "kcode-create-test-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  const baseConfig: PluginScaffoldConfig = {
    name: "test-plugin",
    description: "A test plugin",
    author: "Test Author",
    license: "MIT",
    components: ["skills"],
    language: "markdown",
  };

  test("creates plugin directory", async () => {
    const dir = await createPlugin(baseConfig);
    expect(existsSync(dir)).toBe(true);
  });

  test("generates valid plugin.json", async () => {
    const dir = await createPlugin(baseConfig);
    const manifest = JSON.parse(
      readFileSync(join(dir, "plugin.json"), "utf-8"),
    );
    expect(manifest.name).toBe("test-plugin");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("A test plugin");
    expect(manifest.author).toBe("Test Author");
    expect(manifest.license).toBe("MIT");
    expect(manifest.kcode).toBe(">=1.8.0");
  });

  test("creates skills directory and example", async () => {
    const dir = await createPlugin(baseConfig);
    expect(existsSync(join(dir, "skills"))).toBe(true);
    expect(existsSync(join(dir, "skills/example.md"))).toBe(true);
    const content = readFileSync(join(dir, "skills/example.md"), "utf-8");
    expect(content).toContain("name: example");
    expect(content).toContain("description:");
  });

  test("creates agents directory and example", async () => {
    const config = { ...baseConfig, components: ["agents"] as any };
    const dir = await createPlugin(config);
    expect(existsSync(join(dir, "agents/helper.md"))).toBe(true);
    const content = readFileSync(join(dir, "agents/helper.md"), "utf-8");
    expect(content).toContain("name: test-plugin-helper");
  });

  test("creates output-styles directory", async () => {
    const config = { ...baseConfig, components: ["output-styles"] as any };
    const dir = await createPlugin(config);
    expect(existsSync(join(dir, "output-styles/concise.md"))).toBe(true);
  });

  test("creates hooks in manifest", async () => {
    const config = { ...baseConfig, components: ["hooks"] as any };
    const dir = await createPlugin(config);
    const manifest = JSON.parse(
      readFileSync(join(dir, "plugin.json"), "utf-8"),
    );
    expect(manifest.hooks).toBeDefined();
    expect(manifest.hooks.PostToolUse).toBeArray();
  });

  test("creates MCP server config", async () => {
    const config = { ...baseConfig, components: ["mcp"] as any };
    const dir = await createPlugin(config);
    const manifest = JSON.parse(
      readFileSync(join(dir, "plugin.json"), "utf-8"),
    );
    expect(manifest.mcpServers).toBeDefined();
    expect(manifest.mcpServers["example-server"]).toBeDefined();
  });

  test("creates README.md", async () => {
    const dir = await createPlugin(baseConfig);
    const readme = readFileSync(join(dir, "README.md"), "utf-8");
    expect(readme).toContain("test-plugin");
    expect(readme).toContain("A test plugin");
  });

  test("creates test directory and file", async () => {
    const dir = await createPlugin(baseConfig);
    expect(existsSync(join(dir, "tests/plugin.test.ts"))).toBe(true);
  });

  test("creates .gitignore", async () => {
    const dir = await createPlugin(baseConfig);
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gitignore).toContain("node_modules/");
  });

  test("creates package.json for typescript projects", async () => {
    const config = { ...baseConfig, language: "typescript" as const };
    const dir = await createPlugin(config);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "tsconfig.json"))).toBe(true);
  });

  test("handles multiple components", async () => {
    const config: PluginScaffoldConfig = {
      ...baseConfig,
      components: ["skills", "hooks", "agents", "output-styles"],
    };
    const dir = await createPlugin(config);
    expect(existsSync(join(dir, "skills"))).toBe(true);
    expect(existsSync(join(dir, "hooks"))).toBe(true);
    expect(existsSync(join(dir, "agents"))).toBe(true);
    expect(existsSync(join(dir, "output-styles"))).toBe(true);
  });
});
