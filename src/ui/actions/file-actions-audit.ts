// Audit-related actions: /scan and /fix.
// Split out of file-actions.ts.

import type { ActionContext } from "./action-helpers.js";
import { tokenize } from "./argv-parser.js";
import { log } from "../../core/logger.js";

export async function handleAuditAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { appConfig, args } = ctx;

  switch (action) {
    case "scan": {
      // Parse args: first token = path, optional flags
      // CL.4 (v2.10.374) — shell-quote-aware tokenization. Replaces
      // split(/\s+/) which broke paths with spaces and forced quoted
      // /review note text to be unquoted. Unterminated-quote errors
      // bubble up as a friendly message instead of crashing the TUI.
      let tokens: string[];
      try {
        tokens = tokenize(args);
      } catch (err) {
        return `  ${(err as Error).message}`;
      }
      const skipVerify = tokens.includes("--skip-verify");
      // P1.3 (v2.10.389) — opt-in exploit proof generation. Off by
      // default; enabled with /scan --exploits to produce PoC data
      // for confirmed findings (security-review / customer-report flow).
      const generateExploits = tokens.includes("--exploits") || tokens.includes("--proofs");
      // CL.6 (v2.10.376) — /scan now passes through engine flags that
      // were previously CLI-only. Same parser shape as the audit
      // command in cli/commands/audit.ts so users get one mental
      // model regardless of where they invoke /scan.
      const flagValue = (name: string): string | undefined => {
        const i = tokens.indexOf(name);
        if (i === -1 || i + 1 >= tokens.length) return undefined;
        return tokens[i + 1];
      };
      const sinceRef = flagValue("--since");
      const packArg = flagValue("--pack");
      const maxFilesArg = flagValue("--max-files");
      // Validate --pack against the 5 known names. Same set as
      // cli/commands/audit.ts (kept in sync intentionally — this
      // is a surface-of-truth duplication that's cheaper than a
      // shared module).
      const validPacks = new Set(["web", "ai-ml", "cloud", "supply-chain", "embedded"]);
      if (packArg && !validPacks.has(packArg)) {
        return `  --pack must be one of: ${[...validPacks].join(", ")}. Got: "${packArg}".`;
      }
      let parsedMaxFiles: number | undefined;
      if (maxFilesArg !== undefined) {
        const n = Number.parseInt(maxFilesArg, 10);
        if (!Number.isFinite(n) || n <= 0) {
          return `  --max-files must be a positive integer. Got: "${maxFilesArg}".`;
        }
        parsedMaxFiles = n;
      }
      // pathToken is the first non-flag token AND not the value
      // following one of the known value-flags. Without this the
      // user typing `/scan . --since main` would correctly pick `.`
      // as path, but `/scan --since main /my-project` would pick
      // `main` as path. Skip the value tokens by index.
      const valueFlagIndices = new Set<number>();
      for (const flag of ["--since", "--pack", "--max-files"]) {
        const i = tokens.indexOf(flag);
        if (i !== -1 && i + 1 < tokens.length) valueFlagIndices.add(i + 1);
      }
      let pathToken =
        tokens.find((t, i) => !t.startsWith("--") && !valueFlagIndices.has(i)) ?? ".";
      // Expand ~ to home directory
      if (pathToken.startsWith("~/")) pathToken = pathToken.replace("~", process.env.HOME ?? "");
      const { resolve: resolvePath } = await import("node:path");
      const { join: joinPath } = await import("node:path");
      const { writeFileSync, existsSync, statSync, readFileSync: readFs } = await import("node:fs");

      let projectRoot = pathToken.startsWith("/") ? pathToken : resolvePath(appConfig.workingDirectory, pathToken);

      // Guard: if scanning home directory, try last-project instead
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      if (projectRoot === home || projectRoot === home + "/") {
        const lastProjectFile = joinPath(home, ".kcode", "last-project");
        if (existsSync(lastProjectFile)) {
          const lastProject = readFs(lastProjectFile, "utf-8").trim();
          if (lastProject && existsSync(lastProject)) {
            projectRoot = lastProject;
          }
        }
        if (projectRoot === home || projectRoot === home + "/") {
          return "  ⚠ Cannot scan home directory. Use: /scan <project-path> or /scan ~/my-project";
        }
      }

      if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
        return `  Path not found or not a directory: ${pathToken}`;
      }

      // v2.10.387 — activate the progress bar BEFORE the heavy imports
      // below. scan-state itself is tiny (~80 LOC, no deps), so loading
      // it first costs ~0. With an early `scanState.active = true`,
      // App.tsx's 200ms poll picks up the active state and the
      // indeterminate bar (introduced same release) renders within
      // ~200ms of the user pressing Enter — no perceived "dead air".
      const { scanState, resetScanState } = await import(
        "../../core/audit-engine/scan-state.js"
      );
      resetScanState();
      scanState.active = true;
      scanState.startTime = Date.now();
      scanState.phase = "loading audit engine...";

      const { runAudit } = await import("../../core/audit-engine/audit-engine.js");
      const { generateMarkdownReport } = await import(
        "../../core/audit-engine/report-generator.js"
      );
      const { buildAuditLlmCallbackFromConfigAsync } = await import(
        "../../core/audit-engine/llm-callback.js"
      );

      // Heavy modules loaded — switch phase before the audit pipeline starts.
      scanState.phase = "discovery";

      // v2.10.385 — cancellation: TUI sets scanState.cancelled = true on
      // Esc; this watcher mirrors it onto an AbortController that
      // runAudit propagates to the verifier loop. We poll instead of
      // wiring an event because scanState is already a polled-singleton
      // pattern (App.tsx polls it for progress) — keeps the model
      // consistent.
      const controller = new AbortController();
      const cancelWatcher = setInterval(() => {
        if (scanState.cancelled && !controller.signal.aborted) {
          controller.abort();
        }
      }, 100);

      const llmCallback = skipVerify
        ? async () =>
            JSON.stringify({
              verdict: "confirmed",
              reasoning: "static-only mode",
              evidence: { sink: "static-only bypass" },
            })
        : await buildAuditLlmCallbackFromConfigAsync(appConfig);

      // Detect available audit models (tagged [analysis]/[reasoning] with valid keys)
      let auditModels: Awaited<ReturnType<typeof import("../../core/audit-engine/cloud-fallback.js")["detectAuditModels"]>>["models"] = [];
      if (!skipVerify) {
        const { detectAuditModels } = await import("../../core/audit-engine/cloud-fallback.js");
        const cloudConfig = await detectAuditModels(appConfig.apiBase);
        auditModels = cloudConfig.models;
      }

      // Background async — NOT awaited
      (async () => {
        try {
          // Phase 1: run audit WITHOUT fallback (local model only)
          const result = await runAudit({
            projectRoot,
            llmCallback,
            signal: controller.signal,
            // NO fallbackCallback here — we'll escalate manually after user approval.
            // /scan audits the whole project by design — no truncation
            // by default (Issue #111 v307). User can cap with
            // --max-files <n> if they want partial coverage.
            maxFiles: parsedMaxFiles ?? Number.MAX_SAFE_INTEGER,
            skipVerification: skipVerify,
            generateExploits,
            // CL.6 — pass through diff-based audit and pack filter.
            ...(sinceRef ? { since: sinceRef } : {}),
            ...(packArg
              ? { pack: packArg as "web" | "ai-ml" | "cloud" | "supply-chain" | "embedded" }
              : {}),
            onPhase: (phase, detail) => {
              scanState.phase = detail ? `${phase}: ${detail}` : phase;
              if (phase === "verifying" && detail) {
                const m = detail.match(/(\d+) candidate/);
                if (m) scanState.total = parseInt(m[1]!, 10);
              }
            },
            onCandidate: (_cand, verification) => {
              scanState.verified++;
              if (verification.verdict === "confirmed") scanState.confirmed++;
              if (verification.verdict === "false_positive") scanState.falsePositives++;
            },
          });

          // Phase 2: if there are FPs or NEEDS_CONTEXT and audit models available, offer escalation
          const fpCount = result.false_positives;
          const ncCount = result.candidates_found - result.confirmed_findings - result.false_positives;
          const reviewable = fpCount + ncCount;

          if (reviewable > 0 && auditModels.length > 0) {
            const reason = fpCount > 0
              ? `${fpCount} marked as false positive${ncCount > 0 ? `, ${ncCount} uncertain` : ""}`
              : `${ncCount} need deeper analysis`;
            scanState.phase = reason;
            scanState.pendingEscalation = {
              count: reviewable,
              reason,
              availableModels: auditModels.map((m) => ({
                name: m.name,
                provider: m.provider,
                tags: m.tags,
              })),
            };

            // Wait for user to choose a model (or skip)
            while (scanState.pendingEscalation && scanState.escalationModelChoice === undefined) {
              await new Promise((r) => setTimeout(r, 200));
            }

            const chosenModelName = scanState.escalationModelChoice;
            const chosenModel = auditModels.find((m) => m.name === chosenModelName);
            if (chosenModel) {
              const { buildAuditCallbackForModel } = await import("../../core/audit-engine/cloud-fallback.js");
              const fallbackCallback = await buildAuditCallbackForModel(chosenModel);
              scanState.cloudProvider = chosenModel.provider;
              scanState.phase = `☁ Re-verifying with ${chosenModel.name}...`;
              scanState.pendingEscalation = undefined;
              scanState.verified = 0;
              scanState.total = 0;
              scanState.escalated = 0;

              // Re-run scan with cloud as primary. Wrapped in
              // try/catch because the verifier now aborts after 3
              // consecutive transport / 401 / 404 errors instead of
              // silently bucketing every candidate as needs_context.
              // When that happens we keep the primary pass result and
              // surface a clear error in scanState. v2.10.312.
              //
              // HD.3 (v2.10.380) — pass through the user's original
              // scope (--since, --pack, --max-files) so the cloud
              // pass doesn't widen scope past what the primary
              // scanned. Earlier code hardcoded maxFiles to MAX
              // and dropped the diff/pack filters, which mixed
              // out-of-scope findings into the merged result.
              let cloudResult: typeof result | null = null;
              let cloudAbortError: string | null = null;
              try {
                cloudResult = await runAudit({
                  projectRoot,
                  llmCallback: fallbackCallback,
                  signal: controller.signal,
                  maxFiles: parsedMaxFiles ?? Number.MAX_SAFE_INTEGER,
                  skipVerification: false,
                  generateExploits,
                  ...(sinceRef ? { since: sinceRef } : {}),
                  ...(packArg
                    ? { pack: packArg as "web" | "ai-ml" | "cloud" | "supply-chain" | "embedded" }
                    : {}),
                  onPhase: (phase, detail) => {
                    scanState.phase = `☁ ${phase}${detail ? ": " + detail : ""}`;
                    if (phase === "verifying" && detail) {
                      const m = detail.match(/(\d+) candidate/);
                      if (m) scanState.total = parseInt(m[1]!, 10);
                    }
                  },
                  onCandidate: (_cand, verification) => {
                    scanState.verified++;
                    scanState.escalated++;
                    if (verification.verdict === "confirmed") scanState.confirmed++;
                  },
                });
              } catch (err) {
                cloudAbortError = err instanceof Error ? err.message : String(err);
                scanState.phase = `☁ cloud verification aborted: ${cloudAbortError.slice(0, 120)}`;
                log.warn(
                  "audit",
                  `cloud escalation aborted: ${cloudAbortError}`,
                );
              }

              // Merge: keep original confirmed + add cloud-confirmed.
              // HD.3 — dedup by finding_id when present (refactor-tolerant
              // identity from CL.2) with file:line as fallback for legacy
              // findings. Skip the merge entirely if the cloud pass
              // aborted — primary results stay untouched and the error
              // is surfaced.
              if (cloudResult) {
              const sameFinding = (a: typeof result.findings[number], b: typeof result.findings[number]): boolean => {
                if (a.finding_id && b.finding_id) return a.finding_id === b.finding_id;
                return a.file === b.file && a.line === b.line;
              };
              for (const f of cloudResult.findings) {
                if (!result.findings.some((e) => sameFinding(e, f))) {
                  f.verification.reasoning = `[☁ second opinion] ${f.verification.reasoning}`;
                  result.findings.push(f);
                }
              }
              result.confirmed_findings = result.findings.length;
              // Replace FP detail with cloud's (authoritative second-opinion).
              // Previously this code recomputed result.false_positives without
              // touching false_positives_detail, producing a report with
              // "false_positives: 33" and "false_positives_detail: []" — a
              // contradiction that made the rejections unauditable. Issue
              // #111 v2.10.309.
              // HD.3 — dedupe by finding_id when present.
              const sameAsConfirmed = (entry: { finding_id?: string; file: string; line: number }): boolean =>
                result.findings.some((conf) =>
                  conf.finding_id && entry.finding_id
                    ? conf.finding_id === entry.finding_id
                    : conf.file === entry.file && conf.line === entry.line,
                );
              result.false_positives_detail = cloudResult.false_positives_detail.filter(
                (fp) => !sameAsConfirmed(fp),
              );
              result.false_positives = result.false_positives_detail.length;
              result.needs_context_detail = (cloudResult.needs_context_detail ?? []).filter(
                (nc) => !sameAsConfirmed(nc),
              );
              result.needs_context = result.needs_context_detail.length;
              } // end if (cloudResult)
              // Surface cloud-abort error in the scan state so the
              // user-visible report includes the reason instead of a
              // silent no-op.
              if (cloudAbortError) {
                scanState.cloudAbortError = cloudAbortError;
              }
            } else {
              scanState.pendingEscalation = undefined;
            }
          }

          const outputPath = resolvePath(projectRoot, "AUDIT_REPORT.md");
          writeFileSync(outputPath, generateMarkdownReport(result));
          // Also write JSON for /fix and /pr to consume
          const jsonPath = outputPath.replace(/\.md$/, ".json");
          writeFileSync(jsonPath, JSON.stringify(result, null, 2));

          const topFindings = result.findings.slice(0, 5).map((f) => ({
            severity: f.severity,
            file: f.file.replace(projectRoot + "/", ""),
            line: f.line,
            patternId: f.pattern_id,
          }));

          // Build the report text for conversation history
          const reportLines: string[] = [
            `  KCode Audit Engine`,
            `    Project:  ${projectRoot}`,
            skipVerify ? `    Mode:     static-only` : `    Model:    ${appConfig.model ?? "default"}`,
            "",
            `    ✓ Report written: ${outputPath}`,
            "",
            `    Files scanned:      ${result.files_scanned}${result.coverage ? ` / ${result.coverage.totalCandidateFiles}` : ""}`,
            `    Candidates found:   ${result.candidates_found}`,
            `    Confirmed findings: ${result.confirmed_findings}`,
            `    False positives:    ${result.false_positives}`,
          ];
          if ((result.needs_context ?? 0) > 0) {
            reportLines.push(
              `    \x1b[33mUncertain:          ${result.needs_context}\x1b[0m (verifier couldn't decide)`,
            );
          }
          // v2.10.328 (Sprint 3): announce fix_support breakdown up
          // front so the user knows BEFORE running /fix what fraction
          // is actually mechanical. Avoids the previous trap of seeing
          // "5 confirmed" then "Fixed: 1 / Annotated: 2 / Skipped: 2"
          // and feeling /fix underdelivered — when really only 1 was
          // ever auto-fixable.
          const fixSupport = (result as { fix_support_summary?: { rewrite: number; annotate: number; manual: number } })
            .fix_support_summary;
          if (fixSupport && (fixSupport.rewrite + fixSupport.annotate + fixSupport.manual) > 0) {
            reportLines.push(
              `    Fix support:        ${fixSupport.rewrite} rewrite · ${fixSupport.annotate} annotate · ${fixSupport.manual} manual-only`,
            );
          }
          reportLines.push(
            `    Duration:           ${(result.elapsed_ms / 1000).toFixed(1)}s`,
          );
          if (scanState.cloudAbortError) {
            reportLines.push(
              "",
              `    \x1b[31m✗ Cloud second-opinion aborted:\x1b[0m ${scanState.cloudAbortError.slice(0, 200)}`,
              `    \x1b[33m  Primary results above are from local model only.\x1b[0m`,
            );
          }
          if (result.coverage?.truncated) {
            const suggestion = Math.min(
              result.coverage.totalCandidateFiles,
              result.coverage.maxFiles * 4,
            );
            reportLines.push(
              "",
              `    \x1b[33m⚠ Coverage: ${result.coverage.scannedFiles}/${result.coverage.totalCandidateFiles} files (${result.coverage.skippedByLimit} skipped by --max-files ${result.coverage.maxFiles}).\x1b[0m`,
              `    \x1b[33m  Rerun with --max-files ${suggestion} for full coverage.\x1b[0m`,
            );
          }
          if (topFindings.length > 0) {
            reportLines.push("", `  Top findings:`);
            for (const f of topFindings) {
              const icon =
                f.severity === "critical" ? "🔴" : f.severity === "high" ? "🟠" : f.severity === "medium" ? "🟡" : "🟢";
              reportLines.push(`    ${icon} ${f.file}:${f.line}  ${f.patternId}`);
            }
            if (result.findings.length > 5) {
              reportLines.push(`    ... and ${result.findings.length - 5} more (see AUDIT_REPORT.md)`);
            }
          }

          scanState.result = {
            outputPath,
            filesScanned: result.files_scanned,
            candidates: result.candidates_found,
            findings: result.confirmed_findings,
            falsePositives: result.false_positives,
            elapsedMs: result.elapsed_ms,
            topFindings,
            reportText: reportLines.join("\n"),
          };
        } catch (err) {
          // v2.10.385 — distinguish user cancellation from real errors.
          // ScanCancelledError surfaces as a soft "cancelled" message
          // (no AUDIT_REPORT.json written, no error banner). Other
          // errors still bubble up via scanState.error.
          const { ScanCancelledError } = await import(
            "../../core/audit-engine/scan-state.js"
          );
          if (err instanceof ScanCancelledError) {
            scanState.phase = "cancelled by user";
            scanState.result = {
              outputPath: "",
              filesScanned: 0,
              candidates: 0,
              findings: 0,
              falsePositives: 0,
              elapsedMs: Date.now() - scanState.startTime,
              topFindings: [],
              reportText: `  ◆ /scan cancelled (Esc) after ${((Date.now() - scanState.startTime) / 1000).toFixed(1)}s.`,
            };
          } else {
            scanState.error = err instanceof Error ? err.message : String(err);
          }
        } finally {
          clearInterval(cancelWatcher);
          scanState.active = false;
        }
      })();

      // Return immediately — progress renders via polling in App.tsx
      return `  ◆ Starting scanning ${projectRoot.split("/").pop()}/ in background...`;
    }

    case "review": {
      // /review v2 — Sprint 2. Triage every bucket the verifier produced,
      // not just confirmed.
      //
      //   /review fprime/                          — dashboard (all 3 buckets)
      //   /review fprime/ list confirmed|fp|uncertain
      //   /review fprime/ promote 7,8              — uncertain or FP → confirmed
      //   /review fprime/ demote 2,3               — confirmed → FP
      //   /review fprime/ tag 5 trusted_boundary   — set review_reason
      //   /review fprime/ untag 5                  — clear review_reason
      //   Legacy syntax still works: keep, drop, all, none.
      //
      // Indices are GLOBAL across all three buckets and stable across
      // reruns (driven by array order in the JSON). The dashboard prints
      // them in groups so the user always knows what each number maps to.
      // Decisions persist via the v326 fields review_state, review_reason,
      // and review_tags on Finding / FalsePositiveDetail.
      // CL.4 (v2.10.374) — shell-quote-aware tokenization. Replaces
      // split(/\s+/) which broke paths with spaces and forced quoted
      // /review note text to be unquoted. Unterminated-quote errors
      // bubble up as a friendly message instead of crashing the TUI.
      let tokens: string[];
      try {
        tokens = tokenize(args);
      } catch (err) {
        return `  ${(err as Error).message}`;
      }
      const pathToken = tokens.shift() ?? ".";
      const cmd = (tokens.shift() ?? "").toLowerCase();

      const { resolve: resolvePath } = await import("node:path");
      const { existsSync, readFileSync: readFs, writeFileSync: writeFs } =
        await import("node:fs");
      const projectRoot = resolvePath(appConfig.workingDirectory, pathToken);
      const jsonPath = resolvePath(projectRoot, "AUDIT_REPORT.json");

      if (!existsSync(jsonPath)) {
        return (
          `  No AUDIT_REPORT.json in ${pathToken}/\n` +
          `  Run /scan ${pathToken} first.`
        );
      }

      type Reviewable = {
        pattern_id: string;
        pattern_title?: string;
        severity: string;
        file: string;
        line: number;
        verification: { reasoning: string; verdict: string };
        review_state?: string;
        review_reason?: string;
        review_tags?: string[];
      };
      // v2.10.367 — guard against a corrupt AUDIT_REPORT.json (partial
      // write, manual edit, or version skew). Without try/catch a
      // truncated JSON crashed the TUI session entirely.
      let audit: {
        findings: Reviewable[];
        false_positives: number;
        false_positives_detail?: Reviewable[];
        needs_context?: number;
        needs_context_detail?: Reviewable[];
        confirmed_findings: number;
        pattern_metrics?: Record<string, {
          hits: number;
          unique_sites: number;
          confirmed: number;
          false_positive: number;
          confirmed_rate?: number;
          false_positive_rate?: number;
        }>;
      };
      try {
        audit = JSON.parse(readFs(jsonPath, "utf-8")) as typeof audit;
      } catch (err) {
        return (
          `  Could not parse ${jsonPath.replace(projectRoot + "/", "")}: ${(err as Error).message}.\n` +
          `  Re-run /scan ${pathToken} to regenerate.`
        );
      }
      if (!audit || !Array.isArray(audit.findings)) {
        return `  ${jsonPath.replace(projectRoot + "/", "")} is missing the "findings" array. Re-run /scan ${pathToken}.`;
      }

      // Build a flat global-index map across all three buckets so commands
      // can refer to any finding by a single integer regardless of which
      // bucket it currently lives in.
      type Bucket = "confirmed" | "fp" | "uncertain";
      const fpDetail = audit.false_positives_detail ?? [];
      const ncDetail = audit.needs_context_detail ?? [];
      const flat: Array<{ bucket: Bucket; localIdx: number; item: Reviewable }> = [];
      for (let i = 0; i < audit.findings.length; i++) {
        flat.push({ bucket: "confirmed", localIdx: i, item: audit.findings[i]! });
      }
      for (let i = 0; i < fpDetail.length; i++) {
        flat.push({ bucket: "fp", localIdx: i, item: fpDetail[i]! });
      }
      for (let i = 0; i < ncDetail.length; i++) {
        flat.push({ bucket: "uncertain", localIdx: i, item: ncDetail[i]! });
      }

      const icon = (sev: string): string =>
        sev === "critical" ? "🔴" :
        sev === "high" ? "🟠" :
        sev === "medium" ? "🟡" : "🟢";
      // P2.5 (v2.10.389) — surface pattern_metrics noise hints inline.
      // External audit asked for "this pattern is 80% FP in your past
      // reviews — likely false positive" prompts during triage. We
      // start with the current-run metrics (cheap, no extra IO) and
      // can extend to review-history's cross-run data later. Threshold:
      // >=3 unique_sites + FP rate >50% — below that the sample is too
      // small to be a useful signal.
      const noiseHint = (patternId: string): string => {
        const m = audit.pattern_metrics?.[patternId];
        if (!m || m.unique_sites < 3) return "";
        const fpRate = m.false_positive_rate;
        if (fpRate === undefined || fpRate < 0.5) return "";
        const pct = Math.round(fpRate * 100);
        return ` ⚠ ${pct}% FP this run (${m.false_positive}/${m.unique_sites} sites)`;
      };
      const fmtItem = (
        globalIdx: number,
        e: Reviewable,
      ): string[] => {
        const rel = e.file.replace(projectRoot + "/", "");
        const tagStr = e.review_tags && e.review_tags.length > 0
          ? ` [tags: ${e.review_tags.join(", ")}]`
          : "";
        const reasonStr = e.review_reason ? ` (reason: ${e.review_reason})` : "";
        // v2.10.372 (CL.2) — show finding_id alongside the legacy
        // index. The integer is friendlier to type for ad-hoc
        // triage; the kc-* hash is the one that survives reruns
        // and refactors.
        const idStr = e.finding_id ? `  ${e.finding_id}` : "";
        const hint = noiseHint(e.pattern_id);
        return [
          `    ${globalIdx}. ${icon(e.severity)} [${e.severity.toUpperCase()}] ${e.pattern_id}${idStr}${reasonStr}${tagStr}${hint}`,
          `       ${rel}:${e.line}`,
          `       ${e.verification.reasoning.slice(0, 220)}`,
        ];
      };

      // ── Dashboard (no subcommand) ──────────────────────────────
      if (!cmd) {
        const lines: string[] = [
          `  KCode Review — ${pathToken}`,
          `    Project: ${projectRoot}`,
          `    ${audit.findings.length} confirmed | ${fpDetail.length} false-positive | ${ncDetail.length} uncertain`,
          "",
        ];
        if (audit.findings.length > 0) {
          lines.push(`  ── Confirmed (${audit.findings.length}) ──`);
          for (const entry of flat.filter((e) => e.bucket === "confirmed")) {
            const gIdx = flat.indexOf(entry) + 1;
            lines.push(...fmtItem(gIdx, entry.item));
            lines.push("");
          }
        }
        if (ncDetail.length > 0) {
          lines.push(`  ── Uncertain — needs_context (${ncDetail.length}) ──`);
          for (const entry of flat.filter((e) => e.bucket === "uncertain").slice(0, 10)) {
            const gIdx = flat.indexOf(entry) + 1;
            lines.push(...fmtItem(gIdx, entry.item));
            lines.push("");
          }
          if (ncDetail.length > 10) {
            lines.push(`    …and ${ncDetail.length - 10} more — /review ${pathToken} list uncertain`);
            lines.push("");
          }
        }
        if (fpDetail.length > 0 && fpDetail.length <= 10) {
          lines.push(`  ── False positives (${fpDetail.length}) ──`);
          for (const entry of flat.filter((e) => e.bucket === "fp")) {
            const gIdx = flat.indexOf(entry) + 1;
            lines.push(...fmtItem(gIdx, entry.item));
            lines.push("");
          }
        } else if (fpDetail.length > 10) {
          lines.push(`  ── False positives: ${fpDetail.length} (use /review ${pathToken} list fp to inspect) ──`);
          lines.push("");
        }
        lines.push("  Commands:");
        lines.push(`    /review ${pathToken} list confirmed|fp|uncertain   — show one bucket`);
        lines.push(`    /review ${pathToken} promote 7,8                  — uncertain or FP → confirmed`);
        lines.push(`    /review ${pathToken} demote 2,3                   — confirmed → FP`);
        lines.push(`    /review ${pathToken} tag 5 trusted_boundary       — annotate (drives report sections)`);
        lines.push(`    /review ${pathToken} untag 5                      — clear annotation`);
        lines.push(`    /review ${pathToken} note 5 "free text"           — add reviewer note`);
        lines.push(`    /review ${pathToken} assign 5 high                — override severity`);
        lines.push(`    /review ${pathToken} ignore 4,8 --reason X        — ignore (excluded from /fix /pr)`);
        lines.push(`    /review ${pathToken} restore 4                   — clear review_state`);
        lines.push(`    /review ${pathToken} stats                       — pattern noise table`);
        lines.push(`    /review ${pathToken} export                      — JSON manifest for CI`);
        lines.push("");
        lines.push("  Legacy aliases: keep / drop / all / none — see /help.");
        return lines.join("\n");
      }

      // ── /review … list <bucket> ───────────────────────────────
      if (cmd === "list") {
        const bucketArg = (tokens.shift() ?? "").toLowerCase() as Bucket | "";
        if (!bucketArg || !["confirmed", "fp", "uncertain"].includes(bucketArg)) {
          return (
            `  Usage: /review ${pathToken} list confirmed|fp|uncertain\n` +
            `  Or run /review ${pathToken} (no args) for the dashboard.`
          );
        }
        const filtered = flat.filter((e) => e.bucket === bucketArg);
        if (filtered.length === 0) {
          return `  No ${bucketArg} findings in ${pathToken}/.`;
        }
        const lines: string[] = [
          `  ${bucketArg.toUpperCase()} (${filtered.length}) — ${pathToken}`,
          "",
        ];
        for (const entry of filtered) {
          const gIdx = flat.indexOf(entry) + 1;
          lines.push(...fmtItem(gIdx, entry.item));
          lines.push("");
        }
        return lines.join("\n");
      }

      // Helpers for promote/demote/tag/untag — parse comma-separated
      // refs. v2.10.372 (CL.2): each ref can be either a 1-based
      // integer index OR a stable finding_id like `kc-a3f9b2c14d8e`.
      // resolveFindingRef returns the 0-based slot or -1; we add 1
      // so the existing call sites that do `idx - 1` keep working.
      const { resolveFindingRef } = await import("../../core/audit-engine/finding-id.js");
      const parseIndices = (raw: string): number[] => {
        const out: number[] = [];
        for (const tok of raw.split(",")) {
          const trimmed = tok.trim();
          if (!trimmed) continue;
          const slot = resolveFindingRef(trimmed, flat);
          if (slot >= 0 && slot < flat.length) out.push(slot + 1);
        }
        return out;
      };
      // Single-ref parser for note/assign/tag/untag — same dual-form
      // accept (integer index OR kc-* finding_id). Returns -1 on
      // invalid so call sites can print a uniform error.
      const parseRef = (raw: string): number => {
        return resolveFindingRef(raw, flat);
      };

      // v2.10.351 P0 audit fix (A.1.1) — strip any prior reviewer-
      // state prefix from the reasoning before adding a new one.
      // Without this, round-trips (promote → demote → promote)
      // accumulated a stack of prefixes:
      //   [reviewer promoted] [reviewer demoted] [reviewer promoted] <reason>
      // which adds zero information — the reviewer's intent is the
      // CURRENT state's reason, not a log of every transition. The
      // strip is intentionally narrow: only \`[reviewer X]\` shapes
      // KCode itself produces, never the underlying verifier text.
      const stripReviewerPrefix = (reasoning: string): string => {
        return reasoning.replace(/^(?:\[reviewer (?:promoted|demoted)\]\s*)+/u, "");
      };

      const persist = (): void => {
        // Re-derive arrays from `flat` snapshots — consumers will do
        // their own indexing on next /review run, but we must keep the
        // JSON arrays consistent with the bucket reassignments below.
        const newConfirmed: Reviewable[] = [];
        const newFp: Reviewable[] = [];
        const newNc: Reviewable[] = [];
        for (const e of flat) {
          if (e.bucket === "confirmed") newConfirmed.push(e.item);
          else if (e.bucket === "fp") newFp.push(e.item);
          else newNc.push(e.item);
        }
        audit.findings = newConfirmed;
        audit.false_positives_detail = newFp;
        audit.needs_context_detail = newNc;
        audit.confirmed_findings = newConfirmed.length;
        audit.false_positives = newFp.length;
        audit.needs_context = newNc.length;
        // v2.10.351 P0 — recompute fix_support_summary from the new
        // confirmed array so downstream /fix and the report header
        // see counts that match the post-review state. Pre-fix, the
        // summary stayed at its scan-time value: a promoted finding
        // would land in /fix without being counted in the
        // "X rewrite, Y annotate, Z manual" announcement.
        const summary = { rewrite: 0, annotate: 0, manual: 0 };
        for (const f of newConfirmed) {
          const tier = (f as { fix_support?: "rewrite" | "annotate" | "manual" }).fix_support;
          if (tier === "rewrite") summary.rewrite++;
          else if (tier === "annotate") summary.annotate++;
          else summary.manual++;
        }
        (audit as { fix_support_summary?: { rewrite: number; annotate: number; manual: number } })
          .fix_support_summary = summary;
        writeFs(jsonPath, JSON.stringify(audit, null, 2));
      };

      // ── promote ───────────────────────────────────────────────
      if (cmd === "promote") {
        const indices = parseIndices(tokens.join(" "));
        if (indices.length === 0) {
          return `  Usage: /review ${pathToken} promote 7,8 — indices from the dashboard.`;
        }
        // v2.10.351 P0 — promote now mirrors demote: it updates BOTH
        // review_state AND verification.verdict. Without the verdict
        // update, /fix and /pr (which still filter by
        // verification.verdict, not review_state) would skip
        // promoted findings. Same shape as the demote path below.
        // Also populate fix_support if missing — entries promoted
        // from needs_context / fp may lack the field (it lives on
        // Finding, not on FalsePositiveDetail).
        const { fixSupportFor } = await import("../../core/audit-engine/fixer.js");
        const moved: string[] = [];
        for (const idx of indices) {
          const entry = flat[idx - 1]!;
          if (entry.bucket === "confirmed") {
            moved.push(`#${idx}: already confirmed (no change)`);
            continue;
          }
          entry.item.review_state = "promoted";
          if (!entry.item.review_reason) entry.item.review_reason = "manual_confirmation";
          entry.item.verification = {
            ...entry.item.verification,
            verdict: "confirmed",
            reasoning: `[reviewer promoted] ${stripReviewerPrefix(entry.item.verification.reasoning)}`,
          };
          // fix_support lives on Finding but is absent on
          // FalsePositiveDetail / NeedsContextDetail. Populate it
          // from the pattern registry so downstream /fix can route
          // the entry to the right tier.
          const item = entry.item as { fix_support?: "rewrite" | "annotate" | "manual"; pattern_id: string };
          if (!item.fix_support) {
            item.fix_support = fixSupportFor(item.pattern_id);
          }
          entry.bucket = "confirmed";
          moved.push(`#${idx}: ${entry.item.pattern_id} @ ${entry.item.file.replace(projectRoot + "/", "")}:${entry.item.line}`);
        }
        persist();
        return [
          `  Promoted ${indices.length} finding(s) → confirmed`,
          ...moved.map((s) => `    ${s}`),
          "",
          `  ⚠ Indices have shifted after this mutation. Re-run /review ${pathToken} before issuing more promote/demote/tag commands.`,
          `  Next: /fix ${pathToken}`,
        ].join("\n");
      }

      // ── demote ────────────────────────────────────────────────
      if (cmd === "demote") {
        const indices = parseIndices(tokens.join(" "));
        if (indices.length === 0) {
          return `  Usage: /review ${pathToken} demote 2,3 — indices from the dashboard.`;
        }
        const { recordDemotion } = await import("../../core/audit-engine/review-history.js");
        const moved: string[] = [];
        for (const idx of indices) {
          const entry = flat[idx - 1]!;
          if (entry.bucket === "fp") {
            moved.push(`#${idx}: already FP (no change)`);
            continue;
          }
          entry.item.review_state = "demoted_fp";
          if (!entry.item.review_reason) entry.item.review_reason = "manual_confirmation";
          // Annotate the verdict reasoning so the FP detail section is
          // self-explaining without cross-referencing review_state.
          entry.item.verification = {
            ...entry.item.verification,
            verdict: "false_positive",
            reasoning: `[reviewer demoted] ${stripReviewerPrefix(entry.item.verification.reasoning)}`,
          };
          entry.bucket = "fp";
          // F5.4 learning loop — record the demotion in
          // ~/.kcode/review-history.json so future scans can
          // deprioritize this pattern in similar paths.
          recordDemotion({
            projectRoot,
            patternId: entry.item.pattern_id,
            file: entry.item.file,
          });
          moved.push(`#${idx}: ${entry.item.pattern_id} @ ${entry.item.file.replace(projectRoot + "/", "")}:${entry.item.line}`);
        }
        persist();
        return [
          `  Demoted ${indices.length} finding(s) → false_positives_detail`,
          ...moved.map((s) => `    ${s}`),
          "",
          `  ⚠ Indices have shifted after this mutation. Re-run /review ${pathToken} before issuing more promote/demote/tag commands.`,
        ].join("\n");
      }

      // ── tag <idx> <reason> ────────────────────────────────────
      if (cmd === "tag") {
        const idxArg = tokens.shift() ?? "";
        const reasonArg = (tokens.join(" ").trim() || "").toLowerCase();
        const validReasons = new Set([
          "trusted_boundary", "test_only", "generated_code",
          "build_time_only", "placeholder_secret", "sanitized",
          "manual_confirmation", "other",
        ]);
        const slot = parseRef(idxArg);
        if (slot < 0 || slot >= flat.length) {
          return `  Usage: /review ${pathToken} tag <index|finding_id> <reason>\n  Valid reasons: ${[...validReasons].join(", ")}`;
        }
        if (!validReasons.has(reasonArg)) {
          return `  Unknown reason "${reasonArg}".\n  Valid: ${[...validReasons].join(", ")}`;
        }
        const entry = flat[slot]!;
        entry.item.review_reason = reasonArg as Reviewable["review_reason"];
        persist();
        return `  Tagged #${slot + 1} (${entry.item.finding_id ?? "no-id"}) with reason: ${reasonArg}`;
      }

      if (cmd === "untag") {
        const idxArg = tokens.shift() ?? "";
        const slot = parseRef(idxArg);
        if (slot < 0 || slot >= flat.length) {
          return `  Usage: /review ${pathToken} untag <index|finding_id>`;
        }
        const entry = flat[slot]!;
        delete entry.item.review_reason;
        persist();
        return `  Cleared review_reason on #${slot + 1} (${entry.item.finding_id ?? "no-id"})`;
      }

      // ── /review … note <idx> "free text" ─────────────────────
      // Free-text annotation persisted on the item. Quoted form is
      // recommended but plain words work; everything after the index
      // becomes the note. v2.10.363 (F5).
      if (cmd === "note") {
        const idxArg = tokens.shift() ?? "";
        const slot = parseRef(idxArg);
        if (slot < 0 || slot >= flat.length) {
          return `  Usage: /review ${pathToken} note <index|finding_id> "free text"`;
        }
        let text = tokens.join(" ").trim();
        // Strip surrounding quotes if the user wrapped the note.
        if ((text.startsWith('"') && text.endsWith('"')) ||
            (text.startsWith("'") && text.endsWith("'"))) {
          text = text.slice(1, -1);
        }
        if (!text) {
          return `  Usage: /review ${pathToken} note <index|finding_id> "free text" — text was empty`;
        }
        const entry = flat[slot]!;
        entry.item.review_note = text;
        persist();
        return `  Note saved on #${slot + 1} (${entry.item.finding_id ?? "no-id"}): ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`;
      }

      // ── /review … assign <idx> <severity> ────────────────────
      // Override severity. Useful when the reviewer disagrees with
      // the pattern's default — e.g. "this regex match is HIGH in
      // application code but LOW in vendored deps".
      if (cmd === "assign") {
        const validSeverities = new Set(["critical", "high", "medium", "low"]);
        const idxArg = tokens.shift() ?? "";
        const sev = (tokens.shift() ?? "").toLowerCase();
        const slot = parseRef(idxArg);
        if (slot < 0 || slot >= flat.length) {
          return `  Usage: /review ${pathToken} assign <index|finding_id> <severity>\n  Severities: ${[...validSeverities].join(", ")}`;
        }
        if (!validSeverities.has(sev)) {
          return `  Unknown severity "${sev}".\n  Valid: ${[...validSeverities].join(", ")}`;
        }
        const entry = flat[slot]!;
        const oldSev = entry.item.severity;
        entry.item.severity = sev as typeof entry.item.severity;
        persist();
        return `  Severity on #${slot + 1} (${entry.item.finding_id ?? "no-id"}): ${oldSev} → ${sev}`;
      }

      // ── /review … ignore <idx> [--reason X] ──────────────────
      // Mark a finding as "I see this but I'm not acting on it now"
      // (vs `demote`, which says "the verifier was wrong"). Ignored
      // findings are excluded from /fix, /pr, SARIF, and the actionable
      // count, but stay in the JSON for the audit trail.
      if (cmd === "ignore") {
        const idxArg = tokens.shift() ?? "";
        const indices = idxArg
          .split(",")
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= flat.length);
        if (indices.length === 0) {
          return `  Usage: /review ${pathToken} ignore <idx,idx,...> [--reason text]`;
        }
        // Optional --reason flag: everything after it is the reason.
        let reason: string | undefined;
        const reasonFlagIdx = tokens.indexOf("--reason");
        if (reasonFlagIdx !== -1) {
          reason = tokens.slice(reasonFlagIdx + 1).join(" ").trim();
          if ((reason.startsWith('"') && reason.endsWith('"')) ||
              (reason.startsWith("'") && reason.endsWith("'"))) {
            reason = reason.slice(1, -1);
          }
        }
        for (const i of indices) {
          const entry = flat[i - 1]!;
          entry.item.review_state = "ignored";
          if (reason) entry.item.review_note = reason;
        }
        persist();
        return `  Ignored ${indices.length} finding(s)${reason ? ` (reason: ${reason})` : ""}`;
      }

      // ── /review … restore <idx> ──────────────────────────────
      // Clear review_state so the finding goes back to its original
      // verifier verdict. Counterpart of ignore/demote.
      if (cmd === "restore") {
        const idxArg = tokens.shift() ?? "";
        const indices = idxArg
          .split(",")
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= flat.length);
        if (indices.length === 0) {
          return `  Usage: /review ${pathToken} restore <idx,idx,...>`;
        }
        for (const i of indices) {
          const entry = flat[i - 1]!;
          delete entry.item.review_state;
          delete entry.item.review_note;
        }
        persist();
        return `  Restored ${indices.length} finding(s) to original verdict.`;
      }

      // ── /review … stats ──────────────────────────────────────
      // Top noisy patterns (≥3 sites, <50% confirm rate) ranked by
      // absolute FP count. Helps the reviewer spot patterns that
      // need to be tuned, suppressed, or scoped.
      if (cmd === "stats") {
        const metrics = audit.pattern_metrics;
        if (!metrics || Object.keys(metrics).length === 0) {
          return "  No pattern_metrics on this audit (re-run with verifier active).";
        }
        type Row = { id: string; sites: number; conf: number; fp: number; rate: number };
        const rows: Row[] = [];
        for (const [id, m] of Object.entries(metrics)) {
          if (m.unique_sites < 1) continue;
          const rate = m.confirmed_rate ?? 0;
          rows.push({
            id,
            sites: m.unique_sites,
            conf: m.confirmed,
            fp: m.false_positive,
            rate,
          });
        }
        // Top noise first (low rate, high FP), then total volume.
        rows.sort((a, b) => {
          if (a.rate !== b.rate) return a.rate - b.rate;
          return b.fp - a.fp;
        });
        const out: string[] = ["  Pattern stats (lowest confirm rate first):", ""];
        out.push("  | Pattern                     | Sites | Confirmed | FP  | Confirm rate |");
        out.push("  |-----------------------------|-------|-----------|-----|--------------|");
        for (const r of rows.slice(0, 15)) {
          const pct = `${Math.round(r.rate * 100)}%`;
          out.push(
            `  | ${r.id.padEnd(27)} | ${String(r.sites).padStart(5)} | ${String(r.conf).padStart(9)} | ${String(r.fp).padStart(3)} | ${pct.padStart(12)} |`,
          );
        }
        const reviewerActions = (audit.findings.length + (audit.false_positives_detail ?? []).length)
          ? flat.filter((e) => e.item.review_state).length
          : 0;
        out.push("");
        out.push(`  Total findings reviewed (any state set): ${reviewerActions} of ${flat.length}`);
        return out.join("\n");
      }

      // ── /review … export ─────────────────────────────────────
      // Emit reviewer decisions as JSON for CI gating. Stable shape:
      //   { reviewed: [{ pattern_id, file, line, state, reason?, note?, severity }, ...],
      //     summary: { confirmed, ignored, demoted_fp, promoted, untouched } }
      if (cmd === "export") {
        type Row = {
          pattern_id: string;
          file: string;
          line: number;
          state: string | null;
          reason: string | null;
          note: string | null;
          severity: string;
        };
        const rows: Row[] = flat.map((e) => ({
          pattern_id: e.item.pattern_id,
          file: e.item.file.replace(projectRoot + "/", ""),
          line: e.item.line,
          state: e.item.review_state ?? null,
          reason: e.item.review_reason ?? null,
          note: e.item.review_note ?? null,
          severity: e.item.severity,
        }));
        const summary = {
          total: rows.length,
          confirmed: rows.filter((r) => r.state === "confirmed").length,
          promoted: rows.filter((r) => r.state === "promoted").length,
          demoted_fp: rows.filter((r) => r.state === "demoted_fp").length,
          ignored: rows.filter((r) => r.state === "ignored").length,
          untouched: rows.filter((r) => r.state === null).length,
        };
        const exportPath = resolvePath(projectRoot, "AUDIT_REVIEW.json");
        // v2.10.367 — refuse exports that would write outside the
        // project root (symlink / .. resolution edge cases). The
        // resolvePath already collapses `..`, but a symlinked
        // projectRoot could still escape; realpath confirms.
        const { realpathSync } = await import("node:fs");
        try {
          const realProject = realpathSync(projectRoot);
          // exportPath may not exist yet — realpath its parent.
          const { dirname } = await import("node:path");
          const realParent = realpathSync(dirname(exportPath));
          // v2.10.368 — bare startsWith() lets `/proj` match
          // `/projother/X`. Equality check + separator-suffixed
          // startsWith eliminates the prefix collision.
          const sep = require("node:path").sep;
          if (realParent !== realProject && !realParent.startsWith(realProject + sep)) {
            return `  Export refused: target ${exportPath} escapes the project root.`;
          }
        } catch {
          /* projectRoot disappeared mid-flight — fall through to write attempt */
        }
        const payload = JSON.stringify({ summary, reviewed: rows }, null, 2);
        try {
          writeFs(exportPath, payload);
          return `  Exported ${rows.length} reviewed item(s) → ${exportPath.replace(projectRoot + "/", "")}`;
        } catch (err) {
          return `  Export failed: ${(err as Error).message}`;
        }
      }

      // ── Legacy: keep / drop / all / none (operate on confirmed bucket only)
      if (cmd === "all") {
        return `  No changes — all ${audit.findings.length} confirmed finding(s) remain.`;
      }
      if (cmd === "keep" || cmd === "drop" || cmd === "none") {
        const confirmedRange = audit.findings.length;
        const indicesArg = tokens.join(" ").replace(/\s/g, "");
        let dropLocalIdx: number[];
        if (cmd === "none") {
          dropLocalIdx = audit.findings.map((_, i) => i);
        } else {
          const parsed = indicesArg
            .split(",")
            .map((s) => Number.parseInt(s, 10))
            .filter((n) => Number.isFinite(n) && n >= 1 && n <= confirmedRange);
          if (parsed.length === 0) {
            return (
              `  No valid indices in "${indicesArg}".\n` +
              `  Confirmed indices: 1..${confirmedRange}.\n` +
              `  Example: /review ${pathToken} keep 1,3`
            );
          }
          dropLocalIdx = cmd === "keep"
            ? audit.findings.map((_, i) => i + 1).filter((n) => !parsed.includes(n)).map((n) => n - 1)
            : parsed.map((n) => n - 1);
        }
        // Translate confirmed-local indices to global indices and demote.
        const moved: string[] = [];
        for (const lIdx of dropLocalIdx) {
          const globalIdx = lIdx + 1; // confirmed bucket is the first slice in `flat`
          const entry = flat[globalIdx - 1]!;
          if (entry.bucket !== "confirmed") continue;
          entry.item.review_state = "demoted_fp";
          entry.item.verification = {
            ...entry.item.verification,
            verdict: "false_positive",
            reasoning: `[reviewer demoted via ${cmd}] ${entry.item.verification.reasoning}`,
          };
          entry.bucket = "fp";
          moved.push(`#${globalIdx}: ${entry.item.pattern_id} @ ${entry.item.file.replace(projectRoot + "/", "")}:${entry.item.line}`);
        }
        persist();
        return [
          `  ${cmd}: demoted ${moved.length} finding(s) → false_positives_detail`,
          ...moved.map((s) => `    ${s}`),
          "",
          `  Next: /fix ${pathToken}`,
        ].join("\n");
      }

      return (
        `  Unknown subcommand "${cmd}".\n` +
        `  Try: list | promote | demote | tag | untag | note | assign | ignore | restore | stats | export\n` +
        `  Or run /review ${pathToken} (no args) for the dashboard.`
      );
    }

    case "fix": {
      // v2.10.353 — `/fix <path> --safe-only` restricts the fixer
      // to bespoke rewrites only (fix_support === "rewrite"). The
      // annotate-only and manual-only buckets are skipped with an
      // explicit message telling the reviewer how to apply them
      // later. For PR gate flows where you want auto-merge on a
      // green audit, --safe-only is the right default — recipe
      // annotations require human review and should not land
      // automatically.
      // CL.4 (v2.10.374) — shell-quote-aware tokenization. Replaces
      // split(/\s+/) which broke paths with spaces and forced quoted
      // /review note text to be unquoted. Unterminated-quote errors
      // bubble up as a friendly message instead of crashing the TUI.
      let tokens: string[];
      try {
        tokens = tokenize(args);
      } catch (err) {
        return `  ${(err as Error).message}`;
      }
      // F6 (v2.10.369) — three explicit /fix modes:
      //   --safe-only  : only fix_support === "rewrite" findings, run normal fixer
      //   --annotate   : every finding becomes an audit-note comment, no logic change
      //   --all        : explicit name for the default behavior (rewrites + annotates + manual)
      // CL.8 (v2.10.378) — --ci is a synonym for --safe-only. CI
      // pipelines should never auto-apply audit-note comments or
      // claim a manual-tier finding was "fixed"; --safe-only is the
      // right semantics. Naming it --ci makes the intent clear at
      // the call site (`/fix . --ci`) without forcing the reviewer
      // to remember which flag set is the safe one.
      const ciMode = tokens.includes("--ci");
      const safeOnly = tokens.includes("--safe-only") || ciMode;
      const annotateMode = tokens.includes("--annotate");
      const allMode = tokens.includes("--all");
      // --safe-only / --ci and --annotate are mutually exclusive —
      // they disagree on what should happen to rewrite-tier findings.
      if (safeOnly && annotateMode) {
        const safeFlag = ciMode ? "--ci (alias for --safe-only)" : "--safe-only";
        return (
          `  ${safeFlag} and --annotate are mutually exclusive.\n` +
          `  --safe-only applies rewrites; --annotate emits audit-note comments without changing code.\n` +
          `  Pick one.`
        );
      }
      const pathToken = tokens.find((t) => !t.startsWith("--")) ?? ".";
      const { resolve: resolvePath } = await import("node:path");
      const { existsSync, readFileSync: readFs } = await import("node:fs");
      const projectRoot = resolvePath(appConfig.workingDirectory, pathToken);

      // Look for AUDIT_REPORT.json first (from --json flag), fall back to re-scanning
      const jsonPath = resolvePath(projectRoot, "AUDIT_REPORT.json");
      const mdPath = resolvePath(projectRoot, "AUDIT_REPORT.md");

      if (!existsSync(jsonPath) && !existsSync(mdPath)) {
        return `  No AUDIT_REPORT found in ${pathToken}/\n  Run /scan ${pathToken} first.`;
      }

      let auditResult: import("../../core/audit-engine/types").AuditResult;

      if (existsSync(jsonPath)) {
        // v2.10.368 — same crash-safety guard as the /review JSON
        // parse: a corrupt or partially-written AUDIT_REPORT.json
        // shouldn't crash the TUI when /fix is invoked.
        try {
          auditResult = JSON.parse(readFs(jsonPath, "utf-8"));
        } catch (err) {
          return (
            `  Could not parse ${jsonPath.replace(projectRoot + "/", "")}: ${(err as Error).message}.\n` +
            `  Re-run /scan ${pathToken} to regenerate.`
          );
        }
      } else {
        // Refuse to auto-fix without a verified audit. Previously this
        // re-ran the scan with skipVerification:true and stamped every
        // candidate as 'CONFIRMED' via a hard-coded llmCallback, then
        // handed that to applyFixes() which is contractually for
        // 'confirmed findings only' (see fixer.ts:64). That let regex
        // false positives get patched into user code. Safer: require
        // an actual /scan first so the user has a chance to review.
        return (
          `  /fix refuses to run without a verified AUDIT_REPORT.json.\n` +
          `  Reason: auto-fixing static-only candidates can patch false\n` +
          `  positives into your code.\n\n` +
          `  Next step: run /scan ${pathToken} (without skip-verify),\n` +
          `  review AUDIT_REPORT.md, then /fix.`
        );
      }

      if (auditResult.findings.length === 0) {
        return `  No findings to fix in ${pathToken}/`;
      }

      // Guard: never apply fixes derived from a skip-verified scan.
      // A verified audit has findings whose verdict === 'confirmed'.
      // Static-only scans produce findings with no verification, and
      // applyFixes should not act on them.
      const unverified = auditResult.findings.filter(
        (f) => !(f as { verification?: { verdict?: string } }).verification?.verdict ||
          (f as { verification: { verdict: string } }).verification.verdict !== "confirmed",
      );
      if (unverified.length > 0 && unverified.length === auditResult.findings.length) {
        return (
          `  /fix refuses to apply: all ${auditResult.findings.length} finding(s) in the ` +
          `report lack a 'confirmed' verdict.\n` +
          `  Reason: the fixer is contractually limited to confirmed findings ` +
          `(see src/core/audit-engine/fixer.ts:64).\n` +
          `  Next step: re-run /scan ${pathToken} WITHOUT --skip-verify, or run ` +
          `/review ${pathToken} to mark specific findings as confirmed.`
        );
      }

      const { applyFixes } = await import("../../core/audit-engine/fixer.js");
      // Only pass the confirmed subset so mixed reports can't leak
      // unverified findings through applyFixes.
      // v2.10.353 — when --safe-only is set, narrow further to only
      // bespoke rewrites (fix_support === "rewrite"). Annotate /
      // manual entries get tracked in a separate counter so the
      // summary tells the user what was held back.
      const confirmedFindings = auditResult.findings.filter(
        (f) =>
          (f as { verification?: { verdict?: string } }).verification?.verdict ===
          "confirmed",
      );
      const filteredFindings = safeOnly
        ? confirmedFindings.filter(
            (f) => (f as { fix_support?: string }).fix_support === "rewrite",
          )
        : confirmedFindings;
      const heldBackForSafeOnly = safeOnly
        ? confirmedFindings.length - filteredFindings.length
        : 0;
      const confirmedOnly = {
        ...auditResult,
        findings: filteredFindings,
      };
      // F6 — annotateOnly forces every finding through the recipe path.
      const fixes = applyFixes(confirmedOnly, { annotateOnly: annotateMode });

      // Four-way split (v2.10.328, Sprint 3): transformed (real code
      // change), annotated (advisory comment), manual (no fixer
      // exists for the pattern), skipped (fixer exists but didn't
      // apply this run — idempotent re-runs end up here). v327 and
      // earlier conflated manual and skipped, hiding the difference
      // between "you have to patch this by hand" and "already fixed".
      const transformed = fixes.filter((f) => f.kind === "transformed");
      const annotated = fixes.filter((f) => f.kind === "annotated");
      const manual = fixes.filter((f) => f.kind === "manual");
      const skipped = fixes.filter((f) => f.kind === "skipped");

      const modeLabel = safeOnly
        ? ciMode
          ? "  (--ci mode → --safe-only)"
          : "  (--safe-only mode)"
        : annotateMode
          ? "  (--annotate mode — no code rewrites, audit-note comments only)"
          : allMode
            ? "  (--all mode)"
            : "";
      const lines: string[] = [
        `  KCode Auto-Fixer${modeLabel}`,
        `    Project: ${projectRoot}`,
        "",
        `    ✅ Rewritten: ${transformed.length} (real code transforms)`,
        `    📝 Annotated: ${annotated.length} (advisory \`audit-note\` comments — buggy code unchanged)`,
        `    ✋ Manual:    ${manual.length} (no mechanical fix — patch by hand)`,
        `    ⏭  Skipped:   ${skipped.length} (idempotent — already fixed in a previous run)`,
        "",
      ];

      if (transformed.length > 0) {
        lines.push("  Real fixes (code rewritten):");
        for (const f of transformed) {
          const rel = f.file.replace(projectRoot + "/", "");
          lines.push(`    ✅ ${rel}:${f.line}  ${f.description}`);
        }
      }

      if (annotated.length > 0) {
        lines.push("", "  Advisory annotations (audit-note comments added, code unchanged):");
        for (const f of annotated.slice(0, 10)) {
          const rel = f.file.replace(projectRoot + "/", "");
          lines.push(`    📝 ${rel}:${f.line}  ${f.pattern_id} — ${f.description}`);
        }
        if (annotated.length > 10) {
          lines.push(`    ... and ${annotated.length - 10} more`);
        }
        lines.push(
          "    (Use `grep -rn audit-note` to list all advisories in the project.)",
        );
      }

      if (manual.length > 0) {
        lines.push("", "  Manual-only (these patterns have no autofixer — review by hand):");
        for (const f of manual.slice(0, 10)) {
          const rel = f.file.replace(projectRoot + "/", "");
          lines.push(`    ✋ ${rel}:${f.line}  ${f.pattern_id}`);
        }
        if (manual.length > 10) {
          lines.push(`    ... and ${manual.length - 10} more`);
        }
      }

      if (skipped.length > 0) {
        lines.push("", "  Skipped (fix already applied in a previous run, or unreachable site):");
        for (const f of skipped.slice(0, 10)) {
          const rel = f.file.replace(projectRoot + "/", "");
          lines.push(`    ⏭  ${rel}:${f.line}  ${f.description}`);
        }
        if (skipped.length > 10) {
          lines.push(`    ... and ${skipped.length - 10} more`);
        }
      }

      // v2.10.353 — show what --safe-only held back so the reviewer
      // knows there's a follow-up step.
      if (safeOnly && heldBackForSafeOnly > 0) {
        lines.push(
          "",
          `  ⚠ --safe-only held back ${heldBackForSafeOnly} finding(s) (annotate / manual tier).`,
          `    To apply them: re-run \`/fix ${pathToken}\` (without --safe-only).`,
          "    The held-back set requires human review before landing.",
        );
      }

      // Pick a build/test command based on the files present in the project
      // root. The old hardcoded cmake hint was wrong for every non-C++ project.
      const { existsSync: fsExists } = await import("node:fs");
      const { join: pJoin } = await import("node:path");
      const hint = (() => {
        if (fsExists(pJoin(projectRoot, "package.json"))) {
          // Bun moved from binary bun.lockb to text bun.lock — check both.
          const hasBun = fsExists(pJoin(projectRoot, "bun.lock")) ||
            fsExists(pJoin(projectRoot, "bun.lockb"));
          if (hasBun) return "bun test";
          if (fsExists(pJoin(projectRoot, "pnpm-lock.yaml"))) return "pnpm test";
          if (fsExists(pJoin(projectRoot, "yarn.lock"))) return "yarn test";
          return "npm test";
        }
        if (fsExists(pJoin(projectRoot, "Cargo.toml"))) return "cargo test";
        if (fsExists(pJoin(projectRoot, "go.mod"))) return "go test ./...";
        if (fsExists(pJoin(projectRoot, "pyproject.toml")) || fsExists(pJoin(projectRoot, "setup.py"))) {
          return "pytest";
        }
        if (fsExists(pJoin(projectRoot, "Gemfile"))) return "bundle exec rspec";
        if (fsExists(pJoin(projectRoot, "pom.xml"))) return "mvn test";
        if (fsExists(pJoin(projectRoot, "build.gradle")) || fsExists(pJoin(projectRoot, "build.gradle.kts"))) {
          return "gradle test";
        }
        if (fsExists(pJoin(projectRoot, "mix.exs"))) return "mix test";
        if (fsExists(pJoin(projectRoot, "build.zig"))) return "zig build test";
        if (fsExists(pJoin(projectRoot, "dune-project"))) return "dune runtest";
        if (fsExists(pJoin(projectRoot, "stack.yaml")) || fsExists(pJoin(projectRoot, "cabal.project"))) {
          return "cabal test";
        }
        if (fsExists(pJoin(projectRoot, "pubspec.yaml"))) return "flutter test";
        if (fsExists(pJoin(projectRoot, "Package.swift"))) return "swift test";
        if (fsExists(pJoin(projectRoot, "CMakeLists.txt"))) {
          return "cmake -B build && cmake --build build && ctest --test-dir build";
        }
        if (fsExists(pJoin(projectRoot, "Makefile"))) return "make test";
        return "# no test runner detected — verify manually";
      })();
      lines.push("", `  Run: cd ${pathToken} && ${hint}`);
      lines.push(`  to verify the fixes compile cleanly.`);

      return lines.join("\n");
    }

    default:
      return null;
  }
}
