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
      // /review fprime/                — list confirmed findings with indices
      // /review fprime/ keep 1,3,5     — mark only those findings confirmed; demote rest to FP
      // /review fprime/ drop 2,4       — demote those findings to FP; keep rest
      // /review fprime/ all            — keep everything as-is (no-op)
      // /review fprime/ none           — demote ALL to FP (cancel pre-/fix)
      //
      // Replaces the previous "manually edit AUDIT_REPORT.json with python"
      // workflow that broke the autonomous-flow promise. Issue #111 v322.
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const pathToken = tokens.shift() ?? ".";
      const cmd = (tokens.shift() ?? "").toLowerCase();
      const indicesArg = tokens.join(" ").replace(/\s/g, "");

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

      const audit = JSON.parse(readFs(jsonPath, "utf-8")) as {
        findings: Array<{
          pattern_id: string;
          pattern_title: string;
          severity: string;
          file: string;
          line: number;
          verification: { reasoning: string; verdict: string };
        }>;
        false_positives: number;
        false_positives_detail?: typeof audit.findings;
        confirmed_findings: number;
      };

      // No subcommand → print the list with indices.
      if (!cmd) {
        if (audit.findings.length === 0) {
          return (
            `  ${pathToken}/AUDIT_REPORT.json has 0 confirmed findings.\n` +
            `  Run /scan ${pathToken} first or check the FP details in the JSON.`
          );
        }
        const lines: string[] = [
          `  KCode Review`,
          `    Project: ${projectRoot}`,
          `    ${audit.findings.length} confirmed finding(s) — review each before /fix:`,
          "",
        ];
        for (let i = 0; i < audit.findings.length; i++) {
          const f = audit.findings[i]!;
          const rel = f.file.replace(projectRoot + "/", "");
          const icon =
            f.severity === "critical" ? "🔴" :
            f.severity === "high" ? "🟠" :
            f.severity === "medium" ? "🟡" : "🟢";
          lines.push(`    ${i + 1}. ${icon} [${f.severity.toUpperCase()}] ${f.pattern_id}`);
          lines.push(`       ${rel}:${f.line}`);
          lines.push(`       ${f.verification.reasoning.slice(0, 220)}`);
          lines.push("");
        }
        lines.push("  Decide which to keep, then run ONE of:");
        lines.push(`    /review ${pathToken} keep 1,3   — keep only those, drop the rest as FP`);
        lines.push(`    /review ${pathToken} drop 2,4   — drop those as FP, keep the rest`);
        lines.push(`    /review ${pathToken} none       — mark all as FP (cancel before /fix)`);
        lines.push(`    /review ${pathToken} all        — keep all as-is`);
        return lines.join("\n");
      }

      if (cmd === "all") {
        return `  No changes — all ${audit.findings.length} finding(s) remain confirmed.`;
      }

      // Parse indices for keep/drop/none.
      const allIndices = new Set(audit.findings.map((_, i) => i + 1));
      let keepSet: Set<number>;
      if (cmd === "none") {
        keepSet = new Set();
      } else if (cmd === "keep" || cmd === "drop") {
        const parsed = indicesArg
          .split(",")
          .map((s) => Number.parseInt(s, 10))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= audit.findings.length);
        if (parsed.length === 0) {
          return (
            `  No valid indices in "${indicesArg}".\n` +
            `  Indices must be between 1 and ${audit.findings.length}.\n` +
            `  Example: /review ${pathToken} keep 1,3`
          );
        }
        keepSet = cmd === "keep"
          ? new Set(parsed)
          : new Set(audit.findings.map((_, i) => i + 1).filter((i) => !parsed.includes(i)));
      } else {
        return (
          `  Unknown subcommand "${cmd}". Valid: keep, drop, all, none.\n` +
          `  Run /review ${pathToken} (no args) to see the list.`
        );
      }

      const kept = audit.findings.filter((_, i) => keepSet.has(i + 1));
      const dropped = audit.findings.filter((_, i) => !keepSet.has(i + 1));

      // Move dropped findings to false_positives_detail with verdict downgraded.
      const fpDetail = audit.false_positives_detail ?? [];
      for (const d of dropped) {
        fpDetail.push({
          ...d,
          verification: {
            ...d.verification,
            verdict: "false_positive",
            reasoning: `[reviewed by user — demoted from confirmed] ${d.verification.reasoning}`,
          } as typeof d.verification,
        });
      }

      audit.findings = kept;
      audit.confirmed_findings = kept.length;
      audit.false_positives_detail = fpDetail;
      audit.false_positives = (audit.false_positives ?? 0) + dropped.length;

      writeFs(jsonPath, JSON.stringify(audit, null, 2));

      const lines: string[] = [
        `  KCode Review — applied`,
        `    Project: ${projectRoot}`,
        "",
        `    ✅ Kept:    ${kept.length} confirmed finding(s)`,
        `    🗑  Dropped: ${dropped.length} (moved to false_positives_detail)`,
      ];
      if (kept.length > 0) {
        lines.push("");
        lines.push("    Confirmed findings going to /fix:");
        for (const f of kept) {
          const rel = f.file.replace(projectRoot + "/", "");
          lines.push(`      • ${rel}:${f.line}  [${f.pattern_id}]`);
        }
      }
      lines.push("");
      lines.push(`  Next: /fix ${pathToken}`);
      void allIndices; // kept for future range/range-with-indices syntax
      return lines.join("\n");
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

      // Three-way split: transformed (real code change), annotated
      // (audit-note advisory comment only — finding still needs a manual
      // fix), skipped (nothing applied). The previous UI lumped
      // transformed and annotated together as "Applied", which lied to
      // the user: they'd see "5 applied" and then discover every
      // "fix" was just a TODO comment.
      const transformed = fixes.filter((f) => f.kind === "transformed");
      const annotated = fixes.filter((f) => f.kind === "annotated");
      const skipped = fixes.filter((f) => f.kind === "skipped");

      const lines: string[] = [
        `  KCode Auto-Fixer`,
        `    Project: ${projectRoot}`,
        "",
        `    ✅ Fixed: ${transformed.length} (real code transforms)`,
        `    📝 Annotated: ${annotated.length} (advisory comment only — still needs manual fix)`,
        `    ⏭  Skipped: ${skipped.length}`,
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

      if (skipped.length > 0) {
        lines.push("", "  Skipped (no fix strategy available):");
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
