import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { testPlugin, formatTestResults } from "./test-runner";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("testPlugin", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kcode-testrunner-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(manifest: Record<string, unknown>): void {
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  }

  const validManifest = {
    name: "test-plugin",
    version: "1.0.0",
    description: "A test plugin",
    author: "Test",
    license: "MIT",
  };

  test("passes with valid manifest", async () => {
    writeManifest(validManifest);
    const results = await testPlugin(dir);
    const manifestTest = results.find((r) => r.name === "manifest-load");
    expect(manifestTest?.status).toBe("pass");
  });

  test("fails without manifest", async () => {
    const results = await testPlugin(dir);
    expect(results[0].status).toBe("fail");
    expect(results[0].error).toContain("plugin.json");
  });

  test("fails with invalid version", async () => {
    writeManifest({ ...validManifest, version: "bad" });
    const results = await testPlugin(dir);
    const versionTest = results.find((r) => r.name === "manifest-version");
    expect(versionTest?.status).toBe("fail");
  });

  test("validates skill files", async () => {
    writeManifest({ ...validManifest, skills: ["skills/*.md"] });
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(
      join(dir, "skills/example.md"),
      "---\nname: example\ndescription: Test\n---\nContent",
    );
    const results = await testPlugin(dir);
    const skillTest = results.find((r) => r.name.startsWith("skill-parse:"));
    expect(skillTest?.status).toBe("pass");
  });

  test("fails on skill without frontmatter", async () => {
    writeManifest({ ...validManifest, skills: ["skills/*.md"] });
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "skills/bad.md"), "No frontmatter");
    const results = await testPlugin(dir);
    const skillTest = results.find((r) => r.name.startsWith("skill-parse:"));
    expect(skillTest?.status).toBe("fail");
  });

  test("skips user-tests when no tests dir", async () => {
    writeManifest(validManifest);
    const results = await testPlugin(dir);
    const userTest = results.find((r) => r.name === "user-tests");
    expect(userTest?.status).toBe("skip");
  });

  test("validates MCP server config", async () => {
    writeManifest({
      ...validManifest,
      mcpServers: { test: { command: "echo" } },
    });
    const results = await testPlugin(dir);
    const mcpTest = results.find((r) => r.name === "mcp-config:test");
    expect(mcpTest?.status).toBe("pass");
  });

  test("fails MCP server without command", async () => {
    writeManifest({
      ...validManifest,
      mcpServers: { test: { args: ["--port", "3000"] } },
    });
    const results = await testPlugin(dir);
    const mcpTest = results.find((r) => r.name === "mcp-config:test");
    expect(mcpTest?.status).toBe("fail");
  });
});

describe("formatTestResults", () => {
  test("formats results correctly", () => {
    const output = formatTestResults([
      { name: "test-a", status: "pass", duration: 5 },
      { name: "test-b", status: "fail", duration: 3, error: "Something broke" },
      { name: "test-c", status: "skip", duration: 0 },
    ]);
    expect(output).toContain("\u2713 test-a");
    expect(output).toContain("\u2717 test-b");
    expect(output).toContain("Something broke");
    expect(output).toContain("1 passed, 1 failed, 1 skipped");
  });
});
