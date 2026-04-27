// KCode - Bash Spawn Verifier
//
// Operator-mind primitive: when a Bash background spawn matches a known
// "starts a long-running server" pattern, do not trust the bare "✓ PID X"
// signal. Probe the server over HTTP after a short delay and either
// confirm it is actually live or report a real failure with diagnostics.
//
// This exists because KCode's bash background path used to report
// `✓ PID 1642328 (3.0s)` even when the spawned server immediately
// crashed on EMFILE / EADDRINUSE / missing dependency. Subsequent turns
// would re-spawn the same broken command, accumulating dozens of
// orphaned processes. With this verifier, the model receives the real
// failure and is forced to reconsider instead of looping.

import { log } from "./logger.js";

// ─── Framework detection ───────────────────────────────────────────

export interface SpawnDetection {
  /** Short label for the framework (next, vite, flask, ...). */
  framework: string;
  /** Default port for the framework if not explicitly set. */
  defaultPort?: number;
  /** Path or query to probe (defaults to "/"). */
  probePath?: string;
}

/**
 * Inspect a Bash command and decide whether it is a long-running
 * server spawn that we should HTTP-verify after launch. Returns null
 * for one-shot commands, file ops, builds, etc.
 *
 * Patterns are deliberately conservative — false positives would slow
 * down every Bash call, false negatives just mean we do nothing extra.
 */
export function detectServerSpawn(command: string): SpawnDetection | null {
  const c = command.toLowerCase();

  // Inspection / cleanup tools — these accept server-spawn strings as
  // ARGUMENTS but never actually run a server. Without this guard the
  // `next dev` / `nodemon` / etc. tokens inside e.g.
  //   pkill -f 'next-server|vite|bun --watch|nodemon|next dev'
  // get matched by the regexes below and the preflight refuses the
  // very pkill that would have unblocked the situation. This was the
  // exact failure that defeated phase 6 in real sessions: the model
  // tried the AUTHORIZED RECOVERY pkill and was told the system
  // was saturated. Phase 7 fix: command introspection / process
  // management commands are never server spawns.
  if (looksLikeProcessIntrospection(c)) return null;

  // Next.js: `next dev`, `npm/bun/pnpm/yarn run dev` (most package.json scripts)
  if (/\bnext\s+dev\b/.test(c)) return { framework: "next", defaultPort: 3000 };
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev\b/.test(c))
    return { framework: "node-dev", defaultPort: 3000 };

  // Vite
  if (/\bvite(?:\s|$)/.test(c)) return { framework: "vite", defaultPort: 5173 };

  // Astro
  if (/\bastro\s+dev\b/.test(c)) return { framework: "astro", defaultPort: 4321 };

  // Generic node start scripts
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?start\b/.test(c))
    return { framework: "node-start", defaultPort: 3000 };

  // Python
  if (/\bpython3?\s+-m\s+http\.server\b/.test(c))
    return { framework: "python-http", defaultPort: 8000 };
  if (/\bflask\s+run\b/.test(c)) return { framework: "flask", defaultPort: 5000 };
  if (/\buvicorn\b/.test(c)) return { framework: "uvicorn", defaultPort: 8000 };
  if (/\bgunicorn\b/.test(c)) return { framework: "gunicorn", defaultPort: 8000 };

  // PHP
  if (/\bphp\s+-s\b/.test(c)) return { framework: "php-builtin" };

  // Ruby
  if (/\brails\s+s(?:erver)?\b/.test(c)) return { framework: "rails", defaultPort: 3000 };
  if (/\bruby\s+-run\b/.test(c)) return { framework: "ruby-webrick", defaultPort: 8080 };

  // Caddy / live-server / nodemon
  if (/\bcaddy\s+run\b/.test(c)) return { framework: "caddy", defaultPort: 2015 };
  if (/\blive-server\b/.test(c)) return { framework: "live-server", defaultPort: 8080 };
  if (/\bnodemon\b/.test(c)) return { framework: "nodemon", defaultPort: 3000 };

  // Static servers
  if (/\bserve\s/.test(c) || /\bhttp-server\b/.test(c))
    return { framework: "static-serve", defaultPort: 3000 };

  // Bare `node <file>.js` invocations where the filename hints at a
  // server. `node server.js`, `node app.js`, `node index.js`, and
  // `node main.js` are the canonical "run the server directly" shapes
  // used when the user bypasses `npm run dev`. Only trigger on the
  // filename allowlist to avoid hijacking one-shot scripts like
  // `node scripts/migrate.js` or `node benchmarks/bench.js`.
  if (/\bnode\s+(?:[\w\-/.]+\/)?(?:server|app|index|main)\.(?:js|mjs|cjs)\b/.test(c)) {
    return { framework: "node-direct", defaultPort: 3000 };
  }
  // Bun equivalent
  if (/\bbun\s+(?:run\s+)?(?:[\w\-/.]+\/)?(?:server|app|index|main)\.(?:ts|js|mjs|cjs)\b/.test(c)) {
    return { framework: "bun-direct", defaultPort: 3000 };
  }

  return null;
}

// ─── Phase 7: process-introspection guard ─────────────────────────

/**
 * Process-management / inspection / search tools that accept arbitrary
 * strings as arguments. These commands are NEVER server spawns even
 * when their arguments contain server-spawn vocabulary.
 *
 * The check is lexical and conservative: we look for one of these
 * verbs in the FIRST executable position of the command (ignoring
 * leading `cd && ...`, env-var prefixes like `PORT=N`, and `sudo`).
 */
const INTROSPECTION_VERBS = new Set([
  "pkill",
  "kill",
  "killall",
  "pgrep",
  "ps",
  "fuser",
  "lsof",
  "strace",
  "ltrace",
  "ss",
  "netstat",
  "grep",
  "rg",
  "ack",
  "ag",
  "find",
  "fd",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "tee",
  "echo",
  "printf",
  "wc",
  "awk",
  "sed",
  "cut",
  "sort",
  "uniq",
  "tr",
]);

function looksLikeProcessIntrospection(command: string): boolean {
  // Walk the segments separated by `&&`, `||`, `;`, or `|` and look
  // at the first executable token in each. If ANY segment runs an
  // introspection verb whose argument list mentions server tokens,
  // treat the whole command as introspection (not a spawn).
  const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/);
  for (const seg of segments) {
    const verb = firstExecutable(seg);
    if (verb && INTROSPECTION_VERBS.has(verb)) return true;
  }
  return false;
}

/**
 * Return the first executable token in a single command segment,
 * skipping leading env-var assignments, `sudo`, and `nohup`.
 */
function firstExecutable(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/);
  for (const tok of tokens) {
    if (!tok) continue;
    // env var assignment like PORT=N
    if (/^[A-Z_][A-Z0-9_]*=/i.test(tok)) continue;
    // privilege wrappers
    if (tok === "sudo" || tok === "nohup" || tok === "exec" || tok === "time") continue;
    // bare paths to interpreters / scripts — return basename
    return tok.split("/").pop() ?? tok;
  }
  return null;
}

// ─── Port extraction ───────────────────────────────────────────────

/**
 * Extract the port the spawned server will actually bind to.
 * Checks (in order): `PORT=` env, `--port=N`, `--port N`, `-p N`,
 * `php -S host:N`, then falls back to the framework default.
 */
export function extractDeclaredPort(command: string, defaultPort?: number): number | null {
  // PORT=N env prefix (most reliable)
  const envMatch = command.match(/\bPORT=(\d+)/);
  if (envMatch) return parseInt(envMatch[1]!, 10);

  // --port=N or --port N
  const longFlag = command.match(/--port[=\s]+(\d+)/);
  if (longFlag) return parseInt(longFlag[1]!, 10);

  // -p N (only if the command looks like a node/python server — avoid matching
  // unrelated tools that use -p for "preserve" or "parents")
  if (/\b(?:next|vite|astro|nodemon|live-server|http-server|serve)\b/i.test(command)) {
    const shortFlag = command.match(/-p\s+(\d+)/);
    if (shortFlag) return parseInt(shortFlag[1]!, 10);
  }

  // php -S host:N
  const phpMatch = command.match(/php\s+-S\s+\S*:(\d+)/i);
  if (phpMatch) return parseInt(phpMatch[1]!, 10);

  // python -m http.server [PORT]
  const pyMatch = command.match(/python3?\s+-m\s+http\.server\s+(\d+)/i);
  if (pyMatch) return parseInt(pyMatch[1]!, 10);

  return defaultPort ?? null;
}

// ─── Probe ─────────────────────────────────────────────────────────

export interface ProbeResult {
  ok: boolean;
  /** HTTP status code if the request completed, "000" if connection failed. */
  rawStatusCode: string;
  /** Total request time in ms (capped by timeoutMs). */
  durationMs: number;
  /** Error string if the connection itself failed. */
  error?: string;
}

/**
 * Single HTTP probe against http://127.0.0.1:PORT/PATH.
 * Treats any 2xx/3xx/4xx as "the server is responding" — even 404 is
 * a positive signal because it means TCP+HTTP are working. Only 5xx
 * and connection failures are treated as failure.
 */
export async function probeServer(
  port: number,
  opts: { path?: string; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const path = opts.path ?? "/";
  const timeoutMs = opts.timeoutMs ?? 2000;
  const url = `http://127.0.0.1:${port}${path}`;
  const start = Date.now();

  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const durationMs = Date.now() - start;
    return {
      ok: resp.status < 500,
      rawStatusCode: String(resp.status),
      durationMs,
    };
  } catch (err) {
    return {
      ok: false,
      rawStatusCode: "000",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Liveness ──────────────────────────────────────────────────────

/** Returns true if the OS reports the PID is still alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── High-level verification ───────────────────────────────────────

export interface VerificationOutcome {
  ok: boolean;
  /** Multi-line human-readable report safe to inline into a tool result. */
  report: string;
}

/**
 * Patterns that indicate the spawned framework is in the middle of
 * booting and just needs more time. When the captured output already
 * contains one of these, the verifier extends its probe budget to
 * ~15s so dev servers like Next.js (which can take 8-12s for first
 * compile) don't get false-negative'd. Phase 9 fix: previous 3.5s
 * budget caused KCode to declare a successful Next.js spawn failed
 * because the HTTP probe ran before the dev server finished
 * compiling TypeScript.
 */
const BOOT_IN_PROGRESS_SIGNALS = [
  /\bNext\.js\b/i,
  /\bvite\b.*\bv\d/i,
  /Local:\s+http:\/\//i,
  /Network:\s+http:\/\//i,
  /Starting\.\.\./i,
  /We detected/i, // Next.js TypeScript detection step
  /Compiled successfully/i,
  /Compiling/i,
  /Ready in /i,
  /Server started/i,
  /Serving HTTP on/i,
  /Running on http/i,
  /Application startup complete/i,
  /listening on/i,
  /Server is running at/i,
];

function looksLikeBootInProgress(output: string): boolean {
  if (!output) return false;
  return BOOT_IN_PROGRESS_SIGNALS.some((re) => re.test(output));
}

/**
 * Verify that a background spawn is actually serving traffic.
 *
 * Two probe budgets:
 *   - **Quick mode** (~3.5s): used when the captured wrapper output is
 *     empty or shows no boot-in-progress signals. Fast-fails on
 *     missing-dep / port-collision / immediate-crash cases.
 *   - **Patient mode** (~15s): used when the wrapper output already
 *     contains one of BOOT_IN_PROGRESS_SIGNALS, meaning the framework
 *     is mid-compile. Lets Next.js / Vite / etc. finish booting.
 *
 * Either mode short-circuits as soon as the PID dies, so a process
 * that crashes during boot is detected within one probe interval.
 *
 * Inputs:
 *   - command:        the original Bash command (used for port extraction)
 *   - pid:            the spawned process PID (used for liveness checks)
 *   - capturedOutput: the bytes captured by the wrapper sleep — also
 *                     scanned for boot-in-progress signals
 *   - cwd:            optional, included in the failure report
 */
export async function verifyBackgroundSpawn(
  command: string,
  pid: number | null,
  capturedOutput: string,
  cwd?: string,
): Promise<VerificationOutcome | null> {
  const detection = detectServerSpawn(command);
  if (!detection) return null;

  // Phase 13 (#111 v279 follow-up): skip the HTTP probe for TUI/CLI
  // projects. detectServerSpawn over-matches on the bun-direct /
  // node-direct filename patterns (index.ts / app.ts / main.ts)
  // when the file is actually a blessed TUI entry point. Probing
  // port 3000 then hits whatever unrelated process happens to be
  // listening there and returns a false-positive HTTP 200, which
  // the model reads as "the app works." Issue #111 v279 repro:
  // Bitcoin TUI scaffold was "verified" against a foreign node
  // on port 3000.
  if (detection.framework === "bun-direct" || detection.framework === "node-direct") {
    try {
      const { inferRuntimeModeFromCwd, extractEffectiveCwd, skipsServerPreflight } =
        require("./runtime-mode") as typeof import("./runtime-mode");
      // Effective cwd: honor `cd SUBDIR && ...` in the command so the
      // package.json / entry file we scan belongs to the project
      // actually being spawned, not the session cwd.
      const effective = cwd ? extractEffectiveCwd(command, cwd) : (cwd ?? "");
      const mode = effective ? inferRuntimeModeFromCwd(effective) : "unknown";
      if (skipsServerPreflight(mode)) {
        log.debug(
          "verifier",
          `skip ${detection.framework} probe: effective cwd ${effective}, mode=${mode} (non-web)`,
        );
        return null;
      }
    } catch (err) {
      log.debug(
        "verifier",
        `runtime-mode inference failed, falling through: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const port = extractDeclaredPort(command, detection.defaultPort);
  if (!port) {
    log.debug("verifier", `${detection.framework}: no port resolved, skipping probe`);
    return null;
  }

  // Phase 9: pick the probe budget based on whether the wrapper
  // already saw boot signals. Patient mode gives slow frameworks
  // enough time to finish compiling.
  const patientMode = looksLikeBootInProgress(capturedOutput);
  const probeIntervalMs = 1500;
  const totalBudgetMs = patientMode ? 15_000 : 3_500;
  const probeTimeoutMs = 2_000;

  log.debug(
    "verifier",
    `${detection.framework} probe budget=${totalBudgetMs}ms (patient=${patientMode}) port=${port}`,
  );

  let last: ProbeResult | null = null;
  let elapsed = 0;
  while (elapsed < totalBudgetMs) {
    last = await probeServer(port, { timeoutMs: probeTimeoutMs });
    if (last.ok) break;
    // Process died — no point waiting any longer.
    if (pid !== null && !isPidAlive(pid)) break;
    if (elapsed + probeIntervalMs >= totalBudgetMs) break;
    await new Promise((r) => setTimeout(r, probeIntervalMs));
    elapsed += probeIntervalMs + last.durationMs;
  }

  if (!last) return null;

  const url = `http://localhost:${port}/`;
  if (last.ok) {
    return {
      ok: true,
      report: `${detection.framework} live at ${url} (HTTP ${last.rawStatusCode}, ${last.durationMs}ms)`,
    };
  }

  // Failure path: build a useful diagnostic
  const alive = pid !== null ? isPidAlive(pid) : "unknown";
  const lines: string[] = [];
  lines.push(`✗ ${detection.framework} health check FAILED on ${url}`);
  lines.push(
    `  probe: HTTP ${last.rawStatusCode}${last.error ? ` (${last.error})` : ""} after ${last.durationMs}ms`,
  );
  lines.push(`  pid: ${pid ?? "unknown"}${pid !== null ? ` (alive=${alive})` : ""}`);
  if (cwd) lines.push(`  cwd: ${cwd}`);
  if (capturedOutput.trim()) {
    const tail = capturedOutput.trim().split("\n").slice(-15).join("\n");
    lines.push(`  output (last 15 lines):`);
    for (const ln of tail.split("\n")) lines.push(`    ${ln}`);
  }
  lines.push(`  Do NOT retry the same command without diagnosing first. Likely causes:`);
  lines.push(`    - port ${port} already in use (check 'ss -tlnp | grep ${port}')`);
  lines.push(`    - dependencies missing (check the output above for ENOENT/EMFILE)`);
  lines.push(`    - server crashed during boot (check the output above for stack traces)`);

  return { ok: false, report: lines.join("\n") };
}

// ─── PID extraction from wrapper output ────────────────────────────

/**
 * The bash background wrapper prints `PID: <n>` as its first line.
 * Extract that PID for liveness tracking.
 */
export function extractPidFromWrapperOutput(output: string): number | null {
  const m = output.match(/^PID:\s*(\d+)/m);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
