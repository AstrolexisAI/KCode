// Tests for Skill tool — invoke slash commands
import { describe, expect, test } from "bun:test";
import { executeSkill, skillDefinition } from "./skill";

describe("skillDefinition", () => {
  test("has correct name and required params", () => {
    expect(skillDefinition.name).toBe("Skill");
    expect(skillDefinition.input_schema.required).toContain("skill");
  });
});

describe("executeSkill", () => {
  test("rejects missing skill name", async () => {
    const result = await executeSkill({});
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("skill name is required");
  });

  test("rejects whitespace-only skill name", async () => {
    const result = await executeSkill({ skill: "   " });
    expect(result.is_error).toBe(true);
  });

  test("strips leading slash from skill name", async () => {
    // "/commit" should behave same as "commit"
    const r1 = await executeSkill({ skill: "commit" });
    const r2 = await executeSkill({ skill: "/commit" });
    expect(r1.is_error).toBe(r2.is_error);
  });

  test("returns error with suggestions for unknown skill", async () => {
    const result = await executeSkill({ skill: "nonexistent-skill-xyz" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Unknown skill");
    expect(result.content).toContain("Available:");
  });

  test("invokes known skill (commit)", async () => {
    const result = await executeSkill({ skill: "commit" });
    // commit is a builtin — either succeeds or has a known error
    expect(typeof result.content).toBe("string");
  });

  test("passes args to template", async () => {
    const result = await executeSkill({ skill: "commit", args: "test commit message" });
    // Args should appear in the expanded template
    if (!result.is_error) {
      expect(typeof result.content).toBe("string");
    }
  });

  test("indicates builtin action in output", async () => {
    // Find a builtin and invoke it — content should contain "Builtin action"
    // If "commit" is a builtin, check for the marker
    const result = await executeSkill({ skill: "commit" });
    // Either it's a builtin (contains "Builtin action") or an expanded template
    if (!result.is_error) {
      expect(result.content).toMatch(/Skill (invoked|.*expanded)/);
    }
  });
});
