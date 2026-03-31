import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPlugin } from "./verifier";

let tempDir: string;

function createPluginDir(manifest: object, files?: Record<string, string>): string {
  const pluginDir = join(tempDir, `plugin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest));
  if (files) {
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(pluginDir, path);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, content);
    }
  }
  return pluginDir;
}

describe("verifyPlugin", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-verifier-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("valid plugin with all fields", () => {
    const dir = createPluginDir(
      {
        name: "good-plugin",
        version: "1.0.0",
        description: "A valid plugin",
        skills: ["deploy.md"],
        hooks: { "pre-commit": { command: "lint" } },
        mcpServers: { myServer: { command: "node", args: ["server.js"] } },
      },
      { "deploy.md": "# Deploy skill" },
    );

    const result = verifyPlugin(dir);
    expect(result.valid).toBe(true);
    expect(result.issues.filter(i => i.severity === "error")).toHaveLength(0);
  });

  test("detects missing plugin.json", () => {
    mkdirSync(join(tempDir, "empty-plugin"), { recursive: true });
    const result = verifyPlugin(join(tempDir, "empty-plugin"));
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === "NO_MANIFEST")).toBe(true);
  });

  test("detects invalid JSON in plugin.json", () => {
    const dir = join(tempDir, "bad-json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), "not valid json{{{");

    const result = verifyPlugin(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === "INVALID_MANIFEST")).toBe(true);
  });

  test("detects missing name field", () => {
    const dir = createPluginDir({ version: "1.0.0" });
    const result = verifyPlugin(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === "NO_NAME")).toBe(true);
  });

  test("detects missing version field", () => {
    const dir = createPluginDir({ name: "test" });
    const result = verifyPlugin(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === "NO_VERSION")).toBe(true);
  });

  test("detects missing skill files", () => {
    const dir = createPluginDir({
      name: "test",
      version: "1.0.0",
      skills: ["exists.md", "missing.md"],
    }, { "exists.md": "content" });

    const result = verifyPlugin(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === "MISSING_SKILL" && i.message.includes("missing.md"))).toBe(true);
  });

  test("detects path traversal in skills", () => {
    const dir = createPluginDir({
      name: "test",
      version: "1.0.0",
      skills: ["../../../etc/passwd"],
    });

    const result = verifyPlugin(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === "PATH_TRAVERSAL")).toBe(true);
  });

  test("detects path traversal with absolute path", () => {
    const dir = createPluginDir({
      name: "test",
      version: "1.0.0",
      skills: ["/etc/passwd"],
    });

    const result = verifyPlugin(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === "PATH_TRAVERSAL")).toBe(true);
  });

  test("detects MCP server without command", () => {
    const dir = createPluginDir({
      name: "test",
      version: "1.0.0",
      mcpServers: { bad: { args: ["x"] } },
    });

    const result = verifyPlugin(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === "MCP_NO_CMD")).toBe(true);
  });

  test("warns on unknown hook events", () => {
    const dir = createPluginDir({
      name: "test",
      version: "1.0.0",
      hooks: { "unknown-event": { command: "test" } },
    });

    const result = verifyPlugin(dir);
    // Unknown hook is a warning, not an error
    expect(result.valid).toBe(true);
    expect(result.issues.some(i => i.code === "UNKNOWN_HOOK_EVENT")).toBe(true);
  });

  test("detects hook without command", () => {
    const dir = createPluginDir({
      name: "test",
      version: "1.0.0",
      hooks: { "pre-commit": { args: ["--fix"] } },
    });

    const result = verifyPlugin(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === "HOOK_NO_CMD")).toBe(true);
  });

  test("warns on large plugins", () => {
    // Create a plugin with a large file (>10MB)
    const dir = createPluginDir(
      { name: "big", version: "1.0.0" },
      { "big-file.bin": "x".repeat(10_500_000) },
    );

    const result = verifyPlugin(dir);
    expect(result.valid).toBe(true); // Large size is a warning, not error
    expect(result.issues.some(i => i.code === "LARGE_PLUGIN")).toBe(true);
  });

  test("validates output style paths", () => {
    const dir = createPluginDir({
      name: "test",
      version: "1.0.0",
      outputStyles: ["../escape.md"],
    });

    const result = verifyPlugin(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === "PATH_TRAVERSAL" && i.message.includes("escape.md"))).toBe(true);
  });

  test("validates agent paths for traversal", () => {
    const dir = createPluginDir({
      name: "test",
      version: "1.0.0",
      agents: ["../../../etc/shadow"],
    });

    const result = verifyPlugin(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === "PATH_TRAVERSAL")).toBe(true);
  });

  test("minimal valid plugin (name + version only)", () => {
    const dir = createPluginDir({ name: "minimal", version: "0.1.0" });
    const result = verifyPlugin(dir);
    expect(result.valid).toBe(true);
    expect(result.issues.filter(i => i.severity === "error")).toHaveLength(0);
  });

  test("hook array format is validated", () => {
    const dir = createPluginDir({
      name: "test",
      version: "1.0.0",
      hooks: [
        { event: "pre-commit", command: "lint" },
        { event: "post-edit" }, // missing command
      ],
    });

    const result = verifyPlugin(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === "HOOK_NO_CMD")).toBe(true);
  });
});
