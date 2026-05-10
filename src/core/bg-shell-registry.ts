// KCode - Background Shell Registry
//
// Tracks long-running background shells launched via the Bash tool's
// run_in_background flag. Each shell gets a persistent log file at
// ~/.kcode/bg-shells/<shellId>.log so the model can later inspect
// progress with the BashOutput tool and terminate with KillShell.
//
// Why this exists: pre-2026-05-09 the background path tee'd output
// to /tmp/kcode-bg/<id>.log and DELETED the file after the initial
// 3-second window. The PID was returned but no further introspection
// was possible — the model could launch parallel work but was blind
// after launch. That broke the "spawn 3 scans, monitor each, kill
// the slowest" workflow that's standard for any real diagnostic
// session.

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger";

const REGISTRY_DIR = join(homedir(), ".kcode", "bg-shells");

export interface BgShellRecord {
  shellId: string;
  pid: number;
  command: string;
  logPath: string;
  startedAt: number;
  cwd: string;
}

const _shells = new Map<string, BgShellRecord>();

export function ensureRegistryDir(): void {
  if (!existsSync(REGISTRY_DIR)) {
    mkdirSync(REGISTRY_DIR, { recursive: true });
  }
}

/** Generate a short, human-readable shellId. */
export function newShellId(): string {
  // 8 hex chars — collision risk negligible for per-session tracking,
  // and short enough that the model can copy/paste reliably.
  return Math.random().toString(16).slice(2, 10);
}

/** Path to the log file for a given shellId. */
export function logPathFor(shellId: string): string {
  return join(REGISTRY_DIR, `${shellId}.log`);
}

/** Register a new background shell. */
export function registerShell(record: Omit<BgShellRecord, "logPath">): BgShellRecord {
  ensureRegistryDir();
  const full: BgShellRecord = { ...record, logPath: logPathFor(record.shellId) };
  _shells.set(record.shellId, full);
  log.debug(
    "bg-shell",
    `registered ${record.shellId} pid=${record.pid} cmd=${record.command.slice(0, 60)}`,
  );
  return full;
}

/** Look up a registered shell. Returns undefined if unknown. */
export function getShell(shellId: string): BgShellRecord | undefined {
  return _shells.get(shellId);
}

/** Enumerate all registered shells (newest first). */
export function listShells(): BgShellRecord[] {
  return [..._shells.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** True if the underlying process is still alive. */
export function isShellAlive(record: BgShellRecord): boolean {
  try {
    // kill(pid, 0) checks existence without sending a signal.
    process.kill(record.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the current contents of a shell's log file. */
export function readShellOutput(
  shellId: string,
  opts?: { tailBytes?: number },
): { content: string; size: number; truncated: boolean } | null {
  const record = _shells.get(shellId);
  if (!record) return null;
  if (!existsSync(record.logPath)) {
    return { content: "", size: 0, truncated: false };
  }
  const size = statSync(record.logPath).size;
  const tailBytes = opts?.tailBytes;
  if (tailBytes && size > tailBytes) {
    // Read only the last `tailBytes` bytes — same trick as `tail -c`.
    const fd = require("node:fs").openSync(record.logPath, "r");
    try {
      const buffer = Buffer.alloc(tailBytes);
      require("node:fs").readSync(fd, buffer, 0, tailBytes, size - tailBytes);
      return { content: buffer.toString("utf-8"), size, truncated: true };
    } finally {
      require("node:fs").closeSync(fd);
    }
  }
  return { content: readFileSync(record.logPath, "utf-8"), size, truncated: false };
}

/** Stop a background shell by sending SIGTERM (escalates to SIGKILL on retry). */
export function killShell(shellId: string, force = false): { killed: boolean; reason?: string } {
  const record = _shells.get(shellId);
  if (!record) return { killed: false, reason: `Unknown shellId: ${shellId}` };
  if (!isShellAlive(record)) {
    _shells.delete(shellId);
    return { killed: true, reason: "already-exited" };
  }
  try {
    process.kill(record.pid, force ? "SIGKILL" : "SIGTERM");
    log.info(
      "bg-shell",
      `signaled ${shellId} pid=${record.pid} (${force ? "SIGKILL" : "SIGTERM"})`,
    );
    return { killed: true };
  } catch (err) {
    return { killed: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove a shell record + delete its log file. Use after the shell is dead. */
export function purgeShell(shellId: string): void {
  const record = _shells.get(shellId);
  if (!record) return;
  try {
    if (existsSync(record.logPath)) unlinkSync(record.logPath);
  } catch (err) {
    log.debug("bg-shell", `failed to delete log ${record.logPath}: ${err}`);
  }
  _shells.delete(shellId);
}

/** Test-only: clear in-memory registry. */
export function _resetShellRegistry(): void {
  _shells.clear();
}
