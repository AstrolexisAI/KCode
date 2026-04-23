// KCode - Runtime Mode inference (Phase 12 of #100-#111 refactor)
//
// Disambiguates whether a project's entry file (index.ts, main.py,
// app.js, ...) launches a WEB service or a CLI/TUI/script. The
// filename allowlist in bash-spawn-verifier.ts ("index" / "app" /
// "server" / "main") over-matched in issue #111 v275 repro: the
// user's Bitcoin TUI was a blessed-contrib CLI with an `index.ts`
// entry point, and KCode's spawn preflight tried to reserve port
// 3000 for it, failed (port was occupied by an unrelated dev
// server), and reported "Spawning bun-direct would race and fail".
// The dashboard never ran; the verification failure was a runner
// mismatch, not an app failure.
//
// Two-step inference:
//   1. Package.json deps / requirements.txt names carry strong
//      signals — blessed, blessed-contrib, ink, commander, yargs,
//      inquirer, rich (CLI), curses → TUI/CLI. express, fastify,
//      hono, next, vite, koa, astro, nestjs, http.createServer,
//      flask, fastapi, uvicorn, gunicorn → web.
//   2. Entry file top-level imports: same keyword set, checked
//      against the first ~120 lines to avoid false positives from
//      comments or strings deeper in the file.
//
// When both signals agree, return that mode. When they disagree,
// prefer the file-level evidence (deps can be leftover from
// refactors). When no signal present → "unknown".

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type RuntimeMode = "web" | "cli" | "tui" | "unknown";

/** Names that, if imported/depended-on, indicate a TUI. */
const TUI_SIGNALS = [
  "blessed",
  "blessed-contrib",
  "ink",
  "@textual",
  "textual",
  "curses",
  "npyscreen",
  "urwid",
  "rich.live",
  "rich.layout",
  "rich.console",
  "terminal-kit",
];

/** CLI frameworks (command-parser shaped). */
const CLI_SIGNALS = [
  "commander",
  "yargs",
  "inquirer",
  "enquirer",
  "@oclif/core",
  "meow",
  "arg",
  "clipanion",
  "click",        // python
  "typer",        // python
  "argparse",     // python stdlib — weak signal but still CLI
];

/** Web frameworks / servers. */
const WEB_SIGNALS = [
  "express",
  "fastify",
  "hono",
  "koa",
  "hapi",
  "next",
  "nuxt",
  "astro",
  "vite",
  "@nestjs/core",
  "nestjs",
  "svelte/kit",
  "remix",
  "bun-serve",
  "Bun.serve",
  "http.createServer",
  "https.createServer",
  "net.createServer",
  "flask",
  "fastapi",
  "django",
  "uvicorn",
  "gunicorn",
  "starlette",
  "aiohttp",
  "sanic",
  "bottle",
];

/** Scan a blob of text for any exact match against a signal list. */
function matchesAny(text: string, signals: string[]): boolean {
  for (const s of signals) {
    // Escape regex specials in signal names
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    if (re.test(text)) return true;
  }
  return false;
}

/** Classify from a single blob of code. */
export function inferRuntimeModeFromText(text: string): RuntimeMode {
  if (!text) return "unknown";
  const hasTui = matchesAny(text, TUI_SIGNALS);
  const hasWeb = matchesAny(text, WEB_SIGNALS);
  const hasCli = matchesAny(text, CLI_SIGNALS);

  // TUI trumps CLI (a TUI is a specialized CLI).
  if (hasTui) return "tui";
  if (hasWeb) return "web";
  if (hasCli) return "cli";
  return "unknown";
}

/**
 * Read package.json + the project's canonical entry file from `cwd`
 * and return the inferred RuntimeMode. Silently returns "unknown"
 * for missing / unreadable files — this is a best-effort hint, not
 * a gate.
 */
export function inferRuntimeModeFromCwd(cwd: string): RuntimeMode {
  const snippets: string[] = [];

  // 1. package.json
  try {
    const pkg = readFileSync(join(cwd, "package.json"), "utf8");
    snippets.push(pkg);
  } catch {
    /* no package.json — not a JS project, or no cwd yet */
  }

  // 2. requirements.txt / pyproject.toml
  try {
    snippets.push(readFileSync(join(cwd, "requirements.txt"), "utf8"));
  } catch {
    /* noop */
  }
  try {
    snippets.push(readFileSync(join(cwd, "pyproject.toml"), "utf8"));
  } catch {
    /* noop */
  }

  // 3. Entry files — read up to ~6KB each so top imports are
  //    guaranteed in scope. Multiple candidates because projects
  //    vary; first readable wins.
  const ENTRY_CANDIDATES = [
    "index.ts",
    "index.js",
    "main.ts",
    "main.js",
    "app.ts",
    "app.js",
    "server.ts",
    "server.js",
    "src/index.ts",
    "src/main.ts",
    "main.py",
    "app.py",
    "__main__.py",
    "cli.py",
    "dashboard.py",
  ];
  for (const rel of ENTRY_CANDIDATES) {
    try {
      const body = readFileSync(join(cwd, rel), "utf8").slice(0, 6000);
      snippets.push(body);
    } catch {
      /* skip */
    }
  }

  const joined = snippets.join("\n");
  return inferRuntimeModeFromText(joined);
}

/**
 * Return true when the runtime mode is one that should NOT trigger
 * the bash-spawn-preflight port-collision check. CLI and TUI tools
 * don't bind to ports; flagging them as "bun-direct needing port
 * 3000" is a runner-mismatch, not a real failure. Issue #111 v275.
 */
export function skipsServerPreflight(mode: RuntimeMode): boolean {
  return mode === "cli" || mode === "tui";
}

/**
 * Extract the directory the command will ACTUALLY execute in. When
 * a command starts with `cd PATH && ...` or `cd PATH; ...`, the
 * effective cwd is PATH (resolved against the caller's cwd for
 * relative targets). When the command has no cd prefix, the
 * caller's cwd is the effective cwd.
 *
 * Issue #111 v276: the runtime-mode inference was called with the
 * session cwd (~/proyectos) while the user's actual command was
 * `cd ~/proyectos/bitcoin-tui-dashboard && bun run index.ts`. The
 * package.json with blessed lived in the subdirectory, not in the
 * session cwd, so mode resolved to "unknown" and the preflight
 * still ran.
 *
 * Handles:
 *   cd /abs/path && ...
 *   cd ./rel/path && ...
 *   cd rel/path && ...
 *   cd path ; ...          (semicolon separator)
 *
 * NOT handled: shell-expanded paths ($HOME, ~), subshells, pushd.
 * Those fall through to fallbackCwd — safe default.
 */
export function extractEffectiveCwd(command: string, fallbackCwd: string): string {
  // Match a leading `cd PATH` up to && or ;. Tolerate leading whitespace
  // and optional `sudo`/env-prefix — but only the first segment matters.
  const m = command.match(/^\s*cd\s+([^\s&;|]+)/);
  if (!m || !m[1]) return fallbackCwd;

  const target = m[1].replace(/^['"]|['"]$/g, "");
  if (target.startsWith("/")) return target;

  // Very limited ~ expansion using HOME env (common enough to matter).
  if (target.startsWith("~/") || target === "~") {
    const home = process.env.HOME ?? "";
    if (!home) return fallbackCwd;
    return target === "~" ? home : `${home}/${target.slice(2)}`;
  }

  // Relative path — resolve against fallbackCwd.
  const base = fallbackCwd.endsWith("/") ? fallbackCwd.slice(0, -1) : fallbackCwd;
  const rel = target.startsWith("./") ? target.slice(2) : target;
  return `${base}/${rel}`;
}
