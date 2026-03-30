import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { executeWrite, writeDefinition } from "./write.ts";

const tempDir = `/tmp/kcode-test-write-${Date.now()}`;

describe("write tool", () => {
  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Definition ───

  test("writeDefinition has correct name and required fields", () => {
    expect(writeDefinition.name).toBe("Write");
    expect(writeDefinition.input_schema.required).toContain("file_path");
    expect(writeDefinition.input_schema.required).toContain("content");
  });

  // ─── Basic file creation ───

  test("creates a file with correct content", async () => {
    const filePath = join(tempDir, "hello.txt");
    const result = await executeWrite({
      file_path: filePath,
      content: "Hello, world!\nLine 2\n",
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("File written successfully");
    expect(result.content).toContain(filePath);
    expect(result.content).toContain("3 lines");

    const written = readFileSync(filePath, "utf-8");
    expect(written).toBe("Hello, world!\nLine 2\n");
  });

  // ─── Parent directory creation ───

  test("creates parent directories automatically", async () => {
    const filePath = join(tempDir, "deep", "nested", "dir", "file.txt");
    const result = await executeWrite({
      file_path: filePath,
      content: "nested content",
    });

    expect(result.is_error).toBeUndefined();
    expect(existsSync(filePath)).toBe(true);

    const written = readFileSync(filePath, "utf-8");
    expect(written).toBe("nested content");
  });

  // ─── Overwrites existing file ───

  test("overwrites existing file", async () => {
    const filePath = join(tempDir, "overwrite.txt");
    await executeWrite({ file_path: filePath, content: "original" });
    const result = await executeWrite({ file_path: filePath, content: "replaced" });

    expect(result.is_error).toBeUndefined();
    const written = readFileSync(filePath, "utf-8");
    expect(written).toBe("replaced");
  });

  // ─── HTML-in-TS detection: large content BLOCKED ───

  test("blocks large HTML content in .ts file", async () => {
    const filePath = join(tempDir, "server.ts");
    // Generate content > 2000 chars with HTML tags
    const htmlContent = `
import { serve } from "bun";
const html = \`
<html>
<head><title>Test</title></head>
<body>
<div class="container">
${"<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>\n".repeat(50)}
</div>
</body>
</html>
\`;
serve({ port: 3000, fetch() { return new Response(html); } });
`;
    expect(htmlContent.length).toBeGreaterThan(2000);

    const result = await executeWrite({
      file_path: filePath,
      content: htmlContent,
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("HTML");
    // File should NOT have been created
    expect(existsSync(filePath)).toBe(false);
  });

  // ─── Small HTML-in-TS shows warning but succeeds ───

  test("warns but allows small HTML content in .ts file", async () => {
    const filePath = join(tempDir, "small-server.ts");
    const smallHtml = `const x = "<div>hello</div>";`;

    const result = await executeWrite({
      file_path: filePath,
      content: smallHtml,
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Warning");
    expect(result.content).toContain("HTML");
    expect(existsSync(filePath)).toBe(true);
  });

  // ─── HTML in .js file is fine (no warning) ───

  test("no warning for HTML in .js file", async () => {
    const filePath = join(tempDir, "app.js");
    const content = `const html = "<div>hello</div>";`;

    const result = await executeWrite({
      file_path: filePath,
      content,
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).not.toContain("Warning");
  });

  // ─── Error on invalid path ───

  test("error on unwritable path", async () => {
    const result = await executeWrite({
      file_path: "/nonexistent-root/some/file.txt",
      content: "should fail",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Error writing");
  });

  // ─── Empty content ───

  test("writes empty file", async () => {
    const filePath = join(tempDir, "empty.txt");
    const result = await executeWrite({
      file_path: filePath,
      content: "",
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("1 lines"); // empty string splits to [""] = 1 line
    const written = readFileSync(filePath, "utf-8");
    expect(written).toBe("");
  });

  // ─── tool_use_id ───

  test("result always has empty tool_use_id", async () => {
    const filePath = join(tempDir, "tid.txt");
    const result = await executeWrite({ file_path: filePath, content: "test" });
    expect(result.tool_use_id).toBe("");
  });
});
