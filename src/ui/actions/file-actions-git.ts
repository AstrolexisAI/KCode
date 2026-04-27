// Git/GitHub actions: /pr and /github.
// Split out of file-actions.ts.

import type { ActionContext } from "./action-helpers.js";
import { tokenize } from "./argv-parser.js";

export async function handleGitAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { appConfig, args } = ctx;

  switch (action) {
    case "pr": {
      // HD.2 (v2.10.380) — shell-quote-aware tokenizer, same one
      // /scan, /review, /fix already use. Fixes paths with spaces
      // and lets `--repo "owner/repo with spaces"` parse correctly
      // (rare but possible). Unterminated quotes return a friendly
      // message instead of crashing.
      let tokens: string[];
      try {
        tokens = tokenize(args);
      } catch (err) {
        return `  ${(err as Error).message}`;
      }
      const dryRun = tokens.includes("--dry-run");
      const repoFlag = tokens.indexOf("--repo");
      const repo = repoFlag >= 0 ? tokens[repoFlag + 1] : undefined;
      // pathToken is the first non-flag, non-flag-value token. Skip
      // the value token after --repo so `/pr --repo owner/x .` picks
      // `.` as path, not `owner/x`.
      const pathToken =
        tokens.find((t, i) => !t.startsWith("--") && i !== repoFlag + 1) ?? ".";
      const { resolve: resolvePath } = await import("node:path");
      const projectRoot = resolvePath(appConfig.workingDirectory, pathToken);

      // Background execution — same pattern as /scan
      const { prState, resetPrState } = await import("../../core/audit-engine/pr-state.js");
      const { createPr } = await import("../../core/audit-engine/pr-generator.js");
      const { buildAuditLlmCallbackFromConfigAsync } = await import(
        "../../core/audit-engine/llm-callback.js"
      );

      resetPrState();
      prState.active = true;
      prState.startTime = Date.now();
      prState.step = "Starting...";

      // Fire-and-forget
      (async () => {
        try {
          // v2.10.316: use the registry-aware async builder so /pr
          // hits the actual configured model (e.g. mark7 on port 8090)
          // instead of falling back to the dead localhost:10091 default.
          // Same fix applied to /scan in v311.
          const llmCallback = await buildAuditLlmCallbackFromConfigAsync(appConfig);
          const result = await createPr({
            projectRoot,
            llmCallback,
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
            // Detect upstream repo so the manual-fallback hints don't
            // hardcode the wrong project. Falls back to placeholders
            // when detection fails.
            let upstream = "OWNER/REPO";
            try {
              const { execSync } = await import("node:child_process");
              const url = execSync("git remote get-url origin", {
                cwd: projectRoot,
                encoding: "utf-8",
                timeout: 5000,
              }).trim();
              const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
              if (m) upstream = m[1]!.replace(/\.git$/, "");
            } catch {
              /* keep placeholder */
            }
            const repoName = upstream.split("/")[1] ?? "REPO";

            lines.push(`    ⚠️  Push failed: ${result.pushError}`);
            lines.push(`    Re-running /pr ${pathToken} will resume from this branch.`);
            lines.push(`    Or push + open the PR manually:`);
            lines.push(`      ! cd ${pathToken} && git push -u fork ${result.branchName} --force`);
            lines.push(`      ! cd ${pathToken} && gh pr create --repo ${upstream} --head YOUR_USER:${result.branchName}`);
            lines.push(`    (Replace YOUR_USER with your GitHub username; ${repoName} fork must already exist.)`);
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

    default:
      return null;
  }
}
