// KCode - File Edit History
//
// Operator-mind primitive (phase 4): generalize the retry guard from
// Bash spawns (phase 3) to the file-mutating tools — Edit, MultiEdit,
// and Write. When Edit fails (typically with "old_string not found"
// or "string is not unique"), the model often re-issues the EXACT
// same Edit call instead of reading the file to see what actually
// went wrong. Phase 4 intercepts that pattern.
//
// Scope: only the file-mutating tools. Read-only tools (Read, Grep,
// Glob, LS) are explicitly out of scope — re-reading is normal.
// Bash is handled by phase 3 (bash-spawn-history) with its own scope.
//
// State is process-local; entries expire after the retry window so
// the history never grows unbounded.

import { createHash } from "node:crypto";

const MAX_HISTORY = 64;
const RETRY_WINDOW = 6;

interface AttemptEntry {
  /** Normalized key — see makeKey(). */
  key: string;
  /** Tool name (Edit / MultiEdit / Write) for the diagnostic. */
  toolName: string;
  /** File path the operation targeted. */
  filePath: string;
  /** Was the result an error? */
  isError: boolean;
  /** First ~400 chars of the error output. */
  errorTail: string;
  /** Monotonic attempt index for "N attempts ago" reasoning. */
  index: number;
}

let _attempts: AttemptEntry[] = [];
let _nextIndex = 0;

// ─── Fingerprinting ────────────────────────────────────────────────

/**
 * Fingerprint the inputs that determine whether a retry would fail
 * the same way. Stable across whitespace and unicode normalization.
 */
function fingerprintEditInput(toolName: string, input: Record<string, unknown>): string {
  const filePath = String(input.file_path ?? "");
  let payload = "";
  if (toolName === "Edit") {
    // For Edit, the fingerprint is (file_path, old_string, replace_all).
    // new_string differences are intentional retries with a fix.
    payload = `${input.old_string ?? ""}|${input.replace_all ?? false}`;
  } else if (toolName === "MultiEdit") {
    // Stringify the edits array; identical sequence = same intent.
    payload = JSON.stringify(input.edits ?? []);
  } else if (toolName === "Write") {
    // For Write, content differences are usually intentional revisions.
    // Hash the content so memory cost is bounded and we still detect
    // exact retries.
    payload = String(input.content ?? "");
  }
  const hash = createHash("sha1").update(payload).digest("hex").slice(0, 16);
  return `${toolName}|${filePath}|${hash}`;
}

// ─── Recording ─────────────────────────────────────────────────────

export function recordEditAttempt(
  toolName: string,
  input: Record<string, unknown>,
  isError: boolean,
  errorTail: string,
): void {
  if (!isFileEditTool(toolName)) return;
  const filePath = String(input.file_path ?? "");
  if (!filePath) return;
  _attempts.push({
    key: fingerprintEditInput(toolName, input),
    toolName,
    filePath,
    isError,
    errorTail: errorTail.slice(0, 400),
    index: _nextIndex++,
  });
  if (_attempts.length > MAX_HISTORY) {
    _attempts = _attempts.slice(-MAX_HISTORY);
  }
}

// ─── Detection ─────────────────────────────────────────────────────

export interface EditRetryWarning {
  previous: AttemptEntry;
  attemptsAgo: number;
  /** Multi-line operator report — safe to inline as a tool result. */
  report: string;
}

/**
 * Returns a STOP report if the upcoming tool call is an immediate
 * retry of an identical (file, payload) attempt that just failed,
 * within the retry window. Returns null otherwise.
 *
 * The caller should treat a non-null result as a tool failure with
 * is_error=true and skip execution. The next attempt with the same
 * fingerprint will run normally — see acknowledgeEditWarning().
 */
export function detectImmediateEditRetry(
  toolName: string,
  input: Record<string, unknown>,
): EditRetryWarning | null {
  if (!isFileEditTool(toolName)) return null;
  const key = fingerprintEditInput(toolName, input);
  for (let i = _attempts.length - 1; i >= 0; i--) {
    const e = _attempts[i]!;
    if (e.key !== key) continue;
    const attemptsAgo = _nextIndex - e.index;
    if (!e.isError) return null;
    if (attemptsAgo > RETRY_WINDOW) return null;

    const lines: string[] = [];
    lines.push(`✗ STOP. You are retrying a ${toolName} that just failed.`);
    lines.push(``);
    lines.push(`  tool:  ${toolName}`);
    lines.push(`  file:  ${e.filePath}`);
    lines.push(
      `  failed: ${attemptsAgo === 1 ? "1 tool call ago" : `${attemptsAgo} tool calls ago`}`,
    );
    lines.push(``);
    lines.push(`  The previous failure said:`);
    const tail = e.errorTail.split("\n").slice(0, 6);
    for (const ln of tail) lines.push(`    ${ln}`);
    lines.push(``);
    if (toolName === "Edit") {
      lines.push(`  Edit failures are almost always one of:`);
      lines.push(`    - the file changed since you last read it`);
      lines.push(`    - the old_string contains whitespace/quote differences from the file`);
      lines.push(`    - the old_string occurs multiple times (use replace_all or a longer match)`);
      lines.push(``);
      lines.push(`  BEFORE retrying you MUST:`);
      lines.push(`    1. Re-Read the target file to see its current exact bytes.`);
      lines.push(`    2. Build a new old_string that you can SEE in the Read output.`);
      lines.push(`    3. If the change is large, consider Write instead.`);
    } else if (toolName === "MultiEdit") {
      lines.push(`  MultiEdit ran the edits as a transaction — one bad old_string aborted all.`);
      lines.push(`  BEFORE retrying you MUST:`);
      lines.push(`    1. Re-Read the file.`);
      lines.push(`    2. Identify which specific edit's old_string is wrong.`);
      lines.push(`    3. Either fix that edit or split into single Edit calls.`);
    } else {
      // Write
      lines.push(`  Write failures usually mean a permission/path issue, not a content issue.`);
      lines.push(`  BEFORE retrying you MUST:`);
      lines.push(`    1. Verify the parent directory exists and is writable.`);
      lines.push(`    2. Check the path for typos.`);
      lines.push(`    3. If the failure was about content shape, change the content.`);
    }
    lines.push(``);
    lines.push(`  This message is NOT a real failure of the tool — KCode skipped`);
    lines.push(`  execution to protect you from a tight retry loop. The next attempt`);
    lines.push(`  with this fingerprint will run normally.`);

    return { previous: e, attemptsAgo, report: lines.join("\n") };
  }
  return null;
}

// ─── Acknowledgment / escape hatch ─────────────────────────────────

/**
 * Mark the warning as shown, so the very next call with the same
 * fingerprint runs normally. Same pattern as bash-spawn-history.
 */
export function acknowledgeEditWarning(toolName: string, input: Record<string, unknown>): void {
  if (!isFileEditTool(toolName)) return;
  const key = fingerprintEditInput(toolName, input);
  for (let i = _attempts.length - 1; i >= 0; i--) {
    const e = _attempts[i]!;
    if (e.key === key) {
      _attempts.push({ ...e, index: _nextIndex++, isError: false });
      return;
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function isFileEditTool(toolName: string): boolean {
  return toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write";
}

// ─── Test helpers ──────────────────────────────────────────────────

export function clearEditHistory(): void {
  _attempts = [];
  _nextIndex = 0;
}

export function snapshotEditHistory(): readonly AttemptEntry[] {
  return _attempts.slice();
}
