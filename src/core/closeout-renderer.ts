// KCode - Closeout Renderer (Phase 4 of #100-#108 refactor)
//
// When the task scope says this turn must not claim
// ready/done/implemented, this module renders a scope-grounded
// correction that appends to the model's draft final text. The
// correction surfaces exactly what was verified vs what was not,
// so a later reader can tell fact from narrative.
//
// Design decisions:
//   * We do NOT replace the model's draft. The draft stays as the
//     primary prose and the correction appears after it, so the user
//     has both the model's narrative and the scope-grounded truth.
//     This is cheaper than full interception and avoids the "the
//     agent seems to have been silenced" UX.
//   * Correction is only emitted when the scope actually needs one.
//     In the happy path (phase=done, mayClaimReady=true, no partial
//     language required) we return null and nothing is appended.
//   * Facts come from scope.verification — the file list, runtime
//     results, reasons — NOT from the model. This is what makes the
//     correction authoritative rather than another layer of claims.

import { basename } from "node:path";
import type { TaskScope } from "./task-scope";

/**
 * Decide whether a scope needs a corrective closeout at all.
 * True when the model must NOT claim ready / implemented, or when
 * the phase is failed / partial, or when partial-language is
 * required. Any of these → the draft can't be trusted alone.
 */
export function needsClosewoutCorrection(scope: TaskScope): boolean {
  if (!scope.completion.mayClaimReady) return true;
  if (!scope.completion.mayClaimImplemented) return true;
  if (scope.completion.mustUsePartialLanguage) return true;
  if (scope.phase === "failed" || scope.phase === "partial") return true;
  return false;
}

/**
 * Render the scope-grounded closeout correction, or null when no
 * correction is needed. The returned string is intended to be
 * streamed to the user as a separate markdown block after the
 * model's draft.
 */
export function renderCloseoutFromScope(scope: TaskScope): string | null {
  if (!needsClosewoutCorrection(scope)) return null;

  const lines: string[] = [];
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("**⚖ Scope-grounded status**");
  lines.push("");

  // What landed on disk
  const written = scope.verification.filesWritten;
  const edited = scope.verification.filesEdited;
  if (written.length === 0 && edited.length === 0) {
    lines.push("- Files: **none created or edited** this task.");
  } else {
    if (written.length > 0) {
      lines.push(
        `- Files created: \`${written.map((p) => basename(p)).join("`, `")}\``,
      );
    }
    if (edited.length > 0) {
      lines.push(
        `- Files edited: \`${edited.map((p) => basename(p)).join("`, `")}\``,
      );
    }
  }

  // Runtime outcome.
  // Patch-after-failure check runs FIRST because after applying an
  // Edit post-failure, `lastRuntimeFailure` is cleared by the
  // manager but `patchAppliedAfterFailure` becomes true; the user
  // needs to see that repair is pending, not "runtime failed".
  // (If the manager later logic changes, we fall through safely.)
  const runtimes = scope.verification.runtimeCommands;
  if (scope.verification.patchAppliedAfterFailure && !scope.verification.rerunPassedAfterPatch) {
    lines.push(
      "- Runtime: **patch applied after earlier failure, no successful rerun** — status unverified.",
    );
  } else if (runtimes.length === 0) {
    lines.push("- Runtime: **not verified** — the generated code was not executed this turn.");
  } else {
    const last = runtimes[runtimes.length - 1]!;
    if (last.runtimeFailed) {
      // Prefer an error-signature line over the first-any-line.
      const errorLine =
        last.output
          .split("\n")
          .map((l) => l.trim())
          .find((l) =>
            /\b(?:Error|Exception|ModuleNotFoundError|ImportError|SyntaxError|NameError|AttributeError|IndentationError|TypeError|ValueError|ReferenceError|panic)\b/.test(
              l,
            ),
          ) ??
        last.output.split("\n").find((l) => l.trim())?.trim() ??
        "";
      lines.push(
        `- Runtime: **failed** (${errorLine.slice(0, 140) || "see previous output"})`,
      );
    } else {
      lines.push(`- Runtime: passed (${runtimes.length} command${runtimes.length > 1 ? "s" : ""}).`);
    }
  }

  // Secrets detected
  if (scope.secrets.detected.length > 0) {
    const kinds = [...new Set(scope.secrets.detected.map((s) => s.kind))].join(", ");
    lines.push(`- Secrets detected (redacted): ${kinds}.`);
  }

  // Why the turn cannot be marked done
  if (scope.completion.reasons.length > 0) {
    lines.push("");
    lines.push(`**Why this turn is not marked complete:**`);
    for (const reason of scope.completion.reasons) {
      lines.push(`- ${reason}`);
    }
  }

  // Overall verdict
  lines.push("");
  if (scope.phase === "failed") {
    lines.push("**Status: failed.** The task produced artifacts but verification did not pass.");
  } else if (scope.completion.mustUsePartialLanguage || scope.phase === "partial") {
    lines.push(
      "**Status: partial.** Initial scaffold / MVP is in place; the requested functionality is not end-to-end verified.",
    );
  } else if (!scope.completion.mayClaimReady) {
    lines.push("**Status: not ready.** See reasons above.");
  }

  return lines.join("\n");
}

/**
 * A structured view of scope state, intended for logs / telemetry
 * / debugging. Not user-facing.
 */
export function summarizeScopeForTelemetry(scope: TaskScope): Record<string, unknown> {
  return {
    id: scope.id,
    type: scope.type,
    phase: scope.phase,
    filesWritten: scope.verification.filesWritten.length,
    filesEdited: scope.verification.filesEdited.length,
    runtimesRun: scope.verification.runtimeCommands.length,
    runtimeFailed: scope.verification.runtimeCommands.some((r) => r.runtimeFailed),
    patchAppliedAfterFailure: scope.verification.patchAppliedAfterFailure,
    rerunPassedAfterPatch: scope.verification.rerunPassedAfterPatch,
    secretsDetected: scope.secrets.detected.length,
    mayClaimReady: scope.completion.mayClaimReady,
    mayClaimImplemented: scope.completion.mayClaimImplemented,
    mustUsePartialLanguage: scope.completion.mustUsePartialLanguage,
    reasonsCount: scope.completion.reasons.length,
    broadRequest: scope.broadRequest,
  };
}
