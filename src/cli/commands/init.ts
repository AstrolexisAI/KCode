import type { Command } from "commander";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize KCode in the current project")
    .option("--force", "Overwrite existing files")
    .option("--hooks", "Install git hooks (pre-commit, pre-push)")
    .option("--trust", "Trust this workspace (allow .kcode/ hooks, plugins, and MCP servers)")
    .action(async (opts: { force?: boolean; hooks?: boolean; trust?: boolean }) => {
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

      // 8. Trust workspace if --trust flag is set
      if (opts.trust) {
        const { trustWorkspace, isWorkspaceTrusted } = await import("../../core/hook-trust");
        if (!isWorkspaceTrusted(cwd)) {
          trustWorkspace(cwd);
          created.push("workspace trust (added to ~/.kcode/trusted-workspaces.json)");
        } else {
          skipped.push("workspace trust (already trusted)");
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
      if (!opts.trust) {
        const { isWorkspaceTrusted } = await import("../../core/hook-trust");
        if (!isWorkspaceTrusted(cwd)) {
          console.log("Trust workspace:      \x1b[1mkcode init --trust\x1b[0m");
        }
      }
    });
}
