import type { Command } from "commander";
import { collectStats, formatStats } from "../../core/stats";
import { TranscriptManager } from "../../core/transcript";
import { buildConfig } from "../../core/config";
import { checkForUpdate, performUpdate } from "../../core/updater";
import { getBenchmarkSummary, formatBenchmarks, initBenchmarkSchema } from "../../core/benchmarks";

export function registerMiscCommands(program: Command, VERSION: string): void {
  // ─── Stats subcommand ──────────────────────────────────────────
  program
    .command("stats")
    .description("Show usage statistics")
    .option("--days <n>", "Number of days to look back", parseInt, 7)
    .action(async (opts: { days: number }) => {
      const stats = await collectStats(opts.days);
      console.log(formatStats(stats));
    });

  // ─── Init subcommand ──────────────────────────────────────────
  program
    .command("init")
    .description("Initialize KCode in the current project")
    .option("--force", "Overwrite existing files")
    .option("--hooks", "Install git hooks (pre-commit, pre-push)")
    .action(async (opts: { force?: boolean; hooks?: boolean }) => {
      const { mkdirSync, existsSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const cwd = process.cwd();

      const created: string[] = [];
      const skipped: string[] = [];

      // 1. Create KCODE.md
      const kcodeMdPath = join(cwd, "KCODE.md");
      if (!existsSync(kcodeMdPath) || opts.force) {
        const dirName = cwd.split("/").pop() ?? "project";
        writeFileSync(kcodeMdPath, `# KCODE.md

## Project: ${dirName}

<!-- KCode reads this file at the start of every session. -->
<!-- Add project-specific instructions, conventions, and context here. -->

## Build & Development

\`\`\`bash
# Add your build/test/dev commands here
\`\`\`

## Key Conventions

- <!-- Add coding conventions, naming patterns, etc. -->

## Architecture

- <!-- Describe the high-level architecture, key files, modules -->
`, "utf-8");
        created.push("KCODE.md");
      } else {
        skipped.push("KCODE.md (exists)");
      }

      // 2. Create .kcode/ directory structure
      const kcodeDir = join(cwd, ".kcode");
      mkdirSync(kcodeDir, { recursive: true });

      // 3. Create settings.json
      const settingsPath = join(kcodeDir, "settings.json");
      if (!existsSync(settingsPath) || opts.force) {
        writeFileSync(settingsPath, JSON.stringify({
          hooks: {
            PostToolUse: [],
            PreToolUse: [],
          },
        }, null, 2) + "\n", "utf-8");
        created.push(".kcode/settings.json");
      } else {
        skipped.push(".kcode/settings.json (exists)");
      }

      // 4. Create awareness directory
      const awarenessDir = join(kcodeDir, "awareness");
      mkdirSync(awarenessDir, { recursive: true });

      const exampleAwareness = join(awarenessDir, "project.md");
      if (!existsSync(exampleAwareness) || opts.force) {
        writeFileSync(exampleAwareness, `# Project Context

<!-- Add anything KCode should always know about this project. -->
<!-- Examples: API endpoints, environment setup, team conventions. -->
`, "utf-8");
        created.push(".kcode/awareness/project.md");
      } else {
        skipped.push(".kcode/awareness/project.md (exists)");
      }

      // 5. Create rules directory
      const rulesDir = join(kcodeDir, "rules");
      mkdirSync(rulesDir, { recursive: true });

      // 6. Add .kcode to .gitignore if not already there
      const gitignorePath = join(cwd, ".gitignore");
      if (existsSync(gitignorePath)) {
        const gitignore = (await import("node:fs")).readFileSync(gitignorePath, "utf-8");
        if (!gitignore.includes(".kcode/")) {
          (await import("node:fs")).appendFileSync(gitignorePath, "\n# KCode local config\n.kcode/\n", "utf-8");
          created.push(".gitignore (appended .kcode/)");
        }
      }

      // 7. Install git hooks if --hooks flag is set
      if (opts.hooks) {
        const gitDir = join(cwd, ".git");
        if (existsSync(gitDir)) {
          const hooksDir = join(gitDir, "hooks");
          mkdirSync(hooksDir, { recursive: true });

          const preCommitPath = join(hooksDir, "pre-commit");
          if (!existsSync(preCommitPath) || opts.force) {
            writeFileSync(preCommitPath, `#!/bin/sh
# KCode pre-commit hook — runs lint/typecheck on staged files
# To skip: git commit --no-verify

STAGED_TS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\\.(ts|tsx|js|jsx)$')
if [ -n "$STAGED_TS" ]; then
  echo "[kcode] Checking staged TypeScript/JS files..."
  if command -v bunx >/dev/null 2>&1; then
    bunx tsc --noEmit 2>/dev/null
    if [ $? -ne 0 ]; then
      echo "[kcode] TypeScript errors found. Fix them or commit with --no-verify."
      exit 1
    fi
  fi
fi
`, "utf-8");
            const { chmodSync } = await import("node:fs");
            chmodSync(preCommitPath, 0o755);
            created.push(".git/hooks/pre-commit");
          } else {
            skipped.push(".git/hooks/pre-commit (exists)");
          }

          const prePushPath = join(hooksDir, "pre-push");
          if (!existsSync(prePushPath) || opts.force) {
            writeFileSync(prePushPath, `#!/bin/sh
# KCode pre-push hook — runs tests before pushing
# To skip: git push --no-verify

echo "[kcode] Running tests before push..."
if [ -f "package.json" ]; then
  if command -v bun >/dev/null 2>&1; then
    bun test
    STATUS=$?
  elif command -v npm >/dev/null 2>&1; then
    npm test
    STATUS=$?
  else
    STATUS=0
  fi
  if [ "$STATUS" -ne 0 ]; then
    echo "[kcode] Tests failed. Fix them or push with --no-verify."
    exit 1
  fi
elif [ -f "Makefile" ] && grep -q "^test:" Makefile; then
  make test
  if [ $? -ne 0 ]; then
    echo "[kcode] Tests failed."
    exit 1
  fi
fi
`, "utf-8");
            const { chmodSync } = await import("node:fs");
            chmodSync(prePushPath, 0o755);
            created.push(".git/hooks/pre-push");
          } else {
            skipped.push(".git/hooks/pre-push (exists)");
          }
        } else {
          console.log("  \x1b[33m⚠\x1b[0m Not a git repository — skipping hooks installation.");
        }
      }

      // Report
      if (created.length > 0) {
        console.log("\x1b[32m✓\x1b[0m KCode initialized:");
        for (const f of created) console.log(`  + ${f}`);
      }
      if (skipped.length > 0) {
        for (const f of skipped) console.log(`  \x1b[2m- ${f}\x1b[0m`);
      }
      console.log("\nEdit \x1b[1mKCODE.md\x1b[0m to teach KCode about this project.");
      console.log("Add awareness modules: \x1b[1mkcode teach add <name>\x1b[0m");
      if (!opts.hooks) {
        console.log("Install git hooks:    \x1b[1mkcode init --hooks\x1b[0m");
      }
    });

  // ─── New subcommand (project scaffolding) ───────────────────────
  program
    .command("new <template> [name]")
    .description("Create a new project from a template (api, cli, web, library)")
    .action(async (template: string, name?: string) => {
      const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      const projectName = name ?? template;
      const projectDir = join(process.cwd(), projectName);

      if (existsSync(projectDir)) {
        console.error(`\x1b[31mDirectory "${projectName}" already exists.\x1b[0m`);
        process.exit(1);
      }

      mkdirSync(projectDir, { recursive: true });

      const templates: Record<string, () => void> = {
        api: () => {
          mkdirSync(join(projectDir, "src"), { recursive: true });
          mkdirSync(join(projectDir, "src", "routes"), { recursive: true });
          writeFileSync(join(projectDir, "package.json"), JSON.stringify({
            name: projectName,
            version: "0.1.0",
            type: "module",
            scripts: { start: "bun run src/index.ts", dev: "bun --watch run src/index.ts", test: "bun test" },
            devDependencies: { "@types/bun": "latest" },
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, outDir: "dist" },
            include: ["src"],
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "src", "index.ts"), `const server = Bun.serve({
  port: 10080,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    return new Response("Not found", { status: 404 });
  },
});

console.log(\`Server running at http://localhost:\${server.port}\`);
`);
          writeFileSync(join(projectDir, "KCODE.md"), `# ${projectName}\n\nBun API project. Run with \`bun run dev\`.\n`);
        },
        cli: () => {
          mkdirSync(join(projectDir, "src"), { recursive: true });
          writeFileSync(join(projectDir, "package.json"), JSON.stringify({
            name: projectName,
            version: "0.1.0",
            type: "module",
            bin: { [projectName]: "src/index.ts" },
            scripts: { start: "bun run src/index.ts", build: "bun build src/index.ts --compile --outfile dist/" + projectName, test: "bun test" },
            devDependencies: { "@types/bun": "latest" },
            dependencies: { commander: "^14.0.0" },
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true },
            include: ["src"],
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "src", "index.ts"), `#!/usr/bin/env bun
import { Command } from "commander";

const program = new Command()
  .name("${projectName}")
  .description("A CLI tool")
  .version("0.1.0")
  .argument("[input]", "Input to process")
  .action((input?: string) => {
    console.log(\`Hello from ${projectName}!\`, input ?? "");
  });

program.parse();
`);
          writeFileSync(join(projectDir, "KCODE.md"), `# ${projectName}\n\nBun CLI project. Run with \`bun run start\`, build with \`bun run build\`.\n`);
        },
        web: () => {
          mkdirSync(join(projectDir, "src"), { recursive: true });
          mkdirSync(join(projectDir, "public"), { recursive: true });
          writeFileSync(join(projectDir, "package.json"), JSON.stringify({
            name: projectName,
            version: "0.1.0",
            type: "module",
            scripts: { start: "bun run src/server.ts", dev: "bun --watch run src/server.ts", test: "bun test" },
            devDependencies: { "@types/bun": "latest" },
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "src", "server.ts"), `const server = Bun.serve({
  port: 10080,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(Bun.file("public/index.html"));
    const file = Bun.file("public" + url.pathname);
    return new Response(file);
  },
});
console.log(\`Server running at http://localhost:\${server.port}\`);
`);
          writeFileSync(join(projectDir, "public", "index.html"), `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${projectName}</title><link rel="stylesheet" href="/styles.css"></head>
<body><h1>${projectName}</h1><script src="/app.js"></script></body>
</html>
`);
          writeFileSync(join(projectDir, "public", "styles.css"), "body { font-family: system-ui; max-width: 800px; margin: 2rem auto; }\n");
          writeFileSync(join(projectDir, "public", "app.js"), "console.log('Ready');\n");
          writeFileSync(join(projectDir, "KCODE.md"), `# ${projectName}\n\nBun web project. Run with \`bun run dev\`.\n`);
        },
        library: () => {
          mkdirSync(join(projectDir, "src"), { recursive: true });
          mkdirSync(join(projectDir, "tests"), { recursive: true });
          writeFileSync(join(projectDir, "package.json"), JSON.stringify({
            name: projectName,
            version: "0.1.0",
            type: "module",
            main: "src/index.ts",
            scripts: { test: "bun test", build: "bun build src/index.ts --outdir dist" },
            devDependencies: { "@types/bun": "latest" },
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, declaration: true, outDir: "dist" },
            include: ["src"],
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "src", "index.ts"), `export function hello(name: string): string {
  return \`Hello, \${name}!\`;
}
`);
          writeFileSync(join(projectDir, "tests", "index.test.ts"), `import { test, expect } from "bun:test";
import { hello } from "../src/index";

test("hello returns greeting", () => {
  expect(hello("World")).toBe("Hello, World!");
});
`);
          writeFileSync(join(projectDir, "KCODE.md"), `# ${projectName}\n\nBun library project. Test with \`bun test\`.\n`);
        },
      };

      if (!templates[template]) {
        console.error(`\x1b[31mUnknown template "${template}". Available: ${Object.keys(templates).join(", ")}\x1b[0m`);
        process.exit(1);
      }

      templates[template]();

      // Initialize KCode in the new project
      const kcodeDir = join(projectDir, ".kcode");
      mkdirSync(join(kcodeDir, "awareness"), { recursive: true });
      writeFileSync(join(kcodeDir, "settings.json"), JSON.stringify({ hooks: {} }, null, 2) + "\n");

      // Add .gitignore
      writeFileSync(join(projectDir, ".gitignore"), "node_modules/\ndist/\n.kcode/\n");

      console.log(`\x1b[32m✓\x1b[0m Created ${template} project: ${projectName}/`);
      console.log(`\n  cd ${projectName}`);
      console.log("  bun install");
      console.log("  kcode\n");
    });

  // ─── Resume subcommand ──────────────────────────────────────────
  program
    .command("resume")
    .description("List and resume previous sessions")
    .option("-l, --list", "List recent sessions")
    .option("-n, --number <n>", "Number of sessions to show", parseInt, 10)
    .action(async (opts: { list?: boolean; number?: number }) => {
      const transcript = new TranscriptManager();
      const sessions = transcript.listSessions();

      if (sessions.length === 0) {
        console.log("No previous sessions found.");
        return;
      }

      const count = Math.min(opts.number ?? 10, sessions.length);
      console.log(`\nRecent sessions (${count} of ${sessions.length}):\n`);

      for (let i = 0; i < count; i++) {
        const s = sessions[i];
        const date = s.startedAt.replace("T", " ");
        const prompt = s.prompt.slice(0, 60);
        console.log(`  \x1b[36m${i + 1}.\x1b[0m ${date}  ${prompt}`);
      }

      console.log("\nTo resume a session:");
      console.log("  \x1b[1mkcode --continue\x1b[0m         Resume the most recent session");
      console.log("  \x1b[1mkcode --fork\x1b[0m             Fork the most recent session (new transcript)");
    });

  // ─── Search subcommand ──────────────────────────────────────────
  program
    .command("search <query>")
    .description("Search through past session transcripts (FTS-powered)")
    .option("-n, --number <n>", "Max results to show", parseInt, 10)
    .option("-d, --days <days>", "Limit search to last N days", parseInt, 30)
    .option("--reindex", "Rebuild the FTS search index")
    .action(async (query: string, opts: { number?: number; days?: number; reindex?: boolean }) => {
      const { indexAllTranscripts, searchTranscripts, getIndexStats } = await import("../../core/transcript-search");
      const maxResults = opts.number ?? 10;

      // Auto-index on first use or when --reindex is passed
      const doReindex = opts.reindex ?? false;
      if (doReindex) {
        console.log("Rebuilding search index...");
      }

      const { indexed, entries } = indexAllTranscripts(doReindex);
      if (indexed > 0) {
        console.log(`Indexed ${indexed} new sessions (${entries} entries).`);
      }

      const stats = getIndexStats();
      if (stats.entries === 0) {
        console.log("No transcripts to search. Start a conversation first.");
        return;
      }

      // Use FTS search
      const results = await searchTranscripts(query, maxResults);

      if (results.length === 0) {
        // Fallback: try linear search for partial matches
        const transcript = new TranscriptManager();
        const sessions = transcript.listSessions();
        const cutoff = Date.now() - (opts.days ?? 30) * 24 * 60 * 60 * 1000;
        const queryLower = query.toLowerCase();
        let found = 0;

        console.log(`\nNo FTS matches for "${query}". Trying substring search...\n`);

        for (const session of sessions) {
          const dateStr = session.filename.slice(0, 10);
          const fileDate = new Date(dateStr).getTime();
          if (!isNaN(fileDate) && fileDate < cutoff) continue;

          const entries = transcript.loadSession(session.filename);
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.content.toLowerCase().includes(queryLower)) {
              const preview = entry.content.slice(0, 120).replace(/\n/g, " ");
              console.log(`  \x1b[36m${session.startedAt}\x1b[0m [${entry.role}]`);
              console.log(`    ${preview}${entry.content.length > 120 ? "..." : ""}`);
              console.log(`    \x1b[2mSession: ${session.filename}:${i + 1}\x1b[0m`);
              console.log();
              found++;
              if (found >= maxResults) break;
            }
          }
          if (found >= maxResults) break;
        }

        if (found === 0) {
          console.log(`No matches for "${query}" in last ${opts.days ?? 30} days.`);
        }
        return;
      }

      console.log(`\nFound ${results.length} match(es) for "${query}" (${stats.sessions} sessions indexed):\n`);
      for (const r of results) {
        const preview = r.content.slice(0, 120).replace(/\n/g, " ");
        const dateStr = r.timestamp ? new Date(r.timestamp).toLocaleString() : "";
        console.log(`  \x1b[36m${dateStr}\x1b[0m [${r.role}]`);
        console.log(`    ${preview}${r.content.length > 120 ? "..." : ""}`);
        console.log(`    \x1b[2mSession: ${r.sessionFile}\x1b[0m`);
        console.log();
      }
    });

  // ─── Watch subcommand ───────────────────────────────────────────
  program
    .command("watch [glob]")
    .description("Watch files for changes and auto-run commands")
    .option("-p, --pattern <glob>", "Glob pattern to watch", "**/*.{ts,js,tsx,jsx,py,rs,go}")
    .option("-i, --ignore <dirs>", "Directories to ignore (comma-separated)", "node_modules,dist,build,.git,__pycache__")
    .option("--run <command>", "Command to run on file change (default: auto-detect test runner)")
    .option("--debounce <ms>", "Debounce interval in milliseconds", parseInt, 500)
    .option("--auto-fix", "On failure, invoke KCode to auto-fix errors and re-run")
    .action(async (glob: string | undefined, opts: { pattern?: string; ignore?: string; run?: string; debounce?: number; autoFix?: boolean }) => {
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
        if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bunfig.toml"))) command = "bun test";
        else if (existsSync(join(cwd, "package.json"))) command = "npm test";
        else if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml"))) command = "pytest";
        else if (existsSync(join(cwd, "go.mod"))) command = "go test ./...";
        else if (existsSync(join(cwd, "Cargo.toml"))) command = "cargo test";
      }

      const watchPattern = glob ?? opts.pattern ?? "**/*.{ts,js,tsx,jsx,py,rs,go}";

      if (command) {
        console.log(`\x1b[36mWatching:\x1b[0m ${watchPattern}`);
        console.log(`\x1b[36mCommand:\x1b[0m ${command}`);
        if (opts.autoFix) console.log(`\x1b[36mAuto-fix:\x1b[0m enabled (KCode will attempt to fix errors)`);
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
              const kcodeArgs = ["--print", "--permission", "acceptEdits", fixPrompt];
              const { homedir } = await import("node:os");
              const kcodeBin = [join(homedir(), ".local", "bin", "kcode"), "/usr/local/bin/kcode"].find(p => existsSync(p)) ?? "kcode";
              const fixOutput = execFileSync(kcodeBin, kcodeArgs, {
                cwd,
                timeout: 120000,
                stdio: "pipe",
                env: { ...process.env },
              }).toString();
              const fixLines = fixOutput.trim().split("\n").slice(-10).join("\n");
              console.log(`\x1b[32m⚡ Auto-fix result:\x1b[0m\n${fixLines}\n`);
            } catch (fixErr: any) {
              const fixStderr = fixErr.stderr?.toString() || fixErr.message || "";
              console.log(`\x1b[31m⚡ Auto-fix failed:\x1b[0m ${fixStderr.trim().split("\n").slice(-3).join("\n")}\n`);
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
        } catch { /* ignore */ }
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
            if (relPath.includes("node_modules") || relPath.includes("dist/") || relPath.includes(".git/")) return;

            // Deduplicate rapid-fire events (debounce)
            const now = Date.now();
            const last = recentChanges.get(relPath) ?? 0;
            if (now - last < debounceMs) return;
            recentChanges.set(relPath, now);

            // Check pattern match (simple extension check)
            const ext = filename.split(".").pop() ?? "";
            const allowedExts = (watchPattern)
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
        } catch { /* skip unwatchable dirs */ }
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
    });

  // ─── Update subcommand ──────────────────────────────────────────
  program
    .command("update")
    .description("Check for updates and self-update KCode")
    .option("--check", "Only check, don't download")
    .option("--url <url>", "Custom update URL")
    .action(async (opts: { check?: boolean; url?: string }) => {
      if (opts.check) {
        const newVersion = await checkForUpdate(VERSION);
        if (newVersion) {
          console.log(`\x1b[33mUpdate available: v${VERSION} → v${newVersion}\x1b[0m`);
          console.log("Run \x1b[1mkcode update\x1b[0m to install.");
        } else {
          console.log(`\x1b[32m✓\x1b[0m KCode v${VERSION} is up to date.`);
        }
        return;
      }

      const result = await performUpdate(VERSION, opts.url);
      if (result.error) {
        console.error(`\x1b[31m✗ ${result.error}\x1b[0m`);
        process.exit(1);
      }
    });

  // ─── Warmup subcommand ─────────────────────────────────────────
  program
    .command("warmup")
    .description("Warm up the model with a probe request")
    .option("-m, --model <model>", "Model to warm up")
    .action(async (opts: { model?: string }) => {
      const config = await buildConfig(process.cwd());
      const model = opts.model ?? config.model;
      const { getModelBaseUrl } = await import("../../core/models");
      const baseUrl = await getModelBaseUrl(model, config.apiBase);

      console.log(`Warming up ${model} at ${baseUrl}...`);
      const start = Date.now();

      try {
        const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Say OK" }],
            max_tokens: 8,
            stream: false,
          }),
          signal: AbortSignal.timeout(30000),
        });

        const data = await resp.json() as any;
        const elapsed = Date.now() - start;
        const text = data.choices?.[0]?.message?.content ?? "(no response)";
        const tokens = data.usage?.total_tokens ?? 0;

        console.log(`\x1b[32m✓\x1b[0m Model ready (${elapsed}ms, ${tokens} tok)`);
        console.log(`  Response: ${text.slice(0, 50)}`);

        if (elapsed > 5000) {
          console.log(`\x1b[33m⚠\x1b[0m Slow response — model may still be loading into VRAM`);
        }
      } catch (err) {
        const elapsed = Date.now() - start;
        console.error(`\x1b[31m✗\x1b[0m Warmup failed after ${elapsed}ms`);
        console.error(`  ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // ─── Benchmark subcommand ───────────────────────────────────────
  program
    .command("benchmark")
    .alias("bench")
    .description("Show model quality benchmark results")
    .option("-m, --model <model>", "Filter by model name")
    .option("-d, --days <days>", "Number of days to look back", parseInt, 30)
    .action(async (opts: { model?: string; days?: number }) => {
      try { initBenchmarkSchema(); } catch { /* ignore */ }
      const summaries = getBenchmarkSummary(opts.model, opts.days ?? 30);
      console.log(formatBenchmarks(summaries));
    });

  // ─── Completions subcommand ──────────────────────────────────────
  program
    .command("completions <shell>")
    .description("Generate shell completion script (bash or zsh)")
    .action((shell: string) => {
      if (shell === "bash") {
        console.log(`# KCode bash completion - add to ~/.bashrc:
# eval "$(kcode completions bash)"

_kcode_completions() {
  local cur prev commands subcommands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="models setup server activate pro stats doctor teach init resume search watch new update benchmark completions serve history"

  if [ $COMP_CWORD -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return
  fi

  case "$prev" in
    models)
      COMPREPLY=( $(compgen -W "list add remove set-default" -- "$cur") )
      ;;
    new)
      COMPREPLY=( $(compgen -W "api cli web library" -- "$cur") )
      ;;
    completions)
      COMPREPLY=( $(compgen -W "bash zsh" -- "$cur") )
      ;;
    *)
      COMPREPLY=( $(compgen -f -- "$cur") )
      ;;
  esac
}
complete -F _kcode_completions kcode`);
      } else if (shell === "zsh") {
        console.log(`#compdef kcode
# KCode zsh completion - add to ~/.zshrc:
# eval "$(kcode completions zsh)"

_kcode() {
  local -a commands
  commands=(
    'models:Manage registered LLM models'
    'setup:Run the setup wizard'
    'server:Manage local inference server'
    'init:Initialize a new project'
    'resume:List and resume sessions'
    'search:Search session transcripts'
    'watch:Watch for file changes'
    'new:Create project from template'
    'update:Check for updates'
    'benchmark:Show benchmark results'
    'completions:Generate shell completions'
    'serve:Start HTTP API server'
    'history:Browse session history'
  )

  _arguments -C \\
    '1:command:->cmd' \\
    '*::arg:->args'

  case $state in
    cmd)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        models)
          _values 'subcommand' list add remove set-default
          ;;
        new)
          _values 'template' api cli web library
          ;;
        completions)
          _values 'shell' bash zsh
          ;;
        *)
          _files
          ;;
      esac
      ;;
  esac
}

_kcode`);
      } else {
        console.error(`Unsupported shell: ${shell}. Use 'bash' or 'zsh'.`);
        process.exit(1);
      }
    });

  // ─── History subcommand ──────────────────────────────────────────
  program
    .command("history")
    .description("Browse and manage session history")
    .option("-n, --limit <count>", "Number of sessions to show", parseInt, 20)
    .option("--load <filename>", "Load a specific session by filename")
    .option("--delete <filename>", "Delete a specific session")
    .option("--clear", "Delete all sessions")
    .action(async (opts: { limit?: number; load?: string; delete?: string; clear?: boolean }) => {
      const { readdirSync, unlinkSync, statSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const transcriptsDir = join(homedir(), ".kcode", "transcripts");

      if (opts.clear) {
        try {
          const files = readdirSync(transcriptsDir).filter(f => f.endsWith(".jsonl"));
          for (const f of files) unlinkSync(join(transcriptsDir, f));
          console.log(`Deleted ${files.length} sessions.`);
        } catch { console.log("No sessions to delete."); }
        return;
      }

      if (opts.delete) {
        try {
          unlinkSync(join(transcriptsDir, opts.delete));
          console.log(`Deleted: ${opts.delete}`);
        } catch { console.error(`Session not found: ${opts.delete}`); process.exit(1); }
        return;
      }

      if (opts.load) {
        // Load and display session contents
        try {
          const { readFileSync } = await import("node:fs");
          const content = readFileSync(join(transcriptsDir, opts.load), "utf-8");
          const entries = content.trim().split("\n").filter(Boolean).map(line => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);

          console.log(`\n\x1b[1mSession: ${opts.load}\x1b[0m`);
          console.log(`Entries: ${entries.length}\n`);

          for (const entry of entries) {
            const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString("en-US", { hour12: false }) : "??:??";
            const role = entry.role ?? "?";
            const type = entry.type ?? "?";
            const content = (entry.content ?? "").slice(0, 120);

            if (type === "user_message") {
              console.log(`  \x1b[36m${time}\x1b[0m \x1b[1m❯\x1b[0m ${content}`);
            } else if (type === "assistant_text") {
              console.log(`  \x1b[36m${time}\x1b[0m   ${content}`);
            } else if (type === "tool_use") {
              try {
                const parsed = JSON.parse(content);
                console.log(`  \x1b[36m${time}\x1b[0m \x1b[33m⚡ ${parsed.name}\x1b[0m`);
              } catch {
                console.log(`  \x1b[36m${time}\x1b[0m \x1b[33m⚡ tool\x1b[0m`);
              }
            }
          }
          console.log();
        } catch {
          console.error(`Could not read session: ${opts.load}`);
          process.exit(1);
        }
        return;
      }

      // List recent sessions
      try {
        const files = readdirSync(transcriptsDir)
          .filter(f => f.endsWith(".jsonl"))
          .sort()
          .reverse()
          .slice(0, opts.limit ?? 20);

        if (files.length === 0) {
          console.log("No session history found.");
          return;
        }

        console.log(`\n\x1b[1mRecent sessions\x1b[0m (${files.length}):\n`);
        for (const f of files) {
          try {
            const stat = statSync(join(transcriptsDir, f));
            const sizeKB = Math.round(stat.size / 1024);
            // Extract date and slug from filename: 2026-03-17T12-30-45-slug.jsonl
            const match = f.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})-(.+)\.jsonl$/);
            if (match) {
              const date = match[1];
              const time = match[2].replace(/-/g, ":");
              const slug = match[3].replace(/-/g, " ");
              console.log(`  \x1b[36m${date} ${time}\x1b[0m  ${slug.slice(0, 50).padEnd(52)} \x1b[2m${sizeKB}KB\x1b[0m`);
            } else {
              console.log(`  ${f}  \x1b[2m${sizeKB}KB\x1b[0m`);
            }
          } catch {
            console.log(`  ${f}`);
          }
        }
        console.log(`\n  Load a session: \x1b[1mkcode history --load <filename>\x1b[0m`);
        console.log(`  Continue it:    \x1b[1mkcode --continue\x1b[0m\n`);
      } catch {
        console.log("No session history found.");
      }
    });

  // ─── Serve subcommand (HTTP API) ─────────────────────────────────
  program
    .command("serve")
    .description("Start KCode as an HTTP API server")
    .option("-p, --port <port>", "Port to listen on", (v: string) => parseInt(v, 10), 10101)
    .option("-h, --host <host>", "Host to bind to", "127.0.0.1")
    .option("--api-key <key>", "Require this API key for authentication")
    .action(async (opts: { port?: number; host?: string; apiKey?: string }) => {
      try {
        const { startHttpServer } = await import("../../core/http-server.js");
        process.env.KCODE_VERSION = VERSION;
        await startHttpServer({
          port: opts.port ?? 10101,
          host: opts.host ?? "127.0.0.1",
          apiKey: opts.apiKey,
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}
