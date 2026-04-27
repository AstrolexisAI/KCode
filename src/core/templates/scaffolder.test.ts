// KCode - Scaffolder Tests

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Scaffolder } from "./scaffolder";
import type { Template } from "./types";


const asFetch = (fn: unknown): typeof globalThis.fetch => fn as typeof globalThis.fetch;

const TEST_OUTPUT = join(import.meta.dir, "__test_scaffold__");

const testTemplate: Template = {
  name: "test-tmpl",
  description: "Test template",
  tags: ["test"],
  parameters: [
    { name: "projectName", description: "Name", type: "string", required: true },
    { name: "auth", description: "Auth", type: "boolean", default: true, required: false },
  ],
  prompt: "Create a project called {{projectName}}. {{#if auth}}With auth.{{else}}No auth.{{/if}}",
  source: "builtin",
};

describe("Scaffolder", () => {
  let scaffolder: Scaffolder;

  beforeEach(() => {
    scaffolder = new Scaffolder();
    mkdirSync(TEST_OUTPUT, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_OUTPUT, { recursive: true, force: true });
  });

  test("dryRun returns expanded prompt", () => {
    const result = scaffolder.dryRun(testTemplate, { projectName: "my-app", auth: true });
    expect(result).toContain("my-app");
    expect(result).toContain("With auth.");
  });

  test("dryRun with auth=false shows no auth", () => {
    const result = scaffolder.dryRun(testTemplate, { projectName: "my-app", auth: false });
    expect(result).toContain("No auth.");
  });

  test("dryRun reports validation errors", () => {
    const result = scaffolder.dryRun(testTemplate, {});
    expect(result).toContain("Validation errors");
    expect(result).toContain("projectName");
  });

  test("dryRun applies defaults", () => {
    const result = scaffolder.dryRun(testTemplate, { projectName: "test" });
    // auth defaults to true
    expect(result).toContain("With auth.");
  });

  test("scaffold throws on validation errors", async () => {
    await expect(
      scaffolder.scaffold(testTemplate, {}, TEST_OUTPUT, {
        apiBase: "http://localhost:10091",
        model: "test",
      }),
    ).rejects.toThrow("Invalid parameters");
  });

  test("scaffold writes files from model response", async () => {
    // Mock fetch to return file markers
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetch(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `---FILE: src/index.ts---
console.log("hello");
---END FILE---
---FILE: package.json---
{ "name": "test" }
---END FILE---`,
              },
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      ));

    try {
      const result = await scaffolder.scaffold(
        testTemplate,
        { projectName: "test-proj" },
        TEST_OUTPUT,
        { apiBase: "http://localhost:10091", model: "test" },
      );

      expect(result.filesCreated).toBe(2);
      expect(result.outputDir).toBe(TEST_OUTPUT);
      expect(result.files.some((f) => f.path === "src/index.ts")).toBe(true);
      expect(result.files.some((f) => f.path === "package.json")).toBe(true);

      // Verify files exist on disk
      const indexFile = Bun.file(join(TEST_OUTPUT, "src/index.ts"));
      expect(await indexFile.exists()).toBe(true);
      const content = await indexFile.text();
      expect(content).toContain("hello");
    } finally {
      globalThis.fetch = asFetch(originalFetch);
    }
  });

  test("scaffold throws on empty model response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "No files here." } }] }), {
        headers: { "Content-Type": "application/json" },
      }));

    try {
      await expect(
        scaffolder.scaffold(testTemplate, { projectName: "test" }, TEST_OUTPUT, {
          apiBase: "http://localhost:10091",
          model: "test",
        }),
      ).rejects.toThrow("did not generate any files");
    } finally {
      globalThis.fetch = asFetch(originalFetch);
    }
  });

  test("scaffold throws on API error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetch(async () => new Response("Internal Server Error", { status: 500 }));

    try {
      await expect(
        scaffolder.scaffold(testTemplate, { projectName: "test" }, TEST_OUTPUT, {
          apiBase: "http://localhost:10091",
          model: "test",
        }),
      ).rejects.toThrow("Model API error");
    } finally {
      globalThis.fetch = asFetch(originalFetch);
    }
  });
});
