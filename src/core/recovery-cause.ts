// KCode - Recovery Cause Classifier
//
// When a tool fails, the recovery logic should prefer the simplest
// grounded explanation over speculative external causes. The canonical
// example (#109): a `cd project_dir && pip install` fails with
// `ENOENT / No such file or directory`, and KCode speculates about
// unrelated node dev-server processes interfering. The direct cause
// is the missing directory; no evidence supports the speculation.
//
// This module maps error text to a narrow recovery-cause category so
// the recovery path can branch deterministically.

export type RecoveryCause =
  | "missing_directory"
  | "missing_file"
  | "permission_denied"
  | "runtime_traceback"
  | "dependency_missing"
  | "syntax_error"
  | "network"
  | "timeout"
  | "unknown";

const PATTERNS: Array<[RegExp, RecoveryCause]> = [
  // ENOENT variants (English + Spanish localization)
  [/\bENOENT\b|no such file or directory|cannot stat|cannot access|no existe el (?:fichero|archivo) o el directorio/i, "missing_directory"],
  // Permissions (English + Spanish)
  [/\bEACCES\b|permission denied|operation not permitted|EPERM\b|permiso denegado|no permitido/i, "permission_denied"],
  // Runtime error signatures
  [/\bTraceback\b|\bReferenceError\b|\bpanic:|\bNullPointerException\b|\bSyntaxError\b/i, "runtime_traceback"],
  // Dependency missing (Python/Node/Go)
  [/\bModuleNotFoundError\b|\bImportError\b|\bno module named\b|cannot find module|could not resolve dependency/i, "dependency_missing"],
  // Syntax
  [/\bunexpected token\b|\bparse error\b|\binvalid syntax\b/i, "syntax_error"],
  // Network
  [/\bECONNREFUSED\b|\bENETUNREACH\b|\bEHOSTUNREACH\b|connection refused|network unreachable|no route to host/i, "network"],
  // Timeout
  [/\btimeout\b|\btimed out\b|exit code 124|ETIMEDOUT/i, "timeout"],
];

/**
 * Classify an error text into a recovery cause. Returns "unknown"
 * only when no pattern matches — callers should treat that as a
 * permission to fall back to generic recovery.
 */
export function derivePrimaryFailureCause(errorText: string): RecoveryCause {
  if (!errorText) return "unknown";
  for (const [pattern, cause] of PATTERNS) {
    if (pattern.test(errorText)) return cause;
  }
  return "unknown";
}

/**
 * Whether the given cause justifies speculative recovery moves like
 * asking the user about unrelated running processes, lock contention,
 * firewalls, etc. Conservative by design: when the proximate cause is
 * clearly identified (missing_directory, dependency_missing, etc.),
 * speculation is disallowed.
 */
export function speculationAllowed(cause: RecoveryCause): boolean {
  switch (cause) {
    case "missing_directory":
    case "missing_file":
    case "dependency_missing":
    case "syntax_error":
      // Direct, grounded causes — fix them first, don't speculate.
      return false;
    case "permission_denied":
    case "network":
    case "timeout":
    case "runtime_traceback":
      // Possible-but-not-sole causes — caller may escalate if direct
      // remediation doesn't resolve.
      return true;
    case "unknown":
    default:
      return true;
  }
}

/**
 * For a given cause, return the specific next action the recovery
 * logic should take, or null if the caller should decide.
 */
export function recommendedRecovery(cause: RecoveryCause): string | null {
  switch (cause) {
    case "missing_directory":
      return "Create and verify the missing directory before retrying dependent commands.";
    case "missing_file":
      return "Create the missing file or verify the path before retrying.";
    case "dependency_missing":
      return "Install the missing dependency (pip / npm / cargo) before retrying.";
    case "syntax_error":
      return "Fix the syntax error in the written file and rerun validation.";
    case "permission_denied":
      return "Check ownership / mode of the target path; do not escalate with sudo unless the user explicitly asked.";
    case "network":
      return "Confirm the target host is reachable (ping/curl) before retrying network-dependent steps.";
    case "timeout":
      return "The process was killed by timeout — it started and stayed alive, but end-to-end behavior was not verified. Re-run without timeout to observe real completion.";
    case "runtime_traceback":
      return "Read the traceback, fix the specific failure site, and re-run.";
    case "unknown":
    default:
      return null;
  }
}
