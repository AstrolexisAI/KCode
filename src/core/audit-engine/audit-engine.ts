// KCode - Audit Engine Orchestrator
//
// Pipeline: scan → verify → report.
// Each phase is independent and testable. The orchestrator wires them
// together and handles progress reporting for the CLI.

import {
  dedupByPatternAndFile,
  detectLanguages,
  initSubmodulesAsync,
  needsSubmoduleInit,
  scanProject,
} from "./scanner";
import type {
  AuditResult,
  Candidate,
  FalsePositiveDetail,
  Finding,
  NeedsContextDetail,
  Verification,
} from "./types";
import { verifyAllCandidates, type VerifyOptions } from "./verifier";

export interface AuditEngineOptions {
  /** Project root to audit */
  projectRoot: string;
  /** Primary LLM verification callback (typically local model) */
  llmCallback: (prompt: string) => Promise<string>;
  /** Optional cloud-model fallback for ambiguous candidates */
  fallbackCallback?: (prompt: string) => Promise<string>;
  /** Max files to scan (default 500) */
  maxFiles?: number;
  /** Skip verification phase (return candidates as findings without model check) */
  skipVerification?: boolean;
  /** Progress reporting */
  onPhase?: (phase: "discovery" | "scanning" | "verifying" | "reporting", detail?: string) => void;
  onCandidate?: (candidate: Candidate, verification: Verification, index: number, total: number) => void;
}

/**
 * Run the full audit pipeline and produce a structured result.
 */
export async function runAudit(opts: AuditEngineOptions): Promise<AuditResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().split("T")[0]!;

  // Phase 0: Init submodules if needed (async so progress bar stays alive)
  if (needsSubmoduleInit(opts.projectRoot)) {
    opts.onPhase?.("initializing submodules", "downloading (this may take a minute)...");
    await initSubmodulesAsync(opts.projectRoot);
    opts.onPhase?.("discovery", "Submodules ready");
  } else {
    opts.onPhase?.("discovery");
  }

  // Phase 1: Discovery + scanning
  const {
    files,
    candidates: rawCandidates,
    coverage: scanCoverage,
  } = scanProject(opts.projectRoot, {
    maxFiles: opts.maxFiles,
  });
  const languages = detectLanguages(files);

  // Dedupe: one verification per (pattern, file) pair. When a file has N
  // matches of the same pattern, verify the first; the finding represents
  // all of them with a count.
  const { dedup: candidates, multiples } = dedupByPatternAndFile(rawCandidates);
  opts.onPhase?.(
    "scanning",
    `Found ${rawCandidates.length} raw matches → ${candidates.length} unique (pattern,file) pairs across ${files.length} files`,
  );

  // Phase 2: Verification (optional)
  let verified: Array<{ candidate: Candidate; verification: Verification }>;
  let falsePositives = 0;

  if (opts.skipVerification) {
    // Return all candidates as "confirmed" without model check (used for testing)
    verified = candidates.map((c) => ({
      candidate: c,
      verification: {
        verdict: "confirmed" as const,
        reasoning: "Verification skipped — static-only mode",
      },
    }));
  } else {
    const verifyHint = opts.fallbackCallback
      ? `${candidates.length} candidates (primary + fallback on ambiguity)`
      : `${candidates.length} candidates`;
    opts.onPhase?.("verifying", verifyHint);
    const verifyOpts: VerifyOptions = {
      llmCallback: opts.llmCallback,
      fallbackCallback: opts.fallbackCallback,
      // Fire live progress on each verified candidate so the UI can
      // update its progress bar in real time.
      onVerified: opts.onCandidate
        ? (cand, ver, i, total) => {
            opts.onCandidate?.(cand, ver, i, total);
          }
        : undefined,
    };
    verified = await verifyAllCandidates(candidates, verifyOpts);
  }

  // Filter to confirmed findings AND keep rejected candidates as
  // structured false-positive detail so the report is auditable.
  // Prior behavior persisted a bare counter, which made it impossible
  // to tell whether the verifier's rejections were sensible.
  const findings: Finding[] = [];
  const falsePositivesDetail: FalsePositiveDetail[] = [];
  const needsContextDetail: NeedsContextDetail[] = [];
  // v2.10.331 audit fix: hoist per-candidate imports out of the loop.
  // Previously did `await import("./patterns")` and `await import("./fixer")`
  // inside every iteration; with N candidates that's 2*N module-cache
  // lookups for no reason. Now resolved once.
  const { getPatternById } = await import("./patterns");
  const { fixSupportFor } = await import("./fixer");
  for (const r of verified) {
    const pattern = getPatternById(r.candidate.pattern_id);
    const key = `${r.candidate.pattern_id}|${r.candidate.file}`;
    const count = multiples.get(key);
    const extraReasoning = count
      ? `${r.verification.reasoning} (+${count - 1} more matches of this pattern in the same file)`
      : r.verification.reasoning;
    const base = {
      pattern_id: r.candidate.pattern_id,
      pattern_title: pattern?.title ?? r.candidate.pattern_id,
      severity: r.candidate.severity,
      file: r.candidate.file,
      line: r.candidate.line,
      matched_text: r.candidate.matched_text,
      context: r.candidate.context,
      verification: { ...r.verification, reasoning: extraReasoning },
      cwe: pattern?.cwe,
      fix_support: fixSupportFor(r.candidate.pattern_id),
    };
    if (r.verification.verdict === "confirmed") {
      findings.push(base);
    } else if (r.verification.verdict === "false_positive") {
      falsePositives += 1;
      falsePositivesDetail.push(base);
    } else {
      needsContextDetail.push(base);
    }
  }

  // Build fix_support_summary for the confirmed bucket so the report
  // and /fix output can announce up front: "8 confirmed (3 rewrite, 2
  // annotate, 3 manual)". v2.10.328.
  const fixSupportSummary = { rewrite: 0, annotate: 0, manual: 0 };
  for (const f of findings) {
    const tier = (f as { fix_support?: "rewrite" | "annotate" | "manual" }).fix_support;
    if (tier === "rewrite") fixSupportSummary.rewrite++;
    else if (tier === "annotate") fixSupportSummary.annotate++;
    else fixSupportSummary.manual++;
  }

  // v2.10.330 (Sprint 5/6) — per-pattern metrics. Counts hits,
  // confirmed, false_positive, needs_context for every pattern that
  // produced ≥1 candidate during this run. Compute confirmed_rate
  // and false_positive_rate when hits > 0. Aggregated across many
  // runs, these are the inputs to a pattern-quality dashboard
  // ("which patterns fire heavily but rarely confirm? which never
  // fire at all?"). For a single run, the report can show the top-N
  // hit patterns so the user knows where the noise / value came from.
  // v2.10.331 audit fix: track unique_sites (verifier-call count)
  // separately from hits (total raw matches). Rates use unique_sites
  // as denominator so they stay coherent with the verdict counts —
  // confirmed/false_positive/needs_context all count per-site.
  const patternMetrics: Record<
    string,
    {
      hits: number;
      unique_sites: number;
      confirmed: number;
      false_positive: number;
      needs_context: number;
      confirmed_rate?: number;
      false_positive_rate?: number;
    }
  > = {};
  for (const r of verified) {
    const pid = r.candidate.pattern_id;
    const m = patternMetrics[pid] ??= {
      hits: 0,
      unique_sites: 0,
      confirmed: 0,
      false_positive: 0,
      needs_context: 0,
    };
    m.unique_sites++;
    m.hits++; // first match in the (pattern, file) is +1
    if (r.verification.verdict === "confirmed") m.confirmed++;
    else if (r.verification.verdict === "false_positive") m.false_positive++;
    else m.needs_context++;
  }
  // Add raw-candidate counts (pre-dedupe) so `hits` reflects total
  // regex matches across the run, not just the deduped verifier-call
  // count. multiples is keyed by `${pattern_id}|${file}` and stores
  // the total matches in that file (≥2). Each entry contributes
  // (count - 1) extra hits beyond the one already counted above.
  for (const [key, count] of multiples) {
    const pid = key.split("|", 1)[0]!;
    const m = patternMetrics[pid];
    if (m) m.hits += count - 1;
  }
  // Compute rates against unique_sites (verifier denominator).
  for (const m of Object.values(patternMetrics)) {
    if (m.unique_sites > 0) {
      m.confirmed_rate = m.confirmed / m.unique_sites;
      m.false_positive_rate = m.false_positive / m.unique_sites;
    }
  }

  opts.onPhase?.("reporting");

  const result: AuditResult = {
    project: opts.projectRoot,
    timestamp,
    languages_detected: languages,
    files_scanned: files.length,
    candidates_found: candidates.length,
    confirmed_findings: findings.length,
    false_positives: falsePositives,
    findings,
    false_positives_detail: falsePositivesDetail,
    needs_context: needsContextDetail.length,
    needs_context_detail: needsContextDetail,
    coverage: scanCoverage,
    fix_support_summary: fixSupportSummary,
    pattern_metrics: patternMetrics,
    elapsed_ms: Date.now() - startTime,
  };

  return result;
}
