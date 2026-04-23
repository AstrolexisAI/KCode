// KCode - Rerun Directive (Phase 10 of #100-#111 refactor)
//
// Closes the last loop in the failure→patch→verify cycle. Prior
// phases already detect "patch applied after runtime failure, no
// successful rerun" and reflect it in the closeout, but leave the
// decision to re-run the validation up to the model. In practice
// (issue #111, v2.10.272 Bitcoin TUI repro) the model writes the
// patch, then produces a free-form summary and ends the turn —
// never exercising the patched code. The grounded status shows
// "failed" but the turn still closes.
//
// This module turns the observation into an obligation: when the
// scope carries patchAppliedAfterFailure && !rerunPassedAfterPatch,
// post-turn injects a mandatory-rerun directive and returns action
// "continue" so the model is forced to call Bash with the canonical
// rerun command before any closeout renders.
//
// Guards to prevent infinite loops:
//   - Max 3 rerun attempts per failure cluster (scope field).
//   - Only files relevant to the failed command trigger the gate
//     (editing README.md after a main.py failure does not).

import { basename } from "node:path";
import type { TaskScope } from "./task-scope";

/**
 * Filenames / paths referenced by a failed runtime command, either
 * on the command line itself (`python foo.py`) or in the traceback
 * (`File "bar.py", line 42`). Used to decide whether a follow-up
 * mutation is "relevant" to the failure.
 */
export function extractRelevantPaths(scope: TaskScope): Set<string> {
  const out = new Set<string>();
  const last = scope.verification.lastRuntimeFailure;
  if (!last) return out;

  // Tokens from the command that look like file paths.
  const CMD_FILE_RE = /(?:^|[\s=])([./\w-]+\.(?:py|js|ts|tsx|jsx|mjs|cjs|rb|go|rs|java|sh|php|pl|lua))(?=[\s&|;<>]|$)/gi;
  for (const m of last.command.matchAll(CMD_FILE_RE)) {
    if (m[1]) out.add(basename(m[1]));
  }

  // Files mentioned in traceback / error output.
  const OUT_FILE_RE = /(?:File\s+"([^"]+)"|at\s+([\w./]+\.(?:py|js|ts|rb|go|rs))\b)/g;
  for (const m of last.error.matchAll(OUT_FILE_RE)) {
    const path = m[1] ?? m[2];
    if (path) out.add(basename(path));
  }

  return out;
}

/**
 * Decide whether a just-applied mutation should arm the forced-rerun
 * gate.
 *
 * A mutation "counts" when:
 *   1. The patched basename appears in the failing command or its
 *      traceback (the strictly-relevant case), OR
 *   2. The patched file has a recognized code extension AND isn't
 *      a docs/config file. This catches the indirect-fix case where
 *      `bun run index.ts` fails because of a bad import in rpc.ts;
 *      the error text mentions index.ts and node_modules paths but
 *      not rpc.ts, yet rpc.ts IS where the fix lands. Issue #111
 *      v277 repro.
 *   3. Empty relevance set (no paths extractable) → arm conservatively.
 *
 * Docs/config-only edits (README.md, CHANGELOG, .gitignore) never
 * arm the gate — those can't fix a runtime failure.
 */
export function isRelevantPatch(filePath: string, scope: TaskScope): boolean {
  const relevant = extractRelevantPaths(scope);
  const base = basename(filePath);

  if (relevant.size === 0) return true;
  if (relevant.has(base)) return true;

  // Non-code files never arm the gate.
  const DOC_OR_CONFIG_FILES = /^(?:README|CHANGELOG|LICENSE|CONTRIBUTING|TODO|\.gitignore|\.npmignore|\.dockerignore)(?:\.md|\.txt|\.rst)?$/i;
  if (DOC_OR_CONFIG_FILES.test(base)) return false;

  const DOC_EXT = /\.(?:md|mdx|txt|rst|adoc|html)$/i;
  if (DOC_EXT.test(base)) return false;

  const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|scala|swift|php|pl|lua|sh|bash|zsh|fish|c|cpp|cc|h|hpp|cs|fs|ex|exs|erl|clj|cljs|hs|ml|dart|r|nim|zig|v|vala|sql|json|yaml|yml|toml)$/i;
  if (CODE_EXT.test(base)) return true;

  return false;
}

/**
 * Pick the canonical command to rerun after a patch. Heuristics:
 *   1. If a test_connection.py or similar sanity check is in the
 *      scope's written/edited files, rerun THAT first.
 *   2. Else rerun the last-failed command verbatim, prepending
 *      `timeout 15` when the command invokes a long-running runner
 *      (TUI / server) to avoid hanging the loop.
 */
export function deriveRerunCommand(scope: TaskScope): string | null {
  const last = scope.verification.lastRuntimeFailure;
  if (!last) return null;

  // runner_misfire: the KCode preflight refused the command because
  // of a port-3000 collision, but the project is a CLI/TUI and
  // never binds a port. Re-running the SAME command goes through
  // the same preflight again. The task-scope transition should have
  // moved the scope to phase="partial" and the closeout renders a
  // direct-mode next-step; the forced-rerun gate has nothing useful
  // to inject here. Return null so the gate skips.
  const lastRuntime =
    scope.verification.runtimeCommands[scope.verification.runtimeCommands.length - 1];
  if (lastRuntime?.status === "runner_misfire") return null;

  const allTouched = [
    ...scope.verification.filesWritten,
    ...scope.verification.filesEdited,
  ];

  // Prefer a connection-sanity script when present.
  const sanity = allTouched.find((p) => /\b(test_connection|connection_test|sanity)\.py$/i.test(p));
  if (sanity) {
    return `python3 ${sanity}`;
  }

  // Long-running runners: wrap in timeout.
  const cmd = last.command.trim();
  const looksLongRunning =
    /\b(?:python3?|node|bun\s+run|ruby|cargo\s+run|go\s+run|java|deno\s+run)\b/.test(cmd) &&
    // TUI / server indicators
    /(?:dashboard|server|serve|live|watch|main\.py|app\.py|main\.js|index\.js)/i.test(cmd);

  if (looksLongRunning && !/^\s*timeout\b/.test(cmd)) {
    return `timeout 15 ${cmd}`;
  }
  return cmd;
}

/**
 * Render the forced-rerun system directive. This is the text the
 * post-turn handler injects as a user message to make the model
 * stop narrating and go run the validation.
 */
export function buildRerunDirective(scope: TaskScope): string | null {
  const cmd = deriveRerunCommand(scope);
  if (!cmd) return null;

  const last = scope.verification.lastRuntimeFailure;
  const failed = last?.command ?? "a previous runtime command";
  const patched = [
    ...scope.verification.filesWritten.slice(-2),
    ...scope.verification.filesEdited.slice(-2),
  ]
    .map((p) => basename(p))
    .filter((x, i, a) => a.indexOf(x) === i)
    .slice(0, 3);

  const patchList = patched.length > 0 ? patched.join(", ") : "one or more files";

  return (
    `[SYSTEM] You patched ${patchList} after a runtime failure of \`${failed}\`. ` +
    `Your next action MUST be a Bash call that re-runs the validation:\n\n` +
    `    ${cmd}\n\n` +
    `Do NOT write new prose. Do NOT call Plan or Write. Do NOT close the turn with a summary. ` +
    `If the rerun succeeds, the turn can close with grounded results. ` +
    `If it fails again, address the NEW error — don't silently move on.\n\n` +
    `This is a mandatory recovery step: the previous turn applied a patch without verifying it.`
  );
}
