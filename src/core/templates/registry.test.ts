// KCode - Template Registry Tests

import { beforeEach, describe, expect, test } from "bun:test";
import { TemplateRegistry } from "./registry";

describe("TemplateRegistry", () => {
  let registry: TemplateRegistry;

  beforeEach(async () => {
    registry = new TemplateRegistry();
    await registry.loadAll();
  });

  test("loadAll discovers builtin templates", () => {
    expect(registry.size()).toBeGreaterThanOrEqual(4);
  });

  test("get returns correct template by name", () => {
    const t = registry.get("rest-api");
    expect(t).toBeDefined();
    expect(t!.name).toBe("rest-api");
    expect(t!.source).toBe("builtin");
  });

  test("get returns undefined for non-existent template", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  test("list returns all templates sorted by name", () => {
    const list = registry.list();
    expect(list.length).toBeGreaterThanOrEqual(4);
    // Verify sorted
    for (let i = 1; i < list.length; i++) {
      expect(list[i]!.name >= list[i - 1]!.name).toBe(true);
    }
  });

  test("list items have correct structure", () => {
    const list = registry.list();
    for (const item of list) {
      expect(item.name).toBeDefined();
      expect(item.description).toBeDefined();
      expect(Array.isArray(item.tags)).toBe(true);
      expect(typeof item.parameterCount).toBe("number");
    }
  });

  test("rest-api template has correct parameters", () => {
    const t = registry.get("rest-api");
    expect(t).toBeDefined();
    const names = t!.parameters.map((p) => p.name);
    expect(names).toContain("projectName");
    expect(names).toContain("database");
    expect(names).toContain("auth");
    expect(names).toContain("docker");
  });

  test("cli-tool template has correct parameters", () => {
    const t = registry.get("cli-tool");
    expect(t).toBeDefined();
    expect(t!.parameters.find((p) => p.name === "projectName")?.required).toBe(true);
  });

  test("template prompt is non-empty", () => {
    const t = registry.get("rest-api");
    expect(t!.prompt.length).toBeGreaterThan(10);
  });
});

describe("TemplateRegistry.parseTemplateFile", () => {
  const registry = new TemplateRegistry();

  test("parses valid frontmatter", () => {
    const content = `---
name: test-template
description: A test template
tags: [typescript, test]
parameters:
  - name: projectName
    description: Name
    type: string
    required: true
---

Generate a project called {{projectName}}.`;

    const t = registry.parseTemplateFile(content, "user");
    expect(t).not.toBeNull();
    expect(t!.name).toBe("test-template");
    expect(t!.description).toBe("A test template");
    expect(t!.tags).toContain("typescript");
    expect(t!.parameters).toHaveLength(1);
    expect(t!.parameters[0]!.name).toBe("projectName");
    expect(t!.prompt).toContain("{{projectName}}");
  });

  test("returns null for missing frontmatter", () => {
    const t = registry.parseTemplateFile("No frontmatter here", "user");
    expect(t).toBeNull();
  });

  test("returns null for missing required fields", () => {
    const content = `---
name: incomplete
---
Some prompt.`;
    const t = registry.parseTemplateFile(content, "user");
    expect(t).toBeNull();
  });

  test("handles boolean defaults", () => {
    const content = `---
name: bool-test
description: Test booleans
parameters:
  - name: flag
    description: A flag
    type: boolean
    default: true
    required: false
---
Prompt.`;

    const t = registry.parseTemplateFile(content, "user");
    expect(t).not.toBeNull();
    expect(t!.parameters[0]!.default).toBe(true);
  });
});
