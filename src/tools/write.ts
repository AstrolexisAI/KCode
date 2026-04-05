// KCode - Write Tool
// Creates or overwrites files

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { AUDIT_FILENAME_PATTERN, isAuditFilename } from "../core/audit-guards";
import { grepCount, readCount, wasRead } from "../core/session-tracker";
import type { FileWriteInput, ToolDefinition, ToolResult } from "../core/types";

export const writeDefinition: ToolDefinition = {
  name: "Write",
  description:
    "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["file_path", "content"],
  },
};

// ─── Audit report guards ────────────────────────────────────────
// Detect filenames that look like audit/review reports or their companions.
// The goal is to force the model to update ONE report instead of creating
// FIXES_SUMMARY.txt, FINAL_AUDIT_REPORT.md, AUDIT_INDEX.md, etc. alongside it.
// The AUDIT_FILENAME_PATTERN and isAuditFilename are imported from
// core/audit-guards so Bash and Write use the same detection.

const CANONICAL_AUDIT_NAMES = new Set([
  "audit_report.md",
  "audit-report.md",
  "auditreport.md",
  "audit.md",
]);

function findExistingCanonicalAuditReport(dir: string): string | null {
  try {
    for (const candidate of CANONICAL_AUDIT_NAMES) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
      // Also check capitalized variants
      const cap = join(dir, candidate.toUpperCase());
      if (existsSync(cap)) return cap;
      const title = join(dir, candidate.charAt(0).toUpperCase() + candidate.slice(1));
      if (existsSync(title)) return title;
    }
    // Fallback: scan directory for any file matching the audit pattern
    const fs = require("node:fs") as typeof import("node:fs");
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (AUDIT_FILENAME_PATTERN.test(entry)) {
        return join(dir, entry);
      }
    }
  } catch {
    /* dir doesn't exist yet or not readable */
  }
  return null;
}

/**
 * Extract file paths listed in an audit "proof of work" checklist section.
 * Matches lines like:
 *   1. path/to/file.cpp — 120 lines — checked for: ...
 *   2. `src/foo.ts` - N lines
 *   3. **source/idf/UsbDevice.hh** — Header declarations
 */
function extractProofOfWorkFiles(content: string): string[] | null {
  // Find the "Files read" / "Proof of work" section header
  const headerMatch = content.match(
    /^#{1,6}\s*Files\s*(read|analyzed|examined).*?(proof of work)?.*$/im,
  );
  if (!headerMatch) return null;
  const start = headerMatch.index! + headerMatch[0].length;
  // Take at most the next 80 lines (section should be short)
  const section = content.slice(start, start + 6000);
  const lines = section.split("\n").slice(0, 60);

  const files: string[] = [];
  for (const line of lines) {
    // Stop at next top-level header
    if (/^#{1,3}\s+\S/.test(line) && !/files\s*(read|analyzed|examined)/i.test(line)) break;
    // Match numbered entries with a file path (must contain a slash or a file extension)
    const m = line.match(
      /^\s*\d+\.\s*[`*_]*([A-Za-z0-9._/\\-]+\.(?:cpp|hh|h|c|ts|tsx|js|jsx|py|go|rs|java|rb|md|txt|cmake|CMakeLists\.txt))[`*_]*/,
    );
    if (m?.[1]) {
      files.push(m[1]);
    }
  }
  return files.length > 0 ? files : null;
}

// ─── Sensitive file patterns ────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /\.(env|env\.\w+)$/,
  /\.(pem|key|crt|cert)$/,
  /\.ssh\//,
  /credentials/i,
  /\.aws\//,
  /\.kube\/config/,
  /id_rsa/,
  /id_ed25519/,
  /\.(bashrc|bash_profile|zshrc|zprofile|profile)$/,
  /\.(gitconfig)$/,
  /crontab$/,
  /systemd\/.*\.service$/,
];

export async function executeWrite(input: Record<string, unknown>): Promise<ToolResult> {
  const { file_path, content } = input as unknown as FileWriteInput;

  // Audit report discipline: block creating a SECOND audit-named file when
  // an AUDIT_REPORT.md (or similar) already exists in the same directory.
  // The goal is to force ONE authoritative report instead of a pile of
  // AUDIT_REPORT.md + FIXES_SUMMARY.txt + FINAL_AUDIT_REPORT.md companions.
  if (isAuditFilename(file_path)) {
    const dir = dirname(file_path);
    const existing = findExistingCanonicalAuditReport(dir);
    const fileBase = basename(file_path);
    const existingBase = existing ? basename(existing) : null;
    if (existing && existingBase && existingBase.toLowerCase() !== fileBase.toLowerCase()) {
      return {
        tool_use_id: "",
        content:
          `BLOCKED: An audit report already exists at "${existing}". ` +
          `Do NOT create companion files like "${fileBase}". ` +
          `UPDATE the existing AUDIT_REPORT.md instead — a single authoritative ` +
          `report is the required deliverable. If you need to add more findings, ` +
          `use the Edit tool on "${existing}".`,
        is_error: true,
      };
    }
  }

  // Reconnaissance enforcement: writing an audit report requires both
  // (a) at least one Grep call to locate bug patterns across the tree, and
  // (b) at least 5 distinct files Read in this session.
  // These are hard technical minimums — an audit built on <5 reads and zero
  // greps is a marketing document, not an audit.
  if (isAuditFilename(file_path)) {
    const greps = grepCount();
    const reads = readCount();
    const problems: string[] = [];
    if (greps === 0) {
      problems.push(
        "you have not called the Grep tool ONCE in this session. " +
          "Audits require grep-first reconnaissance to locate bug patterns " +
          "(recv|parse|decode|data\\[|buffer\\[|open\\(|malloc|\\(&[a-z]).",
      );
    }
    if (reads < 5) {
      problems.push(
        `you have Read only ${reads} file(s). ` +
          "An audit requires reading the hot files (protocol decoders, network I/O, " +
          "resource lifecycle) in full — minimum 5, ideally 10+.",
      );
    }
    if (problems.length > 0) {
      return {
        tool_use_id: "",
        content:
          `BLOCKED: Cannot write audit report "${basename(file_path)}" because:\n` +
          problems.map((p, i) => `  ${i + 1}. ${p}`).join("\n") +
          `\n\nBefore writing this report, you MUST:\n` +
          `  1. Run Grep for dangerous patterns across the source tree\n` +
          `  2. Read AT LEAST 5 hot files in full (protocol decoders, parsers, I/O)\n` +
          `  3. Then re-submit the audit report.\n` +
          `This is a hard minimum, not advice. Session state: ${reads} reads, ${greps} greps.`,
        is_error: true,
      };
    }
  }

  // Proof-of-work validation: if the file being written contains an audit
  // "Files read in full" / "Proof of work" checklist, verify every listed
  // file was actually Read by the Read tool in this session. Fabricated
  // checklists void the audit.
  if (isAuditFilename(file_path)) {
    const listedFiles = extractProofOfWorkFiles(content);
    if (listedFiles && listedFiles.length > 0) {
      const fabricated = listedFiles.filter((f) => !wasRead(f));
      if (fabricated.length > 0) {
        return {
          tool_use_id: "",
          content:
            `BLOCKED: The audit report lists ${listedFiles.length} file(s) as "read in full", ` +
            `but ${fabricated.length} of them were NEVER opened with the Read tool in this session:\n` +
            fabricated.map((f) => `  - ${f}`).join("\n") +
            `\n\nFabricating the proof-of-work checklist voids the audit. You must either:\n` +
            `  (a) actually Read those files now, then re-submit, OR\n` +
            `  (b) remove them from the checklist and honestly write ` +
            `"Audit incomplete — only read N files" at the top of the report.\n\n` +
            `Listing files you didn't Read is worse than admitting a short audit.`,
          is_error: true,
        };
      }
    }
  }

  // Block writes to sensitive files
  const isSensitive = SENSITIVE_PATTERNS.some((p) => p.test(file_path));
  if (isSensitive) {
    return {
      tool_use_id: "",
      content: `BLOCKED: Writing to "${file_path}" is blocked because it matches a sensitive file pattern (.env, .pem, .ssh, credentials, etc.). If you need to write this file, ask the user to do it manually.`,
      is_error: true,
    };
  }

  // Resolve symlinks to prevent path traversal (parity with Edit tool)
  try {
    const realPath = realpathSync(file_path);
    if (realPath !== file_path && SENSITIVE_PATTERNS.some((p) => p.test(realPath))) {
      return {
        tool_use_id: "",
        content: `BLOCKED: "${file_path}" is a symlink to "${realPath}" which matches a sensitive file pattern.`,
        is_error: true,
      };
    }
  } catch {
    // File doesn't exist yet — will be created by writeFileSync
  }

  try {
    // Detect inline HTML/CSS/JS in plain .ts files — common model mistake
    // Exclude .tsx/.jsx files: JSX is HTML-in-TypeScript by design (React, Ink, etc.)
    const isTSPlain = file_path.endsWith(".ts") && !file_path.endsWith(".d.ts");
    const hasInlineHTML =
      isTSPlain &&
      /<\s*(html|div|span|body|head|style|script|form|button|input|table|section|header|footer|nav|main|article)\b/i.test(
        content,
      );
    const isLargeInline = hasInlineHTML && content.length > 2000;

    if (isLargeInline) {
      return {
        tool_use_id: "",
        content: `BLOCKED: You are embedding HTML inside a TypeScript file (${file_path}). This will cause parsing errors because backticks, \${}, and HTML attributes conflict with TypeScript syntax.\n\nYou MUST create separate files instead:\n1. public/index.html — for HTML\n2. public/styles.css — for CSS\n3. public/app.js — for frontend JavaScript\n4. ${file_path} — for ONLY the TypeScript server code\n\nUse Bun.file() to serve static files:\n  if (url.pathname === "/") return new Response(Bun.file("public/index.html"));\n\nRewrite your approach using separate files.`,
        is_error: true,
      };
    }

    // Check for symlink BEFORE creating directories (defense-in-depth)
    try {
      const stat = lstatSync(file_path);
      if (stat.isSymbolicLink()) {
        return {
          tool_use_id: "",
          content: `BLOCKED: "${file_path}" is a symlink. Refusing to write through symlinks for security.`,
          is_error: true,
        };
      }
    } catch {
      // File doesn't exist yet — safe to create
    }

    mkdirSync(dirname(file_path), { recursive: true });

    // Atomic TOCTOU-safe write: O_NOFOLLOW rejects symlinks at kernel level,
    // so even if an attacker races to create a symlink between lstatSync and
    // here, the open() will fail instead of following it.
    const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW;
    try {
      const fd = openSync(file_path, flags, 0o644);
      try {
        const buf = Buffer.from(content, "utf-8");
        // Write directly to fd — no path re-resolution possible
        const { writeSync } = require("node:fs") as typeof import("node:fs");
        writeSync(fd, buf, 0, buf.length, 0);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ELOOP" || e.code === "EEXIST") {
        return {
          tool_use_id: "",
          content: `BLOCKED: "${file_path}" is a symlink or was replaced with one mid-write. Aborted for security.`,
          is_error: true,
        };
      }
      throw err;
    }

    const lines = content.split("\n");
    const lineCount = lines.length;
    let warning = "";
    if (hasInlineHTML) {
      warning =
        "\n⚠️ Warning: This file contains HTML inside TypeScript. Consider moving HTML/CSS/JS to separate files in public/ to avoid template literal issues.";
    }

    // Include the complete file content with line numbers for professional display.
    // The UI renders this with syntax-aware formatting (green for new files).
    const numberedLines = lines
      .map((line, i) => `  + ${String(i + 1).padStart(4)} | ${line}`)
      .join("\n");

    return {
      tool_use_id: "",
      content: `Created ${file_path} (${lineCount} lines)${warning}\n${numberedLines}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      tool_use_id: "",
      content: `Error writing "${file_path}": ${msg}`,
      is_error: true,
    };
  }
}
