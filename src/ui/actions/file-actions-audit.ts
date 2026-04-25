// Audit-related actions: /scan and /fix.
// Split out of file-actions.ts.

import type { ActionContext } from "./action-helpers.js";

export async function handleAuditAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { appConfig, args } = ctx;

  switch (action) {
    case "scan": {
      // Parse args: first token = path, optional flags
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const skipVerify = tokens.includes("--skip-verify");
      let pathToken = tokens.find((t) => !t.startsWith("--")) ?? ".";
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

      const { runAudit } = await import("../../core/audit-engine/audit-engine.js");
      const { generateMarkdownReport } = await import(
        "../../core/audit-engine/report-generator.js"
      );

      // Fire-and-forget: start the audit in the background, update global
      // scanState, and return immediately so Ink regains control of the
      // render loop. App.tsx polls scanState via setInterval to show progress.
      const { scanState, resetScanState } = await import(
        "../../core/audit-engine/scan-state.js"
      );
      const { buildAuditLlmCallbackFromConfigAsync } = await import(
        "../../core/audit-engine/llm-callback.js"
      );

      resetScanState();
      scanState.active = true;
      scanState.startTime = Date.now();
      scanState.phase = "discovery";

      const llmCallback = skipVerify
        ? async () => "VERDICT: CONFIRMED\nREASONING: static-only mode\n"
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
            // NO fallbackCallback here — we'll escalate manually after user approval.
            // /scan audits the whole project by design — no truncation.
            // Issue #111 v307 repro: user explicitly asked for unlimited scan.
            maxFiles: Number.MAX_SAFE_INTEGER,
            skipVerification: skipVerify,
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

              // Re-run full scan with cloud as primary. Wrapped in
              // try/catch because the verifier now aborts after 3
              // consecutive transport / 401 / 404 errors instead of
              // silently bucketing every candidate as needs_context.
              // When that happens we keep the primary pass result and
              // surface a clear error in scanState. v2.10.312.
              let cloudResult: typeof result | null = null;
              let cloudAbortError: string | null = null;
              try {
                cloudResult = await runAudit({
                  projectRoot,
                  llmCallback: fallbackCallback,
                  maxFiles: Number.MAX_SAFE_INTEGER,
                  skipVerification: false,
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

              // Merge: keep original confirmed + add cloud-confirmed (dedup by file:line).
              // Skip the merge entirely if the cloud pass aborted —
              // primary results stay untouched and the error is surfaced.
              if (cloudResult) {
              for (const f of cloudResult.findings) {
                if (!result.findings.some((e) => e.file === f.file && e.line === f.line)) {
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
              result.false_positives_detail = cloudResult.false_positives_detail.filter(
                (fp) =>
                  !result.findings.some(
                    (conf) => conf.file === fp.file && conf.line === fp.line,
                  ),
              );
              result.false_positives = result.false_positives_detail.length;
              result.needs_context_detail = (cloudResult.needs_context_detail ?? []).filter(
                (nc) =>
                  !result.findings.some(
                    (conf) => conf.file === nc.file && conf.line === nc.line,
                  ),
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
          scanState.error = err instanceof Error ? err.message : String(err);
        } finally {
          scanState.active = false;
        }
      })();

      // Return immediately — progress renders via polling in App.tsx
      return `  ◆ Scanning ${projectRoot.split("/").pop()}/ in background...`;
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
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
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
      const audit = JSON.parse(readFs(jsonPath, "utf-8")) as {
        findings: Reviewable[];
        false_positives: number;
        false_positives_detail?: Reviewable[];
        needs_context?: number;
        needs_context_detail?: Reviewable[];
        confirmed_findings: number;
      };

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
      const fmtItem = (
        globalIdx: number,
        e: Reviewable,
      ): string[] => {
        const rel = e.file.replace(projectRoot + "/", "");
        const tagStr = e.review_tags && e.review_tags.length > 0
          ? ` [tags: ${e.review_tags.join(", ")}]`
          : "";
        const reasonStr = e.review_reason ? ` (reason: ${e.review_reason})` : "";
        return [
          `    ${globalIdx}. ${icon(e.severity)} [${e.severity.toUpperCase()}] ${e.pattern_id}${reasonStr}${tagStr}`,
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

      // Helpers for promote/demote/tag/untag — parse comma-separated indices.
      const parseIndices = (raw: string): number[] => {
        return raw
          .split(",")
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= flat.length);
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
        writeFs(jsonPath, JSON.stringify(audit, null, 2));
      };

      // ── promote ───────────────────────────────────────────────
      if (cmd === "promote") {
        const indices = parseIndices(tokens.join(" "));
        if (indices.length === 0) {
          return `  Usage: /review ${pathToken} promote 7,8 — indices from the dashboard.`;
        }
        const moved: string[] = [];
        for (const idx of indices) {
          const entry = flat[idx - 1]!;
          if (entry.bucket === "confirmed") {
            moved.push(`#${idx}: already confirmed (no change)`);
            continue;
          }
          entry.item.review_state = "promoted";
          if (!entry.item.review_reason) entry.item.review_reason = "manual_confirmation";
          entry.bucket = "confirmed";
          moved.push(`#${idx}: ${entry.item.pattern_id} @ ${entry.item.file.replace(projectRoot + "/", "")}:${entry.item.line}`);
        }
        persist();
        return [
          `  Promoted ${indices.length} finding(s) → confirmed`,
          ...moved.map((s) => `    ${s}`),
          "",
          `  Next: /fix ${pathToken}`,
        ].join("\n");
      }

      // ── demote ────────────────────────────────────────────────
      if (cmd === "demote") {
        const indices = parseIndices(tokens.join(" "));
        if (indices.length === 0) {
          return `  Usage: /review ${pathToken} demote 2,3 — indices from the dashboard.`;
        }
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
            reasoning: `[reviewer demoted] ${entry.item.verification.reasoning}`,
          };
          entry.bucket = "fp";
          moved.push(`#${idx}: ${entry.item.pattern_id} @ ${entry.item.file.replace(projectRoot + "/", "")}:${entry.item.line}`);
        }
        persist();
        return [
          `  Demoted ${indices.length} finding(s) → false_positives_detail`,
          ...moved.map((s) => `    ${s}`),
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
        const idx = Number.parseInt(idxArg, 10);
        if (!Number.isFinite(idx) || idx < 1 || idx > flat.length) {
          return `  Usage: /review ${pathToken} tag <index> <reason>\n  Valid reasons: ${[...validReasons].join(", ")}`;
        }
        if (!validReasons.has(reasonArg)) {
          return `  Unknown reason "${reasonArg}".\n  Valid: ${[...validReasons].join(", ")}`;
        }
        const entry = flat[idx - 1]!;
        entry.item.review_reason = reasonArg as Reviewable["review_reason"];
        persist();
        return `  Tagged #${idx} with reason: ${reasonArg}`;
      }

      if (cmd === "untag") {
        const idxArg = tokens.shift() ?? "";
        const idx = Number.parseInt(idxArg, 10);
        if (!Number.isFinite(idx) || idx < 1 || idx > flat.length) {
          return `  Usage: /review ${pathToken} untag <index>`;
        }
        const entry = flat[idx - 1]!;
        delete entry.item.review_reason;
        persist();
        return `  Cleared review_reason on #${idx}`;
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
        `  Try: list | promote | demote | tag | untag\n` +
        `  Or run /review ${pathToken} (no args) for the dashboard.`
      );
    }

    case "fix": {
      const pathToken = (args ?? "").trim() || ".";
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
        auditResult = JSON.parse(readFs(jsonPath, "utf-8"));
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
      const confirmedOnly = {
        ...auditResult,
        findings: auditResult.findings.filter(
          (f) =>
            (f as { verification?: { verdict?: string } }).verification?.verdict ===
            "confirmed",
        ),
      };
      const fixes = applyFixes(confirmedOnly);

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

      const lines: string[] = [
        `  KCode Auto-Fixer`,
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
