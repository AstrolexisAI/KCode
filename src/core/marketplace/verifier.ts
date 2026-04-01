// KCode - Plugin Verifier
// Validates plugin integrity: manifest, skill files, hooks, MCP servers, path traversal, size

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { VerificationIssue, VerificationResult } from "./types";

/** Known hook events in KCode (subset, extensible) */
const KNOWN_HOOK_EVENTS = new Set([
  "pre-tool",
  "post-tool",
  "pre-commit",
  "post-commit",
  "pre-edit",
  "post-edit",
  "pre-write",
  "post-write",
  "pre-bash",
  "post-bash",
  "session-start",
  "session-end",
  "pre-compact",
  "post-compact",
  "pre-plan",
  "post-plan",
  "error",
  "pre-save",
  "post-save",
  "pre-send",
  "post-send",
  "pre-agent",
  "post-agent",
  "pre-mcp",
  "post-mcp",
  "pre-skill",
  "post-skill",
]);

/** Maximum recommended plugin size in bytes (10 MB) */
const MAX_RECOMMENDED_SIZE = 10_000_000;

/**
 * Verify the integrity and structure of a plugin directory.
 * Returns a result with valid=true if there are no errors (warnings are acceptable).
 */
export function verifyPlugin(pluginDir: string): VerificationResult {
  const issues: VerificationIssue[] = [];

  // 1. Manifest exists and is valid JSON
  const manifestPath = join(pluginDir, "plugin.json");
  if (!existsSync(manifestPath)) {
    issues.push({
      severity: "error",
      code: "NO_MANIFEST",
      message: "Missing plugin.json",
    });
    return { valid: false, issues };
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    issues.push({
      severity: "error",
      code: "INVALID_MANIFEST",
      message: `Failed to parse plugin.json: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { valid: false, issues };
  }

  // 1b. Required fields
  if (!manifest.name || typeof manifest.name !== "string") {
    issues.push({
      severity: "error",
      code: "NO_NAME",
      message: "Manifest missing required 'name' field",
    });
  }
  if (!manifest.version || typeof manifest.version !== "string") {
    issues.push({
      severity: "error",
      code: "NO_VERSION",
      message: "Manifest missing required 'version' field",
    });
  }

  // 2. Validate skills
  if (Array.isArray(manifest.skills)) {
    for (const skill of manifest.skills) {
      if (typeof skill !== "string") {
        issues.push({
          severity: "error",
          code: "INVALID_SKILL",
          message: `Skill entry is not a string: ${skill}`,
        });
        continue;
      }

      // Path traversal check
      if (isPathTraversal(pluginDir, skill)) {
        issues.push({
          severity: "error",
          code: "PATH_TRAVERSAL",
          message: `Skill path escapes plugin directory: ${skill}`,
        });
        continue;
      }

      const skillPath = join(pluginDir, skill);
      if (!existsSync(skillPath)) {
        issues.push({
          severity: "error",
          code: "MISSING_SKILL",
          message: `Skill file not found: ${skill}`,
        });
      }
    }
  }

  // 3. Validate hooks
  if (manifest.hooks && typeof manifest.hooks === "object" && !Array.isArray(manifest.hooks)) {
    for (const [event, hookConfig] of Object.entries(manifest.hooks as Record<string, unknown>)) {
      if (!KNOWN_HOOK_EVENTS.has(event)) {
        issues.push({
          severity: "warning",
          code: "UNKNOWN_HOOK_EVENT",
          message: `Unknown hook event: ${event}`,
        });
      }
      if (!hookConfig || typeof hookConfig !== "object") {
        issues.push({
          severity: "error",
          code: "INVALID_HOOK",
          message: `Hook for "${event}" is not a valid object`,
        });
        continue;
      }
      const hc = hookConfig as Record<string, unknown>;
      if (!hc.command || typeof hc.command !== "string") {
        issues.push({
          severity: "error",
          code: "HOOK_NO_CMD",
          message: `Hook for "${event}" missing command`,
        });
      }
    }
  } else if (Array.isArray(manifest.hooks)) {
    // Also support array format
    for (const hook of manifest.hooks) {
      if (!hook || typeof hook !== "object") continue;
      const h = hook as Record<string, unknown>;
      if (!h.event || typeof h.event !== "string") {
        issues.push({
          severity: "error",
          code: "HOOK_NO_EVENT",
          message: "Hook entry missing event field",
        });
      }
      if (!h.command || typeof h.command !== "string") {
        issues.push({
          severity: "error",
          code: "HOOK_NO_CMD",
          message: "Hook entry missing command field",
        });
      }
    }
  }

  // 4. Validate MCP servers
  if (
    manifest.mcpServers &&
    typeof manifest.mcpServers === "object" &&
    !Array.isArray(manifest.mcpServers)
  ) {
    for (const [name, config] of Object.entries(manifest.mcpServers as Record<string, unknown>)) {
      if (!config || typeof config !== "object") {
        issues.push({
          severity: "error",
          code: "MCP_INVALID",
          message: `MCP server "${name}" has invalid config`,
        });
        continue;
      }
      const cfg = config as Record<string, unknown>;
      if (!cfg.command || typeof cfg.command !== "string") {
        issues.push({
          severity: "error",
          code: "MCP_NO_CMD",
          message: `MCP server "${name}" missing command`,
        });
      }
    }
  }

  // 5. Validate output styles
  if (Array.isArray(manifest.outputStyles)) {
    for (const style of manifest.outputStyles) {
      if (typeof style !== "string") {
        issues.push({
          severity: "error",
          code: "INVALID_STYLE",
          message: `Output style entry is not a string: ${style}`,
        });
        continue;
      }
      if (isPathTraversal(pluginDir, style)) {
        issues.push({
          severity: "error",
          code: "PATH_TRAVERSAL",
          message: `Output style path escapes plugin directory: ${style}`,
        });
        continue;
      }
      const stylePath = join(pluginDir, style);
      if (!existsSync(stylePath)) {
        issues.push({
          severity: "warning",
          code: "MISSING_STYLE",
          message: `Output style file not found: ${style}`,
        });
      }
    }
  }

  // 6. Validate agents
  if (Array.isArray(manifest.agents)) {
    for (const agent of manifest.agents) {
      if (typeof agent !== "string") {
        issues.push({
          severity: "error",
          code: "INVALID_AGENT",
          message: `Agent entry is not a string: ${agent}`,
        });
        continue;
      }
      if (isPathTraversal(pluginDir, agent)) {
        issues.push({
          severity: "error",
          code: "PATH_TRAVERSAL",
          message: `Agent path escapes plugin directory: ${agent}`,
        });
      }
    }
  }

  // 7. Size check
  try {
    const totalSize = calculateDirSize(pluginDir);
    if (totalSize > MAX_RECOMMENDED_SIZE) {
      issues.push({
        severity: "warning",
        code: "LARGE_PLUGIN",
        message: `Plugin is ${formatBytes(totalSize)} (recommended max: ${formatBytes(MAX_RECOMMENDED_SIZE)})`,
      });
    }
  } catch {
    // Can't measure size, not a blocking issue
  }

  const hasErrors = issues.some((i) => i.severity === "error");
  return { valid: !hasErrors, issues };
}

/**
 * Check if a relative path escapes the base directory.
 */
function isPathTraversal(baseDir: string, relPath: string): boolean {
  if (relPath.includes("..") || relPath.startsWith("/") || relPath.startsWith("\\")) {
    return true;
  }
  const resolved = resolve(baseDir, relPath);
  const rel = relative(baseDir, resolved);
  return rel.startsWith("..") || rel.startsWith("/");
}

/**
 * Recursively calculate directory size in bytes.
 */
function calculateDirSize(dir: string): number {
  let size = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        size += calculateDirSize(fullPath);
      } else if (entry.isFile()) {
        try {
          size += statSync(fullPath).size;
        } catch {
          // Skip unreadable files
        }
      }
    }
  } catch {
    // Directory unreadable
  }
  return size;
}

/**
 * Format bytes into human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
