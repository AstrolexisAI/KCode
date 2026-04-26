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
  /**
   * Diff-based audit: when set, only scan source files that git
   * reports as changed since this ref (e.g. "main", "HEAD~10",
   * "origin/main"). Drops the wallclock 10x+ on big repos and turns
   * /scan into a CI pre-merge gate. v2.10.335.
   */
  since?: string;
  /**
   * Progress reporting. The phase set is the union of stages the
   * runAudit pipeline can be in:
   *   initializing — fetching git submodules before any scan work
   *   discovery    — enumerating in-scope files
   *   scanning     — running regex + AST patterns over the file set
   *   verifying    — sending each candidate to the LLM verifier
   *   reporting    — composing the markdown / JSON / SARIF outputs
   * v2.10.351 P0 — was missing "initializing" so the submodule
   * preflight phase sent a phase id that didn't satisfy the type.
   */
  onPhase?: (
    phase: "initializing" | "discovery" | "scanning" | "verifying" | "reporting",
    detail?: string,
  ) => void;
  onCandidate?: (candidate: Candidate, verification: Verification, index: number, total: number) => void;
}

/**
 * Resolve the list of files git reports as changed since `ref` vs
 * the working tree (HEAD + uncommitted). Returns absolute paths. If
 * git fails or the ref is invalid, throws — the caller decides
 * whether to abort the run or fall back to a full scan.
 *
 * v2.10.335: introduced for the --since diff-based audit mode.
 */
export async function listChangedFilesSinceRef(
  projectRoot: string,
  ref: string,
): Promise<string[]> {
  const { execFileSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  // v2.10.351 P0 — switched from execSync (shell) to execFileSync
  // (argv array). The previous implementation interpolated ref via
  // JSON.stringify — shell-quote was correct in practice but the
  // ergonomic was fragile: any future refactor that drops the
  // quoting reintroduces a shell-injection sink. Argv-style
  // invocation eliminates the shell parser entirely; ref is now a
  // pure positional argument that git treats as text regardless of
  // its content.
  const runGit = (args: string[], timeout: number): string => {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    });
  };
  // Validate the ref upfront so a typo gets a clear error instead of
  // silently scanning the whole project (the chained diffs below
  // would otherwise swallow non-zero exits from the diff against
  // an invalid ref).
  try {
    runGit(["rev-parse", "--verify", `${ref}^{commit}`], 10_000);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `git rev-parse failed for ref "${ref}": ${(e.stderr ?? e.message ?? "").toString().trim().slice(0, 200)}`,
    );
  }
  // `<ref>...HEAD` is the symmetric range used by GitHub PRs:
  // "files changed in HEAD that are NOT in <ref>". Combined with
  // separate diffs against the unstaged and staged working-tree
  // so a developer can audit work in progress.
  //
  // Three separate git invocations instead of one shell-chained
  // command — each gives us a real exit code, and any failure
  // surfaces with its own error rather than being masked by the
  // success of a later step.
  const parts: string[] = [];
  parts.push(runGit(["diff", "--name-only", `${ref}...HEAD`], 30_000));
  parts.push(runGit(["diff", "--name-only", "HEAD"], 15_000));
  parts.push(runGit(["diff", "--name-only", "--cached"], 15_000));
  const out = parts.join("\n");
  const seen = new Set<string>();
  for (const line of out.split("\n")) {
    const rel = line.trim();
    if (!rel) continue;
    seen.add(resolve(projectRoot, rel));
  }
  return [...seen];
}

/**
 * Run the full audit pipeline and produce a structured result.
 */
export async function runAudit(opts: AuditEngineOptions): Promise<AuditResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().split("T")[0]!;

  // Phase 0: Init submodules if needed (async so progress bar stays alive)
  if (needsSubmoduleInit(opts.projectRoot)) {
    opts.onPhase?.("initializing", "submodules: downloading (this may take a minute)...");
    await initSubmodulesAsync(opts.projectRoot);
    opts.onPhase?.("discovery", "Submodules ready");
  } else {
    opts.onPhase?.("discovery");
  }

  // Phase 1: Discovery + scanning.
  //
  // When `opts.since` is set we run scanProject as usual to get the
  // full file universe, then narrow to the intersection with the git
  // diff. The narrowing happens AFTER scanProject so the report's
  // coverage shape stays internally consistent (totalCandidateFiles
  // = full project, scannedFiles = the diff-filtered subset).
  let scanResult = scanProject(opts.projectRoot, {
    maxFiles: opts.maxFiles,
  });
  let changedFilesInDiff: number | undefined;
  if (opts.since) {
    opts.onPhase?.("discovery", `diff filter: ${opts.since}...HEAD`);
    try {
      const changed = await listChangedFilesSinceRef(opts.projectRoot, opts.since);
      changedFilesInDiff = changed.length;
      const changedSet = new Set(changed);
      const filteredFiles = scanResult.files.filter((f) => changedSet.has(f));
      const filteredCandidates = scanResult.candidates.filter((c) =>
        changedSet.has(c.file),
      );
      scanResult = {
        files: filteredFiles,
        candidates: filteredCandidates,
        coverage: {
          ...scanResult.coverage,
          scannedFiles: filteredFiles.length,
          skippedByLimit: scanResult.coverage.totalCandidateFiles - filteredFiles.length,
          // Truncated stays driven by the cap; the diff filter is
          // expressed via `since` / `changedFilesInDiff` instead so
          // callers don't conflate "ran out of budget" with "deliberately
          // narrow".
        },
      };
    } catch (err) {
      throw new Error(
        `--since ${opts.since} failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Make sure the ref exists in this repo (try git rev-parse ${opts.since}) and that the project root is a git checkout.`,
      );
    }
  }
  const { files, coverage: scanCoverage } = scanResult;
  let { candidates: rawCandidates } = scanResult;
  const languages = detectLanguages(files);

  // Phase 1b: AST-based patterns (v2.10.336). Lazy-loads
  // web-tree-sitter; absent dep / grammar → silent no-op so existing
  // regex pipeline is unaffected. AST candidates merge into the same
  // pool that goes through dedupe + verification.
  // v2.10.339: aggregate per-language grammar status so the report can
  // surface a `kcode grammars install` hint when AST coverage is
  // degraded for a language.
  const astLangAgg = new Map<
    string,
    { patterns_attempted: number; loaded: boolean; last_error?: string }
  >();
  try {
    const { runAstPatterns } = await import("./ast/runner");
    const { PYTHON_AST_PATTERNS } = await import("./ast/python-patterns");
    const { JAVASCRIPT_AST_PATTERNS } = await import("./ast/javascript-patterns");
    const { GO_AST_PATTERNS } = await import("./ast/go-patterns");
    const { TYPESCRIPT_AST_PATTERNS } = await import("./ast/typescript-patterns");
    const { JAVA_AST_PATTERNS } = await import("./ast/java-patterns");
    const { C_CPP_AST_PATTERNS } = await import("./ast/c-cpp-patterns");
    const { RUST_AST_PATTERNS } = await import("./ast/rust-patterns");
    const { RUBY_AST_PATTERNS } = await import("./ast/ruby-patterns");
    const { PHP_AST_PATTERNS } = await import("./ast/php-patterns");
    const allAstPatterns = [
      ...PYTHON_AST_PATTERNS,
      ...JAVASCRIPT_AST_PATTERNS,
      ...TYPESCRIPT_AST_PATTERNS,
      ...GO_AST_PATTERNS,
      ...JAVA_AST_PATTERNS,
      ...C_CPP_AST_PATTERNS,
      ...RUST_AST_PATTERNS,
      ...RUBY_AST_PATTERNS,
      ...PHP_AST_PATTERNS,
    ];
    if (allAstPatterns.length > 0 && files.length > 0) {
      const { readFileSync } = await import("node:fs");
      let astTotal = 0;
      for (const file of files) {
        let content: string;
        try {
          content = readFileSync(file, "utf-8");
        } catch {
          continue;
        }
        if (content.length > 500_000) continue;
        const { candidates: astCandidates, stats: astStats } = await runAstPatterns(
          allAstPatterns,
          file,
          content,
        );
        if (astCandidates.length > 0) {
          rawCandidates = rawCandidates.concat(astCandidates);
          astTotal += astCandidates.length;
        }
        for (const s of astStats) {
          const lang = s.language ?? "unknown";
          const cur = astLangAgg.get(lang) ?? { patterns_attempted: 0, loaded: false };
          cur.patterns_attempted += 1;
          if (s.grammar_loaded) cur.loaded = true;
          else if (s.load_error) cur.last_error = s.load_error;
          astLangAgg.set(lang, cur);
        }
      }
      if (astTotal > 0) {
        opts.onPhase?.("scanning", `AST patterns contributed ${astTotal} candidates`);
      }
    }
  } catch (err) {
    // AST module entirely failed to load — that's fine, regex
    // patterns above already produced their candidates.
    void err;
  }

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
    coverage: {
      ...scanCoverage,
      ...(opts.since ? { since: opts.since } : {}),
      ...(changedFilesInDiff !== undefined ? { changedFilesInDiff } : {}),
    },
    fix_support_summary: fixSupportSummary,
    pattern_metrics: patternMetrics,
    // v2.10.351 P1 — surface whether the LLM verifier ran. Used by
    // the Audit Confidence header to warn the reader when --skip-verify
    // produced a static-only output (false-positive rate is the
    // regex's precision, not the verifier's).
    verification_mode: opts.skipVerification ? "skipped" as const : "verified" as const,
    ...(astLangAgg.size > 0
      ? {
          ast_grammar_status: Array.from(astLangAgg.entries())
            .map(([language, v]) => ({
              language,
              patterns_attempted: v.patterns_attempted,
              loaded: v.loaded,
              ...(v.loaded ? {} : v.last_error ? { last_error: v.last_error } : {}),
            }))
            .sort((a, b) => a.language.localeCompare(b.language)),
        }
      : {}),
    elapsed_ms: Date.now() - startTime,
  };

  return result;
}
