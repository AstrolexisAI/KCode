// KCode - Audit file guards (shared between Write and Bash tools)
//
// Centralizes the audit-filename detection so both tools enforce the same
// "ONE report file" discipline. Without this, the model can bypass Write's
// guards by using `cat > AUDIT_REPORT.md << EOF` via Bash.

import { basename } from "node:path";

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
