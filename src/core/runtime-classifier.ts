// KCode - Runtime status classifier (Phase 11 of #100-#111 refactor)
//
// Narrows the binary runtimeFailed flag on RuntimeCommandEvent into
// a small enum that the closeout renderer and task-transition layer
// can act on. Issue #111 follow-up: v2.10.273 said "Runtime: failed"
// for a 401 Unauthorized — generic, and the next-action advice was
// missing. With RuntimeStatus we can render "Runtime: failed_auth
// (401)" AND flip the task type from scaffold → configure so the
// next directive is "configure RPC credentials", not "retry scaffold".

export type RuntimeStatus =
  | "not_run"
  | "started"
  | "verified"
  | "alive_timeout"
  | "failed_auth"
  | "failed_connection"
  | "failed_traceback"
  | "failed_dependency"
  | "failed_unknown";

/**
 * Classify a runtime command result into a RuntimeStatus. Precedence:
 *   1. Auth failure signatures (401 / Unauthorized / Forbidden / invalid credentials)
 *   2. Traceback / exception signatures (always a real crash)
 *   3. Dependency signatures (ModuleNotFoundError / cannot find module)
 *   4. Connection-refused / DNS / timeout
 *   5. Timeout exit code (124) alone → alive_timeout (process stayed up)
 *   6. Exit 0 → verified
 *   7. Unclassified non-zero → failed_unknown
 */
export function classifyRuntimeStatus(
  _command: string,
  exitCode: number | null,
  output: string,
): RuntimeStatus {
  const o = output;
  const lo = o.toLowerCase();

  // Auth first — 401/403/invalid credentials beat a traceback that
  // merely WRAPS the auth error (python-bitcoinrpc raises
  // JSONRPCException with "401 Unauthorized" inside a traceback).
  if (
    /\b401\b[^\n]{0,80}unauthoriz/i.test(o) ||
    /non-?JSON HTTP response with '401/i.test(o) ||
    /\b403\b[^\n]{0,80}forbidden/i.test(o) ||
    /invalid\s+credentials|authentication\s+failed|auth\s+failed/i.test(lo) ||
    /\bHTTP\s+401\b/i.test(o) ||
    /\bHTTP\s+403\b/i.test(o)
  ) {
    return "failed_auth";
  }

  // Dependency issues first — they generate tracebacks but the
  // remediation is "install the package", not "fix the code".
  if (
    /\bModuleNotFoundError\b/.test(o) ||
    /\bImportError\b/.test(o) ||
    /cannot\s+find\s+module/i.test(lo) ||
    /Cannot\s+find\s+package/i.test(o) ||
    /no\s+such\s+file\s+or\s+directory.*\.so\b/i.test(lo)
  ) {
    return "failed_dependency";
  }

  // Connection-layer failures (before generic traceback so
  // ConnectionRefusedError doesn't degrade to failed_traceback).
  if (
    /connection\s+refused/i.test(lo) ||
    /no\s+route\s+to\s+host/i.test(lo) ||
    /name\s+or\s+service\s+not\s+known/i.test(lo) ||
    /could\s+not\s+resolve\s+host/i.test(lo) ||
    /\bECONNREFUSED\b/.test(o) ||
    /\bENOTFOUND\b/.test(o) ||
    /network\s+is\s+unreachable/i.test(lo)
  ) {
    return "failed_connection";
  }

  // Generic traceback / panic / SyntaxError etc.
  if (
    /\bTraceback\b/.test(o) ||
    /\bSyntaxError\b/.test(o) ||
    /\bNameError\b/.test(o) ||
    /\bAttributeError\b/.test(o) ||
    /\bIndentationError\b/.test(o) ||
    /\bReferenceError\b/.test(o) ||
    /\bTypeError\b\s*:/.test(o) ||
    /\bValueError\b\s*:/.test(o) ||
    /\bpanic\b:/i.test(o)
  ) {
    return "failed_traceback";
  }

  // Timeout — process stayed alive but didn't verify anything.
  if (
    exitCode === 124 ||
    /timed\s+out/i.test(lo) ||
    /Bash failed \(\d+\.\d+s\)/.test(o)
  ) {
    return "alive_timeout";
  }

  if (exitCode === 0) return "verified";
  if (exitCode === null) return "failed_unknown";
  return "failed_unknown";
}

/**
 * Convenience: true when the status is any of the failed_* variants.
 * Used by task-scope recordRuntimeCommand to flip phase to "failed"
 * or "blocked".
 */
export function isFailedStatus(status: RuntimeStatus): boolean {
  return status.startsWith("failed_");
}

/**
 * Map a status to the phase a scaffold/implement scope should enter.
 * failed_auth → "blocked" (waiting on user-side configuration).
 * Other failures → "failed" (task needs code-level repair).
 */
export function phaseForStatus(status: RuntimeStatus): "failed" | "blocked" | "verifying" | "done" {
  if (status === "failed_auth") return "blocked";
  if (isFailedStatus(status)) return "failed";
  if (status === "verified") return "done";
  return "verifying";
}
