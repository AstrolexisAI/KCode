// Git actions
// Auto-extracted from builtin-actions.ts
//
// SECURITY (Bruno 2026-05-26): all shell-mode `execSync` calls replaced with
// `execFileSync("git", [...argv])` to eliminate command-injection surface.
// Pipes (`| wc -l`, `| head -N`, etc.) and shell redirects (`2>/dev/null`)
// are reproduced in JavaScript — no shell ever sees user-controlled tokens.
// Self-audit pattern: js-007-command-injection — 13 instances patched.

import type { ActionContext } from "./action-helpers.js";

function formatGitError(err: unknown): string {
  if (err instanceof Error) {
    const execErr = err as { stderr?: Buffer | string };
    const stderr = execErr.stderr?.toString()?.trim();
    return `  Git error: ${stderr || err.message}`;
  }
  return `  Git error: ${String(err)}`;
}

/**
 * Run `git` with argv array (NO shell). Returns trimmed stdout.
 * On non-zero exit, throws — caller handles via formatGitError.
 *
 * Reproducing former shell features:
 * - `2>/dev/null` / `2>&1` are replicated via stdio config + ignoring stderr
 * - `| head -N`, `| wc -l`, `| sort | uniq -c` are reproduced in JS by callers
 */
async function git(
  args: string[],
  cwd: string,
  timeout = 5000,
  swallowStderr = true,
): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("git", args, {
    cwd,
    timeout,
    stdio: swallowStderr ? ["pipe", "pipe", "ignore"] : ["pipe", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

/** Variant that returns "" on failure (mimics ` || true` patterns). */
async function gitTry(args: string[], cwd: string, timeout = 5000): Promise<string> {
  try {
    return await git(args, cwd, timeout, true);
  } catch {
    return "";
  }
}

export async function handleGitAction(action: string, ctx: ActionContext): Promise<string | null> {
  const { appConfig, args } = ctx;
  const cwd = appConfig.workingDirectory;

  switch (action) {
    case "blame": {
      if (!args?.trim()) return "  Usage: /blame <file path>";

      const { resolve: resolvePath, relative } = await import("node:path");
      const filePath = resolvePath(cwd, args.trim());
      const relPath = relative(cwd, filePath);

      try {
        const shortOutput = await git(["blame", "--date=short", relPath], cwd, 10000);
        const rawLines = shortOutput.split("\n");

        const lines = [`  Git Blame: ${relPath} (${rawLines.length} lines)\n`];

        // Show first 40 lines max
        const maxLines = 40;
        for (let i = 0; i < Math.min(rawLines.length, maxLines); i++) {
          lines.push(`  ${rawLines[i]}`);
        }
        if (rawLines.length > maxLines) {
          lines.push(
            `\n  ... ${rawLines.length - maxLines} more lines (use git blame directly for full output)`,
          );
        }

        return lines.join("\n");
      } catch (err) {
        return formatGitError(err);
      }
    }
    case "tags": {
      const arg = args?.trim() ?? "list";

      try {
        if (arg === "list" || !arg) {
          // Was: `git tag -l --sort=... --format=... 2>/dev/null | head -20`
          const allOutput = await git(
            [
              "tag",
              "-l",
              "--sort=-creatordate",
              "--format=%(creatordate:short) %(refname:short) %(subject)",
            ],
            cwd,
            5000,
          );
          if (!allOutput) return "  No tags found.";

          const allTagLines = allOutput.split("\n");
          const output = allTagLines.slice(0, 20).join("\n");

          const lines = [`  Git Tags\n`];
          for (const line of output.split("\n")) {
            const parts = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
            if (parts) {
              lines.push(`  ${parts[2]!.padEnd(20)} ${parts[1]!}  ${parts[3] || ""}`);
            } else {
              lines.push(`  ${line}`);
            }
          }

          // Count total — was `git tag -l | wc -l`
          const totalCount = (await gitTry(["tag", "-l"], cwd, 3000))
            .split("\n")
            .filter((l) => l.trim().length > 0).length;
          lines.push(`\n  ${totalCount} tag(s) total`);
          return lines.join("\n");
        }

        if (arg.startsWith("create ")) {
          const rest = arg.slice(7).trim();
          const spaceIdx = rest.indexOf(" ");
          const tagName = spaceIdx > 0 ? rest.slice(0, spaceIdx) : rest;
          const message = spaceIdx > 0 ? rest.slice(spaceIdx + 1) : "";

          // Validate tag name: alphanumeric, dots, dashes only
          if (!/^[a-zA-Z0-9._-]+$/.test(tagName)) {
            return "  Invalid tag name. Use alphanumeric, dots, dashes only.";
          }

          if (message) {
            // Message can contain anything safely now — no shell interpolation.
            await git(["tag", "-a", tagName, "-m", message], cwd, 5000);
          } else {
            await git(["tag", tagName], cwd, 5000);
          }
          return `  Created tag: ${tagName}${message ? ` ("${message}")` : ""}`;
        }

        if (arg.startsWith("log ") && arg.includes("..")) {
          const range = arg.slice(4).trim();
          // Validate range format
          if (!/^[a-zA-Z0-9._-]+\.\.[a-zA-Z0-9._-]+$/.test(range)) {
            return "  Usage: /tags log <tag1>..<tag2>";
          }
          const output = await git(["log", "--oneline", range], cwd, 10000, false);
          if (!output) return `  No commits between ${range}`;
          const logLines = output.split("\n");
          const lines = [`  Changelog: ${range} (${logLines.length} commits)\n`];
          for (const l of logLines.slice(0, 30)) {
            lines.push(`  ${l}`);
          }
          if (logLines.length > 30) lines.push(`\n  ... ${logLines.length - 30} more`);
          return lines.join("\n");
        }

        return "  Usage: /tags [list | create <name> [message] | log <tag1>..<tag2>]";
      } catch (err) {
        return formatGitError(err);
      }
    }
    case "file_history": {
      if (!args?.trim()) return "  Usage: /file-history <file path>";

      const { resolve: resolvePath, relative } = await import("node:path");
      const filePath = resolvePath(cwd, args.trim());
      const relPath = relative(cwd, filePath);

      try {
        // Was: `git log --oneline --follow --stat -- '<relPath>' 2>&1 | head -60`
        const fullOutput = await git(
          ["log", "--oneline", "--follow", "--stat", "--", relPath],
          cwd,
          10000,
          false,
        );
        if (!fullOutput) return `  No git history for: ${args.trim()}`;

        const allLines = fullOutput.split("\n");
        const output = allLines.slice(0, 60).join("\n");

        // Count total commits for the file — was `... | wc -l`
        const countText = await gitTry(["log", "--oneline", "--follow", "--", relPath], cwd, 5000);
        const countOutput = String(countText.split("\n").filter((l) => l.trim().length > 0).length);

        const lines = [`  File History: ${relPath} (${countOutput} commits)\n`];
        for (const line of output.split("\n")) {
          lines.push(`  ${line}`);
        }

        return lines.join("\n");
      } catch (err) {
        return formatGitError(err);
      }
    }
    case "diff_branch": {
      if (!args?.trim()) return "  Usage: /diff-branch <target branch>";

      const target = args.trim();

      // Validate branch name
      if (!/^[a-zA-Z0-9._\-/]+$/.test(target)) return "  Invalid branch name.";

      try {
        // Get current branch
        const current = (await gitTry(["branch", "--show-current"], cwd, 3000)) || "HEAD";

        // Check target exists
        try {
          await git(["rev-parse", "--verify", target], cwd, 3000);
        } catch {
          return `  Branch not found: ${target}`;
        }

        // Merge base
        const mergeBase = (await gitTry(["merge-base", current, target], cwd, 5000)).slice(0, 8);

        // Commit counts
        const ahead = await gitTry(["rev-list", "--count", `${target}..${current}`], cwd, 5000);
        const behind = await gitTry(["rev-list", "--count", `${current}..${target}`], cwd, 5000);

        // Diff stat — was `git diff --stat '<target>' 2>/dev/null | tail -1`
        const diffStatFull = await gitTry(["diff", "--stat", target], cwd, 10000);
        const diffStatLines = diffStatFull.split("\n").filter((l) => l.length > 0);
        const diffStat = diffStatLines.length > 0 ? diffStatLines[diffStatLines.length - 1] : "";

        // Changed files list — was `... | head -20`
        const changedFilesFull = await gitTry(["diff", "--name-status", target], cwd, 10000);
        const changedFiles = changedFilesFull.split("\n").slice(0, 20).join("\n").trim();

        const lines = [
          `  Branch Comparison\n`,
          `  Current:    ${current}`,
          `  Target:     ${target}`,
          `  Merge base: ${mergeBase}`,
          `  Ahead:      ${ahead} commits`,
          `  Behind:     ${behind} commits`,
          ``,
        ];

        if (diffStat) lines.push(`  ${diffStat}`, ``);

        if (changedFiles) {
          lines.push(`  Changed Files:`);
          for (const line of changedFiles.split("\n")) {
            const [status, ...fileParts] = line.split("\t");
            const file = fileParts.join("\t");
            const statusLabel =
              status === "M"
                ? "modified"
                : status === "A"
                  ? "added"
                  : status === "D"
                    ? "deleted"
                    : (status ?? "");
            lines.push(`    ${statusLabel.padEnd(9)} ${file}`);
          }
          // Was `git diff --name-only '<target>' | wc -l`
          const totalChangedRaw = await gitTry(["diff", "--name-only", target], cwd, 5000);
          const totalChanged = totalChangedRaw.split("\n").filter((l) => l.trim().length > 0).length;
          if (totalChanged > 20) lines.push(`\n    ... ${totalChanged - 20} more files`);
        }

        return lines.join("\n");
      } catch (err) {
        return formatGitError(err);
      }
    }
    case "diff_stats": {
      try {
        await git(["rev-parse", "--is-inside-work-tree"], cwd, 3000);
      } catch {
        return "  Not a git repository.";
      }

      const lines = [`  Repository Stats\n`];

      try {
        // Total commits
        const totalCommits = await gitTry(["rev-list", "--count", "HEAD"], cwd, 5000);
        lines.push(`  Total commits:  ${parseInt(totalCommits).toLocaleString()}`);

        // Contributors — was `git shortlog -sn --no-merges HEAD | wc -l`
        const shortlogRaw = await gitTry(["shortlog", "-sn", "--no-merges", "HEAD"], cwd, 5000);
        const contributors = shortlogRaw.split("\n").filter((l) => l.trim().length > 0).length;
        lines.push(`  Contributors:   ${contributors}`);

        // First and last commit dates — was `... | head -1`
        const firstCommitRaw = await gitTry(["rev-list", "--max-parents=0", "HEAD"], cwd, 5000);
        const firstCommit = firstCommitRaw.split("\n")[0]?.trim() ?? "";
        const firstDate = firstCommit
          ? await gitTry(["log", "-1", "--format=%ai", firstCommit], cwd, 3000)
          : "";
        const lastDate = await gitTry(["log", "-1", "--format=%ai"], cwd, 5000);
        if (firstDate) lines.push(`  First commit:   ${firstDate.slice(0, 10)}`);
        if (lastDate) lines.push(`  Last commit:    ${lastDate.slice(0, 10)}`);

        // Commits in last 7 days
        const weekCommits = await gitTry(
          ["rev-list", "--count", "--since=7 days ago", "HEAD"],
          cwd,
          5000,
        );
        lines.push(`  Last 7 days:    ${weekCommits} commits`);

        // Commits in last 30 days
        const monthCommits = await gitTry(
          ["rev-list", "--count", "--since=30 days ago", "HEAD"],
          cwd,
          5000,
        );
        lines.push(`  Last 30 days:   ${monthCommits} commits`);

        lines.push(``);

        // Most changed files (top 10) — was `... | sort | uniq -c | sort -rn | head -10`
        const hotFilesRaw = await gitTry(
          ["log", "--pretty=format:", "--name-only"],
          cwd,
          10000,
        );
        if (hotFilesRaw) {
          const counts = new Map<string, number>();
          for (const file of hotFilesRaw.split("\n")) {
            const trimmed = file.trim();
            if (!trimmed) continue;
            counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
          }
          const sorted = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
          if (sorted.length > 0) {
            lines.push(`  Most Changed Files:`);
            for (const [file, count] of sorted) {
              lines.push(`    ${String(count).padStart(5)}  ${file}`);
            }
          }
        }

        lines.push(``);

        // Daily activity — was `git log --format=%ad --date=short --since='7 days ago' | sort | uniq -c | sort -rn`
        const dayActivityRaw = await gitTry(
          ["log", "--format=%ad", "--date=short", "--since=7 days ago"],
          cwd,
          5000,
        );
        if (dayActivityRaw) {
          const dayCounts = new Map<string, number>();
          for (const day of dayActivityRaw.split("\n")) {
            const trimmed = day.trim();
            if (!trimmed) continue;
            dayCounts.set(trimmed, (dayCounts.get(trimmed) ?? 0) + 1);
          }
          const sortedDays = Array.from(dayCounts.entries()).sort((a, b) => b[1] - a[1]);
          if (sortedDays.length > 0) {
            lines.push(`  Daily Activity (last 7 days):`);
            for (const [day, count] of sortedDays) {
              const bar = "█".repeat(Math.min(count, 30));
              lines.push(`    ${day}  ${bar} ${count}`);
            }
          }
        }
      } catch (err) {
        lines.push(formatGitError(err).replace("Git error", "Error"));
      }

      return lines.join("\n");
    }
    case "git_graph": {
      const count = Math.min(Math.max(parseInt(args?.trim() || "20") || 20, 5), 50);

      try {
        const output = await gitTry(
          ["log", "--graph", "--oneline", "--decorate", "--all", "-n", String(count)],
          cwd,
          10000,
        );

        if (!output) return "  No git history found.";

        const lines = [`  Git Graph (last ${count})\n`];
        for (const line of output.split("\n")) {
          lines.push(`  ${line}`);
        }

        // Branch summary — was `git branch -a | wc -l`
        try {
          const branchesRaw = await gitTry(["branch", "-a"], cwd, 3000);
          const branches = branchesRaw.split("\n").filter((l) => l.trim().length > 0).length;
          const currentBranch = await gitTry(["branch", "--show-current"], cwd, 3000);
          lines.push(`\n  Current: ${currentBranch || "detached HEAD"}  |  Branches: ${branches}`);
        } catch {
          /* skip */
        }

        return lines.join("\n");
      } catch (err) {
        return formatGitError(err);
      }
    }
    case "mirrors": {
      const arg = args?.trim() ?? "list";

      try {
        if (arg === "list" || !arg) {
          const output = await gitTry(["remote", "-v"], cwd, 5000);
          if (!output) return "  No remotes configured.";

          const lines = [`  Git Remotes\n`];

          // Group by remote name
          const remotes = new Map<string, { fetch?: string; push?: string }>();
          for (const line of output.split("\n")) {
            const m = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
            if (m) {
              if (!remotes.has(m[1]!)) remotes.set(m[1]!, {});
              const entry = remotes.get(m[1]!)!;
              if (m[3] === "fetch") entry.fetch = m[2]!;
              if (m[3] === "push") entry.push = m[2]!;
            }
          }

          const { statSync } = await import("node:fs");
          const { resolve: resolvePath } = await import("node:path");

          for (const [name, urls] of remotes) {
            lines.push(`  ${name}`);
            if (urls.fetch) lines.push(`    fetch: ${urls.fetch}`);
            if (urls.push && urls.push !== urls.fetch) lines.push(`    push:  ${urls.push}`);

            // Last fetch time — was a shell `stat` invocation. Use Node fs directly,
            // bounded to the .git directory of the workspace so no untrusted path
            // can ever be passed through.
            try {
              const candidates = [
                resolvePath(cwd, ".git", "refs", "remotes", name),
                resolvePath(cwd, ".git", "FETCH_HEAD"),
              ];
              let mtimeSec: number | null = null;
              for (const c of candidates) {
                try {
                  const st = statSync(c);
                  mtimeSec = Math.floor(st.mtimeMs / 1000);
                  break;
                } catch {
                  /* try next */
                }
              }
              if (mtimeSec) {
                const ago = Math.round(Date.now() / 1000 - mtimeSec);
                const agoStr =
                  ago < 60
                    ? `${ago}s ago`
                    : ago < 3600
                      ? `${Math.round(ago / 60)}m ago`
                      : ago < 86400
                        ? `${Math.round(ago / 3600)}h ago`
                        : `${Math.round(ago / 86400)}d ago`;
                lines.push(`    fetched: ${agoStr}`);
              }
            } catch {
              /* skip */
            }
            lines.push(``);
          }

          return lines.join("\n");
        }

        if (arg.startsWith("add ")) {
          const addParts = arg.slice(4).trim().split(/\s+/);
          if (addParts.length < 2) return "  Usage: /mirrors add <name> <url>";
          const name = addParts[0]!;
          const url = addParts[1]!;
          if (!/^[a-zA-Z0-9_-]+$/.test(name)) return "  Invalid remote name.";
          // Validate URL is a plausible git URL — block control characters and
          // anything that would have only been weaponized by shell expansion.
          if (!/^[a-zA-Z0-9_\-./:@+~]+$/.test(url)) return "  Invalid remote URL characters.";
          await git(["remote", "add", name, url], cwd, 5000, false);
          return `  Added remote: ${name} → ${url}`;
        }

        if (arg.startsWith("remove ")) {
          const name = arg.slice(7).trim();
          if (!/^[a-zA-Z0-9_-]+$/.test(name)) return "  Invalid remote name.";
          await git(["remote", "remove", name], cwd, 5000, false);
          return `  Removed remote: ${name}`;
        }

        return "  Usage: /mirrors [list | add <name> <url> | remove <name>]";
      } catch (err) {
        return formatGitError(err);
      }
    }
    case "stashes": {
      const arg = args?.trim() ?? "list";

      // Validate stash index to prevent command injection
      const validateIndex = (s: string): string | null => {
        const trimmed = s.trim();
        if (/^\d+$/.test(trimmed)) return trimmed;
        return null;
      };

      try {
        if (arg === "list" || !arg) {
          const output = await gitTry(["stash", "list"], cwd, 5000);
          if (!output) return "  No stashes found.";

          const lines = ["  Git Stashes:\n"];
          for (const line of output.split("\n")) {
            // Format: stash@{0}: WIP on branch: message
            const match = line.match(/^(stash@\{(\d+)\}):\s*(.+)$/);
            if (match) {
              lines.push(`  [${match[2]}] ${match[3]}`);
              // Get stat for this stash
              try {
                const stat = await gitTry(
                  ["stash", "show", `stash@{${match[2]}}`, "--stat"],
                  cwd,
                  3000,
                );
                const lastLine = stat.split("\n").pop() ?? "";
                lines.push(`      ${lastLine}`);
              } catch {
                /* ignore */
              }
            } else {
              lines.push(`  ${line}`);
            }
          }
          return lines.join("\n");
        }

        if (arg.startsWith("show ")) {
          const n = validateIndex(arg.slice(5));
          if (n === null) return "  Usage: /stashes show <number>";
          const diff = await git(["stash", "show", "-p", `stash@{${n}}`], cwd, 5000, false);
          if (!diff) return `  Stash @{${n}} is empty or not found.`;
          // Truncate long diffs
          const lines = diff.split("\n");
          const preview = lines.slice(0, 40).join("\n");
          return `  Stash @{${n}}:\n\n${preview}${lines.length > 40 ? `\n  ... ${lines.length - 40} more lines` : ""}`;
        }

        if (arg === "pop") {
          const output = await git(["stash", "pop"], cwd, 10000, false);
          return `  ${output}`;
        }

        if (arg.startsWith("apply ")) {
          const n = validateIndex(arg.slice(6));
          if (n === null) return "  Usage: /stashes apply <number>";
          const output = await git(["stash", "apply", `stash@{${n}}`], cwd, 10000, false);
          return `  ${output}`;
        }

        if (arg.startsWith("drop ")) {
          const n = validateIndex(arg.slice(5));
          if (n === null) return "  Usage: /stashes drop <number>";
          const output = await git(["stash", "drop", `stash@{${n}}`], cwd, 5000, false);
          return `  ${output}`;
        }

        return "  Usage: /stashes [list | show <n> | apply <n> | pop | drop <n>]";
      } catch (err) {
        return formatGitError(err);
      }
    }
    case "contributors": {
      try {
        const shortlog = await gitTry(["shortlog", "-sne", "HEAD"], cwd, 10000);
        if (!shortlog) return "  No git history found.";

        const contributors = shortlog
          .split("\n")
          .map((line) => {
            const match = line.trim().match(/^(\d+)\s+(.+?)\s+<(.+?)>$/);
            if (!match) return null;
            return { commits: parseInt(match[1]!), name: match[2]!, email: match[3]! };
          })
          .filter(Boolean) as Array<{ commits: number; name: string; email: string }>;

        if (contributors.length === 0) return "  No contributors found.";

        const maxCommits = contributors[0]?.commits ?? 1;
        const barWidth = 15;

        const lines = [`  Git Contributors (${contributors.length})\n`];
        const maxNameLen = Math.max(...contributors.slice(0, 20).map((c) => c.name.length), 6);

        for (const c of contributors.slice(0, 20)) {
          const filled = Math.max(1, Math.round((c.commits / maxCommits) * barWidth));
          const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
          lines.push(
            `  ${c.name.padEnd(maxNameLen)}  ${bar} ${c.commits.toString().padStart(5)} commits`,
          );
        }

        if (contributors.length > 20) {
          lines.push(`\n  ... and ${contributors.length - 20} more contributors`);
        }

        // Total stats
        const totalCommits = contributors.reduce((a, b) => a + b.commits, 0);
        lines.push(`\n  Total: ${totalCommits} commits by ${contributors.length} contributor(s)`);

        return lines.join("\n");
      } catch (err) {
        return formatGitError(err);
      }
    }
    case "gitignore": {
      const {
        existsSync,
        readFileSync,
        statSync: statSyncFn,
        appendFileSync,
      } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const gitignorePath = resolvePath(cwd, ".gitignore");
      const input = args?.trim() || "";

      // /gitignore add <pattern>
      if (input.startsWith("add ")) {
        const pattern = input.slice(4).trim();
        if (!pattern) return "  Usage: /gitignore add <pattern>";

        // Check if pattern already exists
        if (existsSync(gitignorePath)) {
          const content = readFileSync(gitignorePath, "utf-8");
          const existingPatterns = content.split("\n").map((l) => l.trim());
          if (existingPatterns.includes(pattern)) {
            return `  Pattern already in .gitignore: ${pattern}`;
          }
        }

        const suffix = existsSync(gitignorePath) ? "\n" + pattern + "\n" : pattern + "\n";
        appendFileSync(gitignorePath, suffix, "utf-8");
        return `  Added to .gitignore: ${pattern}`;
      }

      // /gitignore check <file>
      if (input.startsWith("check ")) {
        const file = input.slice(6).trim();
        if (!file) return "  Usage: /gitignore check <file>";
        try {
          const { execFileSync } = await import("node:child_process");
          const result = execFileSync("git", ["check-ignore", "-v", file], {
            cwd,
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
          })
            .toString()
            .trim();
          return result ? `  Ignored: ${result}` : `  Not ignored: ${file}`;
        } catch {
          return `  Not ignored: ${file}`;
        }
      }

      // Default: inspect .gitignore
      if (!existsSync(gitignorePath)) return "  No .gitignore found in current directory.";
      const stat = statSyncFn(gitignorePath);
      if (stat.size > 512 * 1024) return "  .gitignore too large (max 512 KB).";

      const content = readFileSync(gitignorePath, "utf-8");
      const rawLines = content.split("\n");
      const patterns = rawLines.filter((l) => l.trim() && !l.trim().startsWith("#"));
      const comments = rawLines.filter((l) => l.trim().startsWith("#")).length;

      const lines = [
        `  .gitignore Inspector\n`,
        `  Patterns:  ${patterns.length}`,
        `  Comments:  ${comments}`,
        `  Size:      ${stat.size} bytes`,
        ``,
        `  Patterns:`,
      ];

      for (const p of patterns.slice(0, 50)) {
        lines.push(`    ${p.trim()}`);
      }
      if (patterns.length > 50) {
        lines.push(`    ... and ${patterns.length - 50} more`);
      }

      return lines.join("\n");
    }
    default:
      return null;
  }
}
