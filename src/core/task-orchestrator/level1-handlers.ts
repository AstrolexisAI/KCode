// KCode - Level 1 Handlers: Zero-LLM execution
//
// These commands are 100% deterministic. The machine detects what to do
// and executes directly — no tokens spent, instant response.

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

export interface DevServer {
  name: string;
  command: string;
  port: number;
  installCmd?: string;
  needsInstall: boolean;
  /**
   * When the dev-server is a static-HTML server, this is the filename
   * that should be linked in the "open at" URL. Used so the auto-launch
   * hook can point the user at http://localhost:PORT/orbital.html
   * instead of the bare directory listing.
   */
  htmlFile?: string;
}

/**
 * Find the first free TCP port in [start, end]. Returns `start` if
 * the probe fails (so the spawn either succeeds or fails visibly
 * instead of silently hanging on an unknown collision).
 *
 * Runs `ss -tln` ONCE to get the full set of listening ports, then
 * iterates in memory. The previous implementation spawned `ss` on
 * every iteration, which could mean up to 1000 subprocess spawns
 * for the full 11000-11999 range.
 */
function findFreePort(start: number, end: number): number {
  // Snapshot listening ports once — O(subprocess) instead of O(subprocess × range).
  let takenPorts: Set<number>;
  try {
    const out = execSync(`ss -tln 2>/dev/null | awk '{print $4}'`, {
      encoding: "utf8",
      timeout: 2000,
    });
    takenPorts = new Set(
      out
        .split(/\n/)
        .map((line) => {
          const m = line.match(/:(\d+)$/);
          return m ? parseInt(m[1]!, 10) : -1;
        })
        .filter((p) => p > 0),
    );
  } catch {
    // ss failed — can't verify which ports are taken. Return start
    // and let the spawn complain if it collides.
    return start;
  }
  for (let port = start; port <= end; port++) {
    if (!takenPorts.has(port)) return port;
  }
  return start;
}

/**
 * KCode avoids well-known (< 1024) and user-reserved ports (< 11000
 * per project convention). Dev servers start at 11000 and scan up to
 * 11999 for the first free slot. This keeps kcode dev servers out of
 * the way of other tools (Docker, llama.cpp at 8090, Postgres at
 * 5432, etc.) and makes them predictable.
 */
const KCODE_PORT_FLOOR = 11000;
const KCODE_PORT_CEILING = 11999;

export function detectDevServer(cwd: string, requestedPort?: number): DevServer | null {
  // If the caller gave a specific port, honor it (even if below 11000 —
  // the user knows what they want). Otherwise find a free one in the
  // kcode dev-server port range.
  const port = requestedPort ?? findFreePort(KCODE_PORT_FLOOR, KCODE_PORT_CEILING);

  // Phase 22 Bug #6 fix: before running the subdirectory scan / early
  // return, check whether cwd already contains an HTML file at its
  // root. If it does, fall through to the static-HTML branch below so
  // `orbital.html` / `dashboard.html` / any single-file site without a
  // package.json gets picked up. Pre-fix: `!existsSync(".../index.html")`
  // caused us to enter the subdir scan, find nothing, and return null,
  // skipping the extended static-HTML detection entirely.
  let cwdHasRootHtml = false;
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    cwdHasRootHtml = entries.some(
      (e) => e.isFile() && e.name.toLowerCase().endsWith(".html"),
    );
  } catch {
    /* unreadable — treat as no html, fall through to subdir scan */
  }

  // If no project in cwd AND no root HTML file, check common project
  // subdirectory names.
  if (!existsSync(join(cwd, "package.json")) && !existsSync(join(cwd, "go.mod")) &&
      !existsSync(join(cwd, "Cargo.toml")) && !existsSync(join(cwd, "pyproject.toml")) &&
      !existsSync(join(cwd, "mix.exs")) && !existsSync(join(cwd, "docker-compose.yml")) &&
      !cwdHasRootHtml) {
    // Check well-known project directory names first (fast)
    const commonNames = ["my-site", "my-app", "app", "web", "frontend", "backend", "api", "server", "project", "site"];
    for (const name of commonNames) {
      const sub = join(cwd, name);
      if (existsSync(sub)) {
        const subResult = detectDevServer(sub, requestedPort);
        if (subResult) return subResult;
      }
    }
    // Then scan recent directories (max 20, skip hidden/node_modules)
    try {
      const entries = readdirSync(cwd, { withFileTypes: true });
      let checked = 0;
      for (const entry of entries) {
        if (checked >= 20) break;
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && !commonNames.includes(entry.name)) {
          const subResult = detectDevServer(join(cwd, entry.name), requestedPort);
          if (subResult) return subResult;
          checked++;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

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

  // Python (FastAPI, Flask, Django). Only return a runnable if a real
  // framework is detected — generic pyproject/requirements without a
  // known server shouldn't fall back to `python -m http.server` since
  // that just serves static files from the directory and is never what
  // a user wanted for a backend project.
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "requirements.txt"))) {
    const hasFastapi = existsSync(join(cwd, "pyproject.toml")) && readFileSync(join(cwd, "pyproject.toml"), "utf-8").includes("fastapi");
    const hasFlask = existsSync(join(cwd, "pyproject.toml")) && readFileSync(join(cwd, "pyproject.toml"), "utf-8").includes("flask");
    const hasDjango = existsSync(join(cwd, "manage.py"));

    if (hasDjango) return { name: "Django", command: `python manage.py runserver 0.0.0.0:${port}`, port, needsInstall: false };
    if (hasFastapi) return { name: "FastAPI", command: `uvicorn main:app --host 0.0.0.0 --port ${port} --reload`, port, needsInstall: false };
    if (hasFlask) return { name: "Flask", command: `flask run --host 0.0.0.0 --port ${port}`, port, needsInstall: false };
    // No known Python web framework — don't fall through to http.server.
    // Let the LLM figure out what to run instead.
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

  // Static HTML — serve single-file or multi-file HTML sites on the
  // kcode dev-server port range. This is the correct path for
  // tutorials, dashboards with Tailwind/Chart.js from CDN, and any
  // other project that is "just an index.html".
  //
  // Requirements (all must hold):
  //   - index.html exists at the root
  //   - NO project markers were found above (no package.json, go.mod,
  //     Cargo.toml, etc.) — those branches would have returned already
  //   - index.html is non-trivial (>500 bytes) — avoids matching a
  //     placeholder "Coming soon" page or a stale file left in a
  //     stripped-down test directory
  //
  // We use `bunx serve` instead of `python3 -m http.server` because
  // (a) CLAUDE.md says "Always use Bun" and (b) bunx serve starts
  // faster and supports live reload with --single. Falls back to
  // python3 only if bunx is not on PATH.
  if (!existsSync(join(cwd, "package.json"))) {
    // Prefer index.html if present, otherwise fall back to any single
    // .html file in the directory root. This handles the Orbital-style
    // case where the model creates orbital.html instead of index.html.
    let htmlFile: string | null = null;
    try {
      if (existsSync(join(cwd, "index.html"))) {
        htmlFile = "index.html";
      } else {
        const entries = readdirSync(cwd, { withFileTypes: true });
        const htmlFiles = entries
          .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".html"))
          .map((e) => e.name);
        // Only auto-serve when there's EXACTLY one HTML file — multiple
        // HTML files are ambiguous and would need a user hint.
        if (htmlFiles.length === 1) htmlFile = htmlFiles[0]!;
      }
      if (htmlFile) {
        const size = statSync(join(cwd, htmlFile)).size;
        if (size >= 500) {
          const hasBunx = tryWhich("bunx");
          const command = hasBunx
            ? `bunx serve -l ${port} .`
            : `python3 -m http.server ${port}`;
          return {
            name: "Static",
            command,
            port,
            needsInstall: false,
            htmlFile,
          };
        }
      }
    } catch {
      /* ignore stat/readdir errors */
    }
  }

  return null;
}

/** Check if a binary is on PATH via `command -v`. Synchronous. */
function tryWhich(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { timeout: 1000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function startDevServer(srv: DevServer, cwd: string): Level1Result {
  // Step 1: Install dependencies if needed
  if (srv.needsInstall && srv.installCmd) {
    const installResult = run(srv.installCmd, cwd, 120_000);
    if (installResult.code !== 0) {
      return { handled: true, output: `  ❌ Install failed\n  $ ${srv.installCmd}\n\n${installResult.output.slice(-1000)}` };
    }
  }

  // Step 2: Start the dev server in background
  try {
    const child = spawn("sh", ["-c", srv.command], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();

    // Wait a moment for the server to start. Use the top-level
    // execSync import — this file used to have three duplicated
    // require("child_process") calls for the same module, cleaned
    // up here alongside the L2 finding.
    try {
      execSync("sleep 2", { timeout: 5000 });
    } catch {
      /* timeout is fine — we just needed a delay */
    }

    // Update last-project so follow-up commands (re-run on a new port,
    // stop, etc.) target the same project without re-resolving the cwd.
    // This also fixes the bug where a stale last-project pointing to a
    // deleted directory would cause the next run to fall through to
    // `python -m http.server`.
    try {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      if (home) {
        const lastProjectFile = join(home, ".kcode", "last-project");
        writeFileSync(lastProjectFile, cwd);
      }
    } catch {
      // Non-fatal: the server is started; only last-project write failed.
    }

    const urlPath = srv.htmlFile && srv.htmlFile !== "index.html" ? `/${srv.htmlFile}` : "";
    const portInfo = srv.port > 0 ? `\n  🌐 http://localhost:${srv.port}${urlPath}` : "";
    // Show explicit shell commands so the user can copy them into
    // another terminal (or their notes) to manage the server manually.
    // The `kill` command uses the child PID directly — that's the
    // process group leader because we spawned with `detached: true`.
    const relCwd = cwd.replace(process.env.HOME ?? "", "~");
    const manualCommands = [
      "",
      "  ── How to manage this server manually ──",
      `  Start:  cd ${relCwd} && ${srv.command}`,
      `  Stop:   kill ${child.pid}   (or: pkill -f '${srv.command.split(" ")[0]}')`,
      `  In kcode: "para el server"  or  /stop`,
    ].join("\n");
    return {
      handled: true,
      output: `  ✅ ${srv.name} server started (PID: ${child.pid})\n  $ ${srv.command}${portInfo}${manualCommands}`,
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

  // Multi-line, very long, or multi-intent messages — let engine/LLM handle
  if (lower.includes("\n") || lower.split(/\s+/).length > 15) {
    return { handled: false, output: "" };
  }
  // If message has creation intent + run intent, skip Level 1 (engine handles both)
  if (/\b(?:create|build|make|crea|genera|scaffold)\b/i.test(lower) && /(?:levant|start|launch|arranca|ejecuta|run\s)/i.test(lower)) {
    return { handled: false, output: "" };
  }

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

  // ── Stop / Kill server (BEFORE run — "para el server" must not match "serve") ──
  if (/(?:^|\s)(?:stop|kill|para(?:r|\s+el)?|det[eé]n(?:lo)?|frena|baja|shutdown|apaga)(?:\s+(?:the\s+)?(?:server|app|it|lo|el\s+server|la\s+app))?[.!]?$/i.test(lower)) {
    run("pkill -f 'next dev|vite|tsx watch|uvicorn|flask run|cargo run|go run|mix phx|http.server' 2>/dev/null; true", cwd);
    return { handled: true, output: "  ✅ Server stopped." };
  }

  // ── Run / Serve / Start (dev server) ──
  //
  // Matches two shapes:
  //   1. Classic start command: "levantalo", "run it", "start", "inicialo en puerto 15965"
  //   2. Port override / re-launch: "usa el puerto 15965", "cambia al puerto 15965",
  //      "el servidor no levantó, usa el puerto 15965" — these are common when
  //      the first start attempt failed and the user wants to retry on a new port.
  //
  // Shape 1 is anchored to the start of the message to avoid matching
  // random occurrences of "start" in unrelated text. Shape 2 is
  // looser — it matches anywhere in the message but REQUIRES a port
  // number to be present, so we only trigger a re-launch when the
  // user is unambiguously asking for a specific port.
  // End-anchored: the verb (+ optional object + optional port clause) MUST
  // consume the entire input modulo trailing punctuation. Without the `$`
  // anchor, "run git status" / "start the build" / "launch the test runner"
  // matched on their first word and spawned a dev server — even though the
  // rest of the sentence was unrelated. See audit round 2026-04-13.
  const startVerbRex = /^(?:levant[ae](?:lo|la)?|run(?:\s+it)?|start|launch|arranca(?:lo)?|ejecuta(?:lo)?|inicia(?:lo)?|corr[ei](?:lo)?|lanza(?:lo)?|pon(?:lo)?|abre(?:lo)?)(?:\s+(?:the\s+)?(?:app|server|project|dev|it|lo|la\s+app|el\s+server|el\s+proyecto))?(?:\s+(?:en|on|in|at)\s+(?:(?:el\s+)?puerto|port)\s+(\d+))?[.!?]?$/i;
  const portOverrideRex = /\b(?:usa(?:lo|la)?|use|cambia(?:lo|la)?|switch|change|move|mu[eé]ve(?:lo|la)?|re?int[eé]ntalo|retry|retri[ée]ntalo|el\s+servidor\s+no\s+levant[oó])\b[^.!?]*?\b(?:(?:el\s+)?puerto|port)\s+(\d+)/i;

  const runMatch = lower.match(startVerbRex);
  const overrideMatch = !runMatch ? lower.match(portOverrideRex) : null;

  if (runMatch || overrideMatch) {
    const requestedPort = runMatch?.[1]
      ? parseInt(runMatch[1], 10)
      : overrideMatch?.[1]
        ? parseInt(overrideMatch[1], 10)
        : undefined;

    // Try cwd first, then last created project (saved to ~/.kcode/last-project)
    let srv = detectDevServer(cwd, requestedPort);
    let serveCwd = cwd;
    if (!srv) {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      const lastProjectFile = join(home, ".kcode", "last-project");
      if (existsSync(lastProjectFile)) {
        const lastProject = readFileSync(lastProjectFile, "utf-8").trim();
        // Require last-project to actually be a real dev project,
        // not a stale pointer to a deleted directory or a static
        // HTML scratch folder. detectDevServer now returns null for
        // directories without a real dev framework, so this is safe.
        if (lastProject && existsSync(lastProject)) {
          srv = detectDevServer(lastProject, requestedPort);
          if (srv) serveCwd = lastProject;
        }
      }
    }

    if (srv) {
      return startDevServer(srv, serveCwd);
    }
    return {
      handled: true,
      output:
        "  No dev server project detected in the current directory. " +
        "cd into the project directory and retry, or open the project " +
        "with `kcode /path/to/project`.",
    };
  }

  // Not a Level 1 command
  return { handled: false, output: "" };
}
