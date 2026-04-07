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

// ── Dev Server Detection ──────────────────────────────────────

interface DevServer {
  name: string;
  command: string;
  port: number;
  installCmd?: string;
  needsInstall: boolean;
}

function detectDevServer(cwd: string, requestedPort?: number): DevServer | null {
  const port = requestedPort ?? 10080;

  // Node.js (Next.js, Vite, Express, etc.)
  const pkg = readJson(join(cwd, "package.json"));
  if (pkg) {
    const hasNodeModules = existsSync(join(cwd, "node_modules"));
    const scripts = pkg.scripts ?? {};
    const pm = existsSync(join(cwd, "bun.lockb")) ? "bun" : existsSync(join(cwd, "pnpm-lock.yaml")) ? "pnpm" : "npm";

    if (scripts.dev) {
      // Next.js uses --port, Vite uses --port, generic uses PORT env
      const isNext = existsSync(join(cwd, "next.config.ts")) || existsSync(join(cwd, "next.config.js")) || existsSync(join(cwd, "next.config.mjs"));
      const isVite = existsSync(join(cwd, "vite.config.ts")) || existsSync(join(cwd, "vite.config.js"));

      let devCmd: string;
      if (isNext) devCmd = `${pm} run dev -- --port ${port}`;
      else if (isVite) devCmd = `${pm} run dev -- --port ${port}`;
      else devCmd = `PORT=${port} ${pm} run dev`;

      // Check if any dependency is missing from node_modules
      const depsOk = hasNodeModules && Object.keys(pkg.dependencies ?? {}).every(
        (dep: string) => existsSync(join(cwd, "node_modules", dep))
      );
      return { name: isNext ? "Next.js" : isVite ? "Vite" : pkg.name ?? "Node.js", command: devCmd, port, installCmd: `${pm} install`, needsInstall: !depsOk };
    }
    if (scripts.start) {
      return { name: pkg.name ?? "Node.js", command: `PORT=${port} ${pm} run start`, port, installCmd: `${pm} install`, needsInstall: !hasNodeModules };
    }
  }

  // Python (FastAPI, Flask, Django)
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "requirements.txt"))) {
    const hasFastapi = existsSync(join(cwd, "pyproject.toml")) && readFileSync(join(cwd, "pyproject.toml"), "utf-8").includes("fastapi");
    const hasFlask = existsSync(join(cwd, "pyproject.toml")) && readFileSync(join(cwd, "pyproject.toml"), "utf-8").includes("flask");
    const hasDjango = existsSync(join(cwd, "manage.py"));

    if (hasDjango) return { name: "Django", command: `python manage.py runserver 0.0.0.0:${port}`, port, needsInstall: false };
    if (hasFastapi) return { name: "FastAPI", command: `uvicorn main:app --host 0.0.0.0 --port ${port} --reload`, port, needsInstall: false };
    if (hasFlask) return { name: "Flask", command: `flask run --host 0.0.0.0 --port ${port}`, port, needsInstall: false };
    return { name: "Python", command: `python -m http.server ${port}`, port, needsInstall: false };
  }

  // Go
  if (existsSync(join(cwd, "go.mod"))) {
    return { name: "Go", command: `PORT=${port} go run .`, port, needsInstall: false };
  }

  // Rust
  if (existsSync(join(cwd, "Cargo.toml"))) {
    return { name: "Rust", command: `PORT=${port} cargo run`, port, needsInstall: false };
  }

  // Elixir
  if (existsSync(join(cwd, "mix.exs"))) {
    return { name: "Elixir", command: `PORT=${port} mix run --no-halt`, port, needsInstall: false };
  }

  // Docker Compose
  if (existsSync(join(cwd, "docker-compose.yml")) || existsSync(join(cwd, "compose.yml"))) {
    return { name: "Docker Compose", command: "docker compose up", port: 0, needsInstall: false };
  }

  // Static HTML
  if (existsSync(join(cwd, "index.html"))) {
    return { name: "Static", command: `python3 -m http.server ${port}`, port, needsInstall: false };
  }

  return null;
}

function startDevServer(srv: DevServer, cwd: string): Level1Result {
  // Step 1: Install dependencies if needed
  if (srv.needsInstall && srv.installCmd) {
    const installResult = run(srv.installCmd, cwd, 120_000);
    if (installResult.code !== 0) {
      return { handled: true, output: `  ❌ Install failed\n  $ ${srv.installCmd}\n\n${installResult.output.slice(-1000)}` };
    }
  }

  // Step 2: Start the dev server in background
  try {
    const { spawn } = require("child_process");
    const child = spawn("sh", ["-c", srv.command], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();

    // Wait a moment for the server to start
    const { execSync: es } = require("child_process");
    try { es("sleep 2", { timeout: 5000 }); } catch {}

    const portInfo = srv.port > 0 ? `\n  🌐 http://localhost:${srv.port}` : "";
    return {
      handled: true,
      output: `  ✅ ${srv.name} server started (PID: ${child.pid})\n  $ ${srv.command}${portInfo}\n\n  Stop with: /stop or "para el server"`,
    };
  } catch (err: any) {
    return { handled: true, output: `  ❌ Failed to start: ${err.message}` };
  }
}

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

  // ── Run / Serve / Start (dev server) ──
  const runMatch = lower.match(/(?:levant[ae](?:lo|la)?|run(?:\s+it)?|start|serve|launch|arranca(?:lo)?|ejecuta(?:lo)?|inicia(?:lo)?|corr[ei](?:lo)?|lanza(?:lo)?|pon(?:lo)?|abre(?:lo)?)(?:\s+(?:the\s+)?(?:app|server|project|dev|it|lo|la\s+app|el\s+server|el\s+proyecto))?(?:\s+(?:en|on|in|at)\s+(?:(?:el\s+)?puerto|port)\s+(\d+))?/i);
  if (runMatch) {
    const requestedPort = runMatch[1] ? parseInt(runMatch[1], 10) : undefined;
    const srv = detectDevServer(cwd, requestedPort);
    if (srv) {
      return startDevServer(srv, cwd);
    }
    return { handled: true, output: "  No project detected. Need package.json, Cargo.toml, go.mod, or similar." };
  }

  // ── Stop / Kill server ──
  if (/^(?:stop|kill|para|detén|detenlo|frena|baja)(?:\s+(?:the\s+)?(?:server|app|it|lo))?[.!]?$/i.test(lower)) {
    const result = run("pkill -f 'next dev|vite|tsx watch|uvicorn|flask run|cargo run|go run|mix phx' 2>/dev/null; echo 'stopped'", cwd);
    return { handled: true, output: "  ✅ Server stopped." };
  }

  // Not a Level 1 command
  return { handled: false, output: "" };
}
