// KCode - Enterprise Policy Enforcement
// Load and enforce team policies from .kcode/policy.json or ~/.kcode/enterprise/policy.json.
// Works entirely locally without external services.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger";
import { kcodeHome } from "../paths";

// ─── Types ──────────────────────────────────────────────────────

export interface NetworkPolicy {
  /** Hosts/IPs allowed for outbound connections (glob patterns). Empty = no restriction. */
  allowedHosts?: string[];
  /** Hosts/IPs explicitly blocked (glob patterns). Takes precedence over allowedHosts. */
  blockedHosts?: string[];
  /** Block all webhook hook destinations (default: false) */
  allowWebhooks?: boolean;
  /** Block all plugin network access (default: true in air-gap) */
  allowPluginNetwork?: boolean;
}

export interface PolicyConfig {
  blockedTools?: string[];
  requiredPermissionMode?: string;
  blockedCloudModels?: string[];
  maxContextWindow?: number;
  /** Network egress control — restrict outbound connections */
  network?: NetworkPolicy;
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

  if (obj.network && typeof obj.network === "object") {
    config.network = validateNetworkPolicy(obj.network as Record<string, unknown>);
  }

  return config;
}

/**
 * Validate and normalize a network policy object.
 */
function validateNetworkPolicy(raw: Record<string, unknown>): NetworkPolicy {
  const policy: NetworkPolicy = {};

  if (Array.isArray(raw.allowedHosts)) {
    policy.allowedHosts = raw.allowedHosts.filter((h): h is string => typeof h === "string");
  }
  if (Array.isArray(raw.blockedHosts)) {
    policy.blockedHosts = raw.blockedHosts.filter((h): h is string => typeof h === "string");
  }
  if (typeof raw.allowWebhooks === "boolean") {
    policy.allowWebhooks = raw.allowWebhooks;
  }
  if (typeof raw.allowPluginNetwork === "boolean") {
    policy.allowPluginNetwork = raw.allowPluginNetwork;
  }

  return policy;
}

// ─── Enforce Policy ────────────────────────────────────────────

/**
 * Check if a tool is allowed by the given policy.
 */
export function enforcePolicy(toolName: string, config: PolicyConfig): PolicyEnforcementResult {
  if (!config.blockedTools || config.blockedTools.length === 0) {
    return { allowed: true };
  }

  const blocked = config.blockedTools.some((pattern) => {
    // Support glob-style wildcards
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
      return regex.test(toolName);
    }
    return pattern.toLowerCase() === toolName.toLowerCase();
  });

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

  const blocked = config.blockedCloudModels.some((pattern) => {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
      return regex.test(modelName);
    }
    return pattern.toLowerCase() === modelName.toLowerCase();
  });

  if (blocked) {
    return {
      allowed: false,
      reason: `Model "${modelName}" is blocked by team policy`,
    };
  }

  return { allowed: true };
}

// ─── Network Egress Enforcement ───────────────────────────────

/**
 * Simple glob match for hostname patterns.
 * Supports * (any chars) and ? (single char).
 */
function hostGlobMatch(pattern: string, hostname: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/([.+^${}()|[\]\\])/g, "\\$1")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
    "i",
  );
  return regex.test(hostname);
}

/**
 * Check if an outbound connection to the given URL is allowed by network policy.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 *
 * Rules:
 *   1. localhost/LAN always allowed (for local inference servers)
 *   2. blockedHosts checked first (deny takes precedence)
 *   3. If allowedHosts is set and non-empty, only those hosts are permitted (allowlist mode)
 *   4. If neither is set, all hosts are allowed (no restriction)
 */
export function enforceNetworkPolicy(url: string, config: PolicyConfig): PolicyEnforcementResult {
  if (!config.network) return { allowed: true };

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: `Invalid URL: ${url}` };
  }

  // Always allow localhost/LAN (needed for local models, Ollama, etc.)
  if (isLocalOrLan(hostname)) return { allowed: true };

  const { allowedHosts, blockedHosts } = config.network;

  // Check blockedHosts first (deny takes precedence)
  if (blockedHosts && blockedHosts.length > 0) {
    const blocked = blockedHosts.some((pattern) => hostGlobMatch(pattern, hostname));
    if (blocked) {
      return {
        allowed: false,
        reason: `Host "${hostname}" is blocked by network policy`,
      };
    }
  }

  // If allowedHosts is set, enforce allowlist (only listed hosts are permitted)
  if (allowedHosts && allowedHosts.length > 0) {
    const allowed = allowedHosts.some((pattern) => hostGlobMatch(pattern, hostname));
    if (!allowed) {
      return {
        allowed: false,
        reason: `Host "${hostname}" is not in the network allowlist`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Check if a webhook URL is allowed by network policy.
 * Webhooks can be entirely disabled via allowWebhooks: false.
 */
export function enforceWebhookPolicy(url: string, config: PolicyConfig): PolicyEnforcementResult {
  if (config.network?.allowWebhooks === false) {
    return {
      allowed: false,
      reason: "Webhooks are disabled by network policy",
    };
  }
  return enforceNetworkPolicy(url, config);
}

/** Check if a hostname is localhost or LAN (always allowed even in air-gap). */
function isLocalOrLan(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h === "0.0.0.0") {
    return true;
  }
  if (h.startsWith("192.168.") || h.startsWith("10.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

/**
 * Get the default network policy for air-gap mode.
 * Blocks all external hosts; allows only localhost and LAN.
 */
export function getAirGapNetworkPolicy(): NetworkPolicy {
  return {
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      "::1",
      "10.*",
      "192.168.*",
      "172.16.*",
      "172.17.*",
      "172.18.*",
      "172.19.*",
      "172.2?.*",
      "172.30.*",
      "172.31.*",
    ],
    blockedHosts: ["*"],
    allowWebhooks: false,
    allowPluginNetwork: false,
  };
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

  if (policy.network) {
    lines.push("", "  Network Policy:");
    if (policy.network.blockedHosts?.length) {
      lines.push(`    Blocked hosts: ${policy.network.blockedHosts.join(", ")}`);
    }
    if (policy.network.allowedHosts?.length) {
      lines.push(`    Allowed hosts: ${policy.network.allowedHosts.join(", ")}`);
    }
    lines.push(`    Webhooks: ${policy.network.allowWebhooks !== false ? "allowed" : "blocked"}`);
    lines.push(
      `    Plugin network: ${policy.network.allowPluginNetwork !== false ? "allowed" : "blocked"}`,
    );
  } else {
    lines.push("", "  Network Policy: not set (no restrictions)");
  }

  return lines.join("\n");
}
