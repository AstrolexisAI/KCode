// KCode — Boot Banner
//
// One-time, pre-TUI banner. Communicates the things a careful operator
// or a security-conscious analyst would want to confirm at a glance:
// version, offline state, model + context budget, where to verify the
// binary's signature.
//
// Deliberate restraint:
//   - No emoji. Disciplined typography (uppercase labels, aligned
//     values, dim separators).
//   - One column of color (theme primary), one column of dim. Errors
//     break that to red, but in normal flow it stays calm.
//   - Suppressed by KCODE_NO_BANNER=1 or --no-banner.
//
// Output goes to stderr so that piping kcode's stdout into another
// program does not pollute the data stream.

import { execSync } from "node:child_process";

export interface BannerInputs {
  version: string;
  /** Defaults to NODE_ENV/KCODE_BUILD_HASH if available, otherwise short git rev. */
  buildHash?: string;
  /** Active model name (resolved). */
  model: string;
  /** Resolved context window size (tokens). */
  contextSize?: number;
  /** Whether KCODE_OFFLINE / settings.offline.enabled is forcing offline. */
  offlineForced: boolean;
  /** Whether offline was auto-detected (not forced). */
  offlineDetected: boolean;
  /** API base URL. Used to label provider as local vs cloud. */
  apiBase?: string;
  /** Working directory. */
  cwd?: string;
}

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function shortHash(): string {
  // Prefer explicit build hash injected by CI
  if (process.env.KCODE_BUILD_HASH) return process.env.KCODE_BUILD_HASH.slice(0, 7);
  // Fall back to git rev (only useful in dev / source checkouts)
  try {
    const out = execSync("git rev-parse --short=7 HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    });
    return out.toString().trim();
  } catch {
    return "unknown";
  }
}

function isLocalApiBase(apiBase?: string): boolean {
  if (!apiBase) return false;
  return /^(http:\/\/)?(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)(:\d+)?/i.test(apiBase);
}

function formatContext(n: number | undefined): string {
  if (!n || n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M tok`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k tok`;
  return `${n} tok`;
}

function shortCwd(cwd: string | undefined): string {
  if (!cwd) return "";
  const home = process.env.HOME ?? "";
  return home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}

/**
 * Render the banner string. Pure function — easy to test.
 * Caller decides where to write it (stderr in production, captured in tests).
 */
export function renderBanner(inputs: BannerInputs): string {
  const lines: string[] = [];
  const labelW = 11;
  const pad = (s: string) => s.padEnd(labelW);

  // Title line
  lines.push(`${BOLD}${CYAN}KCode${RESET} ${DIM}v${inputs.version} · ${shortHash()}${RESET}`);
  lines.push("");

  // Mode row
  let modeLabel: string;
  let modeColor: string;
  if (inputs.offlineForced) {
    modeLabel = "OFFLINE (forced)";
    modeColor = GREEN;
  } else if (inputs.offlineDetected) {
    modeLabel = "OFFLINE (auto-detected)";
    modeColor = YELLOW;
  } else {
    modeLabel = "ONLINE";
    modeColor = DIM;
  }
  lines.push(`  ${DIM}${pad("mode")}${RESET}${modeColor}${modeLabel}${RESET}`);

  // Model row
  const provider = isLocalApiBase(inputs.apiBase) ? "local" : "cloud";
  const providerColor = provider === "local" ? GREEN : YELLOW;
  lines.push(
    `  ${DIM}${pad("model")}${RESET}${inputs.model}  ${providerColor}${provider}${RESET}  ${DIM}${formatContext(inputs.contextSize)}${RESET}`,
  );

  // CWD row
  if (inputs.cwd) {
    lines.push(`  ${DIM}${pad("cwd")}${RESET}${shortCwd(inputs.cwd)}`);
  }

  // Verify hint — only meaningful for shipped binaries, but harmless
  // in dev (the cosign command will simply not find sigs locally).
  lines.push(
    `  ${DIM}${pad("verify")}cosign verify-blob ...  (docs/security/verify-binary.md)${RESET}`,
  );

  // Hint when in mismatched state — e.g. cloud model + offline mode
  if (inputs.offlineForced && provider === "cloud") {
    lines.push("");
    lines.push(
      `  ${RED}!${RESET} ${YELLOW}Cloud model selected with offline mode forced — first request will fail.${RESET}`,
    );
    lines.push(`    ${DIM}Switch to a local model or unset KCODE_OFFLINE.${RESET}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Print the banner to stderr, unless suppressed.
 * Suppressed by:
 *   - KCODE_NO_BANNER=1
 *   - --no-banner CLI flag (caller is responsible for setting this env)
 *   - non-TTY stderr (piped output) — keep the data clean
 */
export function printBanner(inputs: BannerInputs): void {
  if (process.env.KCODE_NO_BANNER === "1") return;
  if (!process.stderr.isTTY) return;
  process.stderr.write(renderBanner(inputs));
}
