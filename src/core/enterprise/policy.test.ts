import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enforceModelPolicy,
  enforcePolicy,
  formatPolicyReport,
  loadTeamPolicy,
  type PolicyConfig,
} from "./policy";

const TEST_HOME = join(tmpdir(), `kcode-policy-test-${Date.now()}`);

describe("enterprise/policy", () => {
  beforeEach(() => {
    process.env.KCODE_HOME = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_HOME, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    delete process.env.KCODE_HOME;
  });

  describe("enforcePolicy", () => {
    test("allows tool when blockedTools is empty", () => {
      const config: PolicyConfig = { blockedTools: [] };
      const result = enforcePolicy("Read", config);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test("allows tool when blockedTools is undefined", () => {
      const config: PolicyConfig = {};
      const result = enforcePolicy("Read", config);
      expect(result.allowed).toBe(true);
    });

    test("blocks exact tool name match", () => {
      const config: PolicyConfig = { blockedTools: ["Bash", "Write"] };
      const result = enforcePolicy("Bash", config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Bash");
      expect(result.reason).toContain("blocked");
    });

    test("allows tool not in blocked list", () => {
      const config: PolicyConfig = { blockedTools: ["Bash"] };
      const result = enforcePolicy("Read", config);
      expect(result.allowed).toBe(true);
    });

    test("blocks tool with wildcard pattern", () => {
      const config: PolicyConfig = { blockedTools: ["Git*"] };
      const result = enforcePolicy("GitCommit", config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("GitCommit");
    });

    test("allows tool that does not match wildcard", () => {
      const config: PolicyConfig = { blockedTools: ["Git*"] };
      const result = enforcePolicy("Read", config);
      expect(result.allowed).toBe(true);
    });

    test("case-insensitive matching for exact names", () => {
      const config: PolicyConfig = { blockedTools: ["bash"] };
      const result = enforcePolicy("Bash", config);
      expect(result.allowed).toBe(false);
    });
  });

  describe("enforceModelPolicy", () => {
    test("allows model when no blocked models", () => {
      const config: PolicyConfig = {};
      const result = enforceModelPolicy("gpt-4", config);
      expect(result.allowed).toBe(true);
    });

    test("blocks exact model match", () => {
      const config: PolicyConfig = { blockedCloudModels: ["gpt-4", "claude-3-opus"] };
      const result = enforceModelPolicy("gpt-4", config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("gpt-4");
    });

    test("blocks wildcard model pattern", () => {
      const config: PolicyConfig = { blockedCloudModels: ["gpt-*"] };
      const result = enforceModelPolicy("gpt-4-turbo", config);
      expect(result.allowed).toBe(false);
    });

    test("allows non-blocked model", () => {
      const config: PolicyConfig = { blockedCloudModels: ["gpt-4"] };
      const result = enforceModelPolicy("claude-3-sonnet", config);
      expect(result.allowed).toBe(true);
    });
  });

  describe("formatPolicyReport", () => {
    test("formats empty policy", () => {
      const report = formatPolicyReport({});
      expect(report).toContain("Team Policy Report");
      expect(report).toContain("Blocked Tools: none");
      expect(report).toContain("not set");
    });

    test("formats policy with blocked tools", () => {
      const config: PolicyConfig = {
        blockedTools: ["Bash", "Write"],
        requiredPermissionMode: "ask",
      };
      const report = formatPolicyReport(config);
      expect(report).toContain("Blocked Tools:");
      expect(report).toContain("- Bash");
      expect(report).toContain("- Write");
      expect(report).toContain("Required Permission Mode: ask");
    });

    test("formats policy with blocked models", () => {
      const config: PolicyConfig = {
        blockedCloudModels: ["gpt-4", "claude-3-opus"],
        maxContextWindow: 32000,
      };
      const report = formatPolicyReport(config);
      expect(report).toContain("Blocked Cloud Models:");
      expect(report).toContain("- gpt-4");
      expect(report).toContain("- claude-3-opus");
      expect(report).toContain("32,000 tokens");
    });

    test("formats full policy", () => {
      const config: PolicyConfig = {
        blockedTools: ["Bash"],
        requiredPermissionMode: "plan",
        blockedCloudModels: ["gpt-*"],
        maxContextWindow: 128000,
      };
      const report = formatPolicyReport(config);
      expect(report).toContain("Bash");
      expect(report).toContain("plan");
      expect(report).toContain("gpt-*");
      expect(report).toContain("128,000");
    });
  });

  describe("loadTeamPolicy", () => {
    test("returns null when no policy file exists", () => {
      const policy = loadTeamPolicy();
      expect(policy).toBeNull();
    });

    test("loads policy from ~/.kcode/enterprise/policy.json", () => {
      const dir = join(TEST_HOME, "enterprise");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "policy.json"),
        JSON.stringify({ blockedTools: ["Bash"], requiredPermissionMode: "ask" }),
        "utf-8",
      );

      const policy = loadTeamPolicy();
      expect(policy).not.toBeNull();
      expect(policy!.blockedTools).toEqual(["Bash"]);
      expect(policy!.requiredPermissionMode).toBe("ask");
    });

    test("validates policy fields", () => {
      const dir = join(TEST_HOME, "enterprise");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "policy.json"),
        JSON.stringify({
          blockedTools: ["Bash", 123], // 123 should be filtered out
          requiredPermissionMode: "invalid_mode", // should be ignored
          maxContextWindow: -1, // should be ignored
        }),
        "utf-8",
      );

      const policy = loadTeamPolicy();
      expect(policy).not.toBeNull();
      expect(policy!.blockedTools).toEqual(["Bash"]);
      expect(policy!.requiredPermissionMode).toBeUndefined();
      expect(policy!.maxContextWindow).toBeUndefined();
    });
  });
});
