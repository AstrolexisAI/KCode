// KCode - Tool Executor E2E Tests
// End-to-end tests for actual tool execution: Read, Write, Edit, Bash, Glob, Grep,
// unknown tools, and permission denial

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeRead } from "../tools/read";
import { executeWrite } from "../tools/write";
import { executeEdit } from "../tools/edit";
import { executeBash } from "../tools/bash";
import { executeGlob } from "../tools/glob";
import { executeGrep } from "../tools/grep";
import { setToolWorkspace } from "../tools/workspace";
import { ToolRegistry } from "./tool-registry";

// ─── Shared State ────────────────────────────────────────────────

let tempDir: string;

async function createTempFile(name: string, content: string): Promise<string> {
  const filePath = join(tempDir, name);
  await Bun.write(filePath, content);
  return filePath;
}

// ─── Read Tool ──────────────────────────────────────────────────

describe("Tool E2E: Read", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-tool-e2e-read-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("reads a real file from the filesystem with line numbers", async () => {
    const content = "line one\nline two\nline three\n";
    const filePath = await createTempFile("real-file.txt", content);

    const result = await executeRead({ file_path: filePath });

    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("line one");
    expect(result.content).toContain("line two");
    expect(result.content).toContain("line three");
  });

  test("returns error for non-existent file", async () => {
    const result = await executeRead({ file_path: join(tempDir, "does-not-exist.txt") });

    expect(result.is_error).toBe(true);
  });
});

// ─── Write Tool ─────────────────────────────────────────────────

describe("Tool E2E: Write", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-tool-e2e-write-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates a file on the real filesystem", async () => {
    const filePath = join(tempDir, "new-file.txt");
    const content = "Hello from the E2E write test!";

    const result = await executeWrite({ file_path: filePath, content });

    expect(result.is_error).toBeFalsy();

    // Verify the file actually exists and has the correct content
    const actual = readFileSync(filePath, "utf-8");
    expect(actual).toBe(content);
  });

  test("overwrites existing file", async () => {
    const filePath = await createTempFile("existing.txt", "old content");

    const result = await executeWrite({ file_path: filePath, content: "new content" });

    expect(result.is_error).toBeFalsy();
    const actual = readFileSync(filePath, "utf-8");
    expect(actual).toBe("new content");
  });
});

// ─── Edit Tool ──────────────────────────────────────────────────

describe("Tool E2E: Edit", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-tool-e2e-edit-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("applies a diff to a real file", async () => {
    const filePath = await createTempFile("editable.txt", "Hello world, welcome to KCode.");

    const result = await executeEdit({
      file_path: filePath,
      old_string: "Hello world",
      new_string: "Goodbye world",
    });

    expect(result.is_error).toBeFalsy();

    const updated = readFileSync(filePath, "utf-8");
    expect(updated).toBe("Goodbye world, welcome to KCode.");
  });

  test("returns error when old_string not found", async () => {
    const filePath = await createTempFile("no-match.txt", "The quick brown fox");

    const result = await executeEdit({
      file_path: filePath,
      old_string: "lazy dog",
      new_string: "active cat",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ─── Bash Tool ──────────────────────────────────────────────────

// Check if bash is available
let hasBash = false;
try {
  execFileSync("bash", ["--version"], { stdio: "pipe" });
  hasBash = true;
} catch {}

(hasBash ? describe : describe.skip)("Tool E2E: Bash", () => {
  test("executes command and returns output", async () => {
    const result = await executeBash({ command: "echo 'hello from e2e'" });

    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("hello from e2e");
  });

  test("captures exit code on failure", async () => {
    const result = await executeBash({ command: "exit 42" });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("exit code 42");
  });
});

// ─── Glob Tool ──────────────────────────────────────────────────

describe("Tool E2E: Glob", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-tool-e2e-glob-"));
    setToolWorkspace(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("finds files by pattern", async () => {
    await createTempFile("alpha.ts", "export const a = 1;");
    await createTempFile("beta.ts", "export const b = 2;");
    await createTempFile("readme.md", "# Docs");

    const result = await executeGlob({ pattern: "*.ts" });

    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("alpha.ts");
    expect(result.content).toContain("beta.ts");
    expect(result.content).not.toContain("readme.md");
  });
});

// ─── Grep Tool ──────────────────────────────────────────────────

describe("Tool E2E: Grep", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-tool-e2e-grep-"));
    setToolWorkspace(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("searches file content by regex", async () => {
    await createTempFile("search-target.ts", "function greetUser() { return 'hello'; }\n");
    await createTempFile("other.ts", "const x = 42;\n");

    const result = await executeGrep({ pattern: "greetUser", path: "." });

    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("search-target.ts");
  });
});

// ─── Unknown Tool via Registry ──────────────────────────────────

describe("Tool E2E: unknown tool", () => {
  test("executing unknown tool returns error", async () => {
    const registry = new ToolRegistry();

    const result = await registry.execute("NonExistentTool", {});

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Unknown tool");
    expect(result.content).toContain("NonExistentTool");
  });

  test("registry has() returns false for unknown tool", () => {
    const registry = new ToolRegistry();
    expect(registry.has("MadeUpTool")).toBe(false);
  });
});

// ─── Permission Denied via Registry ─────────────────────────────

describe("Tool E2E: permission denied", () => {
  test("tool handler that throws permission error returns error result", async () => {
    const registry = new ToolRegistry();

    registry.register(
      "RestrictedTool",
      {
        name: "RestrictedTool",
        description: "A tool that requires permission",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      async () => {
        throw new Error("Permission denied: this operation is not allowed");
      },
    );

    const result = await registry.execute("RestrictedTool", {});

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Permission denied");
  });

  test("tool returning is_error blocks operation", async () => {
    const registry = new ToolRegistry();

    registry.register(
      "DeniedTool",
      {
        name: "DeniedTool",
        description: "A tool that denies permission",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      async () => ({
        tool_use_id: "",
        content: "Error: Permission denied by security policy",
        is_error: true,
      }),
    );

    const result = await registry.execute("DeniedTool", {});

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Permission denied");
  });
});
