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

  // Strip heredoc bodies BEFORE scanning. A heredoc body can contain
  // arbitrary code with '=>' arrow functions, '>' comparisons, etc.
  // that the redirect regex would otherwise misinterpret. Issue #111
  // v290 repro: `cat > index.ts << 'EOF'\n...\n.then(() => {...})\n...EOF`
  // captured `{` as a redirect target because the lookbehind didn't
  // exclude `=`, and the heredoc body was scanned along with the
  // cat-prefix. Strip the heredoc content between DELIMITER markers.
  const stripped = command.replace(
    /<<-?\s*['"]?(\w+)['"]?\s*\n[\s\S]*?^\1\s*$/gm,
    "<<HEREDOC_STRIPPED\nHEREDOC_STRIPPED\n",
  );

  // Match > or >> redirections: optional whitespace, >, >, path.
  // Negative lookbehind now also excludes `=` (for `=>` arrow functions
  // that escape the heredoc strip on single-line heredocs).
  const redirRe = /(?<![<=0-9&])>>?\s*(?:'([^']+)'|"([^"]+)"|([^\s;&|<>`]+))/g;
  let m: RegExpExecArray | null;
  m = redirRe.exec(stripped);
  while (m !== null) {
    const path = m[1] ?? m[2] ?? m[3];
    if (path && looksLikeFilePath(path)) {
      targets.push(path);
    }
    m = redirRe.exec(stripped);
  }

  // Match tee targets: tee [-a|-i|...] file
  const teeRe = /\btee\s+(?:-[\w-]+\s+)*(?:'([^']+)'|"([^"]+)"|([^\s;&|<>`]+))/g;
  m = teeRe.exec(stripped);
  while (m !== null) {
    const path = m[1] ?? m[2] ?? m[3];
    if (path && looksLikeFilePath(path)) targets.push(path);
    m = teeRe.exec(stripped);
  }

  return targets;
}

/**
 * Sanity check: a captured "redirect target" must actually look
 * like a file path. Drops artifacts from regex misfires (bare `{`,
 * `}`, `=>`, numeric-only, starts with `&`, `$VAR` expansions).
 * Shell reserved tokens can't be redirect targets in practice.
 */
function looksLikeFilePath(s: string): boolean {
  if (!s) return false;
  // Pure punctuation / control chars
  if (/^[{}()[\];,&|`]+$/.test(s)) return false;
  // Numeric-only (file descriptor duplicates: &1, &2)
  if (/^\d+$/.test(s)) return false;
  // Starts with & (fd duplicate)
  if (s.startsWith("&")) return false;
  // Shell variable that wasn't expanded (e.g. $HOME, $TMPDIR)
  if (s.startsWith("$")) return false;
  // Single-char that isn't a valid filename
  if (s.length === 1 && !/[a-zA-Z0-9._]/.test(s)) return false;
  return true;
}

/**
 * Extract file paths that a Bash command will MUTATE in place. This is
 * the set of write paths the Edit/Write guards would see if those tools
 * had been used instead — so the same audit-mode discipline can apply.
 *
 * Matches (quoted or unquoted paths):
 *   sed -i[suffix] [script] file
 *   perl -i[.bak] -pe '…' file
 *   awk -i inplace '…' file
 *   > file          (redirect write)
 *   >> file         (redirect append)
 *   tee [-a] file   (captured by the existing redirect extractor)
 *
 * The first three matter because the model can use them to edit a
 * source file without going through the Edit tool, bypassing any
 * task-scoped write policy. See GitHub issue #102.
 */
export function extractBashFileMutations(command: string): string[] {
  const targets: string[] = [];

  // sed -i[suffix] [scripts…] file1 [file2 …]
  // -i can be followed optionally by a suffix with no space, then
  // zero or more -e/-f flags, then one or more file operands.
  const sedRe =
    /\bsed\s+(?:-[a-zA-Z]*[iI][^\s]*|--in-place(?:=\S+)?)(?:\s+-[efnrsE]\S*|\s+['"][^'"]+['"]|\s+\S)*?\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|<>`]+))\s*(?:;|\||&&|\|\||$)/g;
  // Simpler approach: find all sed -i occurrences and collect last token(s)
  // that don't start with `-` as file operands.
  const sedBlockRe = /\bsed\s+(?:-[a-zA-Z]*[iI][^\s]*|--in-place(?:=\S+)?)[^;&|\n]*/g;
  let sm: RegExpExecArray | null;
  sm = sedBlockRe.exec(command);
  while (sm !== null) {
    const block = sm[0];
    // Split on whitespace; collect trailing non-flag non-quoted-script tokens.
    const tokens = block.split(/\s+/);
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i]!;
      if (!t) continue;
      if (t.startsWith("-")) break;
      if (t.startsWith("'") || t.startsWith('"')) break;
      if (t === "sed") break;
      // Strip surrounding quotes if any
      const clean = t.replace(/^['"]|['"]$/g, "");
      if (clean) targets.push(clean);
    }
    sm = sedBlockRe.exec(command);
  }
  void sedRe; // intentionally unused; kept for documentation of the strict shape

  // perl -i[.bak] -pe/-ne '…' file
  const perlRe =
    /\bperl\s+(?:-[a-zA-Z]*i[a-zA-Z0-9.]*)[^;&|\n]*?(?:-[eE]\s+(?:'[^']*'|"[^"]*")|-[nNpP])[^;&|\n]*?\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|<>`]+))\s*(?:;|\||&&|\|\||$)/g;
  let pm: RegExpExecArray | null;
  pm = perlRe.exec(command);
  while (pm !== null) {
    const path = pm[1] ?? pm[2] ?? pm[3];
    if (path) targets.push(path);
    pm = perlRe.exec(command);
  }

  // awk -i inplace '…' file
  const awkRe =
    /\bawk\s+-i\s+inplace\s+(?:'[^']*'|"[^"]*")\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|<>`]+))/g;
  let am: RegExpExecArray | null;
  am = awkRe.exec(command);
  while (am !== null) {
    const path = am[1] ?? am[2] ?? am[3];
    if (path) targets.push(path);
    am = awkRe.exec(command);
  }

  // Redirection writes (already implemented elsewhere, fold them in)
  for (const t of extractRedirectionTargets(command)) {
    targets.push(t);
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

/**
 * Scan a Bash command for file-reading patterns (`cat`, `head`, `tail`,
 * `less`, `more`, `view`) and return the list of file paths being read.
 * This lets us record those as "read" in the session tracker even when
 * the model bypasses the Read tool.
 *
 * Returns an array of absolute paths (best-effort, may include false
 * positives for things like `cat file.gguf` - those are harmless).
 */
export function extractBashReadTargets(command: string): string[] {
  const targets: string[] = [];
  // Match cat/head/tail/less/more/view followed by file arg(s).
  // Flags (-n, -50, --lines=10) are skipped. Path can be unquoted, single
  // or double quoted. Stop at shell separators (|, &&, ||, ;, >, <).
  const re =
    /\b(?:cat|head|tail|less|more|view)\b((?:\s+-[\w-]+(?:=\S+)?|\s+\d+|\s+'[^']+'|\s+"[^"]+"|\s+[^\s|;&<>`$()]+)+)/g;
  let m: RegExpExecArray | null;
  m = re.exec(command);
  while (m !== null) {
    const argsPart = m[1]!;
    // Split on whitespace, keeping quoted segments
    const tokens = argsPart.match(/'[^']+'|"[^"]+"|\S+/g) ?? [];
    for (const tok of tokens) {
      // Skip flags and numeric args
      if (tok.startsWith("-")) continue;
      if (/^\d+$/.test(tok)) continue;
      // Strip quotes
      let path = tok;
      if ((path.startsWith("'") && path.endsWith("'")) ||
          (path.startsWith('"') && path.endsWith('"'))) {
        path = path.slice(1, -1);
      }
      // Only accept things that look like file paths (contain . or /)
      if (path.includes("/") || path.includes(".")) {
        targets.push(path);
      }
    }
    m = re.exec(command);
  }
  return targets;
}

/**
 * Detect if a Bash command is a grep-equivalent (grep, rg, ag, ack).
 * Returns the search pattern (first non-flag arg) if found.
 */
export function extractBashGrepPattern(command: string): string | null {
  // Match grep/rg/ag/ack at the start of a command (possibly after cd && etc)
  // We only care about the pattern for dangerous-pattern detection.
  const re = /(?:^|[|&;]\s*)\b(?:grep|rg|ag|ack)\b([^|&;]*)/i;
  const m = command.match(re);
  if (!m) return null;
  // Parse args, skip flags, return first non-flag token
  const args = m[1]!.trim();
  const tokens = args.match(/'[^']+'|"[^"]+"|\S+/g) ?? [];
  for (const tok of tokens) {
    if (tok.startsWith("-")) continue;
    // Strip quotes
    let pattern = tok;
    if ((pattern.startsWith("'") && pattern.endsWith("'")) ||
        (pattern.startsWith('"') && pattern.endsWith('"'))) {
      pattern = pattern.slice(1, -1);
    }
    return pattern;
  }
  return null;
}

/**
 * Master switch for all audit-specific guards. When KCODE_AUDIT_GUARDS=off,
 * every audit guard becomes a no-op. Use for:
 *   - debugging guard interactions
 *   - power users who don't want the friction
 *   - A/B testing guard effectiveness
 *
 * Default: guards enabled (existing defensive behavior preserved).
 */
export function auditGuardsEnabled(): boolean {
  return process.env.KCODE_AUDIT_GUARDS !== "off";
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
  if (!auditGuardsEnabled()) return { blocked: false };
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

/**
 * Mutation kinds used by the unified policy check. Matches the tool
 * names used by checkMutationAllowed below — adding a new mutation
 * tool requires extending this union AND teaching the tool to call
 * checkMutationAllowed before applying changes.
 */
export type MutationKind =
  | "Edit"
  | "Write"
  | "MultiEdit"
  | "GrepReplace"
  | "Rename"
  | "Bash-sed-i"
  | "Bash-perl-i"
  | "Bash-awk-inplace"
  | "Bash-redirect";

export interface MutationPolicyResult {
  allowed: boolean;
  /** When allowed=false, a full BLOCKED: … message ready to return from the tool. */
  reason?: string;
}

/**
 * Single source of truth for "may this mutation land?" questions. All
 * mutation paths (Edit, Write, MultiEdit, GrepReplace, Bash sed -i,
 * shell redirection, etc.) should call this before applying changes.
 *
 * Today's logic: delegates to the existing checkAuditEditGuard. This
 * preserves current behavior while letting callers depend on a stable
 * high-level helper. Phase 3+ will add scope-driven rules (target
 * paths, read-only scopes, owner-file restrictions, etc.) without
 * each tool needing to learn about them separately.
 *
 * Issue #104 / #108: before this helper, Edit blocked but GrepReplace
 * or Bash sed -i could bypass. All paths now call this, so the policy
 * is consistent.
 */
export function checkMutationAllowed(
  filePath: string,
  mutationKind: MutationKind,
): MutationPolicyResult {
  const result = checkAuditEditGuard(filePath);
  if (result.blocked) {
    // Decorate the reason with the mutation kind so the agent log
    // shows which path tried to bypass the policy.
    const prefix = `BLOCKED (via ${mutationKind}): `;
    const reason = result.reason ?? "";
    // Replace only the first "BLOCKED:" prefix; leave the rest intact.
    const decoratedReason = reason.startsWith("BLOCKED")
      ? prefix + reason.slice(reason.indexOf(":") + 1).trimStart()
      : prefix + reason;
    return { allowed: false, reason: decoratedReason };
  }
  return { allowed: true };
}
