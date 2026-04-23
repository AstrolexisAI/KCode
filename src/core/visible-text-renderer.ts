// KCode - Visible Text Renderer (Phase 5 of #100-#108 refactor)
//
// Single pipeline for every string that flows from the system to the
// user. Two jobs:
//
//   1. Redact secrets (rpcpassword, API keys, JWTs, URL basic-auth,
//      PEM private keys, etc.) via the existing secret-redactor.
//   2. Feed findings back to the TaskScope so the closeout renderer
//      (phase 4) can surface which secret categories were detected
//      this task, without ever exposing the values themselves.
//
// Before phase 5 the redactor was wired into two spots (tool-executor
// post-turn + stream-handler finalization). Phase 5 makes that
// explicit and adds a source label so telemetry/logs can tell
// where a secret was seen.
//
// Design notes:
//
//   - The scope update is fire-and-forget: if the scope manager
//     isn't initialized (early startup, unit tests without scope),
//     we swallow the error and still return the redacted string.
//   - The render function itself never throws. A malformed input
//     that the redactor can't handle (unlikely) falls back to
//     returning the original string; we log a debug line so
//     regressions are visible.
//   - Opt-out via KCODE_DISABLE_REDACTION=1 — same flag as the
//     individual call sites used, so nothing changes for users
//     who already have that set.

import { log } from "./logger";
import { redact } from "./secret-redactor";

/**
 * Where this text came from. Used for scope telemetry and to decide
 * whether the redactor should also record a scope.secret entry
 * (assistant_prose and tool_output always do; internal sources like
 * "log" don't clutter the scope).
 */
export type VisibleTextSource =
  | "tool_output"
  | "assistant_prose"
  | "banner"
  | "closeout"
  | "reality_check"
  | "log";

export interface RenderOptions {
  source?: VisibleTextSource;
  /** When true, skip feeding findings into scope (for internal calls). */
  skipScopeRecord?: boolean;
}

/**
 * Render a string for user-visible output: redact secrets and record
 * any findings to the TaskScope. Safe to call from any layer; never
 * throws.
 */
export function renderVisibleText(raw: string, opts: RenderOptions = {}): string {
  if (!raw) return raw;
  if (process.env.KCODE_DISABLE_REDACTION === "1") return raw;

  let redacted = raw;
  let rulesFired: string[] = [];
  try {
    const result = redact(raw);
    redacted = result.redacted;
    rulesFired = result.rulesFired;
  } catch (err) {
    log.debug(
      "visible-text",
      `redactor threw on ${raw.length}ch input (${opts.source ?? "?"}): ${err instanceof Error ? err.message : err}`,
    );
    return raw;
  }

  if (rulesFired.length > 0 && opts.skipScopeRecord !== true) {
    const source = opts.source ?? "unknown";
    // Scope update is best-effort — if the manager isn't initialized
    // (early session init, unit tests), the redacted string is still
    // returned. Import inline so this module stays loadable in
    // environments that don't ship task-scope.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getTaskScopeManager } = require("./task-scope") as typeof import("./task-scope");
      const mgr = getTaskScopeManager();
      if (mgr.current()) {
        for (const kind of rulesFired) {
          mgr.recordSecret({ kind, source });
        }
      }
    } catch {
      /* task-scope unavailable, swallow */
    }
    log.info(
      "visible-text",
      `redacted ${rulesFired.length} secret(s) from ${source}: ${rulesFired.join(", ")}`,
    );
  }

  return redacted;
}

/**
 * Convenience for log lines — redacts without recording to scope.
 * Useful for logger sanitization paths so log noise doesn't pollute
 * scope telemetry.
 */
export function renderForLog(raw: string): string {
  return renderVisibleText(raw, { source: "log", skipScopeRecord: true });
}
