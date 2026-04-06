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
import type { AuditResult, Candidate, Finding, Verification } from "./types";
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
  const { files, candidates: rawCandidates } = scanProject(opts.projectRoot, {
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

  // Filter to confirmed findings
  const findings: Finding[] = [];
  for (const r of verified) {
    if (r.verification.verdict === "confirmed") {
      const pattern = await import("./patterns").then((m) =>
        m.getPatternById(r.candidate.pattern_id),
      );
      const key = `${r.candidate.pattern_id}|${r.candidate.file}`;
      const count = multiples.get(key);
      // Note: if this pattern+file has multiple matches, mention that.
      const extraReasoning = count
        ? `${r.verification.reasoning} (+${count - 1} more matches of this pattern in the same file)`
        : r.verification.reasoning;
      findings.push({
        pattern_id: r.candidate.pattern_id,
        pattern_title: pattern?.title ?? r.candidate.pattern_id,
        severity: r.candidate.severity,
        file: r.candidate.file,
        line: r.candidate.line,
        matched_text: r.candidate.matched_text,
        context: r.candidate.context,
        verification: { ...r.verification, reasoning: extraReasoning },
        cwe: pattern?.cwe,
      });
    } else if (r.verification.verdict === "false_positive") {
      falsePositives += 1;
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
    elapsed_ms: Date.now() - startTime,
  };

  return result;
}
