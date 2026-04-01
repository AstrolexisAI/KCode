// KCode - Plugin Manifest Schema & Validation

import type { PluginManifest } from "./types";

export const MANIFEST_REQUIRED_FIELDS = ["name", "version", "description"] as const;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
const VERSION_RANGE_PATTERN = /^[><=~^]*\d+\.\d+\.\d+/;

const VALID_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "Stop",
  "ErrorOccurred",
  "PreCompact",
  "PostCompact",
  "ToolError",
  "ModelSwitch",
  "PermissionDenied",
] as const;

const VALID_LICENSES = [
  "MIT",
  "Apache-2.0",
  "GPL-3.0",
  "AGPL-3.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "LGPL-3.0",
  "MPL-2.0",
  "Unlicense",
  "AGPL-3.0-only",
] as const;

export const MANIFEST_SCHEMA = {
  type: "object",
  required: ["name", "version", "description"],
  properties: {
    name: { type: "string", pattern: NAME_PATTERN.source },
    version: { type: "string", pattern: SEMVER_PATTERN.source },
    description: { type: "string", minLength: 1, maxLength: 500 },
    author: { type: "string" },
    license: { type: "string", enum: VALID_LICENSES },
    kcode: { type: "string", pattern: VERSION_RANGE_PATTERN.source },
    skills: { type: "array", items: { type: "string" } },
    hooks: { type: "object" },
    mcpServers: { type: "object" },
    outputStyles: { type: "array", items: { type: "string" } },
    agents: { type: "array", items: { type: "string" } },
  },
} as const;

export function validateManifestSchema(manifest: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["Manifest must be a JSON object"] };
  }

  const m = manifest as Record<string, unknown>;

  // Required fields
  for (const field of MANIFEST_REQUIRED_FIELDS) {
    if (!m[field] || typeof m[field] !== "string") {
      errors.push(`Missing or invalid required field: ${field}`);
    }
  }

  // Name format
  if (typeof m.name === "string" && !NAME_PATTERN.test(m.name)) {
    errors.push(
      `Plugin name must be lowercase alphanumeric with hyphens, got: "${m.name}"`,
    );
  }

  // Name length
  if (typeof m.name === "string" && (m.name.length < 2 || m.name.length > 64)) {
    errors.push("Plugin name must be 2-64 characters");
  }

  // Version format
  if (typeof m.version === "string" && !SEMVER_PATTERN.test(m.version)) {
    errors.push(`Version must be semver (e.g., 1.0.0), got: "${m.version}"`);
  }

  // Description length
  if (typeof m.description === "string" && m.description.length > 500) {
    errors.push("Description must be 500 characters or less");
  }

  // KCode version range
  if (m.kcode !== undefined) {
    if (
      typeof m.kcode !== "string" ||
      !VERSION_RANGE_PATTERN.test(m.kcode)
    ) {
      errors.push(
        `kcode field must be a valid version range (e.g., ">=1.7.0")`,
      );
    }
  }

  // Skills array
  if (m.skills !== undefined) {
    if (!Array.isArray(m.skills)) {
      errors.push("skills must be an array of glob patterns");
    } else {
      for (const s of m.skills) {
        if (typeof s !== "string") {
          errors.push("Each skill pattern must be a string");
        }
      }
    }
  }

  // Hooks object
  if (m.hooks !== undefined) {
    if (typeof m.hooks !== "object" || Array.isArray(m.hooks)) {
      errors.push("hooks must be an object");
    } else {
      for (const event of Object.keys(m.hooks as Record<string, unknown>)) {
        if (!(VALID_HOOK_EVENTS as readonly string[]).includes(event)) {
          errors.push(`Unknown hook event: "${event}"`);
        }
        const handlers = (m.hooks as Record<string, unknown>)[event];
        if (!Array.isArray(handlers)) {
          errors.push(`Hook event "${event}" must be an array of handlers`);
        }
      }
    }
  }

  // MCP servers
  if (m.mcpServers !== undefined) {
    if (typeof m.mcpServers !== "object" || Array.isArray(m.mcpServers)) {
      errors.push("mcpServers must be an object");
    } else {
      for (const [name, config] of Object.entries(
        m.mcpServers as Record<string, unknown>,
      )) {
        if (!config || typeof config !== "object") {
          errors.push(`MCP server "${name}" must be an object`);
          continue;
        }
        if (!(config as Record<string, unknown>).command) {
          errors.push(`MCP server "${name}" missing required field: command`);
        }
      }
    }
  }

  // Output styles array
  if (m.outputStyles !== undefined) {
    if (!Array.isArray(m.outputStyles)) {
      errors.push("outputStyles must be an array of glob patterns");
    }
  }

  // Agents array
  if (m.agents !== undefined) {
    if (!Array.isArray(m.agents)) {
      errors.push("agents must be an array of glob patterns");
    }
  }

  // Path traversal check on all glob arrays
  const allPaths = [
    ...((m.skills as string[]) || []),
    ...((m.outputStyles as string[]) || []),
    ...((m.agents as string[]) || []),
  ];
  for (const p of allPaths) {
    if (typeof p === "string" && (p.includes("..") || p.startsWith("/"))) {
      errors.push(`Unsafe path detected: "${p}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function isValidPluginName(name: string): boolean {
  return (
    NAME_PATTERN.test(name) && name.length >= 2 && name.length <= 64
  );
}

export function suggestFixedName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export { VALID_HOOK_EVENTS, VALID_LICENSES };
