// Tests for per-tool permission policies

import { describe, expect, test } from "bun:test";
import {
  evaluateToolPolicy,
  globMatch,
  matchesCondition,
  type ToolPolicy,
} from "./per-tool-policy";

// ─── globMatch ──────────────────────────────────────────────────

describe("globMatch", () => {
  test("matches exact string", () => {
    expect(globMatch("hello", "hello")).toBe(true);
    expect(globMatch("hello", "world")).toBe(false);
  });

  test("handles * wildcard", () => {
    expect(globMatch("git status", "git*")).toBe(true);
    expect(globMatch("git commit -m 'test'", "git*")).toBe(true);
    expect(globMatch("npm install", "git*")).toBe(false);
  });

  test("handles ? wildcard", () => {
    expect(globMatch("cat", "c?t")).toBe(true);
    expect(globMatch("cut", "c?t")).toBe(true);
    expect(globMatch("ct", "c?t")).toBe(false);
  });

  test("handles ** for recursive matching", () => {
    expect(globMatch("src/core/file.ts", "src/**/*.ts")).toBe(true);
    expect(globMatch("src/file.ts", "src/**/*.ts")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(globMatch("Git Status", "git*")).toBe(true);
    expect(globMatch("GIT STATUS", "git*")).toBe(true);
    expect(globMatch("git status", "GIT*")).toBe(true);
  });

  test("escapes regex special characters", () => {
    expect(globMatch("file.ts", "file.ts")).toBe(true);
    expect(globMatch("filexts", "file.ts")).toBe(false);
    expect(globMatch("rm -rf /", "rm -rf *")).toBe(true);
  });

  test("handles complex patterns", () => {
    expect(globMatch("src/core/permissions.ts", "src/*/permissions.*")).toBe(true);
    expect(globMatch("/home/user/.env", "*/.env")).toBe(true);
  });
});

// ─── matchesCondition ───────────────────────────────────────────

describe("matchesCondition", () => {
  test("matches operator uses glob matching", () => {
    expect(
      matchesCondition("git status", {
        field: "command",
        pattern: "git *",
        operator: "matches",
      }),
    ).toBe(true);
  });

  test("not_matches negates glob matching", () => {
    expect(
      matchesCondition("git status", {
        field: "command",
        pattern: "rm *",
        operator: "not_matches",
      }),
    ).toBe(true);
    expect(
      matchesCondition("rm -rf /", {
        field: "command",
        pattern: "rm *",
        operator: "not_matches",
      }),
    ).toBe(false);
  });

  test("contains checks substring", () => {
    expect(
      matchesCondition("npm install lodash", {
        field: "command",
        pattern: "install",
        operator: "contains",
      }),
    ).toBe(true);
    expect(
      matchesCondition("npm install lodash", {
        field: "command",
        pattern: "uninstall",
        operator: "contains",
      }),
    ).toBe(false);
  });

  test("starts_with checks prefix", () => {
    expect(
      matchesCondition("git commit -m 'test'", {
        field: "command",
        pattern: "git ",
        operator: "starts_with",
      }),
    ).toBe(true);
    expect(
      matchesCondition("npm install", {
        field: "command",
        pattern: "git ",
        operator: "starts_with",
      }),
    ).toBe(false);
  });

  test("contains is case-insensitive", () => {
    expect(
      matchesCondition("NPM INSTALL", {
        field: "command",
        pattern: "install",
        operator: "contains",
      }),
    ).toBe(true);
  });

  test("starts_with is case-insensitive", () => {
    expect(
      matchesCondition("GIT status", {
        field: "command",
        pattern: "git",
        operator: "starts_with",
      }),
    ).toBe(true);
  });
});

// ─── evaluateToolPolicy ─────────────────────────────────────────

describe("evaluateToolPolicy", () => {
  const policies: ToolPolicy[] = [
    {
      toolName: "Bash",
      defaultAction: "ask",
      rules: [
        {
          condition: {
            field: "command",
            pattern: "rm -rf *",
            operator: "matches",
          },
          action: "deny",
          reason: "Dangerous recursive deletion",
        },
        {
          condition: {
            field: "command",
            pattern: "git *",
            operator: "matches",
          },
          action: "allow",
          reason: "Git commands are safe",
        },
        {
          condition: {
            field: "command",
            pattern: "sudo *",
            operator: "matches",
          },
          action: "deny",
          reason: "No sudo allowed",
        },
      ],
    },
    {
      toolName: "Write",
      defaultAction: "allow",
      rules: [
        {
          condition: {
            field: "file_path",
            pattern: "*.env*",
            operator: "matches",
          },
          action: "deny",
          reason: "Cannot write to env files",
        },
      ],
    },
    {
      toolName: "Read",
      defaultAction: "allow",
      rules: [],
    },
  ];

  test("returns ask when no policy exists", () => {
    const result = evaluateToolPolicy("UnknownTool", {}, policies);
    expect(result.action).toBe("ask");
    expect(result.reason).toBeUndefined();
  });

  test("uses defaultAction when no rules match", () => {
    const result = evaluateToolPolicy("Bash", { command: "echo hello" }, policies);
    expect(result.action).toBe("ask");
  });

  test("uses defaultAction for policy with no rules", () => {
    const result = evaluateToolPolicy("Read", { file_path: "/some/file.ts" }, policies);
    expect(result.action).toBe("allow");
  });

  test("rule with matches operator works with glob patterns", () => {
    const result = evaluateToolPolicy("Bash", { command: "git status" }, policies);
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("Git commands are safe");
  });

  test("deny rule blocks dangerous commands", () => {
    const result = evaluateToolPolicy("Bash", { command: "rm -rf /" }, policies);
    expect(result.action).toBe("deny");
    expect(result.reason).toBe("Dangerous recursive deletion");
  });

  test("allow rule permits safe commands", () => {
    const result = evaluateToolPolicy("Bash", { command: "git log --oneline" }, policies);
    expect(result.action).toBe("allow");
  });

  test("first matching rule wins (order matters)", () => {
    // "rm -rf" matches deny rule before any other rule
    const result = evaluateToolPolicy("Bash", { command: "rm -rf /tmp/test" }, policies);
    expect(result.action).toBe("deny");
    expect(result.reason).toBe("Dangerous recursive deletion");
  });

  test("reason is returned with deny actions", () => {
    const result = evaluateToolPolicy("Write", { file_path: ".env.local" }, policies);
    expect(result.action).toBe("deny");
    expect(result.reason).toBe("Cannot write to env files");
  });

  test("tool name matching is case-insensitive", () => {
    const result = evaluateToolPolicy("bash", { command: "git status" }, policies);
    expect(result.action).toBe("allow");
  });

  test("skips rules when field is missing from input", () => {
    const result = evaluateToolPolicy("Bash", { other: "value" }, policies);
    expect(result.action).toBe("ask"); // defaultAction since no rule field matched
  });

  test("handles nested field paths", () => {
    const nestedPolicies: ToolPolicy[] = [
      {
        toolName: "CustomTool",
        defaultAction: "ask",
        rules: [
          {
            condition: {
              field: "config.path",
              pattern: "/safe/*",
              operator: "matches",
            },
            action: "allow",
          },
        ],
      },
    ];
    const result = evaluateToolPolicy(
      "CustomTool",
      { config: { path: "/safe/file.txt" } },
      nestedPolicies,
    );
    expect(result.action).toBe("allow");
  });

  test("returns ask for empty policies array", () => {
    const result = evaluateToolPolicy("Bash", { command: "ls" }, []);
    expect(result.action).toBe("ask");
  });
});
