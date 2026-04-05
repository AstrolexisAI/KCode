// KCode - Session Read Tracker
// Records which files were Read in the current session, so that audit reports
// claiming to have Read a file can be validated against actual tool history.
//
// This is a forcing function against checklist fabrication: the model cannot
// list a file as "analyzed" in an audit if it never called the Read tool on it.

import { resolve } from "node:path";

// Module-level state — reset per CLI process (= per session)
const _readFiles = new Set<string>();

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
 * List all Read files (absolute paths). For debugging/display.
 */
export function listReads(): string[] {
  return Array.from(_readFiles).sort();
}

/**
 * Reset the tracker. Used by tests and session restarts.
 */
export function resetReads(): void {
  _readFiles.clear();
}
