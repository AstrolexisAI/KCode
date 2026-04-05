// KCode - Audit file guards (shared between Write and Bash tools)
//
// Centralizes the audit-filename detection so both tools enforce the same
// "ONE report file" discipline. Without this, the model can bypass Write's
// guards by using `cat > AUDIT_REPORT.md << EOF` via Bash.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { isAuditSession } from "./session-tracker";

/**
 * Filenames that look like audit/review reports or their companions.
 * Examples matched: AUDIT_REPORT.md, FIXES_SUMMARY.txt, FINAL_AUDIT.md,
 * AUDIT_INDEX.md, REMEDIATION_FIXES.md, security-audit.md, audit_certificate.txt
 */
export const AUDIT_FILENAME_PATTERN =
  /(^|[_-])(audit|review|security[_-]?audit|remediation|fixes?[_-]summary|fixes?[_-]applied|audit[_-]index|audit[_-]summary|final[_-]audit|audit[_-]report|audit[_-]certificate)([_-]|\.|$)/i;

export function isAuditFilename(pathOrName: string): boolean {
  return AUDIT_FILENAME_PATTERN.test(basename(pathOrName));
}

/**
 * Extract target filenames from shell redirections and tee commands in a
 * Bash command string. Used to detect when the model is trying to bypass
 * the Write tool by piping content to an audit-named file.
 *
 * Matches (quoted or unquoted paths):
 *   command > file
 *   command >> file
 *   command | tee file
 *   command | tee -a file
 *   cat <<EOF > file
 *
 * Returns the list of destination file paths found in the command.
 */
export function extractRedirectionTargets(command: string): string[] {
  const targets: string[] = [];

  // Match > or >> redirections: optional whitespace, >, >, path
  // Path can be: unquoted (no spaces), single-quoted, or double-quoted
  const redirRe = /(?<![<0-9&])>>?\s*(?:'([^']+)'|"([^"]+)"|([^\s;&|<>`]+))/g;
  let m: RegExpExecArray | null;
  m = redirRe.exec(command);
  while (m !== null) {
    const path = m[1] ?? m[2] ?? m[3];
    if (path && !path.startsWith("&") && !/^\d+$/.test(path)) {
      targets.push(path);
    }
    m = redirRe.exec(command);
  }

  // Match tee targets: tee [-a|-i|...] file
  const teeRe = /\btee\s+(?:-[\w-]+\s+)*(?:'([^']+)'|"([^"]+)"|([^\s;&|<>`]+))/g;
  m = teeRe.exec(command);
  while (m !== null) {
    const path = m[1] ?? m[2] ?? m[3];
    if (path) targets.push(path);
    m = teeRe.exec(command);
  }

  return targets;
}

// File extensions that count as "source code" for the audit-edit guard.
const SOURCE_EXTS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".swift",
  ".rb", ".php", ".cs", ".scala", ".m", ".mm", ".zig",
]);

function isSourceFile(path: string): boolean {
  const name = basename(path);
  const i = name.lastIndexOf(".");
  if (i < 0) return false;
  return SOURCE_EXTS.has(name.slice(i).toLowerCase());
}

/**
 * Walk up from `startDir` looking for an AUDIT_REPORT.md (or variant).
 * Stops at the current working directory or the filesystem root or HOME,
 * to avoid picking up stray audit files in /tmp or elsewhere.
 */
function findAuditReportForFile(startPath: string): string | null {
  const home = process.env.HOME ?? "";
  const cwd = process.cwd();
  const startAbs = resolve(startPath);

  // Build the set of "stop boundaries" — ancestors we refuse to cross.
  // We search within the chain from startPath's dir UP TO (and including)
  // cwd if startPath is under cwd; otherwise just search up 4 levels
  // without crossing /tmp or HOME.
  const isUnderCwd = startAbs.startsWith(cwd + "/") || startAbs === cwd;

  // Dirs we NEVER search (too broad, likely to match stray files)
  const FORBIDDEN_DIRS = new Set(["/", "/tmp", "/var", "/var/tmp", home]);

  let dir = dirname(startAbs);
  for (let depth = 0; depth < 6; depth++) {
    // Stop before searching forbidden broad dirs
    if (FORBIDDEN_DIRS.has(dir)) break;

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (AUDIT_FILENAME_PATTERN.test(entry)) {
          const full = resolve(dir, entry);
          try {
            if (statSync(full).isFile()) return full;
          } catch { /* skip */ }
        }
      }
    } catch { /* dir not readable */ }

    // Don't walk above cwd if we started under it
    if (isUnderCwd && dir === cwd) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Does the given audit report's content cite the given file path?
 * Matches file:line citations where the filename (or any suffix of the
 * path) appears in the report.
 */
function reportCitesFile(reportPath: string, targetFile: string): boolean {
  try {
    const content = readFileSync(reportPath, "utf-8");
    const targetAbs = resolve(targetFile);
    const targetBase = basename(targetAbs);
    // Fast path: basename appears followed by a colon and a digit
    const re = new RegExp(
      `\\b${targetBase.replace(/[.+*?^${}()|[\\\\]/g, "\\$&")}[:#]\\s*\\d+`,
      "g",
    );
    if (re.test(content)) return true;
    // Also check full path substring match
    if (content.includes(targetAbs)) return true;
    // Check relative path components
    const parts = targetAbs.split(/[/\\]/);
    for (let i = 0; i < parts.length - 1; i++) {
      const rel = parts.slice(i).join("/");
      if (rel.length > 15 && content.includes(rel)) return true;
    }
  } catch { /* report unreadable */ }
  return false;
}

export interface AuditEditGuardResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Check whether Edit/MultiEdit should be blocked on this file because
 * the session is in audit mode and the file's findings haven't been
 * reviewed yet.
 *
 * Blocks when ALL are true:
 *   - session has audit intent (user asked for an audit)
 *   - target is a source file
 *   - no AUDIT_REPORT.md exists in the file's directory tree, OR
 *     the existing report does not cite this file
 */
export function checkAuditEditGuard(filePath: string): AuditEditGuardResult {
  if (!isAuditSession()) return { blocked: false };
  if (!isSourceFile(filePath)) return { blocked: false };

  const report = findAuditReportForFile(filePath);
  if (!report) {
    return {
      blocked: true,
      reason:
        `BLOCKED: This session is auditing code and there is no AUDIT_REPORT.md ` +
        `yet. In audit sessions, you must WRITE the audit report with findings ` +
        `FIRST, so the user can review them, BEFORE modifying source files. ` +
        `\n\nFlow:\n` +
        `  1. Grep + Read (reconnaissance)\n` +
        `  2. Write AUDIT_REPORT.md with file:line citations for every finding\n` +
        `  3. Wait for user approval, THEN apply Edit/MultiEdit fixes\n\n` +
        `Rationale: a model can be wrong about a bug. If you "fix" code before ` +
        `the human reviews your findings, you might invert working logic ` +
        `(e.g. misinterpreting strcmp/wcscmp return values).`,
    };
  }

  if (!reportCitesFile(report, filePath)) {
    return {
      blocked: true,
      reason:
        `BLOCKED: Cannot edit "${basename(filePath)}" — the audit report at ` +
        `"${report}" does not cite this file with a "file:line" reference. ` +
        `\n\nIn audit sessions, only files explicitly cited in AUDIT_REPORT.md ` +
        `may be modified. Either:\n` +
        `  (a) Add a finding for "${basename(filePath)}" with a file:line ` +
        `citation to the report, then retry, OR\n` +
        `  (b) Do not modify this file — it is not a documented finding.\n\n` +
        `This prevents scope creep and untracked "fixes" during audits.`,
    };
  }

  return { blocked: false };
}
