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

  return null;
}

// ─── Port extraction ───────────────────────────────────────────────

/**
 * Extract the port the spawned server will actually bind to.
 * Checks (in order): `PORT=` env, `--port=N`, `--port N`, `-p N`,
 * `php -S host:N`, then falls back to the framework default.
 */
export function extractDeclaredPort(
  command: string,
  defaultPort?: number,
): number | null {
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
 * Verify that a background spawn is actually serving traffic. Performs
 * up to 3 retries with backoff (~1.5s total) so slow boots are tolerated.
 *
 * Inputs:
 *   - command:        the original Bash command (used for port extraction)
 *   - pid:            the spawned process PID (used for liveness checks)
 *   - capturedOutput: the bytes captured by the wrapper sleep — included
 *                     verbatim in failure reports for context
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

  const port = extractDeclaredPort(command, detection.defaultPort);
  if (!port) {
    log.debug("verifier", `${detection.framework}: no port resolved, skipping probe`);
    return null;
  }

  // Retry schedule: 0ms, 1500ms, 3500ms (cumulative). Caller already
  // slept ~3s in the wrapper, so by the time we get here the server
  // is usually up if it ever will be.
  const retryDelaysMs = [0, 1500, 2000];
  let last: ProbeResult | null = null;
  for (const delay of retryDelaysMs) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    last = await probeServer(port);
    if (last.ok) break;
    // If the process is already dead, no point retrying.
    if (pid !== null && !isPidAlive(pid)) break;
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
  lines.push(
    `  Do NOT retry the same command without diagnosing first. Likely causes:`,
  );
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
