// KCode - Enterprise Policy Enforcement
// Load and enforce team policies from .kcode/policy.json or ~/.kcode/enterprise/policy.json.
// Works entirely locally without external services.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger";
import { kcodeHome } from "../paths";

// ─── Types ──────────────────────────────────────────────────────

export interface PolicyConfig {
  blockedTools?: string[];
  requiredPermissionMode?: string;
  blockedCloudModels?: string[];
  maxContextWindow?: number;
}

export interface PolicyEnforcementResult {
  allowed: boolean;
  reason?: string;
}

// ─── Load Policy ───────────────────────────────────────────────

/**
 * Load team policy from workspace or global config.
 * Priority: .kcode/policy.json > ~/.kcode/enterprise/policy.json
 * Returns null if no policy file is found.
 */
export function loadTeamPolicy(): PolicyConfig | null {
  const candidates = [
    join(process.cwd(), ".kcode", "policy.json"),
    join(kcodeHome(), "enterprise", "policy.json"),
  ];

  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw);
        log.debug("policy", `Loaded team policy from ${path}`);
        return validatePolicyConfig(parsed);
      }
    } catch (err) {
      log.warn("policy", `Failed to parse policy at ${path}: ${err}`);
    }
  }

  return null;
}

/**
 * Validate and normalize a parsed policy object.
 */
function validatePolicyConfig(raw: unknown): PolicyConfig {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }

  const obj = raw as Record<string, unknown>;
  const config: PolicyConfig = {};

  if (Array.isArray(obj.blockedTools)) {
    config.blockedTools = obj.blockedTools.filter((t): t is string => typeof t === "string");
  }

  if (typeof obj.requiredPermissionMode === "string") {
    const valid = ["ask", "auto", "plan", "deny", "acceptEdits"];
    if (valid.includes(obj.requiredPermissionMode)) {
      config.requiredPermissionMode = obj.requiredPermissionMode;
    }
  }

  if (Array.isArray(obj.blockedCloudModels)) {
    config.blockedCloudModels = obj.blockedCloudModels.filter(
      (m): m is string => typeof m === "string",
    );
  }

  if (typeof obj.maxContextWindow === "number" && obj.maxContextWindow > 0) {
    config.maxContextWindow = obj.maxContextWindow;
  }

  return config;
}

// ─── Enforce Policy ────────────────────────────────────────────

/**
 * Check if a tool is allowed by the given policy.
 */
export function enforcePolicy(toolName: string, config: PolicyConfig): PolicyEnforcementResult {
  if (!config.blockedTools || config.blockedTools.length === 0) {
    return { allowed: true };
  }

  const blocked = config.blockedTools.some(
    (pattern) => {
      // Support glob-style wildcards
      if (pattern.includes("*")) {
        const regex = new RegExp(
          "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
          "i",
        );
        return regex.test(toolName);
      }
      return pattern.toLowerCase() === toolName.toLowerCase();
    },
  );

  if (blocked) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is blocked by team policy`,
    };
  }

  return { allowed: true };
}

/**
 * Check if a model is allowed by the given policy.
 */
export function enforceModelPolicy(
  modelName: string,
  config: PolicyConfig,
): PolicyEnforcementResult {
  if (!config.blockedCloudModels || config.blockedCloudModels.length === 0) {
    return { allowed: true };
  }

  const blocked = config.blockedCloudModels.some(
    (pattern) => {
      if (pattern.includes("*")) {
        const regex = new RegExp(
          "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
          "i",
        );
        return regex.test(modelName);
      }
      return pattern.toLowerCase() === modelName.toLowerCase();
    },
  );

  if (blocked) {
    return {
      allowed: false,
      reason: `Model "${modelName}" is blocked by team policy`,
    };
  }

  return { allowed: true };
}

// ─── Reporting ─────────────────────────────────────────────────

/**
 * Format a human-readable policy report.
 */
export function formatPolicyReport(policy: PolicyConfig): string {
  const lines: string[] = ["  Team Policy Report", "  " + "=".repeat(40)];

  if (policy.blockedTools && policy.blockedTools.length > 0) {
    lines.push("", "  Blocked Tools:");
    for (const t of policy.blockedTools) {
      lines.push(`    - ${t}`);
    }
  } else {
    lines.push("", "  Blocked Tools: none");
  }

  if (policy.requiredPermissionMode) {
    lines.push("", `  Required Permission Mode: ${policy.requiredPermissionMode}`);
  } else {
    lines.push("", "  Required Permission Mode: not set (default)");
  }

  if (policy.blockedCloudModels && policy.blockedCloudModels.length > 0) {
    lines.push("", "  Blocked Cloud Models:");
    for (const m of policy.blockedCloudModels) {
      lines.push(`    - ${m}`);
    }
  } else {
    lines.push("", "  Blocked Cloud Models: none");
  }

  if (policy.maxContextWindow) {
    lines.push("", `  Max Context Window: ${policy.maxContextWindow.toLocaleString()} tokens`);
  } else {
    lines.push("", "  Max Context Window: not set (default)");
  }

  return lines.join("\n");
}
