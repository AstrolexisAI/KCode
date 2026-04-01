import type { Command } from "commander";

export function registerWatchCommand(program: Command): void {
  program
    .command("watch [glob]")
    .description("Watch files for changes and auto-run commands")
    .option("-p, --pattern <glob>", "Glob pattern to watch", "**/*.{ts,js,tsx,jsx,py,rs,go}")
    .option(
      "-i, --ignore <dirs>",
      "Directories to ignore (comma-separated)",
      "node_modules,dist,build,.git,__pycache__",
    )
    .option("--run <command>", "Command to run on file change (default: auto-detect test runner)")
    .option("--debounce <ms>", "Debounce interval in milliseconds", parseInt, 500)
    .option("--auto-fix", "On failure, invoke KCode to auto-fix errors and re-run")
    .action(
      async (
        glob: string | undefined,
        opts: {
          pattern?: string;
          ignore?: string;
          run?: string;
          debounce?: number;
          autoFix?: boolean;
        },
      ) => {
        const { watch } = await import("node:fs");
        const { join, relative, resolve: resolvePath } = await import("node:path");
        const { readdirSync, existsSync } = await import("node:fs");
        const { execSync } = await import("node:child_process");
        const cwd = process.cwd();
        const ignoreDirs = new Set((opts.ignore ?? "").split(",").map((d) => d.trim()));
        const debounceMs = opts.debounce ?? 500;

        // Detect test runner if no --run provided
        let command = opts.run;
        if (!command) {
          if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bunfig.toml")))
            command = "bun test";
          else if (existsSync(join(cwd, "package.json"))) command = "npm test";
          else if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml")))
            command = "pytest";
          else if (existsSync(join(cwd, "go.mod"))) command = "go test ./...";
          else if (existsSync(join(cwd, "Cargo.toml"))) command = "cargo test";
        }

        const watchPattern = glob ?? opts.pattern ?? "**/*.{ts,js,tsx,jsx,py,rs,go}";

        if (command) {
          console.log(`\x1b[36mWatching:\x1b[0m ${watchPattern}`);
          console.log(`\x1b[36mCommand:\x1b[0m ${command}`);
          if (opts.autoFix)
            console.log(`\x1b[36mAuto-fix:\x1b[0m enabled (KCode will attempt to fix errors)`);
          console.log(`\x1b[2mPress Ctrl+C to stop\x1b[0m\n`);
        } else {
          console.log(`\x1b[36mWatching for changes...\x1b[0m (Ctrl+C to stop)`);
          console.log(`  Pattern: ${watchPattern}`);
          console.log(`  Ignoring: ${Array.from(ignoreDirs).join(", ")}\n`);
        }

        let timeout: ReturnType<typeof setTimeout> | null = null;
        let runCount = 0;

        let autoFixRunning = false;

        const runCommand = async (changedFile: string) => {
          if (!command) return;
          if (autoFixRunning) return; // Don't trigger while auto-fix is in progress
          runCount++;
          const rel = relative(cwd, changedFile);
          console.log(`\x1b[33m[${runCount}]\x1b[0m ${rel} changed — running: ${command}`);

          try {
            const output = execSync(command!, { cwd, timeout: 60000, stdio: "pipe" }).toString();
            const lines = output.trim().split("\n");
            const lastLines = lines.slice(-5).join("\n");
            console.log(`\x1b[32m✓\x1b[0m ${lastLines}\n`);
          } catch (err: any) {
            const stderr = err.stderr?.toString() || err.stdout?.toString() || err.message;
            const errorLines = stderr.trim().split("\n").slice(-8).join("\n");
            console.log(`\x1b[31m✗\x1b[0m ${errorLines}\n`);

            // Auto-fix: invoke KCode to analyze and fix the errors
            if (opts.autoFix && !autoFixRunning) {
              autoFixRunning = true;
              console.log(`\x1b[36m⚡ Auto-fix: invoking KCode to fix errors...\x1b[0m`);
              const truncatedErr = stderr.trim().slice(-3000);
              const fixPrompt = `The command "${command}" failed. Error output:\n\`\`\`\n${truncatedErr}\n\`\`\`\nAnalyze the errors, read the failing files, apply minimal fixes, then run "${command}" again to verify.`;
              try {
                const { execFileSync } = await import("node:child_process");
                const { homedir } = await import("node:os");
                const kcodeBin =
                  [join(homedir(), ".local", "bin", "kcode"), "/usr/local/bin/kcode"].find((p) =>
                    existsSync(p),
                  ) ?? "kcode";
                const fixOutput = execFileSync(
                  kcodeBin,
                  ["--print", "--permission", "acceptEdits", fixPrompt],
                  {
                    cwd,
                    timeout: 120000,
                    stdio: "pipe",
                    env: { ...process.env },
                  },
                ).toString();
                const fixLines = fixOutput.trim().split("\n").slice(-10).join("\n");
                console.log(`\x1b[32m⚡ Auto-fix result:\x1b[0m\n${fixLines}\n`);
              } catch (fixErr: any) {
                const fixStderr = fixErr.stderr?.toString() || fixErr.message || "";
                console.log(
                  `\x1b[31m⚡ Auto-fix failed:\x1b[0m ${fixStderr.trim().split("\n").slice(-3).join("\n")}\n`,
                );
              }
              autoFixRunning = false;
            }
          }
        };

        // Collect directories to watch
        function getDirs(dir: string): string[] {
          const dirs = [dir];
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue;
              if (entry.name.startsWith(".") || ignoreDirs.has(entry.name)) continue;
              dirs.push(...getDirs(join(dir, entry.name)));
            }
          } catch {
            /* ignore */
          }
          return dirs;
        }

        const watchDirs = getDirs(cwd);
        const watchers: ReturnType<typeof watch>[] = [];
        const recentChanges = new Map<string, number>();

        for (const dir of watchDirs) {
          try {
            const watcher = watch(dir, { recursive: false }, (eventType, filename) => {
              if (!filename) return;
              const fullPath = join(dir, filename);
              const relPath = relative(cwd, fullPath);

              // Ignore node_modules, dist, .git
              if (
                relPath.includes("node_modules") ||
                relPath.includes("dist/") ||
                relPath.includes(".git/")
              )
                return;

              // Deduplicate rapid-fire events (debounce)
              const now = Date.now();
              const last = recentChanges.get(relPath) ?? 0;
              if (now - last < debounceMs) return;
              recentChanges.set(relPath, now);

              // Check pattern match (simple extension check)
              const ext = filename.split(".").pop() ?? "";
              const allowedExts = watchPattern
                .replace(/\*\*\/\*\.\{?/g, "")
                .replace(/\}$/g, "")
                .split(",");
              if (allowedExts.length > 0 && !allowedExts.includes(ext)) return;

              if (command) {
                // Auto-run mode: debounce and run command
                if (timeout) clearTimeout(timeout);
                timeout = setTimeout(() => runCommand(resolvePath(cwd, relPath)), debounceMs);
              } else {
                // Report mode: just print the change
                const time = new Date().toLocaleTimeString("en-US", { hour12: false });
                const icon = eventType === "rename" ? "+" : "*";
                console.log(`  \x1b[33m${time}\x1b[0m ${icon} ${relPath}`);
              }
            });
            watchers.push(watcher);
          } catch {
            /* skip unwatchable dirs */
          }
        }

        console.log(`  Watching ${watchDirs.length} directories\n`);

        // Keep process alive
        await new Promise(() => {
          process.on("SIGINT", () => {
            for (const w of watchers) w.close();
            if (command) {
              console.log(`\n\x1b[2mStopped watching. ${runCount} runs total.\x1b[0m`);
            } else {
              console.log("\n  Watch stopped.");
            }
            process.exit(0);
          });
        });
      },
    );
}
