import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { validatePlugin, formatValidationReport } from "./validate";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("validatePlugin", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kcode-validate-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(manifest: Record<string, unknown>): void {
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  }

  function writeSkill(name: string, content: string): void {
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "skills", name), content);
  }

  const validManifest = {
    name: "test-plugin",
    version: "1.0.0",
    description: "A test plugin",
    author: "Test",
    license: "MIT",
    kcode: ">=1.7.0",
  };

  test("valid plugin passes", async () => {
    writeManifest(validManifest);
    const report = await validatePlugin(dir);
    expect(report.valid).toBe(true);
    expect(report.errors).toHaveLength(0);
  });

  test("missing manifest fails", async () => {
    const report = await validatePlugin(dir);
    expect(report.valid).toBe(false);
    expect(report.errors[0].code).toBe("MISSING_MANIFEST");
  });

  test("invalid JSON fails", async () => {
    writeFileSync(join(dir, "plugin.json"), "not json{");
    const report = await validatePlugin(dir);
    expect(report.valid).toBe(false);
    expect(report.errors[0].code).toBe("INVALID_JSON");
  });

  test("missing required fields fail", async () => {
    writeManifest({ name: "test" });
    const report = await validatePlugin(dir);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.message.includes("version"))).toBe(true);
  });

  test("invalid name format fails", async () => {
    writeManifest({ ...validManifest, name: "Invalid Name!" });
    const report = await validatePlugin(dir);
    expect(report.valid).toBe(false);
  });

  test("invalid version format fails", async () => {
    writeManifest({ ...validManifest, version: "not-semver" });
    const report = await validatePlugin(dir);
    expect(report.valid).toBe(false);
  });

  test("valid skills pass", async () => {
    writeManifest({ ...validManifest, skills: ["skills/*.md"] });
    writeSkill("example.md", "---\nname: example\ndescription: Test\n---\nContent");
    const report = await validatePlugin(dir);
    expect(report.valid).toBe(true);
  });

  test("skills without frontmatter fail", async () => {
    writeManifest({ ...validManifest, skills: ["skills/*.md"] });
    writeSkill("bad.md", "No frontmatter here");
    const report = await validatePlugin(dir);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "INVALID_SKILL")).toBe(true);
  });

  test("missing skill files warn", async () => {
    writeManifest({ ...validManifest, skills: ["skills/*.md"] });
    const report = await validatePlugin(dir);
    expect(report.warnings.some((w) => w.code === "NO_SKILLS")).toBe(true);
  });

  test("unknown hook events warn", async () => {
    writeManifest({
      ...validManifest,
      hooks: { UnknownEvent: [{ command: "echo", action: "command" }] },
    });
    const report = await validatePlugin(dir);
    expect(report.warnings.some((w) => w.code === "UNKNOWN_HOOK_EVENT")).toBe(true);
  });

  test("MCP server without command fails", async () => {
    writeManifest({
      ...validManifest,
      mcpServers: { test: { args: ["--port", "3000"] } },
    });
    const report = await validatePlugin(dir);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "MCP_NO_COMMAND")).toBe(true);
  });

  test("path traversal fails", async () => {
    writeManifest({
      ...validManifest,
      skills: ["../../../etc/passwd"],
    });
    const report = await validatePlugin(dir);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "PATH_TRAVERSAL")).toBe(true);
  });

  test("absolute path in skills fails", async () => {
    writeManifest({
      ...validManifest,
      skills: ["/etc/passwd"],
    });
    const report = await validatePlugin(dir);
    expect(report.valid).toBe(false);
  });

  test("info includes component summary", async () => {
    writeManifest({ ...validManifest, skills: ["skills/*.md"] });
    const report = await validatePlugin(dir);
    expect(report.info.some((i) => i.code === "SUMMARY")).toBe(true);
  });
});

describe("formatValidationReport", () => {
  test("formats valid report", () => {
    const output = formatValidationReport({
      valid: true,
      errors: [],
      warnings: [],
      info: [{ code: "SUMMARY", message: "Components: skills" }],
    });
    expect(output).toContain("\u2713");
    expect(output).toContain("Components: skills");
  });

  test("formats invalid report with errors", () => {
    const output = formatValidationReport({
      valid: false,
      errors: [{ code: "TEST", message: "Test error" }],
      warnings: [{ code: "WARN", message: "Test warning" }],
      info: [],
    });
    expect(output).toContain("\u2717");
    expect(output).toContain("Test error");
    expect(output).toContain("Test warning");
  });
});
