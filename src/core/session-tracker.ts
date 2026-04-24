// KCode - Session Read Tracker
// Records which files were Read in the current session, so that audit reports
// claiming to have Read a file can be validated against actual tool history.
//
// This is a forcing function against checklist fabrication: the model cannot
// list a file as "analyzed" in an audit if it never called the Read tool on it.

import { resolve } from "node:path";

// Module-level state — reset per CLI process (= per session)
const _readFiles = new Set<string>();
let _grepCount = 0;
let _auditIntent = false;
// Files that appeared in Grep results for DANGEROUS-pattern queries
// (buffer indexing, network I/O, resource lifecycle). These are high-risk
// files the model found but may not have opened.
const _grepHitFiles = new Set<string>();
// Phase 21: user-authored text messages in the current session. Used by
// write-guards to decide whether the user granted doc-creation permission.
const _userTexts: string[] = [];

// Source-code file extensions. Only files with these extensions count
// toward the audit read-minimum (so README.md, CMakeLists.txt, LICENSE
// don't inflate the count).
const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".cs",
  ".scala",
  ".m",
  ".mm",
  ".zig",
]);

function getExt(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const idx = base.lastIndexOf(".");
  return idx >= 0 ? base.slice(idx).toLowerCase() : "";
}

/**
 * Record that a file was Read in this session. Called from executeRead().
 * Stores the absolute, normalized path.
 */
export function recordRead(filePath: string): void {
  try {
    _readFiles.add(resolve(filePath));
  } catch {
    // Ignore resolution errors — just record the raw path
    _readFiles.add(filePath);
  }
}

/**
 * Check whether a file was Read in this session.
 * Accepts absolute or relative paths; both basename and absolute forms match.
 */
export function wasRead(filePath: string): boolean {
  try {
    const abs = resolve(filePath);
    if (_readFiles.has(abs)) return true;
  } catch {
    // fall through
  }
  // Tolerate basename-only matches (model may list just "UsbDevice.cpp")
  const basename = filePath.split(/[/\\]/).pop() ?? filePath;
  for (const read of _readFiles) {
    if (read.endsWith("/" + basename) || read.endsWith("\\" + basename)) {
      return true;
    }
  }
  return false;
}

/**
 * Number of distinct files Read in this session.
 */
export function readCount(): number {
  return _readFiles.size;
}

/**
 * Number of distinct SOURCE files Read in this session.
 * Excludes README.md, CMakeLists.txt, LICENSE, .gitignore, etc.
 * This is the metric used for audit minimums.
 */
export function sourceReadCount(): number {
  let n = 0;
  for (const path of _readFiles) {
    if (SOURCE_EXTENSIONS.has(getExt(path))) n += 1;
  }
  return n;
}

/**
 * List all Read files (absolute paths). For debugging/display.
 */
export function listReads(): string[] {
  return Array.from(_readFiles).sort();
}

/**
 * Record that a Grep call was made in this session.
 * Used to enforce grep-first reconnaissance before audits.
 */
export function recordGrep(): void {
  _grepCount += 1;
}

// Keywords (English + Spanish) that flag a user's first message as an
// audit request. When set, Edit/MultiEdit on source files will be gated
// behind an existing AUDIT_REPORT.md that cites the file being modified.
const AUDIT_INTENT_KEYWORDS = [
  /\baudit\b/i,
  /\bauditalo\b/i,
  /\bauditar\b/i,
  /\bauditoria\b/i,
  /\baudit[ée]e?(?:d|z)?\b/i,
  /\bsecurity[- ]?review\b/i,
  /\bcode[- ]?review\b/i,
  /\brevisa\b/i,
  /\brevisar\b/i,
  /\banaliza(?:lo|r|)\b/i,
];

/**
 * Detect whether a user message looks like an audit request.
 * Used in the conversation loop to set audit intent on first message.
 */
export function detectAuditIntent(userMessage: string): boolean {
  return AUDIT_INTENT_KEYWORDS.some((re) => re.test(userMessage));
}

/**
 * Mark the current session as an audit session. Called from the
 * conversation loop when the user's first message matches audit keywords.
 *
 * Phase 2 of the #100 refactor: when set to true AND a task scope is
 * active, also flip the scope's audit sub-state. When false, do not
 * unilaterally clear the scope — a scope transition is the correct
 * path for that.
 */
export function setAuditIntent(value: boolean): void {
  _auditIntent = value;
  if (value) {
    try {
      const { getTaskScopeManager } = require("./task-scope") as typeof import("./task-scope");
      const mgr = getTaskScopeManager();
      const cur = mgr.current();
      if (cur && !cur.audit.enabled) {
        mgr.update({ audit: { enabled: true, reportRequired: true } });
      }
    } catch {
      /* task-scope module not loaded — legacy path */
    }
  }
}

/**
 * Whether the current session is an audit session.
 *
 * Phase 2: prefers the TaskScope source of truth when available, so a
 * scaffold/implement scope after a prior audit scope no longer reports
 * "audit mode". Falls back to the legacy `_auditIntent` boolean when
 * no scope is active (e.g. during test startup or early session setup).
 */
export function isAuditSession(): boolean {
  try {
    const { getTaskScopeManager } = require("./task-scope") as typeof import("./task-scope");
    const cur = getTaskScopeManager().current();
    if (cur !== null) return cur.audit.enabled;
  } catch {
    /* fall through to legacy */
  }
  return _auditIntent;
}

/**
 * Number of Grep calls made in this session.
 */
export function grepCount(): number {
  return _grepCount;
}

// Substrings that indicate the grep is searching for audit-relevant
// dangerous code (buffer indexing, I/O syscalls, resource lifecycle, etc.).
// We strip regex escape backslashes before checking, so `data\[` and
// `data[` both match.
const DANGEROUS_GREP_SUBSTRINGS = [
  "data[",
  "buffer[",
  "buf[",
  "recv(",
  "recv ",
  "recvfrom",
  "sendto",
  "socket(",
  "open(",
  "fopen",
  "malloc",
  "free(",
  "strcpy",
  "sprintf",
  "(&",
  "parse",
  "decode(",
  "memcpy",
  "memmove",
  "read(",
  "write(",
  "close(",
  "fcntl",
];

function isDangerousGrepPattern(pattern: string): boolean {
  // Strip regex escape backslashes so `data\[` becomes `data[`, and
  // lowercase for case-insensitive substring match
  const normalized = pattern.replace(/\\/g, "").toLowerCase();
  return DANGEROUS_GREP_SUBSTRINGS.some((s) => normalized.includes(s));
}

/**
 * If the grep pattern looks audit-relevant (buffer indexing, I/O, resource
 * lifecycle), record the files that appeared in its results. These become
 * "high-risk unread" targets the audit guard checks before allowing Write.
 */
export function recordGrepHits(pattern: string, matchedFiles: string[]): void {
  if (!isDangerousGrepPattern(pattern)) return;
  for (const f of matchedFiles) {
    try {
      _grepHitFiles.add(resolve(f));
    } catch {
      _grepHitFiles.add(f);
    }
  }
}

/**
 * List of files that were flagged by dangerous-pattern greps in this session.
 */
export function getGrepHitFiles(): string[] {
  return Array.from(_grepHitFiles);
}

/**
 * Of all the grep-hit high-risk files, which ones were NOT Read?
 * Returns absolute paths.
 */
export function unreadGrepHits(): string[] {
  const unread: string[] = [];
  for (const f of _grepHitFiles) {
    if (!_readFiles.has(f)) {
      unread.push(f);
    }
  }
  return unread;
}

/**
 * Phase 21: record a user-authored text message. Called from conversation.ts
 * on every sendMessage. write-guards uses this to determine whether the
 * user's original request granted documentation-creation permission.
 *
 * Phase 2 of the #100 refactor: also drives TaskScope transitions. When
 * the user's intent (classified from the message) differs from the
 * current scope's type, close the current scope and open a new one.
 * This is what kills the "audit-mode leaks into scaffold" class of bug.
 */
export function recordUserText(text: string): void {
  if (!text || typeof text !== "string") return;
  _userTexts.push(text);

  try {
    const { classifyIntent, getTaskScopeManager, shouldOpenNewScope } =
      require("./task-scope") as typeof import("./task-scope");
    const intent = classifyIntent(text);
    const mgr = getTaskScopeManager();
    if (shouldOpenNewScope(mgr.current(), intent)) {
      const broadRequest = /\b(?:todo|toda|completo|completa|completamente|integral|full(?:ly)?|complete(?:ly)?|entire(?:ly)?|comprehensive|end[-\s]to[-\s]end|tiempo\s+real|real[-\s]time|mucho\s+m[aá]s)\b/i.test(
        text,
      );
      mgr.beginNewScope({
        type: intent,
        userPrompt: text,
        broadRequest,
      });
      // Keep the legacy _auditIntent boolean aligned with the new scope
      // for any caller that doesn't yet read from the manager.
      _auditIntent = intent === "audit";

      // Clear any stale plan when the user explicitly starts fresh.
      // v296 repro: a 9-step plan from a prior bitcoin-tui-dashboard
      // scaffold persisted to SQLite. The project directory was
      // later deleted but the plan restored into the new session
      // (same cwd). Model saw '7/9 done' and asked the user to
      // recreate the directory instead of doing it itself.
      //
      // Heuristic: when the prompt says 'nuevo proyecto' / 'new
      // project' / 'from scratch' / 'desde cero', any active plan
      // is for a DIFFERENT task — drop it.
      if (
        intent === "scaffold" &&
        /(?:\bnuevo\s+proyecto\b|\bnew\s+project\b|\bfrom\s+scratch\b|\bdesde\s+cero\b|\bcre[aá]r?\s+un\s+(?:proyecto|app|dashboard)\s+nuevo\b)/i.test(
          text,
        )
      ) {
        try {
          const { discardActivePlanAndPersisted } =
            require("../tools/plan") as typeof import("../tools/plan");
          discardActivePlanAndPersisted();
        } catch {
          /* plan module unavailable — safe to ignore */
        }
      }
    }
  } catch {
    /* task-scope module unavailable — safe to ignore, legacy path keeps working */
  }
}

/**
 * Return all user-authored text messages recorded so far in this session,
 * in order. Read-only — callers should not mutate the array.
 */
export function getUserTexts(): readonly string[] {
  return _userTexts;
}

/**
 * Reset the tracker. Used by tests and session restarts.
 */
export function resetReads(): void {
  _readFiles.clear();
  _grepCount = 0;
  _grepHitFiles.clear();
  _auditIntent = false;
  _userTexts.length = 0;
  try {
    const { getTaskScopeManager } = require("./task-scope") as typeof import("./task-scope");
    getTaskScopeManager().reset();
  } catch {
    /* task-scope module unavailable */
  }
}
