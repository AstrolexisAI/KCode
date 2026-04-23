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
      // A new mutation after a runtime failure marks "patch applied, needs rerun".
      if (_current.verification.lastRuntimeFailure) {
        _current.verification.patchAppliedAfterFailure = true;
        _current.verification.rerunPassedAfterPatch = false;
      }
      if (_current.phase === "planning") {
        _current.phase = "writing";
      }
      touch(_current);
    },

    recordRuntimeCommand(ev): void {
      if (_current === null) return;
      _current.verification.runtimeCommands.push(ev);
      if (ev.runtimeFailed) {
        _current.verification.lastRuntimeFailure = {
          command: ev.command,
          error: ev.output.slice(0, 400),
        };
        _current.phase = "failed";
        _current.completion.mayClaimReady = false;
        _current.completion.mustUsePartialLanguage = true;
        if (!_current.completion.reasons.includes("runtime failure")) {
          _current.completion.reasons.push("runtime failure");
        }
      } else if (_current.verification.patchAppliedAfterFailure) {
        // Successful rerun after a patch clears the "not rerun" flag.
        _current.verification.rerunPassedAfterPatch = true;
        _current.verification.patchAppliedAfterFailure = false;
        _current.verification.lastRuntimeFailure = undefined;
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
