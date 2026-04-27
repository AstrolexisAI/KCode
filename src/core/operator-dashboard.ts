// KCode - Operator Dashboard
//
// Operator-mind primitive (phase 5): proactive system invariant probe.
//
// Phases 1-4 are reactive — they fire when the model attempts a specific
// failing action. Phase 5 closes the loop by surfacing system state to
// the model BEFORE it acts. Right before each user turn is processed,
// a fast invariant probe runs and, if anything is wrong, prepends an
// `[OPERATOR]` heads-up message to the conversation. The model then
// has the system state in front of it and can suggest cleanup or pick
// a different approach without first running into the wall.
//
// Probes (all cheap, all silent when healthy):
//   1. inotify saturation — reuses checkInotifyState from phase 2.
//      Threshold: 75% (warns BEFORE phase 2's 85% hard refusal).
//   2. Orphaned long-running servers rooted in cwd — counts processes
//      in the cwd subtree (next-server / vite / nodemon / bun --watch).
//      If >1 per project, the model is told they exist with PIDs so
//      it can decide to reuse or kill.
//   3. Recent operator-mind retries — sums the burned attempts from
//      bash-spawn-history and file-edit-history that fired in the
//      last few turns.
//
// Findings are advisory. The model still has full freedom to act —
// the probe just makes invisible state visible.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { snapshotBashHistory } from "./bash-spawn-history.js";
import { checkInotifyState } from "./bash-spawn-preflight.js";
import { snapshotEditHistory } from "./file-edit-history.js";
import { log } from "./logger.js";

// ─── Findings model ────────────────────────────────────────────────

export type Severity = "info" | "warn" | "alert";

export interface Finding {
  severity: Severity;
  /** Stable code so tests can assert without matching prose. */
  code: string;
  /** One-sentence summary suitable for the operator banner. */
  message: string;
  /** Optional follow-up actions for the model. */
  hint?: string;
}

// ─── Probe: inotify saturation ─────────────────────────────────────

const INOTIFY_WARN_RATIO = 0.75;

export function probeInotifySaturation(): Finding | null {
  const state = checkInotifyState();
  if (!state) return null;
  if (state.ratio < INOTIFY_WARN_RATIO) return null;
  const pct = Math.round(state.ratio * 100);
  return {
    severity: state.ratio >= 0.9 ? "alert" : "warn",
    code: "INOTIFY_HIGH",
    message: `inotify usage is ${pct}% (${state.used}/${state.limit} instances)`,
    hint:
      "Spawning another watch-mode dev server here will likely EMFILE. " +
      "Run `pkill -9 -u $USER -f 'next-server|vite|bun --watch|nodemon'` to reclaim leaked watchers, " +
      "or raise the limit with `sudo sysctl -w fs.inotify.max_user_instances=1024`.",
  };
}

// ─── Probe: orphan dev servers rooted in cwd ───────────────────────

interface ProcessHit {
  pid: number;
  comm: string;
  cwd: string;
}

/** Best-effort: list processes whose cwd is inside `root`. */
function processesUnder(root: string): ProcessHit[] {
  const hits: ProcessHit[] = [];
  let entries: string[] = [];
  try {
    entries = require("node:fs").readdirSync("/proc");
  } catch {
    return hits;
  }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      const cwd = readlinkSync(`/proc/${ent}/cwd`);
      if (!cwd.startsWith(root)) continue;
      const comm = readFileSync(`/proc/${ent}/comm`, "utf-8").trim();
      hits.push({ pid: parseInt(ent, 10), comm, cwd });
    } catch {
      // Permission denied or process exited — skip
    }
  }
  return hits;
}

/** Process names that count as "long-running dev servers" for the probe. */
const DEV_SERVER_COMMS = new Set([
  "next-server",
  "vite",
  "nodemon",
  "uvicorn",
  "gunicorn",
  "node", // generic — many dev tools run as bare `node`, filtered by cwd match
  "bun", // bun --watch
  "rails",
]);

export function probeOrphanDevServers(cwd: string): Finding | null {
  if (!cwd || !existsSync(cwd)) return null;
  const all = processesUnder(cwd);
  const servers = all.filter((p) => DEV_SERVER_COMMS.has(p.comm));
  if (servers.length === 0) return null;

  // Group by comm so a single process per type isn't worth surfacing
  // (one dev server in a project is normal).
  const byComm = new Map<string, ProcessHit[]>();
  for (const s of servers) {
    const list = byComm.get(s.comm) ?? [];
    list.push(s);
    byComm.set(s.comm, list);
  }

  // Only flag when ANY one comm has >= 2 instances under cwd, OR when
  // total servers exceed 3 (mixed runtime types).
  const anyDup = Array.from(byComm.values()).some((l) => l.length >= 2);
  if (!anyDup && servers.length < 3) return null;

  const lines: string[] = [];
  for (const [comm, list] of byComm) {
    const pids = list.map((p) => p.pid).join(", ");
    lines.push(`${list.length}× ${comm} (PIDs: ${pids})`);
  }
  return {
    severity: anyDup ? "alert" : "warn",
    code: "ORPHAN_DEV_SERVERS",
    message: `${servers.length} dev-server process(es) already rooted in this cwd: ${lines.join("; ")}`,
    hint:
      "Reuse one of them OR kill the duplicates before spawning another. " +
      "Each leaked dev server holds inotify watchers and a TCP port.",
  };
}

// ─── Probe: recent operator-mind retries ───────────────────────────

const RECENT_RETRY_LOOKBACK = 12;

export function probeRecentRetries(): Finding | null {
  const bash = snapshotBashHistory();
  const edits = snapshotEditHistory();
  const recentBashErrors = bash.slice(-RECENT_RETRY_LOOKBACK).filter((e) => e.isError);
  const recentEditErrors = edits.slice(-RECENT_RETRY_LOOKBACK).filter((e) => e.isError);
  const total = recentBashErrors.length + recentEditErrors.length;
  if (total < 3) return null;
  const parts: string[] = [];
  if (recentBashErrors.length > 0) parts.push(`${recentBashErrors.length}× Bash`);
  if (recentEditErrors.length > 0) parts.push(`${recentEditErrors.length}× Edit/Write`);
  return {
    severity: total >= 5 ? "alert" : "warn",
    code: "RECENT_RETRIES",
    message: `${total} guarded tool failures in the last ${RECENT_RETRY_LOOKBACK} attempts (${parts.join(", ")})`,
    hint:
      "You are repeatedly hitting the same wall. Stop and read the failing files / inspect system state " +
      "before issuing more mutations.",
  };
}

// ─── High-level probe ──────────────────────────────────────────────

export interface OperatorProbeResult {
  findings: Finding[];
}

export function probeOperatorState(cwd: string): OperatorProbeResult {
  const findings: Finding[] = [];
  try {
    const f1 = probeInotifySaturation();
    if (f1) findings.push(f1);
  } catch (err) {
    log.debug("operator-dashboard", `inotify probe failed: ${err}`);
  }
  try {
    const f2 = probeOrphanDevServers(cwd);
    if (f2) findings.push(f2);
  } catch (err) {
    log.debug("operator-dashboard", `orphan probe failed: ${err}`);
  }
  try {
    const f3 = probeRecentRetries();
    if (f3) findings.push(f3);
  } catch (err) {
    log.debug("operator-dashboard", `recent retries probe failed: ${err}`);
  }
  return { findings };
}

// ─── Banner formatting ─────────────────────────────────────────────

const SEVERITY_ICON: Record<Severity, string> = {
  info: "ℹ",
  warn: "⚠",
  alert: "✗",
};

/**
 * Render findings as an `[OPERATOR]` banner suitable for prepending
 * to the user message before it goes to the LLM. Returns "" when
 * there are no findings (so the caller can short-circuit cleanly).
 */
export function formatOperatorBanner(findings: Finding[]): string {
  if (findings.length === 0) return "";
  const lines: string[] = [];
  lines.push("[OPERATOR] System state to consider before your next action:");
  for (const f of findings) {
    lines.push(`  ${SEVERITY_ICON[f.severity]} ${f.message}`);
    if (f.hint) lines.push(`    → ${f.hint}`);
  }
  return lines.join("\n");
}

// ─── Throttling ────────────────────────────────────────────────────
//
// Surface the same finding code at most once per N turns so we don't
// nag the model about the same issue every single message.

const REPEAT_COOLDOWN_TURNS = 4;
const _lastShownTurn = new Map<string, number>();
let _turnCounter = 0;

export function selectFindingsForTurn(findings: Finding[]): Finding[] {
  _turnCounter++;
  const out: Finding[] = [];
  for (const f of findings) {
    const last = _lastShownTurn.get(f.code);
    if (last !== undefined && _turnCounter - last < REPEAT_COOLDOWN_TURNS) continue;
    _lastShownTurn.set(f.code, _turnCounter);
    out.push(f);
  }
  return out;
}

/** Reset throttling state — for tests. */
export function clearOperatorDashboardState(): void {
  _lastShownTurn.clear();
  _turnCounter = 0;
}

// Avoid unused-parameter lints for spawnSync (re-exported for future probes).
void spawnSync;
