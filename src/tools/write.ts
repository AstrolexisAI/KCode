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
import { AUDIT_FILENAME_PATTERN, auditGuardsEnabled, isAuditFilename } from "../core/audit-guards";
import {
  getGrepHitFiles,
  grepCount,
  sourceReadCount,
  unreadGrepHits,
  wasRead,
} from "../core/session-tracker";
import type { FileWriteInput, ToolDefinition, ToolResult } from "../core/types";

export const writeDefinition: ToolDefinition = {
  name: "Write",
  description:
    "Writes a file to the local filesystem.\n\n" +
    "Usage:\n" +
    "- This tool will overwrite the existing file if there is one at the provided path.\n" +
    "- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n" +
    "- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.\n" +
    "- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.\n" +
    "- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
  input_schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The absolute path to the file to write (must be absolute, not relative)",
      },
      content: { type: "string", description: "The content to write to the file" },
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
 * Extract file citations from audit content. Matches two patterns:
 *
 * 1. "file.cpp:NNN" — classic file:line reference
 *
 * 2. Content claims where the model attaches a code snippet to a
 *    filename, e.g.:
 *       `HidDevice.cpp`: `buttons.push_back(new SingleInput(0,1))`
 *       **File:** `Utils.cpp`\n```cpp\ncode\n```
 *    These are specific claims about file contents — the model can only
 *    know the contents if it Read the file.
 *
 * Returns unique file paths (deduplicated).
 */
function extractCitedFiles(content: string): string[] {
  const SOURCE_EXT =
    "cpp|cc|cxx|c|hh|hpp|hxx|h|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|scala|m|mm|zig";
  const seen = new Set<string>();

  // Pattern 1: "file.ext:NNN" or "file.ext#NNN"
  const reLine = new RegExp(
    `\\b([\\w./\\\\-]*[\\w-]+\\.(?:${SOURCE_EXT}))[:#]\\s*\\d+`,
    "g",
  );
  let m: RegExpExecArray | null;
  m = reLine.exec(content);
  while (m !== null) {
    seen.add(m[1]!);
    m = reLine.exec(content);
  }

  // Pattern 2: \`file.ext\` followed by colon and inline-code content claim
  //   matches: \`HidDevice.cpp\`: \`code...\`  OR  \`HidDevice.cpp\` — \`code...\`
  const reBacktickClaim = new RegExp(
    "`([\\w./\\\\-]*[\\w-]+\\.(?:" +
      SOURCE_EXT +
      "))`\\s*[:\\-—–]\\s*`[^`]+`",
    "g",
  );
  m = reBacktickClaim.exec(content);
  while (m !== null) {
    seen.add(m[1]!);
    m = reBacktickClaim.exec(content);
  }

  // Pattern 3: filename referenced in "**File:** \`name.ext\`" or
  // "File: \`name.ext\`" followed by a code fence within 300 chars.
  // This catches markdown-style finding headers where the model then
  // shows a code block pretending to be from that file.
  const reFileLabel = new RegExp(
    "\\*{0,2}File\\*{0,2}\\s*:\\s*\\*{0,2}\\s*`?([\\w./\\\\-]*[\\w-]+\\.(?:" +
      SOURCE_EXT +
      "))`?[\\s\\S]{0,300}?```",
    "g",
  );
  m = reFileLabel.exec(content);
  while (m !== null) {
    seen.add(m[1]!);
    m = reFileLabel.exec(content);
  }

  return Array.from(seen);
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
  // Phase 4: detect immediate retry of a failed Write with identical content
  try {
    const { detectImmediateEditRetry, acknowledgeEditWarning } = await import(
      "../core/file-edit-history.js"
    );
    const warning = detectImmediateEditRetry("Write", input);
    if (warning) {
      acknowledgeEditWarning("Write", input);
      return { tool_use_id: "", content: warning.report, is_error: true };
    }
  } catch {
    /* non-fatal */
  }

  const result = await _executeWriteInner(input);

  try {
    const { recordEditAttempt } = await import("../core/file-edit-history.js");
    recordEditAttempt("Write", input, result.is_error ?? false, String(result.content ?? ""));
  } catch {
    /* non-fatal */
  }

  return result;
}

async function _executeWriteInner(input: Record<string, unknown>): Promise<ToolResult> {
  const { file_path, content } = input as unknown as FileWriteInput;

  // Audit report discipline: block creating a SECOND audit-named file when
  // an AUDIT_REPORT.md (or similar) already exists in the same directory.
  // The goal is to force ONE authoritative report instead of a pile of
  // AUDIT_REPORT.md + FIXES_SUMMARY.txt + FINAL_AUDIT_REPORT.md companions.
  if (auditGuardsEnabled() && isAuditFilename(file_path)) {
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

  // Reconnaissance enforcement: writing an audit report requires
  // (a) at least one Grep call to locate bug patterns across the tree,
  // (b) at least 8 distinct SOURCE files Read in this session, and
  // (c) coverage of grep-hit files — you can't leave high-risk files unread.
  if (auditGuardsEnabled() && isAuditFilename(file_path)) {
    const greps = grepCount();
    const sourceReads = sourceReadCount();
    const problems: string[] = [];
    if (greps === 0) {
      problems.push(
        "you have not called the Grep tool ONCE in this session. " +
          "Audits require grep-first reconnaissance to locate bug patterns " +
          "(recv|parse|decode|data\\[|buffer\\[|open\\(|malloc|\\(&[a-z]).",
      );
    }
    if (sourceReads < 6) {
      problems.push(
        `you have Read only ${sourceReads} SOURCE file(s) (.cpp/.h/.ts/.py/etc — ` +
          `README.md and CMakeLists.txt don't count). ` +
          "An audit requires reading the hot files (network I/O, protocol " +
          "decoders, resource lifecycle) in full — minimum 6 source files.",
      );
    }
    // Grep-hit coverage: require the model to Read a reasonable number of
    // high-risk files flagged by its dangerous-pattern greps. Cap at 5
    // absolute — if grep returns 22 hits, reading ALL of them is
    // unreasonable for one session, but reading 5 is fair.
    // Formula: required = min(ceil(totalHits / 2), 5)
    //   3 hits  → need 2 read
    //   10 hits → need 5 read
    //   22 hits → need 5 read (capped)
    const unread = unreadGrepHits();
    const totalHits = getGrepHitFiles().length;
    const readHits = totalHits - unread.length;
    const required = Math.min(Math.ceil(totalHits / 2), 5);
    if (totalHits >= 3 && readHits < required) {
      const examples = unread.slice(0, 6).map((f) => `    - ${f}`).join("\n");
      problems.push(
        `your Grep calls flagged ${totalHits} high-risk file(s) for dangerous ` +
          `patterns (buffer indexing, I/O, resource lifecycle). You have Read ` +
          `${readHits} of them, but need to Read at least ${required}. ` +
          `\n  Unread high-risk files (pick ${required - readHits} more to open):\n${examples}` +
          (unread.length > 6 ? `\n    ... and ${unread.length - 6} more` : ""),
      );
    }
    if (problems.length > 0) {
      // Actionable next-step: list specific unread grep-hit files so the
      // model knows EXACTLY which Reads to call before retrying.
      let nextSteps = "";
      const filesToRead = unread.slice(0, 6);
      if (filesToRead.length > 0) {
        nextSteps =
          `\n\nNEXT STEP — call Read on these unread high-risk files:\n` +
          filesToRead.map((f, i) => `  ${i + 1}. Read("${f}")`).join("\n");
      } else if (sourceReads < 6) {
        // No grep hits yet — give generic guidance
        nextSteps =
          `\n\nNEXT STEP — run more Greps to locate hot files (e.g. for data[, ` +
          `buffer[, recv(, open(), then Read at least ${6 - sourceReads} more ` +
          `source files (.cpp/.hh/.ts, NOT README.md or CMakeLists.txt).`;
      }

      // Honest-summary template the model must use if it gives up.
      const neededMore = Math.max(0, 6 - sourceReads);
      const honestSummary =
        `\n\nIF YOU STOP HERE: your response to the user MUST begin with ` +
        `"AUDIT INCOMPLETE" and state exactly: ` +
        `"I could not write the audit report. I only Read ${sourceReads} of ` +
        `6 required source files${neededMore > 0 ? ` (needed ${neededMore} more)` : ""}${
          unread.length > 0 ? `, leaving ${unread.length} high-risk file(s) unopened` : ""
        }." ` +
        `Do NOT describe the codebase as "production-ready", "excellent", ` +
        `"professional-grade", or give star ratings — you did not read enough ` +
        `code to make that claim.`;

      return {
        tool_use_id: "",
        content:
          `BLOCKED — FILE NOT CREATED: "${basename(file_path)}" was NOT written. Reasons:\n` +
          problems.map((p, i) => `  ${i + 1}. ${p}`).join("\n") +
          `\n\nSession state: ${sourceReads} source reads, ${greps} greps, ` +
          `${totalHits} grep-hit files (${unread.length} unread).` +
          nextSteps +
          honestSummary,
        is_error: true,
      };
    }
  }

  // Citation validation: every file:line citation in the audit body must
  // refer to a file actually Read in this session. Catches hallucinated
  // line numbers and fabricated findings on unread files.
  if (auditGuardsEnabled() && isAuditFilename(file_path)) {
    const citedFiles = extractCitedFiles(content);
    const uncitedUnread = citedFiles.filter((f) => !wasRead(f));
    if (uncitedUnread.length > 0) {
      const listed = uncitedUnread.slice(0, 8).map((f) => `    - ${f}`).join("\n");
      return {
        tool_use_id: "",
        content:
          `BLOCKED — FILE NOT CREATED: Your audit cites ${uncitedUnread.length} ` +
          `file(s) you never opened with the Read tool in this session:\n${listed}` +
          (uncitedUnread.length > 8 ? `\n    ... and ${uncitedUnread.length - 8} more` : "") +
          `\n\nEvery "file.cpp:line" citation must point to a file you ` +
          `actually Read. Either:\n  (a) Read the cited files, then re-submit, OR\n` +
          `  (b) remove the unverified citations from the report.\n\n` +
          `IMPORTANT: The audit file does NOT exist. Do NOT tell the user that ` +
          `the report was created. Inventing file:line references is fabricating ` +
          `evidence — fix it before the next Write.`,
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

  // Phase 17: skeleton + sibling proliferation guards.
  // Run AFTER audit guards (audit reports are allowed to be long prose
  // with their own content validation) but BEFORE sensitive-file /
  // symlink checks so a real write attempt never has placeholder
  // content land on disk.
  if (!isAuditFilename(file_path)) {
    const {
      detectSiblingProliferation,
      buildProliferationReport,
      detectSkeletonContent,
      buildSkeletonReport,
      checkDegradation,
      detectInPlaceShrinkage,
      buildShrinkageReport,
      detectUnsolicitedDoc,
      buildUnsolicitedDocReport,
    } = await import("../core/write-guards.js");

    // Phase 21: block unsolicited doc files. If the target matches a
    // doc-filename pattern (README.md, QUICK_START.md, TECHNICAL_
    // REFERENCE.md, INDEX.md, etc.) AND the user's session text has
    // not granted doc-creation permission (no "full project", "readme",
    // "documentation", "proyecto completo", etc.), refuse the write.
    try {
      const { getUserTexts } = await import("../core/session-tracker.js");
      const userTexts = getUserTexts();
      const docVerdict = detectUnsolicitedDoc(file_path, userTexts);
      if (docVerdict.isUnsolicitedDoc) {
        return {
          tool_use_id: "",
          content: buildUnsolicitedDocReport(docVerdict),
          is_error: true,
        };
      }
    } catch {
      /* non-fatal — if the tracker isn't available, skip this check */
    }

    const proliferation = detectSiblingProliferation(file_path);
    if (proliferation.isProliferation) {
      return {
        tool_use_id: "",
        content: buildProliferationReport(file_path, proliferation),
        is_error: true,
      };
    }

    // Phase 19: in-place shrinkage. Block a Write that replaces an
    // existing file with significantly fewer lines. The NASA Explorer
    // session showed the model rewriting nasa-explorer.html from 901
    // lines to 554 lines (39% drop) while claiming "behavior is
    // identical" — silent lossy rewrite.
    const shrinkage = detectInPlaceShrinkage(file_path, content);
    if (shrinkage.isShrinking) {
      return {
        tool_use_id: "",
        content: buildShrinkageReport(file_path, shrinkage),
        is_error: true,
      };
    }

    const skeleton = detectSkeletonContent(content);
    if (skeleton.isSkeleton) {
      let report = buildSkeletonReport(file_path, skeleton);
      const degradation = checkDegradation(file_path, content);
      if (degradation) {
        report +=
          `\n\nDegradation detected: "${degradation.original}" has ` +
          `${degradation.originalLines} lines; your new content has ` +
          `${degradation.newLines}. You are shrinking a working file into a stub.`;
      }
      return { tool_use_id: "", content: report, is_error: true };
    }

    // Phase 26: hardcoded secrets scan. Blocks the Write when the
    // content contains a plausible API key / access token / bearer
    // credential that isn't a known placeholder. Docs, .env.example,
    // and README.md are exempt. See write-content-scanner.ts.
    try {
      const { detectSecrets, buildSecretReport } = await import(
        "../core/write-content-scanner.js"
      );
      const secrets = detectSecrets(file_path, content);
      if (secrets.hasSecret) {
        return {
          tool_use_id: "",
          content: buildSecretReport(file_path, secrets),
          is_error: true,
        };
      }
    } catch {
      /* non-fatal */
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

    // Phase 27.5 (P4-lite): snapshot old content for declaration-loss
    // comparison AFTER the write. Read here so we capture the pre-write
    // state; the comparison itself runs in the success path.
    let oldContentForDeclCheck: string | null = null;
    if (existsSync(file_path)) {
      try {
        const { readFileSync } =
          require("node:fs") as typeof import("node:fs");
        oldContentForDeclCheck = readFileSync(file_path, "utf-8");
      } catch {
        /* can't read — skip declaration loss check */
      }
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

    // Phase 26 (non-blocking): append a debug-statement warning if
    // the file contains leftover console.log / debugger / print() /
    // dbg! / println! outside of test/example/script paths.
    //
    // Phase 27.5 (non-blocking): append a declaration-loss warning
    // when the Write replaces an existing file with significantly
    // fewer top-level declarations (functions, classes, types). Fills
    // the gap between phase 19 (line shrinkage) and phase 17 (skeleton
    // stubs): a silent refactor that drops 4 of 10 functions but
    // keeps the file size via added comments/CSS doesn't trip either.
    try {
      const {
        detectDebugStatements,
        buildDebugWarning,
        detectDeclarationLoss,
        buildDeclarationLossWarning,
      } = await import("../core/write-content-scanner.js");
      const debug = detectDebugStatements(file_path, content);
      if (debug.hasDebug) {
        warning += buildDebugWarning(debug);
      }
      if (oldContentForDeclCheck !== null) {
        const decl = detectDeclarationLoss(
          oldContentForDeclCheck,
          content,
          file_path,
        );
        if (decl.hasLoss) {
          warning += buildDeclarationLossWarning(decl);
        }
      }
    } catch {
      /* non-fatal */
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
