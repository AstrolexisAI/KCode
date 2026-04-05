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
// Files that appeared in Grep results for DANGEROUS-pattern queries
// (buffer indexing, network I/O, resource lifecycle). These are high-risk
// files the model found but may not have opened.
const _grepHitFiles = new Set<string>();

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
 * Reset the tracker. Used by tests and session restarts.
 */
export function resetReads(): void {
  _readFiles.clear();
  _grepCount = 0;
  _grepHitFiles.clear();
}
