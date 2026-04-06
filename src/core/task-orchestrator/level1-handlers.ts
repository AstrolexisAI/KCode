// KCode - Level 1 Handlers: Zero-LLM execution
//
// These commands are 100% deterministic. The machine detects what to do
// and executes directly — no tokens spent, instant response.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function run(cmd: string, cwd: string, timeout = 30_000): { output: string; code: number } {
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { output, code: 0 };
  } catch (err: any) {
    return {
      output: err.stdout?.toString().trim() ?? err.stderr?.toString().trim() ?? err.message,
      code: err.status ?? 1,
    };
  }
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

// ── Build Detection ────────────────────────────────────────────

interface BuildSystem {
  name: string;
  command: string;
  detected: boolean;
}

function detectBuildSystem(cwd: string): BuildSystem | null {
  const checks: BuildSystem[] = [
    // Node.js / Bun
    {
      name: "bun",
      command: (() => {
        const pkg = readJson(join(cwd, "package.json"));
        const buildScript = pkg?.scripts?.build;
        return buildScript ? `bun run build` : "";
      })(),
      detected: existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock")),
    },
    {
      name: "npm",
      command: "npm run build",
      detected: existsSync(join(cwd, "package-lock.json")),
    },
    {
      name: "yarn",
      command: "yarn build",
      detected: existsSync(join(cwd, "yarn.lock")),
    },
    {
      name: "pnpm",
      command: "pnpm build",
      detected: existsSync(join(cwd, "pnpm-lock.yaml")),
    },
    // Python
    {
      name: "pip",
      command: "pip install -e .",
      detected: existsSync(join(cwd, "setup.py")) || existsSync(join(cwd, "pyproject.toml")),
    },
    // Rust
    {
      name: "cargo",
      command: "cargo build",
      detected: existsSync(join(cwd, "Cargo.toml")),
    },
    // Go
    {
      name: "go",
      command: "go build ./...",
      detected: existsSync(join(cwd, "go.mod")),
    },
    // C/C++
    {
      name: "cmake",
      command: "mkdir -p build && cd build && cmake .. && make -j$(nproc)",
      detected: existsSync(join(cwd, "CMakeLists.txt")),
    },
    {
      name: "make",
      command: "make",
      detected: existsSync(join(cwd, "Makefile")),
    },
    // Java
    {
      name: "maven",
      command: "mvn package",
      detected: existsSync(join(cwd, "pom.xml")),
    },
    {
      name: "gradle",
      command: "./gradlew build",
      detected: existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts")),
    },
  ];

  return checks.find(c => c.detected && c.command) ?? null;
}

// ── Test Runner Detection ──────────────────────────────────────

function detectTestRunner(cwd: string): { name: string; command: string } | null {
  const pkg = readJson(join(cwd, "package.json"));

  // Bun test
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) {
    return { name: "bun test", command: "bun test" };
  }

  // Vitest
  if (pkg?.devDependencies?.vitest || pkg?.dependencies?.vitest) {
    return { name: "vitest", command: "npx vitest run" };
  }

  // Jest
  if (pkg?.devDependencies?.jest || pkg?.dependencies?.jest) {
    return { name: "jest", command: "npx jest" };
  }

  // Mocha
  if (pkg?.devDependencies?.mocha) {
    return { name: "mocha", command: "npx mocha" };
  }

  // Python pytest
  if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml"))) {
    return { name: "pytest", command: "python -m pytest" };
  }

  // Go
  if (existsSync(join(cwd, "go.mod"))) {
    return { name: "go test", command: "go test ./..." };
  }

  // Rust
  if (existsSync(join(cwd, "Cargo.toml"))) {
    return { name: "cargo test", command: "cargo test" };
  }

  // npm test fallback
  if (pkg?.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
    return { name: "npm test", command: "npm test" };
  }

  return null;
}

// ── Linter Detection ───────────────────────────────────────────

function detectLinter(cwd: string): { name: string; command: string } | null {
  const pkg = readJson(join(cwd, "package.json"));

  if (existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"))) {
    return { name: "biome", command: "npx biome check ." };
  }
  if (existsSync(join(cwd, ".eslintrc.js")) || existsSync(join(cwd, ".eslintrc.json")) || existsSync(join(cwd, "eslint.config.js"))) {
    return { name: "eslint", command: "npx eslint ." };
  }
  if (pkg?.devDependencies?.prettier || existsSync(join(cwd, ".prettierrc"))) {
    return { name: "prettier", command: "npx prettier --check ." };
  }
  if (existsSync(join(cwd, ".flake8")) || existsSync(join(cwd, "pyproject.toml"))) {
    return { name: "ruff/flake8", command: "ruff check . 2>/dev/null || python -m flake8 ." };
  }
  if (existsSync(join(cwd, "Cargo.toml"))) {
    return { name: "clippy", command: "cargo clippy" };
  }
  if (existsSync(join(cwd, "go.mod"))) {
    return { name: "go vet", command: "go vet ./..." };
  }

  return null;
}

// ── Commit Message Generator ───────────────────────────────────

function generateCommitMessage(cwd: string): { message: string; files: string } | null {
  const diff = run("git diff --cached --stat", cwd);
  if (!diff.output) {
    // Nothing staged, try staging all
    run("git add -A", cwd);
    const retry = run("git diff --cached --stat", cwd);
    if (!retry.output) return null;
  }

  const stat = run("git diff --cached --stat", cwd).output;
  const diffContent = run("git diff --cached --name-only", cwd).output;
  const files = diffContent.split("\n").filter(Boolean);

  // Detect type from files changed
  const hasTests = files.some(f => f.includes("test") || f.includes("spec"));
  const hasDocs = files.some(f => f.endsWith(".md") || f.includes("doc"));
  const hasFix = files.some(f => f.includes("fix") || f.includes("patch"));
  const hasConfig = files.some(f => f.includes("config") || f.includes(".json") || f.includes(".yml"));

  const type = hasTests ? "test" : hasDocs ? "docs" : hasFix ? "fix" : hasConfig ? "chore" : "feat";

  // Get the most changed file for scope
  const scope = files[0]?.split("/").slice(-1)[0]?.split(".")[0] ?? "";

  const message = `${type}${scope ? `(${scope})` : ""}: update ${files.length} file(s)\n\n${stat}`;

  return { message, files: stat };
}

// ── Public API ─────────────────────────────────────────────────

export interface Level1Result {
  handled: boolean;
  output: string;
}

/**
 * Try to handle a user message as a Level 1 (zero-LLM) command.
 * Returns { handled: true, output } if it was handled deterministically.
 * Returns { handled: false } if the LLM should handle it.
 */
export function tryLevel1(message: string, cwd: string): Level1Result {
  const lower = message.toLowerCase().trim();

  // ── Build ──
  if (/^(?:build|compile|make|construir|compilar)(?:\s+(?:the\s+)?(?:project|app|it))?[.!]?$/i.test(lower)) {
    const bs = detectBuildSystem(cwd);
    if (!bs) return { handled: true, output: "  No build system detected (no package.json, Makefile, Cargo.toml, etc.)" };

    const result = run(bs.command, cwd, 60_000);
    const icon = result.code === 0 ? "✅" : "❌";
    return {
      handled: true,
      output: `  ${icon} ${bs.name} build ${result.code === 0 ? "succeeded" : "failed"}\n  $ ${bs.command}\n\n${result.output.slice(-2000)}`,
    };
  }

  // ── Test ──
  if (/^(?:test|tests|run tests|pruebas|correr tests|ejecutar tests)(?:\s+(?:the\s+)?(?:project|app|it|all))?[.!]?$/i.test(lower)) {
    const tr = detectTestRunner(cwd);
    if (!tr) return { handled: true, output: "  No test runner detected." };

    const result = run(tr.command, cwd, 120_000);
    const icon = result.code === 0 ? "✅" : "❌";
    return {
      handled: true,
      output: `  ${icon} ${tr.name} ${result.code === 0 ? "passed" : "failed"}\n  $ ${tr.command}\n\n${result.output.slice(-2000)}`,
    };
  }

  // ── Lint ──
  if (/^(?:lint|format|check style|lintear|formatear)(?:\s+(?:the\s+)?(?:project|code|it|all))?[.!]?$/i.test(lower)) {
    const linter = detectLinter(cwd);
    if (!linter) return { handled: true, output: "  No linter detected." };

    const result = run(linter.command, cwd, 30_000);
    const icon = result.code === 0 ? "✅" : "⚠️";
    return {
      handled: true,
      output: `  ${icon} ${linter.name} ${result.code === 0 ? "clean" : "found issues"}\n  $ ${linter.command}\n\n${result.output.slice(-2000)}`,
    };
  }

  // ── Status ──
  if (/^(?:status|estado|git status)$/i.test(lower)) {
    const branch = run("git branch --show-current", cwd).output;
    const status = run("git status --short", cwd).output;
    const ahead = run("git rev-list --count @{u}..HEAD 2>/dev/null", cwd).output;
    const behind = run("git rev-list --count HEAD..@{u} 2>/dev/null", cwd).output;

    const lines = [`  Branch: ${branch}`];
    if (ahead && ahead !== "0") lines.push(`  Ahead: ${ahead} commits`);
    if (behind && behind !== "0") lines.push(`  Behind: ${behind} commits`);
    lines.push(status ? `\n${status}` : "  Clean working tree");
    return { handled: true, output: lines.join("\n") };
  }

  // ── Commit ──
  if (/^(?:commit|commitear|guardar cambios)(?:\s+(?:this|all|todo|everything))?$/i.test(lower)) {
    const result = generateCommitMessage(cwd);
    if (!result) return { handled: true, output: "  Nothing to commit." };

    const commitResult = run(`git commit -m "${result.message.replace(/"/g, '\\"')}"`, cwd);
    const icon = commitResult.code === 0 ? "✅" : "❌";
    return {
      handled: true,
      output: `  ${icon} Committed\n${result.files}\n\n  Message: ${result.message.split("\n")[0]}`,
    };
  }

  // ── Find / Search ──
  const findMatch = lower.match(/^(?:find|search|buscar?|donde|where)\s+(?:is\s+)?["']?(.+?)["']?\s*$/i);
  if (findMatch) {
    const query = findMatch[1]!.trim();
    const grepResult = run(
      `grep -rn "${query}" --include="*.ts" --include="*.js" --include="*.py" --include="*.go" --include="*.rs" --include="*.cpp" --include="*.c" --include="*.java" --include="*.rb" --include="*.swift" -l 2>/dev/null | head -20`,
      cwd,
    );
    const globResult = run(
      `find . -name "*${query}*" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -20`,
      cwd,
    );

    const files = grepResult.output ? grepResult.output.split("\n").filter(Boolean) : [];
    const namedFiles = globResult.output ? globResult.output.split("\n").filter(Boolean) : [];

    const lines = [`  Search: "${query}"\n`];
    if (namedFiles.length > 0) {
      lines.push(`  📁 Files matching name:`);
      for (const f of namedFiles.slice(0, 10)) lines.push(`    ${f}`);
    }
    if (files.length > 0) {
      lines.push(`\n  📄 Files containing "${query}":`);
      for (const f of files.slice(0, 10)) lines.push(`    ${f}`);
    }
    if (files.length === 0 && namedFiles.length === 0) {
      lines.push(`  No results found.`);
    }
    return { handled: true, output: lines.join("\n") };
  }

  // Not a Level 1 command
  return { handled: false, output: "" };
}
