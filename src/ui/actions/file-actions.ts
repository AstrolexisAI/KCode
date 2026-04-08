// File and code inspection actions
// Extracted from utility-actions.ts

import type { ActionContext } from "./action-helpers.js";

export async function handleFileAction(action: string, ctx: ActionContext): Promise<string | null> {
  const { appConfig, args, setCompleted } = ctx;

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
      const { buildAuditLlmCallbackFromConfig } = await import(
        "../../core/audit-engine/llm-callback.js"
      );

      resetScanState();
      scanState.active = true;
      scanState.startTime = Date.now();
      scanState.phase = "discovery";

      const llmCallback = skipVerify
        ? async () => "VERDICT: CONFIRMED\nREASONING: static-only mode\n"
        : buildAuditLlmCallbackFromConfig(appConfig);

      // Auto-detect cloud fallback for hybrid verification
      // Prefers OAuth bridge (subscription) over API key (per-token)
      let fallbackCallback: ((prompt: string) => Promise<string>) | undefined;
      if (!skipVerify) {
        const { buildCloudFallbackCallback, detectCloudFallback } = await import(
          "../../core/audit-engine/cloud-fallback.js"
        );
        const cloudConfig = await detectCloudFallback(appConfig.apiBase);
        if (cloudConfig.available) {
          fallbackCallback = (await buildCloudFallbackCallback(appConfig.apiBase)) ?? undefined;
          scanState.cloudProvider = cloudConfig.provider;
        }
      }

      // Background async — NOT awaited
      (async () => {
        try {
          // Phase 1: run audit WITHOUT fallback (local model only)
          const result = await runAudit({
            projectRoot,
            llmCallback,
            // NO fallbackCallback here — we'll escalate manually after user approval
            maxFiles: 500,
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

          // Phase 2: if there are FPs or NEEDS_CONTEXT and cloud is available, offer second opinion
          const fpCount = result.false_positives;
          const ncCount = result.candidates_found - result.confirmed_findings - result.false_positives;
          const reviewable = fpCount + ncCount;

          if (reviewable > 0 && fallbackCallback) {
            const reason = fpCount > 0
              ? `${fpCount} marked as false positive${ncCount > 0 ? `, ${ncCount} uncertain` : ""}`
              : `${ncCount} need deeper analysis`;
            scanState.phase = reason;
            scanState.pendingEscalation = {
              count: reviewable,
              provider: scanState.cloudProvider ?? "cloud",
              reason,
            };

            // Wait for user to approve/deny (polled by App.tsx)
            while (scanState.pendingEscalation && scanState.escalationApproved === undefined) {
              await new Promise((r) => setTimeout(r, 200));
            }

            if (scanState.escalationApproved) {
              scanState.phase = `☁ Re-verifying with ${scanState.cloudProvider}...`;
              scanState.pendingEscalation = undefined;
              scanState.verified = 0;
              scanState.total = 0;
              scanState.escalated = 0;

              // Re-run full scan with cloud as primary
              const cloudResult = await runAudit({
                projectRoot,
                llmCallback: fallbackCallback!,
                maxFiles: 500,
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

              // Merge: keep original confirmed + add cloud-confirmed (dedup by file:line)
              for (const f of cloudResult.findings) {
                if (!result.findings.some((e) => e.file === f.file && e.line === f.line)) {
                  f.verification.reasoning = `[☁ second opinion] ${f.verification.reasoning}`;
                  result.findings.push(f);
                }
              }
              result.confirmed_findings = result.findings.length;
              result.false_positives = result.candidates_found - result.confirmed_findings;
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
            `    Files scanned:      ${result.files_scanned}`,
            `    Candidates found:   ${result.candidates_found}`,
            `    Confirmed findings: ${result.confirmed_findings}`,
            `    False positives:    ${result.false_positives}`,
            `    Duration:           ${(result.elapsed_ms / 1000).toFixed(1)}s`,
          ];
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
        // Re-run scan in skip-verify mode to get structured findings fast
        const { runAudit } = await import("../../core/audit-engine/audit-engine.js");
        auditResult = await runAudit({
          projectRoot,
          llmCallback: async () => "VERDICT: CONFIRMED\nREASONING: static-only\n",
          skipVerification: true,
        });
      }

      if (auditResult.findings.length === 0) {
        return `  No findings to fix in ${pathToken}/`;
      }

      const { applyFixes } = await import("../../core/audit-engine/fixer.js");
      const fixes = applyFixes(auditResult);

      const applied = fixes.filter((f) => f.applied);
      const skipped = fixes.filter((f) => !f.applied);

      const lines: string[] = [
        `  KCode Auto-Fixer`,
        `    Project: ${projectRoot}`,
        "",
        `    ✅ Applied: ${applied.length} fixes`,
        `    ⏭  Skipped: ${skipped.length}`,
        "",
      ];

      if (applied.length > 0) {
        lines.push("  Applied fixes:");
        for (const f of applied) {
          const rel = f.file.replace(projectRoot + "/", "");
          lines.push(`    ✅ ${rel}:${f.line}  ${f.description}`);
        }
      }

      if (skipped.length > 0) {
        lines.push("", "  Skipped (manual fix needed):");
        for (const f of skipped.slice(0, 10)) {
          const rel = f.file.replace(projectRoot + "/", "");
          lines.push(`    ⏭  ${rel}:${f.line}  ${f.description}`);
        }
        if (skipped.length > 10) {
          lines.push(`    ... and ${skipped.length - 10} more`);
        }
      }

      lines.push("", `  Run: cd ${pathToken} && mkdir -p build && cd build && cmake .. && make`);
      lines.push(`  to verify the fixes compile cleanly.`);

      return lines.join("\n");
    }

    case "pr": {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const dryRun = tokens.includes("--dry-run");
      const repoFlag = tokens.indexOf("--repo");
      const repo = repoFlag >= 0 ? tokens[repoFlag + 1] : undefined;
      const pathToken = tokens.find((t) => !t.startsWith("--") && t !== repo) ?? ".";
      const { resolve: resolvePath } = await import("node:path");
      const projectRoot = resolvePath(appConfig.workingDirectory, pathToken);

      // Background execution — same pattern as /scan
      const { prState, resetPrState } = await import("../../core/audit-engine/pr-state.js");
      const { createPr } = await import("../../core/audit-engine/pr-generator.js");
      const { buildAuditLlmCallbackFromConfig } = await import(
        "../../core/audit-engine/llm-callback.js"
      );

      resetPrState();
      prState.active = true;
      prState.startTime = Date.now();
      prState.step = "Starting...";

      // Fire-and-forget
      (async () => {
        try {
          const result = await createPr({
            projectRoot,
            llmCallback: buildAuditLlmCallbackFromConfig(appConfig),
            repo,
            dryRun,
            onStep: (step) => { prState.step = step; },
          });

          const lines: string[] = [
            `  KCode PR Generator`,
            `    Project:  ${projectRoot}`,
            `    Branch:   ${result.branchName}`,
            `    Files:    ${result.filesChanged} changed`,
            "",
          ];

          if (result.dryRun) {
            lines.push("    Mode: --dry-run (no push, no PR created)");
            lines.push("");
          }

          if (result.commitHash) {
            lines.push(`    ✅ Committed: ${result.commitHash}`);
          }
          if (result.pushError) {
            lines.push(`    ⚠️  Push failed: ${result.pushError}`);
            lines.push(`    Branch ready locally. To submit as fork PR:`);
            lines.push(`      cd ${pathToken} && git remote add fork https://github.com/YOUR_USER/IDF.git`);
            lines.push(`      git push -u fork ${result.branchName}`);
            lines.push(`      gh pr create --repo nasa/IDF --head YOUR_USER:${result.branchName}`);
          } else if (result.prUrl) {
            lines.push(`    ✅ PR created: ${result.prUrl}`);
          }

          lines.push("");
          lines.push("  PR Description:");
          lines.push("  " + "─".repeat(60));
          for (const line of result.prDescription.split("\n")) {
            lines.push(`  ${line}`);
          }
          lines.push("  " + "─".repeat(60));
          lines.push("");
          lines.push("  Signed: Astrolexis.space — Kulvex Code");

          prState.result = {
            branchName: result.branchName,
            commitHash: result.commitHash,
            prUrl: result.prUrl,
            filesChanged: result.filesChanged,
            pushFailed: result.pushError,
            prDescription: lines.join("\n"),
          };
        } catch (err) {
          prState.error = err instanceof Error ? err.message : String(err);
        } finally {
          prState.active = false;
        }
      })();

      return `  ◆ Generating PR for ${projectRoot.split("/").pop()}/ in background...`;
    }

    case "github": {
      const { execSync } = await import("node:child_process");
      const sub = (args ?? "").trim().toLowerCase() || "status";

      // Check if gh CLI is installed
      let ghInstalled = false;
      try {
        execSync("gh --version", { encoding: "utf-8", timeout: 5000 });
        ghInstalled = true;
      } catch { /* not installed */ }

      if (!ghInstalled) {
        return [
          "  GitHub CLI (gh) not installed.",
          "",
          "  Install it:",
          "    Fedora:  sudo dnf install gh",
          "    Ubuntu:  sudo apt install gh",
          "    macOS:   brew install gh",
          "    Other:   https://cli.github.com",
        ].join("\n");
      }

      if (sub === "login") {
        // Check if already logged in
        try {
          const status = execSync("gh auth status 2>&1", { encoding: "utf-8", timeout: 10000 });
          if (status.includes("Logged in")) {
            const user = execSync("gh api user --jq .login 2>/dev/null", {
              encoding: "utf-8",
              timeout: 10000,
            }).trim();
            return [
              `  ✅ Already authenticated as: ${user}`,
              "",
              "  To re-authenticate: ! gh auth login",
              "  To logout: ! gh auth logout",
            ].join("\n");
          }
        } catch { /* not logged in */ }

        // Start device flow login
        try {
          // gh auth login --web does device flow: shows URL + code
          const result = execSync(
            "gh auth login -h github.com -p https --web 2>&1 || true",
            { encoding: "utf-8", timeout: 60000 },
          );

          // Parse the one-time code and URL from gh output
          const codeMatch = result.match(/one-time code[:\s]+([A-Z0-9-]+)/i);
          const urlMatch = result.match(/(https:\/\/github\.com\/login\/device)/i);

          if (codeMatch) {
            return [
              "  GitHub Login — Device Flow",
              "",
              `  1. Open: ${urlMatch?.[1] ?? "https://github.com/login/device"}`,
              `  2. Enter code: ${codeMatch[1]}`,
              "  3. Authorize KCode",
              "",
              "  Waiting for authorization...",
              "  (If browser didn't open, copy the URL manually)",
              "",
              result.includes("Logged in") ? "  ✅ Authenticated!" : "  Run /github status to verify.",
            ].join("\n");
          }

          // Fallback: show raw output
          return "  " + result.split("\n").join("\n  ");
        } catch (err) {
          return [
            "  ⚠️ Interactive login not available from TUI.",
            "",
            "  Run this in a separate terminal:",
            "    gh auth login",
            "",
            "  Or use a personal access token:",
            "    gh auth login --with-token <<< 'ghp_your_token_here'",
            "",
            "  Then come back and run /github status",
          ].join("\n");
        }
      }

      if (sub === "whoami" || sub === "status") {
        try {
          const status = execSync("gh auth status 2>&1", { encoding: "utf-8", timeout: 10000 });
          let user = "";
          let scopes = "";
          try {
            user = execSync("gh api user --jq .login 2>/dev/null", {
              encoding: "utf-8",
              timeout: 10000,
            }).trim();
          } catch { /* ignore */ }
          try {
            scopes = execSync("gh auth status 2>&1 | grep -i scope || true", {
              encoding: "utf-8",
              timeout: 5000,
            }).trim();
          } catch { /* ignore */ }

          const lines = [
            "  GitHub Status",
            "  ─".repeat(30),
          ];
          if (user) lines.push(`    User:    ${user}`);
          if (status.includes("Logged in")) {
            lines.push("    Auth:    ✅ Authenticated");
          } else {
            lines.push("    Auth:    ❌ Not authenticated");
            lines.push("");
            lines.push("    Run /github login to authenticate.");
          }
          if (scopes) lines.push(`    Scopes:  ${scopes.trim()}`);
          lines.push("  ─".repeat(30));

          // Check if user can fork repos (needed for /pr)
          if (user && status.includes("Logged in")) {
            lines.push("");
            lines.push("    ✅ Ready for /scan → /fix → /pr workflow");
          }

          return lines.join("\n");
        } catch {
          return [
            "  ❌ Not authenticated with GitHub",
            "",
            "  Run /github login to authenticate.",
          ].join("\n");
        }
      }

      if (sub === "logout") {
        try {
          execSync("gh auth logout -h github.com 2>&1", { encoding: "utf-8", timeout: 10000 });
          return "  ✅ Logged out from GitHub.";
        } catch {
          return "  Run: ! gh auth logout";
        }
      }

      return [
        "  GitHub Commands:",
        "    /github status   — check auth status",
        "    /github login    — authenticate with GitHub",
        "    /github whoami   — show current user",
        "    /github logout   — log out",
      ].join("\n");
    }

    case "debug": {
      const targetArgs = (args ?? "").trim();
      if (!targetArgs) {
        return "  Usage: /debug <file> or /debug <error description>\n  Example: /debug src/auth.ts\n  Example: /debug TypeError: Cannot read property 'id' of null";
      }

      const { resolve: resolvePath } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const { collectEvidence, formatEvidenceForLLM } = await import(
        "../../core/debug-engine/evidence-collector.js"
      );

      // Parse: if first arg is a file, treat as target. Otherwise it's an error description.
      const tokens = targetArgs.split(/\s+/);
      const firstToken = tokens[0] ?? "";
      const isFile = existsSync(resolvePath(appConfig.workingDirectory, firstToken));

      const files = isFile ? [firstToken] : [];
      const errorMessage = isFile ? tokens.slice(1).join(" ") || undefined : targetArgs;

      const evidence = await collectEvidence({
        files,
        errorMessage,
        cwd: appConfig.workingDirectory,
      });

      const lines: string[] = [
        "  KCode Debug Engine",
        `    Target: ${evidence.targetFiles.join(", ") || "(auto-detected)"}`,
        "",
        `    📁 Files analyzed:    ${evidence.fileContents.size}`,
        `    🔍 Error patterns:    ${evidence.errorPatterns.length}`,
        `    🧪 Test files found:  ${evidence.testFiles.length}`,
        `    📞 Callers found:     ${evidence.callers.length}`,
        `    📜 Git changes:       ${evidence.recentChanges ? "yes" : "none"}`,
        `    🔬 Git blame:         ${evidence.blame ? "yes" : "n/a"}`,
      ];

      if (evidence.testOutput) {
        const passed = evidence.testOutput.includes("PASS") || evidence.testOutput.includes("passed");
        const failed = evidence.testOutput.includes("FAIL") || evidence.testOutput.includes("failed");
        lines.push(`    ✅ Tests run:          ${passed ? "PASS" : failed ? "FAIL" : "completed"}`);
      }

      lines.push("");
      lines.push("  Evidence package ready. Sending to model for diagnosis...");
      lines.push("");
      lines.push("  " + "─".repeat(50));

      // Summary of evidence
      if (evidence.errorPatterns.length > 0) {
        lines.push("  Error hotspots detected:");
        for (const ep of evidence.errorPatterns.slice(0, 5)) {
          lines.push(`    ⚠️ ${ep.type} — ${ep.file}:${ep.line}: ${ep.code.slice(0, 60)}`);
        }
      }

      return lines.join("\n");
    }

    case "web": {
      const desc = (args ?? "").trim();
      if (!desc) {
        return [
          "  Usage: /web <description>",
          "",
          "  Examples:",
          "    /web landing page for my AI startup",
          "    /web SaaS dashboard with auth and payments",
          "    /web e-commerce store for handmade jewelry",
          "    /web personal portfolio",
          "    /web blog with markdown support",
        ].join("\n");
      }

      const { createWebProject } = await import("../../core/web-engine/web-engine.js");
      const result = createWebProject(desc, appConfig.workingDirectory);

      const lines = [
        "  KCode Web Engine",
        `    Project:   ${result.intent.name}/`,
        `    Type:      ${result.intent.siteType}`,
        `    Stack:     ${result.intent.stack}`,
        `    Features:  ${result.intent.features.join(", ")}`,
        "",
        `    📁 Machine-generated: ${result.machineFiles} files (0 tokens)`,
        `    ✏️  Needs customization: ${result.llmFiles} files`,
        "",
        `    Project created at: ${result.projectPath}`,
        "",
        "  Next steps:",
        `    1. Model will customize ${result.llmFiles} content files`,
        `    2. cd ${result.intent.name} && npm install && npm run dev`,
        "",
        "  Sending to model for content customization...",
      ];

      return lines.join("\n");
    }

    case "api": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /api users, products, orders\n  Example: /api task management with users and tasks";

      const { createApiProject } = await import("../../core/web-engine/api-engine.js");
      const result = createApiProject(desc, appConfig.workingDirectory);

      return [
        "  KCode API Engine",
        `    Project:    ${result.projectPath}`,
        `    Framework:  ${result.framework}`,
        `    Entities:   ${result.entities.map(e => e.name).join(", ")}`,
        `    Files:      ${result.files.length}`,
        "",
        "  Endpoints created:",
        ...result.entities.map(e =>
          `    /api/${e.name}s  — GET, POST, GET/:id, PUT/:id, DELETE/:id`
        ),
        "",
        `  Next: cd ${result.projectPath.split("/").pop()} && npm install && npm run dev`,
      ].join("\n");
    }

    case "fullstack": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /fullstack task management app with users\n  Creates: frontend + API + database";

      const { createFullstackProject } = await import("../../core/web-engine/fullstack-engine.js");
      const result = createFullstackProject(desc, appConfig.workingDirectory);

      return [
        "  KCode Fullstack Engine",
        `    Project:    ${result.name}/`,
        "",
        `    Frontend:   ${result.frontend.files} files (${result.frontend.machineFiles} machine, ${result.frontend.llmFiles} LLM)`,
        `    Backend:    ${result.backend.files} files`,
        `    Entities:   ${result.backend.entities.join(", ")}`,
        `    Total:      ${result.totalFiles} files`,
        "",
        `  Next: cd ${result.name} && npm install && npm run dev`,
        "  Frontend: http://localhost:3000",
        "  API:      http://localhost:3001",
      ].join("\n");
    }

    case "python": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /python FastAPI for task management\n  /python web scraper for news\n  /python ML pipeline for sentiment analysis\n  /py CLI tool for file processing\n  /py Discord bot";

      const { createPyProject } = await import("../../core/web-engine/stacks/python-engine.js");
      const result = createPyProject(desc, appConfig.workingDirectory);
      const machine = result.files.filter(f => !f.needsLlm).length;
      const llm = result.files.filter(f => f.needsLlm).length;

      return [
        "  KCode Python Engine",
        `    Project:      ${result.config.name}/`,
        `    Type:         ${result.config.type}`,
        `    Python:       ${result.config.pythonVersion}`,
        result.config.framework ? `    Framework:    ${result.config.framework}` : "",
        `    Dependencies: ${result.config.dependencies.slice(0, 5).join(", ")}${result.config.dependencies.length > 5 ? " +" + (result.config.dependencies.length - 5) + " more" : ""}`,
        `    Files:        ${result.files.length} (${machine} machine, ${llm} LLM)`,
        "",
        `  Setup: cd ${result.config.name} && python -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"`,
        `  Run:   make run`,
        `  Test:  make test`,
      ].filter(Boolean).join("\n");
    }

    case "cpp": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /cpp HTTP server with SQLite\n  /cpp embedded firmware for ESP32\n  /cpp game engine with OpenGL\n  /c library for data compression";

      const { createCppProject } = await import("../../core/web-engine/stacks/cpp-engine.js");
      const result = createCppProject(desc, appConfig.workingDirectory);
      const machine = result.files.filter(f => !f.needsLlm).length;
      const llm = result.files.filter(f => f.needsLlm).length;

      return [
        "  KCode C/C++ Engine",
        `    Project:      ${result.config.name}/`,
        `    Type:         ${result.config.type}`,
        `    Standard:     ${result.config.standard}`,
        `    Dependencies: ${result.config.dependencies.join(", ") || "none"}`,
        `    Files:        ${result.files.length} (${machine} machine, ${llm} LLM)`,
        "",
        "  Structure:",
        `    📁 CMakeLists.txt`,
        `    📁 include/${result.config.name}.*`,
        `    📁 src/main.* + ${result.config.name}.*`,
        `    📁 tests/`,
        result.config.hasDocker ? `    📁 Dockerfile` : "",
        result.config.hasCI ? `    📁 .github/workflows/ci.yml` : "",
        "",
        `  Build: cmake -B build && cmake --build build`,
        `  Test:  cd build && ctest`,
      ].filter(Boolean).join("\n");
    }

    case "rust": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /rust API server with Axum\n  /rust CLI tool for file processing\n  /rust game with Bevy";
      const { createRustProject } = await import("../../core/web-engine/stacks/rust-engine.js");
      const r = createRustProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Rust Engine`, `    ${r.config.name}/ | ${r.config.type} | ${r.files.length} files (${m} machine)`, "", `  cargo run / cargo test`].join("\n");
    }

    case "go": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /go API with Chi\n  /go CLI tool\n  /go gRPC service";
      const { createGoProject } = await import("../../core/web-engine/stacks/go-engine.js");
      const r = createGoProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Go Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  make run / make test`].join("\n");
    }

    case "swift": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /swift iOS app with SwiftUI\n  /swift macOS app\n  /swift CLI tool\n  /swift Vapor server";
      const { createSwiftProject } = await import("../../core/web-engine/stacks/swift-engine.js");
      const r = createSwiftProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Swift Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  swift build / swift run / swift test`].join("\n");
    }

    case "java": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /java REST API with Spring\n  /java microservice with Kafka\n  /java CLI tool";
      const { createJavaProject } = await import("../../core/web-engine/stacks/java-engine.js");
      const r = createJavaProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Java Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  ./gradlew bootRun / ./gradlew test`].join("\n");
    }

    case "node": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /node CLI tool called mytool\n  /node Discord bot\n  /node library for data processing\n  /node worker with Redis queue";
      const { createNodeProject } = await import("../../core/web-engine/stacks/node-engine.js");
      const r = createNodeProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Node.js Engine`, `    ${r.config.name}/ | ${r.config.type} | ${r.files.length} files (${m} machine)`, "", `  npm run dev / npm test`].join("\n");
    }

    case "docker": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /docker Node.js API with Redis and Postgres\n  /docker Python ML pipeline with GPU\n  /docker microservices with Nginx reverse proxy";
      const { createDockerProject } = await import("../../core/web-engine/stacks/docker-engine.js");
      const r = createDockerProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Docker Engine`, `    ${r.config.name}/ | ${r.services.length} services | ${r.files.length} files (${m} machine)`, "", `  docker compose up / docker compose down`].join("\n");
    }

    case "csharp":
    case "dotnet":
    case "cs": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /csharp REST API with Entity Framework\n  /csharp Blazor app\n  /csharp CLI tool\n  /dotnet worker service";
      const { createCSharpProject } = await import("../../core/web-engine/stacks/csharp-engine.js");
      const r = createCSharpProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode C#/.NET Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  dotnet run / dotnet test`].join("\n");
    }

    case "kotlin":
    case "kt": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /kotlin API with Ktor\n  /kotlin Android app with Compose\n  /kotlin CLI tool\n  /kt library";
      const { createKotlinProject } = await import("../../core/web-engine/stacks/kotlin-engine.js");
      const r = createKotlinProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Kotlin Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  ./gradlew run / ./gradlew test`].join("\n");
    }

    case "php":
    case "laravel":
    case "symfony": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /php REST API with Slim\n  /php Laravel web app\n  /php CLI tool\n  /php WordPress plugin";
      const { createPhpProject } = await import("../../core/web-engine/stacks/php-engine.js");
      const r = createPhpProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode PHP Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  composer serve / composer test`].join("\n");
    }

    case "ruby":
    case "rb":
    case "rails":
    case "sinatra": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /ruby Sinatra API\n  /ruby CLI tool with Thor\n  /ruby gem library\n  /ruby Sidekiq worker";
      const { createRubyProject } = await import("../../core/web-engine/stacks/ruby-engine.js");
      const r = createRubyProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Ruby Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  bundle exec ruby app.rb / bundle exec rspec`].join("\n");
    }

    case "zig": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /zig CLI tool\n  /zig HTTP server\n  /zig library\n  /zig embedded firmware\n  /zig WASM module";
      const { createZigProject } = await import("../../core/web-engine/stacks/zig-engine.js");
      const r = createZigProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Zig Engine`, `    ${r.config.name}/ | ${r.config.type} | ${r.files.length} files (${m} machine)`, "", `  zig build run / zig build test`].join("\n");
    }

    case "elixir":
    case "ex":
    case "phoenix": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /elixir Phoenix API\n  /elixir LiveView app\n  /elixir CLI escript\n  /elixir GenServer worker";
      const { createElixirProject } = await import("../../core/web-engine/stacks/elixir-engine.js");
      const r = createElixirProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Elixir Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  mix run --no-halt / mix test`].join("\n");
    }

    case "dart":
    case "flutter": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /dart Flutter mobile app\n  /dart CLI tool\n  /dart server with shelf\n  /flutter iOS + Android app with Riverpod";
      const { createDartProject } = await import("../../core/web-engine/stacks/dart-engine.js");
      const r = createDartProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Dart/Flutter Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  ${r.config.type === "mobile" || r.config.type === "web" ? "flutter run" : "dart run"} / dart test`].join("\n");
    }

    case "lua":
    case "love2d": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /lua Love2D game\n  /lua Neovim plugin\n  /lua CLI script\n  /lua server with Lapis";
      const { createLuaProject } = await import("../../core/web-engine/stacks/lua-engine.js");
      const r = createLuaProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Lua Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  lua main.lua / busted`].join("\n");
    }

    case "haskell":
    case "hs": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /haskell API with Scotty\n  /haskell CLI tool\n  /hs library";
      const { createHaskellProject } = await import("../../core/web-engine/stacks/haskell-engine.js");
      const r = createHaskellProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Haskell Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  stack build / stack run / stack test`].join("\n");
    }

    case "scala": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /scala API with http4s\n  /scala Spark data pipeline\n  /scala CLI tool";
      const { createScalaProject } = await import("../../core/web-engine/stacks/scala-engine.js");
      const r = createScalaProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Scala Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  sbt run / sbt test`].join("\n");
    }

    case "terraform":
    case "tf":
    case "iac":
    case "infra": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /terraform AWS VPC with RDS and S3\n  /tf Kubernetes deployment\n  /iac GCP Cloud Run service";
      const { createTerraformProject } = await import("../../core/web-engine/stacks/terraform-engine.js");
      const r = createTerraformProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Terraform Engine`, `    ${r.config.name}/ | ${r.config.type} | ${r.files.length} files (${m} machine)`, "", `  terraform init / terraform plan / terraform apply`].join("\n");
    }

    case "monorepo":
    case "turborepo":
    case "nx": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /monorepo web + API with shared lib\n  /turborepo Next.js frontend with Express API\n  /nx React + Node monorepo";
      const { createMonorepoProject } = await import("../../core/web-engine/stacks/monorepo-engine.js");
      const r = createMonorepoProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Monorepo Engine`, `    ${r.config.name}/ | ${r.config.tool} + ${r.config.packageManager} | ${r.config.packages.length} packages | ${r.files.length} files (${m} machine)`, "", `  ${r.config.packageManager} run dev / ${r.config.packageManager} run build`].join("\n");
    }

    case "cicd":
    case "ci":
    case "pipeline": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /cicd Node.js with deploy to Vercel\n  /ci Python with Docker\n  /pipeline Go with GitHub Actions";
      const { createCicdProject } = await import("../../core/web-engine/stacks/cicd-engine.js");
      const r = createCicdProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode CI/CD Engine`, `    ${r.config.name}/ | ${r.config.platform} | ${r.config.projectType} | ${r.files.length} files (${m} machine)`, `    Test: ${r.config.hasTest} | Lint: ${r.config.hasLint} | Deploy: ${r.config.hasDeploy}${r.config.deployTarget ? " → " + r.config.deployTarget : ""}`, "", `  git push (triggers pipeline)`].join("\n");
    }

    case "db":
    case "database":
    case "schema": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /db Postgres with users, products, orders\n  /db MongoDB with posts and comments\n  /db SQLite with tasks using Drizzle\n  /db MySQL with users and sessions using TypeORM";
      const { createDbProject } = await import("../../core/web-engine/stacks/db-engine.js");
      const r = createDbProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Database Engine`, `    ${r.config.name}/ | ${r.config.type} + ${r.config.orm} | ${r.config.entities.length} entities | ${r.files.length} files (${m} machine)`, `    Entities: ${r.config.entities.map(e => e.name).join(", ")}`, `    Docker: ${r.config.hasDocker ? "yes" : "no"} | Backup: ${r.config.hasBackup ? "yes" : "no"}`, "", `  make up / npm run db:init / npm run db:seed`].join("\n");
    }

    case "css":
    case "design-system": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /css design system with dark mode\n  /css component library called myui\n  /css Tailwind plugin for animations\n  /css animation library\n  /css Sass framework";
      const { createCssProject } = await import("../../core/web-engine/stacks/css-engine.js");
      const r = createCssProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode CSS Engine`, `    ${r.config.name}/ | ${r.config.type} | ${r.files.length} files (${m} machine)`, `    Preprocessor: ${r.config.preprocessor} | Dark mode: ${r.config.darkMode ? "yes" : "no"}`, "", `  npm run dev / npm run build`].join("\n");
    }

    case "depgraph": {
      if (!args?.trim()) return "  Usage: /depgraph <file path>";

      const { resolve: resolvePath } = await import("node:path");
      const { readFileSync, existsSync } = await import("node:fs");
      const { dirname, basename, relative } = await import("node:path");

      const filePath = resolvePath(appConfig.workingDirectory, args.trim());
      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;

      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        return `  Cannot read: ${args.trim()}`;
      }

      // Extract imports (handles multiline imports)
      const importRegex =
        /(?:import\s+[\s\S]*?from\s+["'](.+?)["']|require\s*\(\s*["'](.+?)["']\s*\))/g;
      const imports: string[] = [];
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        imports.push((match[1] ?? match[2])!);
      }

      // Extract exports
      const exportRegex =
        /export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
      const exports: string[] = [];
      while ((match = exportRegex.exec(content)) !== null) {
        exports.push(match[1]!);
      }
      // Also check for `export { ... }`
      const reExportRegex = /export\s*\{([^}]+)\}/g;
      while ((match = reExportRegex.exec(content)) !== null) {
        const names = match[1]!
          .split(",")
          .map((s) =>
            s
              .trim()
              .split(/\s+as\s+/)
              .pop()
              ?.trim(),
          )
          .filter(Boolean);
        exports.push(...(names as string[]));
      }

      const relPath = relative(appConfig.workingDirectory, filePath) || basename(filePath);
      const lines = [`  Dependency Graph: ${relPath}\n`];

      // Imports tree
      if (imports.length > 0) {
        lines.push(`  Imports (${imports.length}):`);
        for (let i = 0; i < imports.length; i++) {
          const isLast = i === imports.length - 1;
          const prefix = isLast ? "\u2514\u2500" : "\u251C\u2500";
          const imp = imports[i]!;
          const isLocal = imp.startsWith(".") || imp.startsWith("/");
          const tag = isLocal ? "" : " (external)";
          lines.push(`    ${prefix} ${imp}${tag}`);
        }
      } else {
        lines.push(`  No imports found.`);
      }

      lines.push(``);

      // Exports tree
      if (exports.length > 0) {
        lines.push(`  Exports (${exports.length}):`);
        for (let i = 0; i < exports.length; i++) {
          const isLast = i === exports.length - 1;
          const prefix = isLast ? "\u2514\u2500" : "\u251C\u2500";
          lines.push(`    ${prefix} ${exports[i]}`);
        }
      } else {
        lines.push(`  No exports found.`);
      }

      return lines.join("\n");
    }
    case "filesize": {
      const { execFileSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      const rawPattern = args?.trim() || "**/*.*";
      // Sanitize pattern: only allow alphanumeric, *, ?, ., -, _, /
      const pattern = rawPattern.replace(/[^a-zA-Z0-9*?._\-/]/g, "");
      if (!pattern) return "  Invalid pattern. Use glob characters like *.ts or **/*.js";

      // Use find to get files matching pattern, sorted by size
      const files: Array<{ path: string; size: number }> = [];
      try {
        const namePattern = pattern.includes("*") ? pattern.split("/").pop() || "*" : pattern;
        const output = execFileSync(
          "find",
          [
            ".",
            "-type",
            "f",
            "-name",
            namePattern,
            "-not",
            "-path",
            "*/node_modules/*",
            "-not",
            "-path",
            "*/.git/*",
            "-printf",
            "%s\\t%p\\n",
          ],
          {
            cwd,
            timeout: 10000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          },
        ).trim();
        // Sort by size descending and limit to 30
        const sorted = output
          .split("\n")
          .filter((l) => l.trim())
          .sort((a, b) => parseInt(b.split("\t")[0] ?? "0") - parseInt(a.split("\t")[0] ?? "0"))
          .slice(0, 30)
          .join("\n");
        if (sorted) {
          for (const line of sorted.split("\n")) {
            const [sizeStr, ...pathParts] = line.split("\t");
            const filePath = pathParts.join("\t");
            const size = parseInt(sizeStr ?? "0") || 0;
            if (filePath) files.push({ path: filePath.replace(/^\.\//, ""), size });
          }
        }
      } catch {
        return "  Error scanning files. Check the glob pattern.";
      }

      if (files.length === 0) return `  No files found matching: ${pattern}`;

      const maxSize = files[0]?.size ?? 1;
      const barWidth = 20;

      const formatSize = (bytes: number): string => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      };

      const lines = [`  File Sizes (top ${files.length}, pattern: ${pattern})\n`];
      for (const f of files) {
        const filled = Math.max(1, Math.round((f.size / maxSize) * barWidth));
        const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
        lines.push(`  ${bar} ${formatSize(f.size).padStart(10)}  ${f.path}`);
      }

      const totalSize = files.reduce((a, b) => a + b.size, 0);
      lines.push(`\n  Total: ${formatSize(totalSize)} across ${files.length} file(s)`);
      return lines.join("\n");
    }
    case "filediff": {
      if (!args?.trim()) return "  Usage: /filediff <file1> <file2>";

      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) return "  Usage: /filediff <file1> <file2>";

      const { resolve: resolvePath } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      const file1 = resolvePath(cwd, parts[0]!);
      const file2 = resolvePath(cwd, parts[1]!);

      if (!existsSync(file1)) return `  File not found: ${parts[0]}`;
      if (!existsSync(file2)) return `  File not found: ${parts[1]}`;

      try {
        // Use diff command (returns exit code 1 if files differ, which is normal)
        // Escape single quotes in paths to prevent injection
        const esc = (s: string) => s.replace(/'/g, "'\\''");
        const output = execSync(`diff -u '${esc(file1)}' '${esc(file2)}' 2>&1; true`, {
          cwd,
          timeout: 10000,
        })
          .toString()
          .trim();

        if (!output) return `  Files are identical: ${parts[0]} = ${parts[1]}`;

        const diffLines = output.split("\n");
        const lines = [`  File Diff: ${parts[0]} vs ${parts[1]}\n`];

        // Show first 50 lines of diff
        const maxLines = 50;
        for (let i = 0; i < Math.min(diffLines.length, maxLines); i++) {
          lines.push(`  ${diffLines[i]}`);
        }
        if (diffLines.length > maxLines) {
          lines.push(`\n  ... ${diffLines.length - maxLines} more lines`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "outline": {
      if (!args?.trim()) return "  Usage: /outline <file path>";

      const { existsSync, readFileSync } = await import("node:fs");
      const { resolve: resolvePath, extname, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());

      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;

      const { statSync: statSyncOutline } = await import("node:fs");
      if (statSyncOutline(filePath).size > 5 * 1024 * 1024)
        return "  File too large for outline (max 5 MB).";

      const content = readFileSync(filePath, "utf-8");
      const ext = extname(filePath).toLowerCase();
      const relPath = relative(cwd, filePath);
      const fileLines = content.split("\n");
      const symbols: Array<{ line: number; kind: string; name: string }> = [];

      // Language-specific patterns
      if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*export\s+(default\s+)?(async\s+)?function\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "fn", name: m[3]! });
          else if ((m = l.match(/^\s*(export\s+)?(async\s+)?function\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "fn", name: m[3]! });
          else if ((m = l.match(/^\s*export\s+(default\s+)?class\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "class", name: m[2]! });
          else if ((m = l.match(/^\s*class\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "class", name: m[1]! });
          else if ((m = l.match(/^\s*export\s+(default\s+)?interface\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "iface", name: m[2]! });
          else if ((m = l.match(/^\s*interface\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "iface", name: m[1]! });
          else if ((m = l.match(/^\s*export\s+(default\s+)?type\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "type", name: m[2]! });
          else if ((m = l.match(/^\s*type\s+(\w+)\s*=/)))
            symbols.push({ line: i + 1, kind: "type", name: m[1]! });
          else if ((m = l.match(/^\s*export\s+(const|let|var)\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "var", name: m[2]! });
          else if ((m = l.match(/^\s*const\s+(\w+)\s*=\s*(async\s+)?\(/)))
            symbols.push({ line: i + 1, kind: "fn", name: m[1]! });
        }
      } else if ([".py"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^class\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "class", name: m[1]! });
          else if ((m = l.match(/^(\s*)def\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: m[1] ? "method" : "fn", name: m[2]! });
          else if ((m = l.match(/^(\s*)async\s+def\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: m[1] ? "method" : "fn", name: m[2]! });
        }
      } else if ([".go"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^func\s+\((\w+)\s+\*?(\w+)\)\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "method", name: `${m[2]}.${m[3]}` });
          else if ((m = l.match(/^func\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "fn", name: m[1]! });
          else if ((m = l.match(/^type\s+(\w+)\s+struct/)))
            symbols.push({ line: i + 1, kind: "struct", name: m[1]! });
          else if ((m = l.match(/^type\s+(\w+)\s+interface/)))
            symbols.push({ line: i + 1, kind: "iface", name: m[1]! });
        }
      } else if ([".rs"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*(pub\s+)?fn\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "fn", name: m[2]! });
          else if ((m = l.match(/^\s*(pub\s+)?struct\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "struct", name: m[2]! });
          else if ((m = l.match(/^\s*(pub\s+)?enum\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "enum", name: m[2]! });
          else if ((m = l.match(/^\s*(pub\s+)?trait\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "trait", name: m[2]! });
          else if ((m = l.match(/^\s*impl\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "impl", name: m[1]! });
        }
      } else if ([".swift"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?class\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "class", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?struct\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "struct", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?func\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "fn", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?enum\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "enum", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?protocol\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "proto", name: m[2]! });
        }
      } else {
        // Generic: look for common patterns
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if (
            (m = l.match(
              /^\s*(public|private|protected)?\s*(static\s+)?(void|int|string|boolean|async)?\s*(\w+)\s*\(/,
            ))
          ) {
            if (!["if", "for", "while", "switch", "catch", "return", "else"].includes(m[4]!)) {
              symbols.push({ line: i + 1, kind: "fn", name: m[4]! });
            }
          }
        }
      }

      if (symbols.length === 0) return `  No symbols found in ${relPath}`;

      const kindIcons: Record<string, string> = {
        fn: "f",
        method: "m",
        class: "C",
        struct: "S",
        iface: "I",
        type: "T",
        var: "v",
        enum: "E",
        trait: "R",
        impl: "M",
        proto: "P",
      };

      const lines = [
        `  Outline: ${relPath} (${symbols.length} symbols, ${fileLines.length} lines)\n`,
      ];
      for (const sym of symbols) {
        const icon = kindIcons[sym.kind] ?? "?";
        lines.push(`  ${String(sym.line).padStart(5)}  [${icon}] ${sym.name}`);
      }

      return lines.join("\n");
    }
    case "csv": {
      if (!args?.trim()) return "  Usage: /csv <file path>";

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative, extname } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());

      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 10 * 1024 * 1024) return "  File too large (max 10 MB).";

      const content = readFileSync(filePath, "utf-8");
      const relPath = relative(cwd, filePath);
      const ext = extname(filePath).toLowerCase();

      // Detect delimiter
      const delimiter =
        ext === ".tsv" || content.split("\t").length > content.split(",").length ? "\t" : ",";
      const delimName = delimiter === "\t" ? "TAB" : "COMMA";

      const rows = content.split("\n").filter((l) => l.trim());
      if (rows.length === 0) return "  Empty file.";

      // Parse with simple CSV logic (handles quoted fields)
      const parseRow = (line: string): string[] => {
        const fields: string[] = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i]!;
          if (ch === '"') {
            inQuotes = !inQuotes;
          } else if (ch === delimiter && !inQuotes) {
            fields.push(current.trim());
            current = "";
          } else {
            current += ch;
          }
        }
        fields.push(current.trim());
        return fields;
      };

      const headers = parseRow(rows[0]!);
      const dataRows = rows.slice(1).map(parseRow);

      // Column widths for preview
      const colWidths = headers.map((h, i) => {
        const values = [h, ...dataRows.slice(0, 10).map((r) => r[i] ?? "")];
        return Math.min(Math.max(...values.map((v) => v.length), 3), 25);
      });

      const lines = [
        `  CSV Inspector: ${relPath}\n`,
        `  Delimiter: ${delimName}`,
        `  Columns:   ${headers.length}`,
        `  Rows:      ${dataRows.length}`,
        `  Size:      ${(stat.size / 1024).toFixed(1)} KB`,
        ``,
        `  Columns: ${headers.map((h, i) => `${h} (${i + 1})`).join(", ")}`,
        ``,
      ];

      // Table preview (header + first 10 rows)
      const formatRow = (fields: string[]) =>
        fields
          .map((f, i) =>
            f.length > colWidths[i]!
              ? f.slice(0, colWidths[i]! - 1) + "\u2026"
              : f.padEnd(colWidths[i]!),
          )
          .join("  ");

      lines.push(`  ${formatRow(headers)}`);
      lines.push(`  ${colWidths.map((w) => "\u2500".repeat(w)).join("  ")}`);
      for (const row of dataRows.slice(0, 10)) {
        lines.push(`  ${formatRow(row)}`);
      }
      if (dataRows.length > 10) {
        lines.push(`\n  ... ${dataRows.length - 10} more rows`);
      }

      return lines.join("\n");
    }
    case "json": {
      if (!args?.trim()) return "  Usage: /json <file path or JSON text>";

      const input = args.trim();
      let text = input;
      let isFile = false;

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const filePath = resolvePath(appConfig.workingDirectory, input);

      if (existsSync(filePath) && statSyncFn(filePath).isFile()) {
        if (statSyncFn(filePath).size > 5 * 1024 * 1024) return "  File too large (max 5 MB).";
        text = readFileSync(filePath, "utf-8");
        isFile = true;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return `  Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Analyze structure
      const countKeys = (
        obj: unknown,
        depth = 0,
      ): { keys: number; maxDepth: number; arrays: number; objects: number } => {
        const result = { keys: 0, maxDepth: depth, arrays: 0, objects: 0 };
        if (depth > 100) return result;
        if (Array.isArray(obj)) {
          result.arrays++;
          for (const item of obj) {
            const sub = countKeys(item, depth + 1);
            result.keys += sub.keys;
            result.maxDepth = Math.max(result.maxDepth, sub.maxDepth);
            result.arrays += sub.arrays;
            result.objects += sub.objects;
          }
        } else if (obj && typeof obj === "object") {
          result.objects++;
          const entries = Object.entries(obj as Record<string, unknown>);
          result.keys += entries.length;
          for (const [, val] of entries) {
            const sub = countKeys(val, depth + 1);
            result.keys += sub.keys;
            result.maxDepth = Math.max(result.maxDepth, sub.maxDepth);
            result.arrays += sub.arrays;
            result.objects += sub.objects;
          }
        }
        return result;
      };

      const stats = countKeys(parsed);
      const formatted = JSON.stringify(parsed, null, 2);
      const preview = formatted.split("\n").slice(0, 30).join("\n");

      const lines = [
        `  JSON Inspector${isFile ? ` (${input})` : ""}\n`,
        `  Valid:    \u2713`,
        `  Type:     ${Array.isArray(parsed) ? "array" : typeof parsed}`,
        `  Keys:     ${stats.keys}`,
        `  Depth:    ${stats.maxDepth}`,
        `  Objects:  ${stats.objects}`,
        `  Arrays:   ${stats.arrays}`,
        `  Size:     ${text.length.toLocaleString()} chars`,
        ``,
        `  Preview:`,
      ];

      for (const line of preview.split("\n")) {
        lines.push(`  ${line}`);
      }
      if (formatted.split("\n").length > 30) {
        lines.push(`  ... ${formatted.split("\n").length - 30} more lines`);
      }

      return lines.join("\n");
    }
    case "dotenv": {
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args?.trim() || ".env");

      if (!existsSync(filePath)) return `  File not found: ${relative(cwd, filePath)}`;
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 1024 * 1024) return "  File too large (max 1 MB).";

      const content = readFileSync(filePath, "utf-8");
      const relPath = relative(cwd, filePath);
      const rawLines = content.split("\n");

      const keys: string[] = [];
      const duplicates: string[] = [];
      const empty: string[] = [];
      const comments = rawLines.filter((l) => l.trim().startsWith("#")).length;
      const seen = new Set<string>();

      for (const line of rawLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();

        keys.push(key);
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
        if (!val || val === '""' || val === "''") empty.push(key);
      }

      const lines = [
        `  Dotenv Inspector: ${relPath}\n`,
        `  Variables:   ${keys.length}`,
        `  Unique:      ${seen.size}`,
        `  Comments:    ${comments}`,
        `  Empty:       ${empty.length}`,
        `  Duplicates:  ${duplicates.length}`,
        ``,
        `  Keys:`,
      ];

      for (const key of [...seen].sort()) {
        const flags: string[] = [];
        if (duplicates.includes(key)) flags.push("DUP");
        if (empty.includes(key)) flags.push("EMPTY");
        lines.push(`    ${key}${flags.length ? `  [${flags.join(", ")}]` : ""}`);
      }

      if (duplicates.length > 0) {
        lines.push(`\n  \u26a0 Duplicate keys: ${[...new Set(duplicates)].join(", ")}`);
      }
      if (empty.length > 0) {
        lines.push(`  \u26a0 Empty values: ${empty.join(", ")}`);
      }

      return lines.join("\n");
    }
    case "count": {
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative, extname } = await import("node:path");
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const target = args?.trim() || ".";
      const targetPath = resolvePath(cwd, target);

      if (!existsSync(targetPath)) return `  Not found: ${target}`;

      const stat = statSyncFn(targetPath);

      if (stat.isFile()) {
        if (stat.size > 50 * 1024 * 1024) return "  File too large (max 50 MB).";
        const content = readFileSync(targetPath, "utf-8");
        const lineCount = content.split("\n").length;
        const wordCount = content.split(/\s+/).filter(Boolean).length;
        const charCount = content.length;
        const relPath = relative(cwd, targetPath);

        return [
          `  Count: ${relPath}\n`,
          `  Lines:      ${lineCount.toLocaleString()}`,
          `  Words:      ${wordCount.toLocaleString()}`,
          `  Characters: ${charCount.toLocaleString()}`,
          `  Size:       ${(stat.size / 1024).toFixed(1)} KB`,
        ].join("\n");
      }

      // Directory: count files by extension
      try {
        const output = execSync(
          `find '${targetPath.replace(/'/g, "'\\''")}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null`,
          { cwd, timeout: 10000 },
        )
          .toString()
          .trim();

        if (!output) return "  No files found.";

        const files = output.split("\n");
        const extCounts: Record<string, { count: number; lines: number }> = {};
        let totalLines = 0;
        const totalFiles = files.length;

        for (const file of files) {
          const ext = extname(file).toLowerCase() || "(no ext)";
          if (!extCounts[ext]) extCounts[ext] = { count: 0, lines: 0 };
          extCounts[ext]!.count++;
        }

        // Batch line count via wc -l (much faster than reading each file)
        try {
          const wcOutput = execSync(
            `find '${targetPath.replace(/'/g, "'\\''")}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -size -1M -exec wc -l {} + 2>/dev/null | tail -1`,
            { cwd, timeout: 15000 },
          )
            .toString()
            .trim();
          const totalMatch = wcOutput.match(/^\s*(\d+)\s+total$/);
          if (totalMatch) totalLines = parseInt(totalMatch[1]!);
        } catch {
          /* skip line counting */
        }

        const sorted = Object.entries(extCounts).sort((a, b) => b[1].count - a[1].count);
        const relDir = relative(cwd, targetPath) || ".";

        const lines = [
          `  Count: ${relDir}\n`,
          `  Total files: ${totalFiles.toLocaleString()}`,
          `  Total lines: ${totalLines > 0 ? totalLines.toLocaleString() : "(unknown)"}`,
          ``,
        ];

        const maxExtLen = Math.max(...sorted.map(([e]) => e.length), 5);
        lines.push(`  ${"Ext".padEnd(maxExtLen)}  ${"Files".padStart(6)}`);
        lines.push(`  ${"\u2500".repeat(maxExtLen)}  ${"\u2500".repeat(6)}`);

        for (const [ext, data] of sorted.slice(0, 20)) {
          lines.push(`  ${ext.padEnd(maxExtLen)}  ${String(data.count).padStart(6)}`);
        }
        if (sorted.length > 20) lines.push(`\n  ... ${sorted.length - 20} more extensions`);

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "sort_lines": {
      if (!args?.trim()) return "  Usage: /sort-lines <file> [--reverse] [--numeric] [--unique]";

      const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;

      const parts = args.trim().split(/\s+/);
      const flags = new Set(parts.filter((p) => p.startsWith("--")));
      const filePart = parts.find((p) => !p.startsWith("--"));
      if (!filePart) return "  Usage: /sort-lines <file> [--reverse] [--numeric] [--unique]";

      const filePath = resolvePath(cwd, filePart);
      if (!existsSync(filePath)) return `  File not found: ${filePart}`;

      const { statSync: statSyncFn } = await import("node:fs");
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 10 * 1024 * 1024) return "  File too large (max 10 MB).";

      const content = readFileSync(filePath, "utf-8");
      let lines = content.split("\n");

      // Remove trailing empty line if present
      if (lines[lines.length - 1] === "") lines.pop();

      const originalCount = lines.length;

      // Sort
      if (flags.has("--numeric")) {
        lines.sort((a, b) => {
          const na = parseFloat(a) || 0;
          const nb = parseFloat(b) || 0;
          return na - nb;
        });
      } else {
        lines.sort((a, b) => a.localeCompare(b));
      }

      if (flags.has("--reverse")) lines.reverse();
      if (flags.has("--unique")) lines = [...new Set(lines)];

      const relPath = relative(cwd, filePath);
      const removed = originalCount - lines.length;

      writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

      return [
        `  Sorted: ${relPath}`,
        ``,
        `  Lines:   ${originalCount}${removed > 0 ? ` \u2192 ${lines.length} (${removed} duplicates removed)` : ""}`,
        `  Order:   ${flags.has("--numeric") ? "numeric" : "alphabetic"}${flags.has("--reverse") ? " (reversed)" : ""}`,
        `  Unique:  ${flags.has("--unique") ? "yes" : "no"}`,
      ].join("\n");
    }
    case "markdown_toc": {
      if (!args?.trim()) return "  Usage: /markdown-toc <file.md>";

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());

      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 2 * 1024 * 1024) return "  File too large (max 2 MB).";

      const content = readFileSync(filePath, "utf-8");
      const relPath = relative(cwd, filePath);

      // Extract headings (skip code blocks)
      let inCodeBlock = false;
      const headings: { level: number; text: string; anchor: string }[] = [];

      for (const line of content.split("\n")) {
        if (line.trim().startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (inCodeBlock) continue;

        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
          const level = headingMatch[1]!.length;
          const text = headingMatch[2]!.trim();
          const anchor = text
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-{2,}/g, "-");
          headings.push({ level, text, anchor });
        }
      }

      if (headings.length === 0) return `  No headings found in ${relPath}`;

      const minLevel = Math.min(...headings.map((h) => h.level));
      const lines = [`  Table of Contents: ${relPath}\n`];

      for (const h of headings.slice(0, 100)) {
        const indent = "  ".repeat(h.level - minLevel);
        lines.push(`  ${indent}- [${h.text}](#${h.anchor})`);
      }
      if (headings.length > 100) {
        lines.push(`  ... and ${headings.length - 100} more`);
      }

      lines.push(``);
      lines.push(
        `  Headings: ${headings.length}  |  Levels: ${minLevel}-${Math.max(...headings.map((h) => h.level))}`,
      );

      return lines.join("\n");
    }
    default:
      return null;
  }
}
