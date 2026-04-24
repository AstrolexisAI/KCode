// KCode - Verification Probe Registry (v298, Phase 2 of #111 roadmap)
//
// Active verification layer. The runtime classifier observes exit
// codes + stdout patterns; the probe layer goes further and actually
// EXERCISES the thing the user's code claims to do. If the project
// is a Bitcoin RPC dashboard, the probe opens a JSON-RPC connection
// and calls getblockcount. If the endpoint responds with a block
// number, evidence tier jumps from 2 (process spawned) to 3 (RPC
// verified).
//
// Design:
//   - Each probe declares `applies(scope, files)` and `run(scope)`.
//   - Probes are pure (no side effects beyond the probe itself).
//   - Results feed scope.verification.lastProbeResult and lift the
//     evidenceTier accordingly.
//   - Registry is resolved on every post-turn; the first applicable
//     probe runs once per turn.

import type { TaskScope } from "../task-scope";

export type ProbeResult =
  | { status: "pass"; evidence: string; tier: 3 | 4; probeId: string }
  | { status: "fail_auth"; error: string; probeId: string }
  | { status: "fail_connection"; error: string; probeId: string }
  | { status: "fail_runtime"; error: string; probeId: string }
  | { status: "not_applicable"; probeId: string };

export interface VerificationProbe {
  /** Stable identifier for logging / scope records. */
  id: string;
  /** Human-readable description shown in closeout. */
  description: string;
  /**
   * Decide whether this probe should run for the current scope state.
   * Should be cheap — avoids filesystem reads beyond glancing at
   * scope.verification.filesWritten/Edited.
   */
  applies(scope: TaskScope): Promise<boolean> | boolean;
  /** Execute the probe. Must return within ~8s. */
  run(scope: TaskScope): Promise<ProbeResult>;
}

/**
 * Evidence tiers (v298): everything the system knows about the task's
 * operational state collapses to one of these levels. Each tier
 * corresponds to a class of claim the closeout renderer can make.
 *
 *   0 = no artifacts produced this turn
 *   1 = artifacts on disk (files written / edited)
 *   2 = process spawned (PID alive within wrapper window)
 *   3 = functional probe passed (RPC reachable, endpoint 200, etc.)
 *   4 = outcome-specific assertion passed (feature works end-to-end)
 *
 * Closeout language rules:
 *   tier < 1 → no 'implemented' claims
 *   tier < 2 → no 'running' claims
 *   tier < 3 → no 'verified' / 'works' / 'ready' claims
 *   tier === 4 → free-form summary allowed
 */
export type EvidenceTier = 0 | 1 | 2 | 3 | 4;

export function tierAllowsClaim(
  tier: EvidenceTier,
  claim: "implemented" | "running" | "verified" | "ready" | "works" | "complete",
): boolean {
  switch (claim) {
    case "implemented":
      return tier >= 1;
    case "running":
      return tier >= 2;
    case "verified":
    case "works":
    case "ready":
      return tier >= 3;
    case "complete":
      return tier >= 4;
  }
}

/**
 * Compute the current evidence tier from scope state. Called in
 * post-turn after all events have been recorded for the turn.
 */
export function computeEvidenceTier(scope: TaskScope): EvidenceTier {
  const v = scope.verification;
  const last = v.runtimeCommands[v.runtimeCommands.length - 1];
  const lastProbe = (v as { lastProbeResult?: ProbeResult }).lastProbeResult;

  // Tier 4: outcome-specific assertion. Reserved for future project-
  // specific probes that verify the feature the user asked for.
  // Currently no tier-4 probes exist, but the branch is here for
  // the registry extension story.
  if (lastProbe?.status === "pass" && lastProbe.tier === 4) return 4;

  // Tier 3: functional probe passed.
  if (lastProbe?.status === "pass" && lastProbe.tier === 3) return 3;

  // Tier 2: process spawned and verified alive.
  if (last?.status === "verified") return 2;
  if (last?.status === "started_unverified" || last?.status === "alive_timeout") return 2;

  // Tier 1: artifacts on disk.
  const hasArtifacts =
    v.filesWritten.length + v.filesEdited.length > 0 ||
    scope.projectRoot.status === "verified" ||
    scope.projectRoot.status === "created";
  if (hasArtifacts) return 1;

  return 0;
}
