import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { generateDocs, formatDocs } from "./docs-gen";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("docs-gen", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kcode-docs-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function createPlugin(extra: Record<string, unknown> = {}): void {
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({
        name: "docs-test",
        version: "1.0.0",
        description: "A plugin for testing docs generation",
        author: "Test Author",
        license: "MIT",
        kcode: ">=1.7.0",
        ...extra,
      }),
    );
  }

  test("generates overview section", async () => {
    createPlugin();
    const sections = await generateDocs(dir);
    const overview = sections.find((s) => s.title === "Overview");
    expect(overview).toBeDefined();
    expect(overview!.content).toContain("docs-test");
    expect(overview!.content).toContain("1.0.0");
    expect(overview!.content).toContain("Test Author");
  });

  test("generates installation section", async () => {
    createPlugin();
    const sections = await generateDocs(dir);
    const install = sections.find((s) => s.title === "Installation");
    expect(install).toBeDefined();
    expect(install!.content).toContain("kcode plugin install docs-test");
  });

  test("generates skill docs", async () => {
    createPlugin({ skills: ["skills/*.md"] });
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(
      join(dir, "skills/search.md"),
      "---\nname: search\ndescription: Search the codebase\naliases: [s, find]\n---\nSearch for {{query}} in the codebase.",
    );
    const sections = await generateDocs(dir);
    const skills = sections.find((s) => s.title === "Skills");
    expect(skills).toBeDefined();
    expect(skills!.content).toContain("/search");
    expect(skills!.content).toContain("Search the codebase");
  });

  test("generates hook docs", async () => {
    createPlugin({
      hooks: {
        PostToolUse: [
          { match: { toolName: "Bash" }, command: "echo", args: ["done"] },
        ],
      },
    });
    const sections = await generateDocs(dir);
    const hooks = sections.find((s) => s.title === "Hooks");
    expect(hooks).toBeDefined();
    expect(hooks!.content).toContain("PostToolUse");
    expect(hooks!.content).toContain("echo");
  });

  test("generates MCP docs", async () => {
    createPlugin({
      mcpServers: {
        "my-server": { command: "npx", args: ["@my/server"] },
      },
    });
    const sections = await generateDocs(dir);
    const mcp = sections.find((s) => s.title === "MCP Servers");
    expect(mcp).toBeDefined();
    expect(mcp!.content).toContain("my-server");
    expect(mcp!.content).toContain("npx");
  });

  test("generates agent docs", async () => {
    createPlugin({ agents: ["agents/*.md"] });
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(
      join(dir, "agents/helper.md"),
      "---\nname: helper\ndescription: Helper agent\ntools: [Read, Grep]\nmaxTurns: 5\n---\nHelp with tasks.",
    );
    const sections = await generateDocs(dir);
    const agents = sections.find((s) => s.title === "Agents");
    expect(agents).toBeDefined();
    expect(agents!.content).toContain("helper");
  });

  test("throws for missing manifest", async () => {
    await expect(generateDocs(dir)).rejects.toThrow("plugin.json");
  });

  test("formatDocs combines sections", async () => {
    createPlugin();
    const sections = await generateDocs(dir);
    const output = formatDocs(sections);
    expect(output).toContain("## Overview");
    expect(output).toContain("## Installation");
    expect(output).toContain("## Configuration");
  });
});
