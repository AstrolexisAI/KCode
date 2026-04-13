// KCode - Bash Spawn History
//
// Operator-mind primitive (phase 3): the hypothesis-mismatch loop.
//
// Tracks the last few Bash invocations and, if the model retries the
// EXACT same command in the EXACT same cwd immediately after a failure,
// intercepts the retry and returns a "STOP and reassess" message instead
// of executing.
//
// This is the most important of the three operator-mind pieces because
// it directly attacks the failure mode that bricked the Artemis session:
// blind retry-after-failure. Phase 1 (post-spawn verification) makes
// failures visible; phase 2 (pre-flight) refuses doomed spawns; phase 3
// breaks the retry loop after the model has already seen one failure.
//
// State is process-local (a singleton Map). Entries expire after the
// retry window (default 8 attempts) so the history never grows
// unbounded even in long sessions.
//
// Scope: detection only fires for commands that match a known
// server-spawn pattern (detectServerSpawn). One-shot commands like
// `ls`, `git status`, `sudo echo X`, `cat package.json` are tracked
// in the history (so they don't pollute the retry window of real
// server spawns) but never trigger the STOP report. This keeps the
// guard focused on the actual failure mode it was built to fix:
// blind retry of broken dev-server spawns.

import { detectServerSpawn } from "./bash-spawn-verifier.js";

const MAX_HISTORY = 64;
const RETRY_WINDOW = 8;

interface AttemptEntry {
  /** Normalized key — see makeKey(). */
  key: string;
  /** Original command (unnormalized) for the diagnostic report. */
  command: string;
  /** Working directory the command ran in. */
  cwd: string;
  /** Was the result an error? */
  isError: boolean;
  /** First ~400 chars of the error output (for the "you saw THIS" reminder). */
  errorTail: string;
  /** Monotonic attempt index for "N attempts ago" reasoning. */
  index: number;
}

let _attempts: AttemptEntry[] = [];
let _nextIndex = 0;

function normalizeCommand(command: string): string {
  return command
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\bPORT=\d+/g, "PORT=N")  // port-only changes still count as same intent
    .replace(/--port[=\s]\d+/g, "--port N");
}

function makeKey(command: string, cwd: string): string {
  return `${cwd}|${normalizeCommand(command)}`;
}

// ─── Recording ─────────────────────────────────────────────────────

export function recordBashAttempt(
  command: string,
  cwd: string,
  isError: boolean,
  errorTail: string,
): void {
  _attempts.push({
    key: makeKey(command, cwd),
    command,
    cwd,
    isError,
    errorTail: errorTail.slice(0, 400),
    index: _nextIndex++,
  });
  // Bound the history. Drop the oldest.
  if (_attempts.length > MAX_HISTORY) {
    _attempts = _attempts.slice(-MAX_HISTORY);
  }
}

// ─── Detection ─────────────────────────────────────────────────────

export interface RetryWarning {
  /** The previous failed attempt for the same (cmd, cwd). */
  previous: AttemptEntry;
  /** How many Bash calls ago the previous failure was. */
  attemptsAgo: number;
  /** Multi-line operator report — safe to inline as a tool result. */
  report: string;
}

/**
 * Check if the given command is an immediate retry of a recently
 * failed identical command in the same cwd. Returns null when the
 * command is novel, when the previous attempt succeeded, or when the
 * previous attempt is older than RETRY_WINDOW.
 *
 * If a retry is detected, the caller should return the report as a
 * tool result with is_error=true and SKIP execution. Treat the warning
 * itself as the "second failure" for fingerprint accounting.
 */
export function detectImmediateRetry(
  command: string,
  cwd: string,
): RetryWarning | null {
  // Phase 3 is scoped to server-spawn commands only — it exists to
  // break the dev-server retry loop pattern. Sudo prompts, file ops,
  // builds, tests, etc. should never see this warning.
  if (!detectServerSpawn(command)) return null;

  const key = makeKey(command, cwd);
  // Search backward for the most recent entry with this key
  for (let i = _attempts.length - 1; i >= 0; i--) {
    const e = _attempts[i]!;
    if (e.key !== key) continue;
    // Found the previous occurrence
    const attemptsAgo = _nextIndex - e.index;
    if (!e.isError) return null; // last time it WORKED, retry is fine
    if (attemptsAgo > RETRY_WINDOW) return null; // too old, allow

    const lines: string[] = [];
    lines.push(`✗ STOP. You are retrying a command that just failed.`);
    lines.push(``);
    lines.push(`  command: ${e.command}`);
    lines.push(`  cwd:     ${e.cwd}`);
    lines.push(
      `  failed:  ${attemptsAgo === 1 ? "1 Bash call ago" : `${attemptsAgo} Bash calls ago`}`,
    );
    lines.push(``);
    lines.push(`  The previous failure said:`);
    const tail = e.errorTail.split("\n").slice(0, 8);
    for (const ln of tail) lines.push(`    ${ln}`);
    lines.push(``);
    lines.push(`  Retrying without changing anything will fail the same way and waste a turn.`);
    lines.push(`  Before re-issuing this command you MUST do ONE of:`);
    lines.push(`    1. Diagnose: explain in one sentence what would be different this time.`);
    lines.push(`       (e.g. "I just killed the conflicting process" or "I added the missing file")`);
    lines.push(`    2. Change the command: different cwd, different args, different tool.`);
    lines.push(`    3. Read more state first (ls / ss / ps / cat the failing file).`);
    lines.push(``);
    lines.push(`  This message is NOT a real failure of the command — KCode skipped`);
    lines.push(`  execution to protect you from a tight retry loop. The next attempt`);
    lines.push(`  will run normally.`);

    return { previous: e, attemptsAgo, report: lines.join("\n") };
  }
  return null;
}

// ─── Test helpers ──────────────────────────────────────────────────

/** Wipe all history. Use in tests. */
export function clearBashHistory(): void {
  _attempts = [];
  _nextIndex = 0;
}

/** Read-only snapshot of the history, oldest first. Use in tests. */
export function snapshotBashHistory(): readonly AttemptEntry[] {
  return _attempts.slice();
}

// ─── Escape hatch ──────────────────────────────────────────────────

/**
 * After detectImmediateRetry returns a warning AND the model issues
 * the same command yet again, we still want to allow execution (the
 * model may legitimately know something we don't). Call this from the
 * caller AFTER showing the warning once — it bumps the entry's index
 * so the warning won't fire on the very next attempt.
 */
export function acknowledgeRetryWarning(command: string, cwd: string): void {
  const key = makeKey(command, cwd);
  for (let i = _attempts.length - 1; i >= 0; i--) {
    const e = _attempts[i]!;
    if (e.key === key) {
      // Bump the entry to "now" so the next call sees attemptsAgo=0 and skips
      _attempts.push({ ...e, index: _nextIndex++, isError: false });
      return;
    }
  }
}
