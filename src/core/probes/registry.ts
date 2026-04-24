// KCode - Probe Registry
//
// Central registration point for all verification probes. Post-turn
// iterates through the registry, runs the first applicable probe,
// and records the result in scope.verification.lastProbeResult.

import { log } from "../logger";
import type { TaskScope } from "../task-scope";
import { bitcoinRpcProbe } from "./bitcoin-rpc";
import type { ProbeResult, VerificationProbe } from "./types";

const _probes: VerificationProbe[] = [bitcoinRpcProbe];

/** Register an additional probe at runtime. Used by plugins. */
export function registerProbe(probe: VerificationProbe): void {
  if (_probes.some((p) => p.id === probe.id)) {
    log.warn("probe", `probe ${probe.id} already registered; replacing`);
    const idx = _probes.findIndex((p) => p.id === probe.id);
    if (idx >= 0) _probes[idx] = probe;
    return;
  }
  _probes.push(probe);
}

/** All registered probes (for tests / introspection). */
export function listProbes(): readonly VerificationProbe[] {
  return _probes;
}

/**
 * Find the first probe whose `applies(scope)` returns true. If no
 * probe applies, returns null. Callers should treat null as
 * "no verification capability for this task shape".
 */
export async function resolveApplicableProbe(
  scope: TaskScope,
): Promise<VerificationProbe | null> {
  for (const probe of _probes) {
    try {
      const applies = await probe.applies(scope);
      if (applies) return probe;
    } catch (err) {
      log.debug(
        "probe",
        `probe ${probe.id} applies() threw: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return null;
}

/**
 * Run the applicable probe (if any) and return the result. Safe:
 * never throws, always resolves to a ProbeResult or null. Call
 * from post-turn with a small timeout budget.
 */
export async function runApplicableProbe(
  scope: TaskScope,
): Promise<ProbeResult | null> {
  const probe = await resolveApplicableProbe(scope);
  if (!probe) return null;
  log.info("probe", `running ${probe.id}: ${probe.description}`);
  try {
    const result = await probe.run(scope);
    log.info(
      "probe",
      `${probe.id} → ${result.status}${result.status === "pass" ? ` (${result.evidence})` : result.status === "not_applicable" ? "" : ` (${result.error})`}`,
    );
    return result;
  } catch (err) {
    log.warn(
      "probe",
      `${probe.id} threw: ${err instanceof Error ? err.message : err}`,
    );
    return {
      status: "fail_runtime",
      error: err instanceof Error ? err.message : String(err),
      probeId: probe.id,
    };
  }
}
