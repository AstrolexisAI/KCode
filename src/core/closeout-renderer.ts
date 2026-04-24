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
  // When the scope says the artifact is not ready, make the header
  // explicitly supersede the draft above instead of coexisting with
  // it as "extra info". Issue #107/#108 follow-up.
  if (scope.phase === "failed" || !scope.completion.mayClaimReady) {
    lines.push("## ⚠ Verified status (supersedes any 'ready/created successfully' claim above)");
  } else if (scope.completion.mustUsePartialLanguage) {
    lines.push("## ⚠ Verified status — partial progress (read below, not the optimistic summary above)");
  } else {
    lines.push("**⚖ Scope-grounded status**");
  }
  lines.push("");

  // Project root (phase 9 — directory-level artifact). Distinguishes
  // "no files written BUT root verified" from "root never established".
  // Issue #109: v2.10.269 closeout said "Files: none" while the real
  // problem was that mkdir/cd never actually succeeded.
  if (scope.projectRoot.path && scope.projectRoot.status !== "unknown") {
    const rootLabel =
      scope.projectRoot.status === "verified"
        ? "verified"
        : scope.projectRoot.status === "created"
          ? "created (not re-verified)"
          : scope.projectRoot.status === "missing"
            ? "**missing** (ENOENT / cd failed)"
            : scope.projectRoot.status;
    lines.push(`- Project root: ${rootLabel} (\`${basename(scope.projectRoot.path)}\`)`);

    // Issue #110: when the scope says missing AND the reasons list
    // includes the executor-skip marker, make it visually clear that
    // the agent did something wrong, not the user. The agent has
    // Bash — it was supposed to mkdir -p and didn't.
    const skippedMkdir = scope.completion.reasons.some((r) =>
      r.startsWith("executor skipped mandatory mkdir"),
    );
    if (scope.projectRoot.status === "missing" && skippedMkdir) {
      lines.push(
        `  ↳ **Executor error:** Bash is available; the agent should have run ` +
          `\`mkdir -p ${basename(scope.projectRoot.path)}\` instead of asking the ` +
          `user to create the directory manually. A forced-recovery directive ` +
          `has been injected for the next turn.`,
      );
    }
  }

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
    if (last.status === "runner_misfire") {
      lines.push(
        `- Runtime: **runner_misfire** — KCode's spawn preflight refused the command because it treated the project as a web server (port check). The app itself was never executed.`,
      );
    } else if (last.status === "failed_auth") {
      const authLine =
        last.output
          .split("\n")
          .map((l) => l.trim())
          .find((l) => /401|403|Unauthorized|Forbidden|auth/i.test(l)) ??
        "auth rejected";
      lines.push(`- Runtime: **failed_auth** (${authLine.slice(0, 140)})`);
    } else if (last.status === "failed_dependency") {
      const depLine =
        last.output
          .split("\n")
          .map((l) => l.trim())
          .find((l) => /ModuleNotFound|ImportError|cannot find/i.test(l)) ??
        "missing dependency";
      lines.push(`- Runtime: **failed_dependency** (${depLine.slice(0, 140)})`);
    } else if (last.status === "failed_connection") {
      const connLine =
        last.output
          .split("\n")
          .map((l) => l.trim())
          .find((l) => /refused|unreachable|resolve|ECONNREFUSED|ENOTFOUND/i.test(l)) ??
        "connection refused";
      lines.push(`- Runtime: **failed_connection** (${connLine.slice(0, 140)})`);
    } else if (last.runtimeFailed || last.status === "failed_traceback" || last.status === "failed_unknown") {
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
    } else if (last.exitCode === 124 || last.status === "alive_timeout") {
      lines.push(
        `- Runtime: **started and stayed alive under timeout** — no connection/RPC/UI assertion verified.`,
      );
    } else if (last.status === "started_unverified") {
      const errLine =
        last.output
          .split("\n")
          .map((l) => l.trim())
          .find((l) => /(^|[\s\n])(?:Error|ERROR|error)\s*[:\-—]/.test(l)) ??
        last.output.split("\n").find((l) => l.trim())?.trim() ??
        "";
      lines.push(
        `- Runtime: **started_unverified** — process exited cleanly but printed an application error (${errLine.slice(0, 140)}); end-to-end behavior not proven.`,
      );
    } else {
      lines.push(`- Runtime: verified (${runtimes.length} command${runtimes.length > 1 ? "s" : ""}).`);
    }
  }

  // Secrets detected
  if (scope.secrets.detected.length > 0) {
    const kinds = [...new Set(scope.secrets.detected.map((s) => s.kind))].join(", ");
    lines.push(`- Secrets detected (redacted): ${kinds}.`);
  }

  // Plan progress. Source of truth is whatever is higher:
  //   A) completedSteps — steps the Plan tool explicitly marked done.
  //   B) deriveCompletedFromVerification(scope) — steps whose keywords
  //      match the verification state (project root verified, files
  //      written, runtime verified, etc.).
  // Issue #111 v273 repro: the model never called plan.update after
  // declaring 4 steps, so completedSteps stayed [] and the closeout
  // rendered "0/4" while the project root was verified, 3 files were
  // written, and runtime had actually run. Derivation fixes that.
  const planned = scope.progress.plannedSteps.length;
  const explicitCompleted = scope.progress.completedSteps.length;
  const derivedCompleted = countDerivedCompletedSteps(scope);
  const completed = Math.max(explicitCompleted, derivedCompleted);
  if (planned > 0) {
    const current = scope.progress.currentStep
      ? ` — current: "${scope.progress.currentStep}"`
      : "";
    const note =
      derivedCompleted > explicitCompleted ? " (derived from verification)" : "";
    lines.push(
      `- Plan progress: ${completed}/${planned} step(s) completed${current}${note}.`,
    );
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
  const misfire = runtimes[runtimes.length - 1]?.status === "runner_misfire";
  if (misfire) {
    lines.push(
      "**Status: partial.** The project artifacts were created, but KCode's verification runner " +
        "refused the command based on a web-server preflight — not an app failure.",
    );
    lines.push("");
    lines.push(
      "**Next required step:** rerun with a direct CLI/TUI execution mode (e.g. `bun index.ts` / `timeout 8 bun run index.ts`) outside the spawn preflight, or confirm the project's web framework imports.",
    );
    return lines.join("\n");
  }
  // failed_auth on scaffold/implement → task transitioned to configure/blocked
  // in the scope manager. Render a precise next-step instead of a generic
  // "failed". Issue #111 v273 repro.
  const lastRuntime = runtimes[runtimes.length - 1];
  const isAuthBlocked =
    scope.phase === "blocked" &&
    (scope.type === "configure" || lastRuntime?.status === "failed_auth");
  if (isAuthBlocked) {
    lines.push(
      "**Status: blocked by configuration.** The project artifacts exist, but the runtime rejected the credentials.",
    );
    lines.push("");
    lines.push(
      "**Next required step:** supply valid credentials. For Bitcoin Core, set `BITCOIN_RPC_USER` and `BITCOIN_RPC_PASSWORD` (or equivalent `rpcuser` / `rpcpassword` in `bitcoin.conf`) and re-run the connection test.",
    );
  } else if (scope.phase === "failed") {
    lines.push("**Status: failed.** The task produced artifacts but verification did not pass.");
    lines.push("");
    lines.push(
      "The narrative summary above is unverified. Treat the lines above this block as suggestions, not facts — only the verification lines here reflect real state.",
    );
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
 * Count the plannedSteps that appear satisfied by the verification
 * state, independent of whether the Plan tool was told they're done.
 * Each step title is matched against keyword signals — the step
 * counts as completed when its signal is present in scope state.
 *
 * Keyword → signal mapping:
 *   create / project / directory      → projectRoot.status === "verified"
 *   install / deps / dependenc        → deps present (any Write to requirements / pyproject / package.json, OR any runtime command succeeded importing)
 *   write / script / code / main / app  → at least one file created/edited
 *   test / verify / run / check / connect → at least one non-failed runtime command
 */
export function countDerivedCompletedSteps(scope: TaskScope): number {
  let done = 0;
  const v = scope.verification;
  const lastRuntime = v.runtimeCommands[v.runtimeCommands.length - 1];
  const depsFilesTouched = [...v.filesWritten, ...v.filesEdited].some((p) =>
    /(?:requirements\.txt|pyproject\.toml|package\.json|Cargo\.toml|go\.mod|Gemfile)$/i.test(p),
  );
  const anyFileWritten = v.filesWritten.length + v.filesEdited.length > 0;
  const anyRuntimeHappened = v.runtimeCommands.length > 0;
  const depsInstalled = (v.packageManagerOps ?? []).length > 0;
  const allPaths = [...v.filesWritten, ...v.filesEdited];
  const hasTransactionsFile = allPaths.some((p) =>
    /(?:transactions?|tx|mempool)[./\\]|(?:transactions?|tx|mempool)\.\w+$/i.test(p),
  );
  const hasRefreshCode = allPaths.some((p) =>
    // Entrypoint files likely to host setInterval / refresh loops.
    /(?:index|main|app|dashboard|server)\.(?:ts|tsx|js|jsx|py|mjs)$/i.test(p),
  );
  // Strict verification: "test/verify/connect" steps ONLY complete when
  // the runtime classifier returned "verified". started_unverified,
  // alive_timeout, and any failed_* variant leave the step open.
  // Issue #111 v274: previous looser test (!runtimeFailed) marked the
  // verify step done when the app printed "Error: Request-sent" and
  // exited 0, producing "4/4 completed" under "status: partial".
  const lastRuntimeVerified =
    !!lastRuntime &&
    !lastRuntime.runtimeFailed &&
    (lastRuntime.status === undefined || lastRuntime.status === "verified");

  for (const title of scope.progress.plannedSteps) {
    const t = title.toLowerCase();

    // Create / scaffold a project root
    if (/(create|cre[aá]r|init|setup|scaffold|project|directory|carpeta|proyecto)/i.test(t)) {
      if (
        scope.projectRoot.status === "verified" ||
        scope.projectRoot.status === "created"
      ) {
        done++;
        continue;
      }
    }

    // Install dependencies
    if (/(install|instal[aá]r?|depend|requirement|dependenc|paquet|librer)/i.test(t)) {
      if (depsInstalled || depsFilesTouched || anyRuntimeHappened) {
        done++;
        continue;
      }
    }

    // Transactions / mempool view (specific file)
    if (/(transacc|transaction|mempool)/i.test(t)) {
      if (hasTransactionsFile) {
        done++;
        continue;
      }
    }

    // Live updates / refresh / auto-refresh
    if (/(live|refresh|actualiz|vivo|tiempo.?real|real.?time|auto.?refresh|setInterval)/i.test(t)) {
      if (hasRefreshCode) {
        done++;
        continue;
      }
    }

    // Write / implement application code
    if (/(write|escribi|code|c[oó]digo|main|app|script|application|aplicaci|implement|implementar|rpc|client|cliente)/i.test(t)) {
      if (anyFileWritten) {
        done++;
        continue;
      }
    }

    // Test / verify / run / connect — strict: only verified runtime counts.
    if (/(test|verify|verific|run|ejecut|check|revis|connect|conect|probar|prueba)/i.test(t)) {
      if (lastRuntimeVerified) {
        done++;
        continue;
      }
      // Runtime happened but status is started_unverified / alive_timeout /
      // failed_* — the step is open. The closeout verdict already renders
      // the failure separately.
    }
  }
  return done;
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
