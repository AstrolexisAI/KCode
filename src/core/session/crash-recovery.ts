// Crash Recovery — Detects interrupted sessions and offers recovery.
//
// At startup:
// 1. Check ~/.kcode/kcode.pid
// 2. If exists and the process is NOT alive → previous crash
// 3. Load latest checkpoint for recovery
// 4. Clean up stale PID file

import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { CheckpointManager } from "./checkpoint";
import type { CrashInfo, SessionCheckpoint } from "./types";

const PID_FILE = join(homedir(), ".kcode", "kcode.pid");

/** Write current PID to file (call at startup) */
export async function writePidFile(): Promise<void> {
  await Bun.write(PID_FILE, String(process.pid));
}

/** Remove PID file (call at clean shutdown) */
export async function removePidFile(): Promise<void> {
  try {
    const file = Bun.file(PID_FILE);
    if (await file.exists()) {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(PID_FILE);
    }
  } catch {
    // Ignore — best effort
  }
}

/** Check if a process is alive */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

/** Read PID from file, returns null if file doesn't exist */
async function readPidFile(): Promise<number | null> {
  try {
    const file = Bun.file(PID_FILE);
    if (!(await file.exists())) return null;
    const text = await file.text();
    const pid = parseInt(text.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Detect if a previous session crashed.
 * Returns crash info with the latest checkpoint if available.
 */
export async function detectCrash(db: Database): Promise<CrashInfo | null> {
  const pid = await readPidFile();
  if (pid === null) return null;

  // If the process is still alive, it's not a crash
  if (processIsAlive(pid)) return null;

  // Crash detected — stale PID file
  const manager = new CheckpointManager(db);
  const recoverable = manager.listRecoverable();

  let checkpoint: SessionCheckpoint | null = null;
  if (recoverable.length > 0) {
    checkpoint = manager.getLatest(recoverable[0].conversationId);
  }

  return {
    pid,
    staleFile: PID_FILE,
    checkpoint,
  };
}

/** Clean up after crash detection (remove stale PID, optionally clear checkpoint) */
export async function cleanupCrash(clearCheckpoint = false, db?: Database): Promise<void> {
  await removePidFile();
  if (clearCheckpoint && db) {
    const manager = new CheckpointManager(db);
    manager.pruneOlderThan(0); // Remove all
  }
}

/** Register shutdown handlers to clean up PID file */
export function registerShutdownHandlers(): void {
  const cleanup = () => {
    try {
      const { unlinkSync, existsSync } = require("node:fs");
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    } catch {
      // Best effort
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}
