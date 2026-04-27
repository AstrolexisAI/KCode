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
  BugPattern,
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
   * F9 (v2.10.370) — restrict the run to a specific vendible pack
   * (e.g. "ai-ml", "web", "cloud", "supply-chain", "embedded"). When
   * set, only patterns whose `pack` field matches are loaded. Patterns
   * with no pack are excluded — they're "general" and outside the
   * vendible-packs scope. Useful for AI/ML audits where the user only
   * cares about the LLM/model surface, not generic web XSS.
   */
  pack?: import("./types").PatternPack;
  /**
   * P1.3 (v2.10.389) — generate proof-of-concept exploit data for
   * each confirmed finding. Off by default to keep /scan output focused
   * on the audit shape; enable with /scan --exploits or
   * `kcode audit . --exploits` when you want to demonstrate
   * exploitability (security review, customer report, etc.). Templates
   * exist for ~10 patterns and produce deterministic PoCs;
   * uncovered patterns optionally use the LLM verifier callback for
   * an LLM-assisted PoC. The module never EXECUTES anything — it
   * generates structured data the report renders.
   */
  generateExploits?: boolean;
  /**
   * Optional cancellation signal. The pipeline checks it at every
   * phase boundary and propagates it into verification so an in-flight
   * /scan can be interrupted from the TUI (Esc) without killing the
   * process. The orchestrator throws ScanCancelledError when the
   * signal aborts; callers should catch it and produce a soft message.
   * v2.10.385.
   */
  signal?: AbortSignal;
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

  // v2.10.388 — yield to event loop so the TUI's setInterval polling
  // can render the indeterminate progress bar BEFORE scanProject
  // blocks the thread for ~5-15s. Without this, the user pressed
  // Enter on /scan and saw a blank screen for 15+ seconds because
  // setInterval(200ms) couldn't fire while scanProject ran.
  await new Promise((r) => setImmediate(r));

  // Phase 1: Discovery + scanning.
  //
  // When `opts.since` is set we run scanProject as usual to get the
  // full file universe, then narrow to the intersection with the git
  // diff. The narrowing happens AFTER scanProject so the report's
  // coverage shape stays internally consistent (totalCandidateFiles
  // = full project, scannedFiles = the diff-filtered subset).
  // F9 (v2.10.370) — when opts.pack is set, narrow the regex pattern
  // set to that pack only. AST patterns get the same filter below.
  let regexPatterns: BugPattern[] | undefined;
  if (opts.pack) {
    const { ALL_PATTERNS } = await import("./patterns");
    regexPatterns = ALL_PATTERNS.filter((p) => p.pack === opts.pack);
  }
  opts.onPhase?.("scanning", "regex patterns over file tree");
  // v2.10.388: scanProject is now async with periodic yields. The
  // event loop stays responsive throughout (TUI poll keeps ticking,
  // Esc cancellation works) instead of blocking for tens of seconds
  // on large repos.
  let scanResult = await scanProject(opts.projectRoot, {
    maxFiles: opts.maxFiles,
    ...(regexPatterns ? { patterns: regexPatterns } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    onProgress: (scanned, total) => {
      opts.onPhase?.("scanning", `regex: ${scanned}/${total} files`);
    },
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
    const allAstPatternsRaw = [
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
    // F9 — same pack filter as the regex patterns.
    const allAstPatterns = opts.pack
      ? allAstPatternsRaw.filter((p) => p.pack === opts.pack)
      : allAstPatternsRaw;
    if (allAstPatterns.length > 0 && files.length > 0) {
      const { readFileSync } = await import("node:fs");
      let astTotal = 0;
      // v2.10.388 — yield every YIELD_EVERY files so the TUI poll can
      // refresh elapsed time and the indeterminate bar keeps moving.
      // Tree-sitter parsing is sync C++ that blocks ~50-300ms per file;
      // accumulating without yields keeps the bar frozen for 10s+ on
      // large repos. 32 is the empirical sweet spot — small enough to
      // give visible motion, big enough that yield overhead is <1%.
      const YIELD_EVERY = 32;
      let i = 0;
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
        i++;
        if (i % YIELD_EVERY === 0) {
          opts.onPhase?.("scanning", `AST: ${i}/${files.length} files`);
          await new Promise((r) => setImmediate(r));
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

  // CL.3 (v2.10.373) — learning loop. review-history persists every
  // /review demote_fp action keyed by (project, pattern, path-glob).
  // Before sending each candidate to the verifier, check if this
  // (pattern, path-glob) combo has been demoted ≥10 times in this
  // project. If so, pre-mark as needs_context with a reasoning that
  // explains the suppression — saves verifier tokens AND surfaces
  // the decision so the user can override with /review promote.
  // The candidate still appears in the report; it's just routed to
  // a different bucket without a model call.
  const { isHighNoise, getDemotionCount } = await import("./review-history");
  const learningLoopSuppressed: Candidate[] = [];
  const candidatesToVerify: Candidate[] = [];
  for (const c of candidates) {
    if (
      isHighNoise({
        projectRoot: opts.projectRoot,
        patternId: c.pattern_id,
        file: c.file,
      })
    ) {
      learningLoopSuppressed.push(c);
    } else {
      candidatesToVerify.push(c);
    }
  }
  if (learningLoopSuppressed.length > 0) {
    opts.onPhase?.(
      "scanning",
      `learning loop: ${learningLoopSuppressed.length} candidate(s) pre-marked needs_context based on prior demotions`,
    );
  }

  // Phase 2: Verification (optional)
  // Cancellation gate: if the user already hit Esc during the scanning
  // phase (which can be slow on large repos), short-circuit before the
  // verifier loop so we don't burn LLM calls for a result that will be
  // discarded.
  if (opts.signal?.aborted) {
    const { ScanCancelledError } = await import("./scan-state");
    throw new ScanCancelledError(
      `Scan cancelled before verification (${candidates.length} candidates queued)`,
    );
  }
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
      ? `${candidatesToVerify.length} candidates (primary + fallback on ambiguity)`
      : `${candidatesToVerify.length} candidates`;
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
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    const verifiedSubset = await verifyAllCandidates(candidatesToVerify, verifyOpts);
    // Stitch suppressed candidates back into the result with a
    // synthetic needs_context verdict that names the cause.
    const suppressed = learningLoopSuppressed.map((c) => {
      const count = getDemotionCount({
        projectRoot: opts.projectRoot,
        patternId: c.pattern_id,
        file: c.file,
      });
      return {
        candidate: c,
        verification: {
          verdict: "needs_context" as const,
          reasoning: `[learning loop] pattern demoted ${count} times in similar paths in this project — verifier skipped to save tokens. /review promote ${c.pattern_id} to override.`,
        },
      };
    });
    verified = [...verifiedSubset, ...suppressed];
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
  // v2.10.372 (CL.2) — stamp every finding with a stable hash so
  // /review can address it across runs without relying on the
  // shifting integer index.
  const { computeFindingId } = await import("./finding-id");
  for (const r of verified) {
    const pattern = getPatternById(r.candidate.pattern_id);
    // v2.10.389 (P1.1) — site-level key matches the new dedupe key
    // shape `pattern|file|line`. The "+N more" annotation now reads
    // "matches at this line" not "in the same file" because each
    // distinct line is its own finding.
    const key = `${r.candidate.pattern_id}|${r.candidate.file}|${r.candidate.line}`;
    const count = multiples.get(key);
    const extraReasoning = count
      ? `${r.verification.reasoning} (+${count - 1} more matches of this pattern at the same site)`
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
      finding_id: computeFindingId({
        pattern_id: r.candidate.pattern_id,
        file: r.candidate.file,
        matched_text: r.candidate.matched_text,
        projectRoot: opts.projectRoot,
      }),
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

  // P1.3 (v2.10.389) — opt-in exploit generation. Off by default
  // (preserves the existing /scan output shape); enable with
  // generateExploits=true (CLI flag --exploits / TUI flag --exploits).
  // generateExploits() never executes anything — it produces structured
  // PoC data the report renders for the user/reviewer.
  let exploits: Awaited<ReturnType<typeof import("./exploit-gen").generateExploits>> | undefined;
  if (opts.generateExploits && findings.length > 0) {
    opts.onPhase?.("verifying", `generating exploit proofs for ${findings.length} confirmed findings`);
    try {
      const { generateExploits: genExploits } = await import("./exploit-gen");
      // Pass the verifier callback so patterns without a deterministic
      // template can ask the model for an LLM-assisted PoC.
      exploits = await genExploits(findings, opts.skipVerification ? undefined : opts.llmCallback);
    } catch (err) {
      // Exploit generation is opt-in and additive — failure here must
      // not break the audit. Log and continue with no exploits attached.
      // eslint-disable-next-line no-console
      console.warn(`[audit-engine] exploit generation failed: ${err instanceof Error ? err.message : String(err)}`);
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
    ...(exploits && exploits.length > 0 ? { exploits } : {}),
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

  // F2 (v2.10.362) — quantitative trustworthiness score derived from
  // the just-built result. Late-binds the field so we can read all
  // the verifier outputs + coverage + ast status in one shot.
  const { computeAuditConfidence } = await import("./confidence-scorer");
  result.audit_confidence = computeAuditConfidence(result);

  // F9 (v2.10.370) — pack breakdown of confirmed findings. Resolves
  // each pattern's pack via the bundled lookup so we don't need to
  // store the pack on every finding.
  if (findings.length > 0) {
    const { getPatternById } = await import("./patterns");
    const breakdown: Record<string, number> = {};
    for (const f of findings) {
      const pat = getPatternById(f.pattern_id);
      const pk = (pat as { pack?: string } | null)?.pack ?? "general";
      breakdown[pk] = (breakdown[pk] ?? 0) + 1;
    }
    result.pack_breakdown = breakdown;
  }
  if (opts.pack) result.scoped_pack = opts.pack;
  if (learningLoopSuppressed.length > 0) {
    result.learning_loop_suppressed = learningLoopSuppressed.length;
  }

  return result;
}
