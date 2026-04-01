// KCode - Plugin Validator
// Validates plugin structure, manifest, and content integrity.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  VALID_HOOK_EVENTS,
  validateManifestSchema,
} from "../../../core/plugin-sdk/manifest-schema";
import type { ValidationIssue, ValidationReport } from "../../../core/plugin-sdk/types";

export async function validatePlugin(dir: string): Promise<ValidationReport> {
  const report: ValidationReport = { valid: true, errors: [], warnings: [], info: [] };

  // 1. Manifest exists
  const manifestPath = join(dir, "plugin.json");
  if (!existsSync(manifestPath)) {
    report.errors.push({ code: "MISSING_MANIFEST", message: "plugin.json not found" });
    report.valid = false;
    return report;
  }

  // 2. Parse JSON
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (e: any) {
    report.errors.push({
      code: "INVALID_JSON",
      message: `plugin.json parse error: ${e.message}`,
    });
    report.valid = false;
    return report;
  }

  // 3. Schema validation
  const schemaResult = validateManifestSchema(manifest);
  if (!schemaResult.valid) {
    for (const err of schemaResult.errors) {
      report.errors.push({ code: "SCHEMA_ERROR", message: err, file: "plugin.json" });
    }
    report.valid = false;
  }

  // 4. Skills validation
  if (Array.isArray(manifest.skills)) {
    for (const pattern of manifest.skills as string[]) {
      const files = findMatchingFiles(dir, pattern);
      if (files.length === 0) {
        report.warnings.push({
          code: "NO_SKILLS",
          message: `No files match skill pattern: ${pattern}`,
        });
      }
      for (const file of files) {
        const content = readFileSync(join(dir, file), "utf-8");
        const fmErrors = validateFrontmatter(content);
        if (fmErrors.length > 0) {
          report.errors.push({
            code: "INVALID_SKILL",
            message: `Invalid frontmatter in ${file}: ${fmErrors.join(", ")}`,
            file,
          });
          report.valid = false;
        }
      }
    }
  }

  // 5. Hooks validation
  if (manifest.hooks && typeof manifest.hooks === "object") {
    for (const event of Object.keys(manifest.hooks as Record<string, unknown>)) {
      if (!(VALID_HOOK_EVENTS as readonly string[]).includes(event)) {
        report.warnings.push({
          code: "UNKNOWN_HOOK_EVENT",
          message: `Unknown hook event: ${event}`,
        });
      }
      const handlers = (manifest.hooks as Record<string, unknown[]>)[event];
      if (Array.isArray(handlers)) {
        for (const handler of handlers) {
          if (!handler || typeof handler !== "object") continue;
          const h = handler as Record<string, unknown>;
          if (!h.command && !h.action) {
            report.warnings.push({
              code: "HOOK_NO_COMMAND",
              message: `Hook "${event}" handler missing command or action`,
            });
          }
        }
      }
    }
  }

  // 6. MCP servers validation
  if (manifest.mcpServers && typeof manifest.mcpServers === "object") {
    for (const [name, config] of Object.entries(manifest.mcpServers as Record<string, unknown>)) {
      if (!config || typeof config !== "object") continue;
      if (!(config as Record<string, unknown>).command) {
        report.errors.push({
          code: "MCP_NO_COMMAND",
          message: `MCP server '${name}' missing command`,
        });
        report.valid = false;
      }
    }
  }

  // 7. Agents validation
  if (Array.isArray(manifest.agents)) {
    for (const pattern of manifest.agents as string[]) {
      const files = findMatchingFiles(dir, pattern);
      if (files.length === 0) {
        report.warnings.push({
          code: "NO_AGENTS",
          message: `No files match agent pattern: ${pattern}`,
        });
      }
      for (const file of files) {
        const content = readFileSync(join(dir, file), "utf-8");
        const fmErrors = validateFrontmatter(content);
        if (fmErrors.length > 0) {
          report.warnings.push({
            code: "INVALID_AGENT",
            message: `Invalid frontmatter in ${file}: ${fmErrors.join(", ")}`,
            file,
          });
        }
      }
    }
  }

  // 8. Path traversal check
  const allPaths = [
    ...((manifest.skills as string[]) || []),
    ...((manifest.outputStyles as string[]) || []),
    ...((manifest.agents as string[]) || []),
  ];
  for (const p of allPaths) {
    if (typeof p === "string" && (p.includes("..") || p.startsWith("/"))) {
      report.errors.push({ code: "PATH_TRAVERSAL", message: `Unsafe path: ${p}` });
      report.valid = false;
    }
  }

  // 9. Size check
  const totalSize = calculateDirSize(dir);
  if (totalSize > 10_000_000) {
    report.warnings.push({
      code: "LARGE_PLUGIN",
      message: `Plugin size: ${formatBytes(totalSize)} (recommended: <10MB)`,
    });
  }

  // 10. Component summary
  const components = ["skills", "hooks", "mcpServers", "outputStyles", "agents"]
    .filter((k) => manifest[k])
    .join(", ");
  report.info.push({
    code: "SUMMARY",
    message: `Components: ${components || "none"}`,
  });
  report.info.push({
    code: "SIZE",
    message: `Total size: ${formatBytes(totalSize)}`,
  });

  return report;
}

export function formatValidationReport(report: ValidationReport): string {
  const lines: string[] = [];

  if (report.valid) {
    lines.push("\u2713 Plugin is valid\n");
  } else {
    lines.push("\u2717 Plugin has errors\n");
  }

  if (report.errors.length > 0) {
    lines.push("Errors:");
    for (const e of report.errors) {
      const loc = e.file ? ` (${e.file})` : "";
      lines.push(`  \u2717 [${e.code}] ${e.message}${loc}`);
      if (e.fix) lines.push(`    Fix: ${e.fix}`);
    }
    lines.push("");
  }

  if (report.warnings.length > 0) {
    lines.push("Warnings:");
    for (const w of report.warnings) {
      lines.push(`  \u26a0 [${w.code}] ${w.message}`);
    }
    lines.push("");
  }

  if (report.info.length > 0) {
    lines.push("Info:");
    for (const i of report.info) {
      lines.push(`  \u2139 ${i.message}`);
    }
  }

  return lines.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────

function findMatchingFiles(dir: string, pattern: string): string[] {
  // Simple glob matching for *.md patterns
  const parts = pattern.split("/");
  const dirPart = parts.slice(0, -1).join("/");
  const filePart = parts[parts.length - 1];
  const targetDir = join(dir, dirPart);

  if (!existsSync(targetDir)) return [];

  try {
    const entries = readdirSync(targetDir);
    const regex = new RegExp("^" + filePart.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    return entries.filter((e) => regex.test(e)).map((e) => (dirPart ? `${dirPart}/${e}` : e));
  } catch {
    return [];
  }
}

function validateFrontmatter(content: string): string[] {
  const errors: string[] = [];
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    errors.push("Missing YAML frontmatter (--- delimiters)");
    return errors;
  }

  const fm = match[1];
  const lines = fm.split("\n").filter((l) => l.trim());
  const fields: Record<string, string> = {};

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      fields[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
    }
  }

  if (!fields.name) errors.push("Missing 'name' in frontmatter");
  if (!fields.description) errors.push("Missing 'description' in frontmatter");

  return errors;
}

function calculateDirSize(dir: string): number {
  let total = 0;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        total += calculateDirSize(fullPath);
      } else {
        total += stat.size;
      }
    }
  } catch {
    /* skip inaccessible dirs */
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
