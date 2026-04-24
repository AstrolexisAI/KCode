// KCode - Task Scope (single source of truth for task state)
//
// Replaces the fragmented truth model that produced the #100-#108
// failure cluster. Historically KCode had five separate mechanisms
// each trying to correct each other:
//
//   - session-tracker._auditIntent (global boolean)
//   - audit-guards.ts               (per-file block/allow)
//   - grounding-gate.ts              (post-hoc warnings)
//   - conversation-reality-check.ts  (same-turn correction)
//   - plan tool                      (separate progress tracking)
//
// Each was correct in isolation but produced contradictions when
// combined. This module introduces a single TaskScope record that
// all those layers can read from and write to, so at any point in
// time there's exactly one answer to questions like:
//
//   - "Is the agent in audit mode right now?"
//   - "What files were successfully written this task?"
//   - "Did runtime validation pass since the last patch?"
//   - "May the final summary claim 'ready / complete'?"
//
// Phase 1 (this commit): types + manager + transitions only. No
// behavior change — nothing reads from TaskScope yet. Phase 2
// (unified mutation policy) and beyond will replace the legacy
// feeds one at a time.

// ─── Types ──────────────────────────────────────────────────────

/**
 * The broad intent category of the current task. Derived once when
 * the scope is opened; changes only via a scope transition, never
 * silently mutated.
 */
export type TaskType =
  | "audit"       // read-only security/code review, produces AUDIT_REPORT.md
  | "analyze"     // general exploration / explain / inspect, no mutation expected
  | "scaffold"    // create a new project from scratch
  | "implement"   // add features to an existing project
  | "configure"   // tweak settings / config files, no code writing
  | "operate";    // run, deploy, debug an existing system

/**
 * Where we are in the task lifecycle. Certain phases preclude
 * strong completion claims — e.g. a scope in phase="failed" or
 * phase="partial" cannot close with "ready / complete" wording.
 */
export type TaskPhase =
  | "planning"    // scope opened, no tool calls yet
  | "writing"     // at least one mutation in flight
  | "verifying"   // runtime checks in progress
  | "blocked"     // a tool call was refused by policy; repair needed
  | "partial"     // tools succeeded but scope isn't met yet
  | "done"        // all verification passed
  | "failed";     // runtime/verification demonstrably failed

export interface MutationEvent {
  tool: string;           // "Write" | "Edit" | "MultiEdit" | "GrepReplace" | "Bash"
  path: string;           // absolute file path that was mutated
  at: number;             // Date.now() when the mutation was recorded
}

export interface RuntimeCommandEvent {
  command: string;        // the full bash command
  exitCode: number | null; // null if the process timed out or was killed
  output: string;         // stdout + stderr combined (truncated to 2KB)
  runtimeFailed: boolean; // true when output contains a traceback / error signature
                          // even if exitCode === 0 (see issue #106)
  /**
   * Fine-grained classification. Populated by tool-executor via
   * classifyRuntimeStatus(); defaults to inferring from runtimeFailed
   * when absent so legacy callers keep working. See runtime-classifier.ts.
   */
  status?:
    | "not_run"
    | "started"
    | "verified"
    | "started_unverified"
    | "alive_timeout"
    | "failed_auth"
    | "failed_connection"
    | "failed_traceback"
    | "failed_dependency"
    | "runner_misfire"
    | "failed_unknown";
  timestamp: number;
}

export interface SecretFinding {
  kind: string;   // "rpcpassword" | "api_key" | "jwt" | etc. (matches redactor rules)
  source: string; // where it was detected — path or "assistant-prose"
}

/**
 * Project root state for scaffold tasks. Distinguishes "never tried"
 * from "mkdir succeeded but not re-verified" from "verified to exist
 * on disk" from "failed to create / missing". Issue #108 + #109:
 * without this, the plan advanced past step 1 on an abstract mkdir
 * success while the directory didn't actually exist (cd → ENOENT).
 */
export type ProjectRootStatus = "unknown" | "created" | "verified" | "missing";

export interface ProjectRootState {
  path: string;
  status: ProjectRootStatus;
  lastError?: string;
  verifiedAt?: number;
}

/**
 * Self-contained snapshot of everything the task layers need. All
 * fields are initialized on beginNewScope(); mutations go through
 * `update()` which bumps `updatedAt`.
 */
export interface TaskScope {
  id: string;
  type: TaskType;
  phase: TaskPhase;
  /** The user prompt that originated this scope. */
  userPrompt: string;
  /** Whether the prompt contained broad-scope markers ("complete", "full", etc). */
  broadRequest: boolean;
  /** Absolute paths the task is working with (root dir, target files). */
  targetPaths: string[];

  // ── Audit sub-state ──
  audit: {
    enabled: boolean;
    /** Whether the current scope requires an AUDIT_REPORT.md before mutations. */
    reportRequired: boolean;
    reportPath?: string;
    /** File paths cited with file:line references in the report. */
    citedFiles: string[];
  };

  // ── Progress sub-state ──
  progress: {
    plannedSteps: string[];
    completedSteps: string[];
    currentStep?: string;
  };

  // ── Verification sub-state ──
  verification: {
    filesWritten: string[];
    filesEdited: string[];
    mutationsSucceeded: MutationEvent[];
    runtimeCommands: RuntimeCommandEvent[];
    lastRuntimeFailure?: { command: string; error: string };
    /** True when a successful runtime command ran AFTER the most recent patch. */
    rerunPassedAfterPatch: boolean;
    /** True when a patch was applied after a runtime failure (needs rerun). */
    patchAppliedAfterFailure: boolean;
    /**
     * Number of mandatory-rerun directives injected for the current
     * failure cluster. Capped in post-turn to prevent infinite loops
     * when the model refuses to call Bash. Reset to 0 when the
     * failure is cleared (new failure or successful rerun).
     */
    rerunAttempts: number;
    /**
     * Successful package-manager bash invocations — bun add / npm
     * install / pip install / cargo add / go get. Tool-executor
     * records each successful call. Used by plan reconciliation to
     * mark the "install dependencies" step as done without needing
     * a recorded filesystem mutation on package.json.
     * Issue #111 v285 repro: `bun add blessed bitcoin-core` ran
     * successfully but the plan step stayed incomplete.
     */
    packageManagerOps: string[];
    /**
     * Result of the most recent verification probe (v298). Separate
     * from runtimeCommands because probes are ACTIVE verification
     * (kcode reaches into the app) whereas runtimeCommands are
     * passive observation (kcode records what bash did).
     * Shape matches ProbeResult from core/probes/types.ts; using a
     * loose type here to avoid a circular import.
     */
    lastProbeResult?: {
      status: "pass" | "fail_auth" | "fail_connection" | "fail_runtime" | "not_applicable";
      probeId: string;
      evidence?: string;
      error?: string;
      tier?: 3 | 4;
    };
  };

  // ── Secrets sub-state ──
  secrets: {
    detected: SecretFinding[];
    /** When true, the visible-text renderer must redact all known secret patterns. */
    redactionRequired: boolean;
  };

  // ── Project root (scaffold tasks) ──
  projectRoot: ProjectRootState;

  // ── Completion flags (computed by grounding layers, read by closeout renderer) ──
  completion: {
    mayClaimReady: boolean;
    mayClaimImplemented: boolean;
    mustUsePartialLanguage: boolean;
    /** Reasons currently blocking strong-completion language, for display. */
    reasons: string[];
  };

  createdAt: number;
  updatedAt: number;
}

// ─── Manager ────────────────────────────────────────────────────

export interface TaskScopeManager {
  /** Current active scope. Null when no task is in progress. */
  current(): TaskScope | null;
  /** Close any prior scope and start a new one. Returns the new scope. */
  beginNewScope(opts: {
    type: TaskType;
    userPrompt: string;
    broadRequest?: boolean;
    targetPaths?: string[];
    audit?: Partial<TaskScope["audit"]>;
  }): TaskScope;
  /** Merge-patch the current scope. No-op when no scope is active. */
  update(patch: DeepPartial<TaskScope>): void;
  /** Record a successful mutation. Updates verification + phase. */
  recordMutation(ev: MutationEvent): void;
  /** Record a runtime command result. Updates verification + phase. */
  recordRuntimeCommand(ev: RuntimeCommandEvent): void;
  /** Record a detected secret (for redaction). */
  recordSecret(finding: SecretFinding): void;
  /** mkdir succeeded (directory CREATED but not yet verified to exist on disk). */
  recordDirectoryCreated(path: string): void;
  /** existsSync + isDirectory confirmed. Step 1 can only complete after this. */
  recordDirectoryVerified(path: string): void;
  /** cd / stat / similar returned ENOENT. Prior "created" optimism invalidated. */
  recordDirectoryMissing(path: string, reason: string): void;
  /** Close the current scope explicitly. */
  closeScope(reason: string): void;
  /** History of prior closed scopes (for debugging / telemetry). */
  history(): TaskScope[];
  /** Reset everything — intended only for tests. */
  reset(): void;
}

type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

// ─── Default scope builder ──────────────────────────────────────

function uuid(): string {
  // Cheap UUIDv4 without crypto import for this synchronous hot path.
  const hex = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function makeEmptyScope(opts: {
  type: TaskType;
  userPrompt: string;
  broadRequest?: boolean;
  targetPaths?: string[];
  audit?: Partial<TaskScope["audit"]>;
}): TaskScope {
  const now = Date.now();
  return {
    id: uuid(),
    type: opts.type,
    phase: "planning",
    userPrompt: opts.userPrompt,
    broadRequest: opts.broadRequest ?? false,
    targetPaths: opts.targetPaths ?? [],
    audit: {
      enabled: opts.type === "audit",
      reportRequired: opts.type === "audit",
      reportPath: undefined,
      citedFiles: [],
      ...opts.audit,
    },
    progress: {
      plannedSteps: [],
      completedSteps: [],
      currentStep: undefined,
    },
    verification: {
      filesWritten: [],
      filesEdited: [],
      mutationsSucceeded: [],
      runtimeCommands: [],
      lastRuntimeFailure: undefined,
      rerunPassedAfterPatch: false,
      patchAppliedAfterFailure: false,
      rerunAttempts: 0,
      packageManagerOps: [],
      lastProbeResult: undefined,
    },
    secrets: {
      detected: [],
      redactionRequired: true,
    },
    projectRoot: {
      path: "",
      status: "unknown",
    },
    completion: {
      mayClaimReady: true,
      mayClaimImplemented: true,
      mustUsePartialLanguage: false,
      reasons: [],
    },
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Deep merge helper ──────────────────────────────────────────

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}

function deepMerge<T>(target: T, patch: DeepPartial<T>): T {
  if (!isPlainObject(patch)) return target;
  const out = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    const pv = (patch as Record<string, unknown>)[key];
    const tv = out[key];
    if (isPlainObject(pv) && isPlainObject(tv)) {
      out[key] = deepMerge(tv, pv as DeepPartial<typeof tv>);
    } else if (pv !== undefined) {
      out[key] = pv;
    }
  }
  return out as T;
}

// ─── In-memory implementation ───────────────────────────────────

export function createTaskScopeManager(): TaskScopeManager {
  let _current: TaskScope | null = null;
  const _history: TaskScope[] = [];

  function touch(scope: TaskScope): void {
    scope.updatedAt = Date.now();
  }

  return {
    current(): TaskScope | null {
      return _current;
    },

    beginNewScope(opts): TaskScope {
      if (_current !== null) {
        _history.push(_current);
      }
      _current = makeEmptyScope(opts);
      return _current;
    },

    update(patch): void {
      if (_current === null) return;
      _current = deepMerge(_current, patch);
      touch(_current);
    },

    recordMutation(ev): void {
      if (_current === null) return;
      _current.verification.mutationsSucceeded.push(ev);
      // When the tool was Write, track the path as filesWritten; Edit → filesEdited.
      if (ev.tool === "Write") {
        if (!_current.verification.filesWritten.includes(ev.path)) {
          _current.verification.filesWritten.push(ev.path);
        }
      } else {
        if (!_current.verification.filesEdited.includes(ev.path)) {
          _current.verification.filesEdited.push(ev.path);
        }
      }
      // A new mutation after a runtime failure marks "patch applied,
      // needs rerun" — but only when the patched file is PLAUSIBLY
      // relevant to the failure. Relaxed in v277: a code file in the
      // same project is usually the fix location even when its name
      // doesn't appear in the failing command/traceback (e.g. the
      // error is in index.ts but the bad import lives in rpc.ts).
      // Docs/config files (README.md, .gitignore, *.md) still never
      // arm the gate.
      if (_current.verification.lastRuntimeFailure) {
        const failure = _current.verification.lastRuntimeFailure;
        const CMD_FILE_RE =
          /(?:^|[\s=])([./\w-]+\.(?:py|js|ts|tsx|jsx|mjs|cjs|rb|go|rs|java|sh|php|pl|lua))(?=[\s&|;<>]|$)/gi;
        const OUT_FILE_RE =
          /(?:File\s+"([^"]+)"|at\s+([\w./]+\.(?:py|js|ts|rb|go|rs))\b)/g;
        const relevant = new Set<string>();
        for (const m of failure.command.matchAll(CMD_FILE_RE)) {
          if (m[1]) {
            const parts = m[1].split("/");
            relevant.add(parts[parts.length - 1] ?? m[1]);
          }
        }
        for (const m of failure.error.matchAll(OUT_FILE_RE)) {
          const p = m[1] ?? m[2];
          if (p) {
            const parts = p.split("/");
            relevant.add(parts[parts.length - 1] ?? p);
          }
        }
        const evParts = ev.path.split("/");
        const evBase = evParts[evParts.length - 1] ?? ev.path;
        const DOC_OR_CONFIG =
          /^(?:README|CHANGELOG|LICENSE|CONTRIBUTING|TODO|\.gitignore|\.npmignore|\.dockerignore)(?:\.md|\.txt|\.rst)?$/i;
        const DOC_EXT = /\.(?:md|mdx|txt|rst|adoc|html)$/i;
        const CODE_EXT =
          /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|scala|swift|php|pl|lua|sh|bash|zsh|fish|c|cpp|cc|h|hpp|cs|fs|ex|exs|erl|clj|cljs|hs|ml|dart|r|nim|zig|v|vala|sql|json|yaml|yml|toml)$/i;

        const directHit = relevant.has(evBase);
        const isDoc = DOC_OR_CONFIG.test(evBase) || DOC_EXT.test(evBase);
        const isCode = CODE_EXT.test(evBase);
        // arm if relevant has no paths (nothing to narrow), OR direct
        // basename hit, OR the edit is to a code file (plausible fix).
        const relevantHit =
          relevant.size === 0 || directHit || (isCode && !isDoc);
        if (relevantHit) {
          _current.verification.patchAppliedAfterFailure = true;
          _current.verification.rerunPassedAfterPatch = false;
          // Explicit claim-gate (#111 v294 user feedback #3): while a
          // patch is pending rerun, no 'ready/complete' claims allowed.
          // Previously we relied on phase=failed (set when the runtime
          // failed) to keep mayClaimReady=false, but the claim-gate
          // should be independent of phase in case other transitions
          // clear phase back to something healthier.
          _current.completion.mayClaimReady = false;
          _current.completion.mayClaimImplemented = false;
          _current.completion.mustUsePartialLanguage = true;
          const reason = "patch applied after failure, awaiting successful rerun";
          if (!_current.completion.reasons.includes(reason)) {
            _current.completion.reasons.push(reason);
          }
        }
      }
      if (_current.phase === "planning") {
        _current.phase = "writing";
      }
      touch(_current);
    },

    recordRuntimeCommand(ev): void {
      if (_current === null) return;
      _current.verification.runtimeCommands.push(ev);

      // runner_misfire is a runner-level issue, not an app-level
      // failure. It doesn't set runtimeFailed (the app never ran),
      // but we STILL need to transition the scope to "partial" so
      // the closeout renders the runner-misfire next-step line
      // instead of a generic "verified" verdict. Handled before
      // the runtimeFailed branch to run regardless of that flag.
      // Issue #111 v276 repro.
      if (ev.status === "runner_misfire") {
        _current.phase = "partial";
        _current.completion.mayClaimReady = false;
        _current.completion.mustUsePartialLanguage = true;
        const reason =
          "verification runner chose the wrong execution mode (CLI/TUI project executed through a web-spawn path)";
        if (!_current.completion.reasons.includes(reason)) {
          _current.completion.reasons.push(reason);
        }
        touch(_current);
        return;
      }

      if (ev.runtimeFailed) {
        _current.verification.lastRuntimeFailure = {
          command: ev.command,
          error: ev.output.slice(0, 400),
        };
        // Status-driven transitions.
        //
        // failed_auth on a scaffold/implement scope means the code
        // artifact is fine but credentials need user configuration —
        // flip task type to "configure" and phase to "blocked".
        //
        // runner_misfire means KCode's verification runner refused
        // the spawn (wrong execution mode — CLI/TUI treated as web).
        // The app itself was never executed, so phase is "partial",
        // NOT "failed". Issue #111 v275.
        //
        // Everything else → phase "failed".
        if (
          ev.status === "failed_auth" &&
          (_current.type === "scaffold" || _current.type === "implement")
        ) {
          _current.type = "configure";
          _current.phase = "blocked";
          const reason = "RPC authentication failed — credentials required";
          if (!_current.completion.reasons.includes(reason)) {
            _current.completion.reasons.push(reason);
          }
        } else {
          _current.phase = "failed";
        }
        _current.completion.mayClaimReady = false;
        _current.completion.mustUsePartialLanguage = true;
        // A new failure resets the rerun counter — the old attempts
        // were for a different failure cluster.
        _current.verification.rerunAttempts = 0;
        const genericReason =
          ev.status && ev.status.startsWith("failed_")
            ? `runtime failure: ${ev.status}`
            : "runtime failure";
        if (!_current.completion.reasons.includes(genericReason)) {
          _current.completion.reasons.push(genericReason);
        }
      } else if (_current.verification.patchAppliedAfterFailure) {
        // Successful rerun after a patch clears the "not rerun" flag.
        // Only a true "verified" status clears; started_unverified /
        // alive_timeout / etc. don't prove the patch worked.
        if (ev.status === undefined || ev.status === "verified") {
          _current.verification.rerunPassedAfterPatch = true;
          _current.verification.patchAppliedAfterFailure = false;
          _current.verification.lastRuntimeFailure = undefined;
          _current.verification.rerunAttempts = 0;
          // Also lift phase out of "failed" — the verified rerun
          // proves the patch worked. Move to "verifying" (the task
          // is running and passed a check; subsequent state will
          // promote it to "done" or similar). Claims stay cautious
          // until any later grounding gate confirms readiness.
          // Issue #111 v290: phase stayed locked at "failed" after
          // a successful post-patch rerun, so the closeout reported
          // 'Runtime: verified (3 commands)' alongside 'Status: failed'
          // — a self-contradiction.
          if (_current.phase === "failed") {
            _current.phase = "verifying";
            // Drop the stale 'runtime failure: ...' reason because
            // the patch was rerun and verified. Keep any other
            // reasons (grounding gates may have added their own).
            _current.completion.reasons = _current.completion.reasons.filter(
              (r) => !r.startsWith("runtime failure"),
            );
          }
        }
      }

      // Non-verified runtime → downgrade to partial. A TUI that started
      // and was killed by timeout, or a process that exited 0 after
      // printing an application error, is NOT end-to-end verified.
      // Without this downgrade the scope stays phase=writing,
      // mayClaimReady=true, and the model's "Proyecto creado. Para
      // ejecutar: ..." prose slips through. Issue #111 v281 repro.
      //
      // Skips if phase is already failed/blocked (those are stronger
      // signals) or if the status is explicitly verified.
      if (
        _current.phase !== "failed" &&
        _current.phase !== "blocked" &&
        ev.status !== undefined &&
        ev.status !== "verified" &&
        (ev.status === "alive_timeout" || ev.status === "started_unverified")
      ) {
        _current.phase = "partial";
        _current.completion.mayClaimReady = false;
        _current.completion.mustUsePartialLanguage = true;
        const reason =
          ev.status === "alive_timeout"
            ? "runtime started and stayed alive under timeout — end-to-end behavior not verified"
            : "runtime exited cleanly but printed an application error — end-to-end behavior not verified";
        if (!_current.completion.reasons.includes(reason)) {
          _current.completion.reasons.push(reason);
        }
      }
      touch(_current);
    },

    recordSecret(finding): void {
      if (_current === null) return;
      // Deduplicate by kind+source
      const exists = _current.secrets.detected.some(
        (s) => s.kind === finding.kind && s.source === finding.source,
      );
      if (!exists) _current.secrets.detected.push(finding);
      _current.secrets.redactionRequired = true;
      touch(_current);
    },

    recordDirectoryCreated(path): void {
      if (_current === null) return;
      // Don't downgrade "verified" to "created" if we already verified.
      if (_current.projectRoot.status === "verified" && _current.projectRoot.path === path) return;
      _current.projectRoot = {
        path,
        status: "created",
        lastError: undefined,
      };
      touch(_current);
    },

    recordDirectoryVerified(path): void {
      if (_current === null) return;
      _current.projectRoot = {
        path,
        status: "verified",
        lastError: undefined,
        verifiedAt: Date.now(),
      };
      touch(_current);
    },

    recordDirectoryMissing(path, reason): void {
      if (_current === null) return;
      _current.projectRoot = {
        path,
        status: "missing",
        lastError: reason,
      };
      // A missing root invalidates any ready/implemented claim and
      // flags the turn as partial until the root is re-established.
      _current.completion.mayClaimReady = false;
      _current.completion.mustUsePartialLanguage = true;
      if (!_current.completion.reasons.includes(`project root missing: ${path}`)) {
        _current.completion.reasons.push(`project root missing: ${path}`);
      }
      touch(_current);
    },

    closeScope(reason: string): void {
      if (_current === null) return;
      _current.completion.reasons.push(`scope closed: ${reason}`);
      _history.push(_current);
      _current = null;
    },

    history(): TaskScope[] {
      return [..._history];
    },

    reset(): void {
      _current = null;
      _history.length = 0;
    },
  };
}

// ─── Singleton ──────────────────────────────────────────────────
//
// One shared manager per process. `reset()` is exposed only for
// tests — production code should never call it.

let _singleton: TaskScopeManager | null = null;

export function getTaskScopeManager(): TaskScopeManager {
  if (_singleton === null) {
    _singleton = createTaskScopeManager();
  }
  return _singleton;
}

// ─── Intent classifier (phase 1 — used on next user prompt) ─────
//
// Mapping from a user-typed message to the TaskType that should
// open a new scope. Intentionally wide: if we can't tell, default
// to "implement" (safer than "audit" which triggers stricter
// guards).

// Word-boundary macro: `\b` breaks on accented chars (á, é, í, ó, ú)
// in JS regex. Use `(?<![\w])` / `(?![\w])` instead so Spanish accented
// tokens like "auditá", "corré", "explicá" match correctly.
// NB: these are broad-ish by design — a spurious match here only opens
// a new scope, it doesn't destroy state.
const B = "(?<![\\w])"; // left boundary (non-word to the left)
const E = "(?![\\w])";  // right boundary (non-word to the right)

const INTENT_PATTERNS: Array<{ type: TaskType; patterns: RegExp[] }> = [
  {
    type: "audit",
    patterns: [
      new RegExp(
        `${B}(?:audit[ae]?|audit[aá][rs]?|auditor[ií]?a|vulnerabilit[iy]|security\\s+review|pentest)${E}`,
        "i",
      ),
      new RegExp(`${B}revis[aá][rs]?\\s+(?:el|la|este|esta|todo|toda)`, "i"),
    ],
  },
  {
    type: "scaffold",
    patterns: [
      new RegExp(
        `${B}(?:cre[aá]r?|construir|armar|generar)\\s+un\\s+(?:proyecto|app|aplicaci[oó]n)\\s+nuevo`,
        "i",
      ),
      /\bnuevo\s+proyecto\b|\bnew\s+project\b|\bfrom\s+scratch\b|desde\s+cero/i,
      new RegExp(`${B}quiero\\s+un\\s+(?:dashboard|app|proyecto|sistema)`, "i"),
      /\bscaffold\b/i,
    ],
  },
  {
    type: "operate",
    patterns: [
      new RegExp(
        `${B}(?:ejecut[aá][rs]?|corr[eé][rs]?|deploya[rs]?|despleg[aá][rs]?)${E}`,
        "i",
      ),
      /\brun\s+the\b|\bstart\s+the\b|\bdebug\s+the\b/i,
      /\b(?:diagnostic|troubleshoot)\b/i,
    ],
  },
  {
    type: "analyze",
    patterns: [
      new RegExp(`${B}(?:analiz[aá][rs]?|explic[aá][rs]?|entender)${E}`, "i"),
      /\b(?:analyze|explain|understand)\b/i,
      new RegExp(`${B}por\\s+qu[eé]${E}`, "i"),
      /\bwhy\b/i,
    ],
  },
  {
    type: "configure",
    patterns: [
      new RegExp(`${B}(?:configur[aá][rs]?|setear?|ajust[aá][rs]?)${E}`, "i"),
      /\b(?:setup|settings?)\b/i,
    ],
  },
  {
    type: "implement",
    patterns: [
      new RegExp(
        `${B}(?:implement[aá][rs]?|agreg[aá][rs]?|a[nñ]ad[ií][rs]?)${E}`,
        "i",
      ),
      /\b(?:implement|add\s+feature)\b/i,
    ],
  },
];

export function classifyIntent(userPrompt: string): TaskType {
  for (const { type, patterns } of INTENT_PATTERNS) {
    if (patterns.some((p) => p.test(userPrompt))) return type;
  }
  return "implement";
}

/**
 * True when the user's prompt requires a fresh scope, because the
 * intent differs from the current scope's type. The caller is
 * responsible for actually calling beginNewScope() on this signal.
 */
export function shouldOpenNewScope(
  current: TaskScope | null,
  nextIntent: TaskType,
): boolean {
  if (current === null) return true;
  return current.type !== nextIntent;
}
