// KCode - Template Engine Tests

import { describe, test, expect } from "bun:test";
import { TemplateEngine } from "./engine";
import type { Template } from "./types";

const engine = new TemplateEngine();

// ─── expandTemplate ────────────────────────────────────────────

describe("expandTemplate", () => {
  test("replaces simple variables", () => {
    const result = engine.expandTemplate("Hello {{name}}!", { name: "World" });
    expect(result).toBe("Hello World!");
  });

  test("replaces multiple variables", () => {
    const result = engine.expandTemplate("{{a}} and {{b}}", { a: "X", b: "Y" });
    expect(result).toBe("X and Y");
  });

  test("replaces missing variables with empty string", () => {
    const result = engine.expandTemplate("Hello {{name}}!", {});
    expect(result).toBe("Hello !");
  });

  test("handles #if with truthy value", () => {
    const result = engine.expandTemplate("{{#if auth}}has auth{{/if}}", { auth: true });
    expect(result).toBe("has auth");
  });

  test("handles #if with falsy value", () => {
    const result = engine.expandTemplate("{{#if auth}}has auth{{/if}}", { auth: false });
    expect(result).toBe("");
  });

  test("handles #if/else with truthy", () => {
    const result = engine.expandTemplate("{{#if auth}}yes{{else}}no{{/if}}", { auth: true });
    expect(result).toBe("yes");
  });

  test("handles #if/else with falsy", () => {
    const result = engine.expandTemplate("{{#if auth}}yes{{else}}no{{/if}}", { auth: false });
    expect(result).toBe("no");
  });

  test("handles #if with string value", () => {
    const result = engine.expandTemplate("{{#if name}}hello{{/if}}", { name: "Bob" });
    expect(result).toBe("hello");
  });

  test("handles #if with empty string as falsy", () => {
    const result = engine.expandTemplate("{{#if name}}hello{{/if}}", { name: "" });
    expect(result).toBe("");
  });

  test("handles #each with array", () => {
    const result = engine.expandTemplate("{{#each items}}- {{this}}\n{{/each}}", { items: ["a", "b", "c"] });
    expect(result).toBe("- a\n- b\n- c\n");
  });

  test("handles #each with empty array", () => {
    const result = engine.expandTemplate("{{#each items}}item{{/each}}", { items: [] });
    expect(result).toBe("");
  });

  test("handles #each with non-array", () => {
    const result = engine.expandTemplate("{{#each items}}item{{/each}}", { items: "not-array" });
    expect(result).toBe("");
  });

  test("handles nested variables inside #if", () => {
    const result = engine.expandTemplate("{{#if auth}}Auth: {{authType}}{{/if}}", { auth: true, authType: "JWT" });
    expect(result).toBe("Auth: JWT");
  });

  test("handles multiline templates", () => {
    const tmpl = `Project: {{name}}
{{#if docker}}Docker: yes{{else}}Docker: no{{/if}}
Done.`;
    const result = engine.expandTemplate(tmpl, { name: "test", docker: true });
    expect(result).toContain("Project: test");
    expect(result).toContain("Docker: yes");
    expect(result).toContain("Done.");
  });
});

// ─── validateParams ────────────────────────────────────────────

describe("validateParams", () => {
  const template: Template = {
    name: "test",
    description: "test",
    tags: [],
    parameters: [
      { name: "name", description: "name", type: "string", required: true },
      { name: "db", description: "db", type: "choice", choices: ["sqlite", "postgres"], required: false },
      { name: "auth", description: "auth", type: "boolean", required: false },
    ],
    prompt: "",
    source: "builtin",
  };

  test("passes valid params", () => {
    const errors = engine.validateParams(template, { name: "test", db: "sqlite", auth: true });
    expect(errors).toHaveLength(0);
  });

  test("catches missing required param", () => {
    const errors = engine.validateParams(template, {});
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("name");
  });

  test("catches invalid choice", () => {
    const errors = engine.validateParams(template, { name: "test", db: "mongodb" });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("db");
  });

  test("allows optional params to be missing", () => {
    const errors = engine.validateParams(template, { name: "test" });
    expect(errors).toHaveLength(0);
  });

  test("catches empty required param", () => {
    const errors = engine.validateParams(template, { name: "" });
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ─── applyDefaults ─────────────────────────────────────────────

describe("applyDefaults", () => {
  const template: Template = {
    name: "test",
    description: "test",
    tags: [],
    parameters: [
      { name: "name", description: "n", type: "string", required: true },
      { name: "db", description: "d", type: "choice", choices: ["sqlite"], default: "sqlite", required: false },
      { name: "auth", description: "a", type: "boolean", default: true, required: false },
    ],
    prompt: "",
    source: "builtin",
  };

  test("applies defaults for missing params", () => {
    const result = engine.applyDefaults(template, { name: "test" });
    expect(result.db).toBe("sqlite");
    expect(result.auth).toBe(true);
  });

  test("does not override provided params", () => {
    const result = engine.applyDefaults(template, { name: "test", db: "postgres" });
    expect(result.db).toBe("postgres");
  });
});

// ─── parseFiles ────────────────────────────────────────────────

describe("parseFiles", () => {
  test("extracts files from AI response", () => {
    const content = `---FILE: src/index.ts---
console.log("hello");
---END FILE---
---FILE: package.json---
{ "name": "test" }
---END FILE---`;

    const files = engine.parseFiles(content);
    expect(files).toHaveLength(2);
    expect(files[0]!.path).toBe("src/index.ts");
    expect(files[0]!.content).toContain('console.log("hello")');
    expect(files[1]!.path).toBe("package.json");
  });

  test("returns empty array when no files found", () => {
    const files = engine.parseFiles("Just some text without file markers.");
    expect(files).toHaveLength(0);
  });

  test("skips absolute paths", () => {
    const content = `---FILE: /etc/passwd---
bad content
---END FILE---
---FILE: src/good.ts---
good content
---END FILE---`;

    const files = engine.parseFiles(content);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("src/good.ts");
  });

  test("skips path traversal", () => {
    const content = `---FILE: ../../etc/passwd---
bad content
---END FILE---`;

    const files = engine.parseFiles(content);
    expect(files).toHaveLength(0);
  });

  test("handles files with empty content", () => {
    const content = `---FILE: empty.ts---
---END FILE---`;

    const files = engine.parseFiles(content);
    expect(files).toHaveLength(1);
    expect(files[0]!.content).toBe("");
  });
});
