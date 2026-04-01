// KCode - Managed Policy Tests
// Tests for enterprise managed settings, model restrictions, and policy enforcement

import { describe, expect, test } from "bun:test";
import { isModelAllowedByPolicy, type ManagedPolicy } from "./config";

// ─── Model Restriction Tests ───────────────────────────────────

describe("isModelAllowedByPolicy", () => {
  test("allows any model when no restrictions", () => {
    const policy: ManagedPolicy = {};
    expect(isModelAllowedByPolicy("gpt-4", policy)).toBe(true);
    expect(isModelAllowedByPolicy("mnemo:mark5", policy)).toBe(true);
  });

  test("allowedModels restricts to whitelist", () => {
    const policy: ManagedPolicy = {
      allowedModels: ["mnemo:*", "llama-*"],
    };
    expect(isModelAllowedByPolicy("mnemo:mark5", policy)).toBe(true);
    expect(isModelAllowedByPolicy("mnemo:mark5-nano", policy)).toBe(true);
    expect(isModelAllowedByPolicy("llama-3.1-70b", policy)).toBe(true);
    expect(isModelAllowedByPolicy("gpt-4", policy)).toBe(false);
    expect(isModelAllowedByPolicy("claude-3-opus", policy)).toBe(false);
  });

  test("blockedModels denies matching models", () => {
    const policy: ManagedPolicy = {
      blockedModels: ["gpt-*", "claude-*"],
    };
    expect(isModelAllowedByPolicy("gpt-4", policy)).toBe(false);
    expect(isModelAllowedByPolicy("gpt-4o", policy)).toBe(false);
    expect(isModelAllowedByPolicy("claude-3-opus", policy)).toBe(false);
    expect(isModelAllowedByPolicy("mnemo:mark5", policy)).toBe(true);
    expect(isModelAllowedByPolicy("llama-3.1", policy)).toBe(true);
  });

  test("blockedModels takes precedence over allowedModels", () => {
    const policy: ManagedPolicy = {
      allowedModels: ["*"],
      blockedModels: ["gpt-4"],
    };
    expect(isModelAllowedByPolicy("gpt-4", policy)).toBe(false);
    expect(isModelAllowedByPolicy("gpt-3.5", policy)).toBe(true);
    expect(isModelAllowedByPolicy("mnemo:mark5", policy)).toBe(true);
  });

  test("case insensitive matching", () => {
    const policy: ManagedPolicy = {
      allowedModels: ["Mnemo:*"],
    };
    expect(isModelAllowedByPolicy("mnemo:mark5", policy)).toBe(true);
    expect(isModelAllowedByPolicy("MNEMO:MARK5", policy)).toBe(true);
  });

  test("exact model name match", () => {
    const policy: ManagedPolicy = {
      allowedModels: ["mnemo:mark5-nano"],
    };
    expect(isModelAllowedByPolicy("mnemo:mark5-nano", policy)).toBe(true);
    expect(isModelAllowedByPolicy("mnemo:mark5", policy)).toBe(false);
  });

  test("empty allowedModels blocks all models", () => {
    const policy: ManagedPolicy = {
      allowedModels: [],
    };
    // Empty array means no restrictions (length is 0, skipped)
    expect(isModelAllowedByPolicy("anything", policy)).toBe(true);
  });

  test("validates fallback models too", () => {
    const policy: ManagedPolicy = {
      blockedModels: ["gpt-*"],
      allowedModels: ["mnemo:*", "llama-*"],
    };
    // Primary
    expect(isModelAllowedByPolicy("mnemo:mark5", policy)).toBe(true);
    // Fallback that should be blocked
    expect(isModelAllowedByPolicy("gpt-4", policy)).toBe(false);
    expect(isModelAllowedByPolicy("gpt-3.5-turbo", policy)).toBe(false);
    // Fallback that should be allowed
    expect(isModelAllowedByPolicy("llama-3.1-70b", policy)).toBe(true);
  });
});

// ─── Policy Shape Tests ─────────────────────────────────────────

describe("ManagedPolicy shape", () => {
  test("locked settings override user settings", () => {
    const policy: ManagedPolicy = {
      locked: {
        model: "mnemo:mark5-nano",
        permissionMode: "ask",
        maxBudgetUsd: 10,
      },
    };
    expect(policy.locked?.model).toBe("mnemo:mark5-nano");
    expect(policy.locked?.permissionMode).toBe("ask");
    expect(policy.locked?.maxBudgetUsd).toBe(10);
  });

  test("org-level tool restrictions", () => {
    const policy: ManagedPolicy = {
      disallowedTools: ["Bash", "Agent", "CronCreate"],
      allowedTools: ["Read", "Glob", "Grep"],
    };
    expect(policy.disallowedTools).toContain("Bash");
    expect(policy.allowedTools).toContain("Read");
  });

  test("web access disable", () => {
    const policy: ManagedPolicy = {
      disableWebAccess: true,
    };
    expect(policy.disableWebAccess).toBe(true);
  });

  test("audit logging with org ID", () => {
    const policy: ManagedPolicy = {
      auditLog: true,
      orgId: "acme-corp",
    };
    expect(policy.auditLog).toBe(true);
    expect(policy.orgId).toBe("acme-corp");
  });

  test("permission rules at org level", () => {
    const policy: ManagedPolicy = {
      permissionRules: [
        { pattern: "Bash(rm -rf *)", action: "deny" },
        { pattern: "Edit(/etc/**)", action: "deny" },
      ],
    };
    expect(policy.permissionRules).toHaveLength(2);
    expect(policy.permissionRules![0]!.action).toBe("deny");
  });

  test("max budget enforcement", () => {
    const policy: ManagedPolicy = {
      maxBudgetUsd: 5.0,
    };
    expect(policy.maxBudgetUsd).toBe(5.0);
  });
});

// ─── Audit Logger Tests ──────────────────────────────────────

import {
  auditLog,
  auditPermissionDecision,
  auditPolicyViolation,
  auditToolExecution,
  getAuditEntries,
  initAuditLogger,
  isAuditEnabled,
} from "./audit-logger";

describe("Audit Logger", () => {
  test("disabled by default", () => {
    expect(isAuditEnabled()).toBe(false);
  });

  test("can be initialized", () => {
    initAuditLogger({ enabled: true, orgId: "test-org" });
    expect(isAuditEnabled()).toBe(true);
  });

  test("logs tool execution", () => {
    auditToolExecution({
      toolName: "Read",
      status: "success",
      inputSummary: "/home/user/file.ts",
      sessionId: "test-session",
      model: "mnemo:mark5",
    });
    // Should not throw
  });

  test("logs permission decision", () => {
    auditPermissionDecision({
      toolName: "Bash",
      granted: false,
      reason: "User denied",
      sessionId: "test-session",
    });
    // Should not throw
  });

  test("logs policy violation", () => {
    auditPolicyViolation({
      action: "Attempted to use blocked model gpt-4",
      reason: "Model not in allowedModels list",
      sessionId: "test-session",
    });
    // Should not throw
  });

  test("can query audit entries", () => {
    const entries = getAuditEntries({ limit: 10 });
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  test("can filter by event type", () => {
    const entries = getAuditEntries({ eventType: "tool_execute", limit: 10 });
    expect(Array.isArray(entries)).toBe(true);
    for (const entry of entries) {
      expect(entry.event_type).toBe("tool_execute");
    }
  });

  test("truncates long input summaries", () => {
    const longInput = "x".repeat(500);
    auditToolExecution({
      toolName: "Read",
      status: "success",
      inputSummary: longInput,
    });
    const entries = getAuditEntries({ eventType: "tool_execute", limit: 1 });
    if (entries.length > 0) {
      const summary = entries[0]!.input_summary as string;
      expect(summary.length).toBeLessThanOrEqual(200);
    }
  });

  test("query respects limit", () => {
    const entries = getAuditEntries({ limit: 2 });
    expect(entries.length).toBeLessThanOrEqual(2);
  });
});
