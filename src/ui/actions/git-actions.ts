// Git actions
// Auto-extracted from builtin-actions.ts

import type { ActionContext } from "./action-helpers.js";

export async function handleGitAction(action: string, ctx: ActionContext): Promise<string | null> {
  const { conversationManager, setCompleted, appConfig, args, switchTheme } = ctx;

  switch (action) {
    case "blame": {
      if (!args?.trim()) return "  Usage: /blame <file path>";

      const { execSync } = await import("node:child_process");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());
      const relPath = relative(cwd, filePath);

      try {
        const shortOutput = execSync(`git blame --date=short "${relPath}" 2>&1`, {
          cwd,
          timeout: 10000,
        })
          .toString()
          .trim();
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
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "tags": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const arg = args?.trim() ?? "list";

      try {
        if (arg === "list" || !arg) {
          const output = execSync(
            `git tag -l --sort=-creatordate --format='%(creatordate:short) %(refname:short) %(subject)' 2>/dev/null | head -20`,
            { cwd, timeout: 5000 },
          )
            .toString()
            .trim();
          if (!output) return "  No tags found.";

          const lines = [`  Git Tags\n`];
          for (const line of output.split("\n")) {
            const parts = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
            if (parts) {
              lines.push(`  ${parts[2]!.padEnd(20)} ${parts[1]!}  ${parts[3] || ""}`);
            } else {
              lines.push(`  ${line}`);
            }
          }

          // Count total
          const total = execSync(`git tag -l 2>/dev/null | wc -l`, { cwd, timeout: 3000 })
            .toString()
            .trim();
          lines.push(`\n  ${total} tag(s) total`);
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
            execSync(
              `git tag -a '${tagName.replace(/'/g, "")}' -m '${message.replace(/'/g, "'\\''")}'`,
              { cwd, timeout: 5000 },
            );
          } else {
            execSync(`git tag '${tagName.replace(/'/g, "")}'`, { cwd, timeout: 5000 });
          }
          return `  Created tag: ${tagName}${message ? ` ("${message}")` : ""}`;
        }

        if (arg.startsWith("log ") && arg.includes("..")) {
          const range = arg.slice(4).trim();
          // Validate range format
          if (!/^[a-zA-Z0-9._-]+\.\.[a-zA-Z0-9._-]+$/.test(range)) {
            return "  Usage: /tags log <tag1>..<tag2>";
          }
          const output = execSync(`git log --oneline '${range}' 2>&1`, { cwd, timeout: 10000 })
            .toString()
            .trim();
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
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "file_history": {
      if (!args?.trim()) return "  Usage: /file-history <file path>";

      const { execSync } = await import("node:child_process");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());
      const relPath = relative(cwd, filePath);

      try {
        const output = execSync(
          `git log --oneline --follow --stat -- '${relPath.replace(/'/g, "'\\''")}'  2>&1 | head -60`,
          { cwd, timeout: 10000 },
        )
          .toString()
          .trim();
        if (!output) return `  No git history for: ${args.trim()}`;

        // Count total commits for the file
        const countOutput = execSync(
          `git log --oneline --follow -- '${relPath.replace(/'/g, "'\\''")}'  2>/dev/null | wc -l`,
          { cwd, timeout: 5000 },
        )
          .toString()
          .trim();

        const lines = [`  File History: ${relPath} (${countOutput} commits)\n`];
        for (const line of output.split("\n")) {
          lines.push(`  ${line}`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "diff_branch": {
      if (!args?.trim()) return "  Usage: /diff-branch <target branch>";

      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const target = args.trim();

      // Validate branch name
      if (!/^[a-zA-Z0-9._\-/]+$/.test(target)) return "  Invalid branch name.";

      try {
        // Get current branch
        const current =
          execSync(`git branch --show-current 2>/dev/null`, { cwd, timeout: 3000 })
            .toString()
            .trim() || "HEAD";

        // Check target exists
        try {
          execSync(`git rev-parse --verify '${target.replace(/'/g, "'\\''")}' 2>/dev/null`, {
            cwd,
            timeout: 3000,
          });
        } catch {
          return `  Branch not found: ${target}`;
        }

        // Merge base
        const mergeBase = execSync(
          `git merge-base '${current.replace(/'/g, "'\\''")}' '${target.replace(/'/g, "'\\''")}' 2>/dev/null`,
          { cwd, timeout: 5000 },
        )
          .toString()
          .trim()
          .slice(0, 8);

        // Commit counts
        const ahead = execSync(
          `git rev-list --count '${target.replace(/'/g, "'\\''")}'..'${current.replace(/'/g, "'\\''")}' 2>/dev/null`,
          { cwd, timeout: 5000 },
        )
          .toString()
          .trim();
        const behind = execSync(
          `git rev-list --count '${current.replace(/'/g, "'\\''")}'..'${target.replace(/'/g, "'\\''")}' 2>/dev/null`,
          { cwd, timeout: 5000 },
        )
          .toString()
          .trim();

        // Diff stat
        const diffStat = execSync(
          `git diff --stat '${target.replace(/'/g, "'\\''")}' 2>/dev/null | tail -1`,
          { cwd, timeout: 10000 },
        )
          .toString()
          .trim();

        // Changed files list
        const changedFiles = execSync(
          `git diff --name-status '${target.replace(/'/g, "'\\''")}' 2>/dev/null | head -20`,
          { cwd, timeout: 10000 },
        )
          .toString()
          .trim();

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
          const totalChanged = execSync(
            `git diff --name-only '${target.replace(/'/g, "'\\''")}' 2>/dev/null | wc -l`,
            { cwd, timeout: 5000 },
          )
            .toString()
            .trim();
          if (parseInt(totalChanged) > 20)
            lines.push(`\n    ... ${parseInt(totalChanged) - 20} more files`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "diff_stats": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      try {
        execSync(`git rev-parse --is-inside-work-tree 2>/dev/null`, { cwd, timeout: 3000 });
      } catch {
        return "  Not a git repository.";
      }

      const lines = [`  Repository Stats\n`];

      try {
        // Total commits
        const totalCommits = execSync(`git rev-list --count HEAD 2>/dev/null`, {
          cwd,
          timeout: 5000,
        })
          .toString()
          .trim();
        lines.push(`  Total commits:  ${parseInt(totalCommits).toLocaleString()}`);

        // Contributors
        const contributors = execSync(`git shortlog -sn --no-merges HEAD 2>/dev/null | wc -l`, {
          cwd,
          timeout: 5000,
        })
          .toString()
          .trim();
        lines.push(`  Contributors:   ${contributors}`);

        // First and last commit dates
        const firstCommit = execSync(`git rev-list --max-parents=0 HEAD 2>/dev/null | head -1`, {
          cwd,
          timeout: 5000,
        })
          .toString()
          .trim();
        const firstDate = firstCommit
          ? execSync(`git log -1 --format='%ai' '${firstCommit}' 2>/dev/null`, {
              cwd,
              timeout: 3000,
            })
              .toString()
              .trim()
          : "";
        const lastDate = execSync(`git log -1 --format='%ai' 2>/dev/null`, { cwd, timeout: 5000 })
          .toString()
          .trim();
        if (firstDate) lines.push(`  First commit:   ${firstDate.slice(0, 10)}`);
        if (lastDate) lines.push(`  Last commit:    ${lastDate.slice(0, 10)}`);

        // Commits in last 7 days
        const weekCommits = execSync(`git rev-list --count --since='7 days ago' HEAD 2>/dev/null`, {
          cwd,
          timeout: 5000,
        })
          .toString()
          .trim();
        lines.push(`  Last 7 days:    ${weekCommits} commits`);

        // Commits in last 30 days
        const monthCommits = execSync(
          `git rev-list --count --since='30 days ago' HEAD 2>/dev/null`,
          { cwd, timeout: 5000 },
        )
          .toString()
          .trim();
        lines.push(`  Last 30 days:   ${monthCommits} commits`);

        lines.push(``);

        // Most changed files (top 10)
        const hotFiles = execSync(
          `git log --pretty=format: --name-only 2>/dev/null | sort | uniq -c | sort -rn | head -10`,
          { cwd, timeout: 10000 },
        )
          .toString()
          .trim();
        if (hotFiles) {
          lines.push(`  Most Changed Files:`);
          for (const line of hotFiles.split("\n")) {
            const m = line.trim().match(/^(\d+)\s+(.+)$/);
            if (m && m[2]) lines.push(`    ${m[1]!.padStart(5)}  ${m[2]}`);
          }
        }

        lines.push(``);

        // Recent activity (commits per day, last 7 days)
        const dayActivity = execSync(
          `git log --format='%ad' --date=short --since='7 days ago' 2>/dev/null | sort | uniq -c | sort -rn`,
          { cwd, timeout: 5000 },
        )
          .toString()
          .trim();
        if (dayActivity) {
          lines.push(`  Daily Activity (last 7 days):`);
          for (const line of dayActivity.split("\n")) {
            const m = line.trim().match(/^(\d+)\s+(.+)$/);
            if (m) {
              const count = parseInt(m[1]!);
              const bar = "\u2588".repeat(Math.min(count, 30));
              lines.push(`    ${m[2]}  ${bar} ${count}`);
            }
          }
        }
      } catch (err: any) {
        lines.push(`  Error: ${err.message}`);
      }

      return lines.join("\n");
    }
    case "git_graph": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const count = Math.min(Math.max(parseInt(args?.trim() || "20") || 20, 5), 50);

      try {
        const output = execSync(
          `git log --graph --oneline --decorate --all -n ${count} 2>/dev/null`,
          { cwd, timeout: 10000 },
        )
          .toString()
          .trim();

        if (!output) return "  No git history found.";

        const lines = [`  Git Graph (last ${count})\n`];
        for (const line of output.split("\n")) {
          lines.push(`  ${line}`);
        }

        // Branch summary
        try {
          const branches = execSync(`git branch -a 2>/dev/null | wc -l`, { cwd, timeout: 3000 })
            .toString()
            .trim();
          const currentBranch = execSync(`git branch --show-current 2>/dev/null`, {
            cwd,
            timeout: 3000,
          })
            .toString()
            .trim();
          lines.push(`\n  Current: ${currentBranch || "detached HEAD"}  |  Branches: ${branches}`);
        } catch {
          /* skip */
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "mirrors": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const arg = args?.trim() ?? "list";

      try {
        if (arg === "list" || !arg) {
          const output = execSync(`git remote -v 2>/dev/null`, { cwd, timeout: 5000 })
            .toString()
            .trim();
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

          for (const [name, urls] of remotes) {
            lines.push(`  ${name}`);
            if (urls.fetch) lines.push(`    fetch: ${urls.fetch}`);
            if (urls.push && urls.push !== urls.fetch) lines.push(`    push:  ${urls.push}`);

            // Last fetch time
            try {
              const fetchHead = execSync(
                `stat -c '%Y' '.git/refs/remotes/${name.replace(/'/g, "'\\''")}' 2>/dev/null || stat -c '%Y' .git/FETCH_HEAD 2>/dev/null`,
                { cwd, timeout: 3000 },
              )
                .toString()
                .trim();
              if (fetchHead) {
                const ago = Math.round(Date.now() / 1000 - parseInt(fetchHead));
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
          execSync(`git remote add '${name}' '${url.replace(/'/g, "'\\''")}' 2>&1`, {
            cwd,
            timeout: 5000,
          });
          return `  Added remote: ${name} → ${url}`;
        }

        if (arg.startsWith("remove ")) {
          const name = arg.slice(7).trim();
          if (!/^[a-zA-Z0-9_-]+$/.test(name)) return "  Invalid remote name.";
          execSync(`git remote remove '${name}' 2>&1`, { cwd, timeout: 5000 });
          return `  Removed remote: ${name}`;
        }

        return "  Usage: /mirrors [list | add <name> <url> | remove <name>]";
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "stashes": {
      const { execSync } = await import("node:child_process");
      const arg = args?.trim() ?? "list";
      const cwd = appConfig.workingDirectory;

      // Validate stash index to prevent command injection
      const validateIndex = (s: string): string | null => {
        const trimmed = s.trim();
        if (/^\d+$/.test(trimmed)) return trimmed;
        return null;
      };

      try {
        if (arg === "list" || !arg) {
          const output = execSync("git stash list 2>/dev/null", { cwd, timeout: 5000 })
            .toString()
            .trim();
          if (!output) return "  No stashes found.";

          const lines = ["  Git Stashes:\n"];
          for (const line of output.split("\n")) {
            // Format: stash@{0}: WIP on branch: message
            const match = line.match(/^(stash@\{(\d+)\}):\s*(.+)$/);
            if (match) {
              lines.push(`  [${match[2]}] ${match[3]}`);
              // Get stat for this stash
              try {
                const stat = execSync(`git stash show stash@{${match[2]}} --stat 2>/dev/null`, {
                  cwd,
                  timeout: 3000,
                })
                  .toString()
                  .trim();
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
          const diff = execSync(`git stash show -p stash@{${n}} 2>&1`, { cwd, timeout: 5000 })
            .toString()
            .trim();
          if (!diff) return `  Stash @{${n}} is empty or not found.`;
          // Truncate long diffs
          const lines = diff.split("\n");
          const preview = lines.slice(0, 40).join("\n");
          return `  Stash @{${n}}:\n\n${preview}${lines.length > 40 ? `\n  ... ${lines.length - 40} more lines` : ""}`;
        }

        if (arg === "pop") {
          const output = execSync("git stash pop 2>&1", { cwd, timeout: 10000 }).toString().trim();
          return `  ${output}`;
        }

        if (arg.startsWith("apply ")) {
          const n = validateIndex(arg.slice(6));
          if (n === null) return "  Usage: /stashes apply <number>";
          const output = execSync(`git stash apply stash@{${n}} 2>&1`, { cwd, timeout: 10000 })
            .toString()
            .trim();
          return `  ${output}`;
        }

        if (arg.startsWith("drop ")) {
          const n = validateIndex(arg.slice(5));
          if (n === null) return "  Usage: /stashes drop <number>";
          const output = execSync(`git stash drop stash@{${n}} 2>&1`, { cwd, timeout: 5000 })
            .toString()
            .trim();
          return `  ${output}`;
        }

        return "  Usage: /stashes [list | show <n> | apply <n> | pop | drop <n>]";
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString() || err.message}`;
      }
    }
    case "contributors": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      try {
        // Get contributor stats using git shortlog
        const shortlog = execSync(`git shortlog -sne HEAD 2>/dev/null`, { cwd, timeout: 10000 })
          .toString()
          .trim();
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
          const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
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
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "gitignore": {
      const {
        existsSync,
        readFileSync,
        statSync: statSyncFn,
        appendFileSync,
      } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
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
