// KCode - Bash Platform Translation (phase 14)
//
// Transparently rewrites platform-specific commands that the model
// chose for the wrong OS. Catches the pattern observed in a real
// session where grok-4.20 tried `open file.html` on Linux, got
// "bash: open: orden no encontrada", then burned a turn telling
// the user to run `xdg-open` instead.
//
// Design constraints:
//   - Only rewrite the FIRST executable token (leave arguments alone).
//   - Only rewrite when (a) the original executable does NOT exist
//     in PATH on the current host, AND (b) the translated
//     equivalent DOES exist. This prevents surprising the user when
//     both are available.
//   - Preserve quoting and env-var prefixes exactly.
//   - Emit a short, concrete note in the tool result so the model
//     sees what was done and can learn for later calls in the same
//     session.
//   - Narrow scope: macOS ↔ Linux only, and only for commands where
//     the behavior is exact or near-exact (open/xdg-open, pbcopy/
//     xsel --clipboard --input, etc.). Do NOT touch commands like
//     `sed`, `find`, `date`, `readlink`, `stat` where BSD and GNU
//     flags differ — those translations would change semantics.

import { spawnSync } from "node:child_process";
import { log } from "./logger.js";

// ─── Translation table ────────────────────────────────────────────

export interface Translation {
  /** The executable the model wrote. */
  from: string;
  /** Replacement invocation that keeps the rest of the arg list working. */
  to: string;
  /** Short human-readable reason for the translation report. */
  reason: string;
  /** Platforms on which the "from" command does NOT exist natively. */
  missingOn: ("linux" | "darwin")[];
}

/**
 * Narrow mapping of commands that are safe to auto-translate across
 * macOS and Linux. Each entry has to pass two gates at runtime:
 *   1. The `from` command must NOT be available on the host.
 *   2. The `to` command (first token) must BE available on the host.
 * Gate 1 prevents us from surprising a user who has installed e.g.
 * `xdg-utils` on macOS via homebrew. Gate 2 prevents us from
 * replacing with something that also doesn't work.
 */
export const TRANSLATIONS: readonly Translation[] = [
  {
    from: "open",
    to: "xdg-open",
    reason: "`open` is macOS-only — Linux uses `xdg-open` to launch the default app",
    missingOn: ["linux"],
  },
  {
    from: "pbcopy",
    to: "xsel --clipboard --input",
    reason: "`pbcopy` is macOS-only — Linux with xsel uses `xsel --clipboard --input`",
    missingOn: ["linux"],
  },
  {
    from: "pbpaste",
    to: "xsel --clipboard --output",
    reason: "`pbpaste` is macOS-only — Linux with xsel uses `xsel --clipboard --output`",
    missingOn: ["linux"],
  },
  {
    from: "xdg-open",
    to: "open",
    reason: "`xdg-open` is Linux-only — macOS uses `open` to launch the default app",
    missingOn: ["darwin"],
  },
];

// ─── Command-existence cache ──────────────────────────────────────
//
// Running `command -v X` once per translation per Bash call would
// add ~10-30ms of overhead. We cache the result per-session since
// PATH typically doesn't change mid-session.

const _existsCache = new Map<string, boolean>();

function commandExists(cmd: string): boolean {
  if (_existsCache.has(cmd)) return _existsCache.get(cmd)!;
  try {
    // Use Bun's native spawnSync via node:child_process for consistency.
    const result = spawnSync("sh", ["-c", `command -v ${shellEscapeArg(cmd)} >/dev/null 2>&1`], {
      timeout: 500,
    });
    const exists = result.status === 0;
    _existsCache.set(cmd, exists);
    return exists;
  } catch {
    _existsCache.set(cmd, false);
    return false;
  }
}

/** Test helper: wipe the exists cache so individual tests stay deterministic. */
export function clearCommandExistsCache(): void {
  _existsCache.clear();
}

// Minimal shell-escape for a single argument (used only for the
// sub-shell `command -v` check — not for the actual user command).
function shellEscapeArg(arg: string): string {
  if (/^[A-Za-z0-9_./+@=:,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// ─── First-executable extraction ──────────────────────────────────

/**
 * Extract the first executable token from a command string. Handles:
 *   - Leading env-var assignments:  `PORT=3000 npm run dev` → `npm`
 *   - `sudo`, `nohup`, `exec`, `time` prefixes → first non-prefix word
 *   - `cd /x && <cmd>` → the command after `&&`
 *   - Absolute paths: `/usr/bin/open x` → basename `open`
 * Returns null when no executable can be identified.
 */
export function extractFirstExecutable(command: string): {
  executable: string | null;
  /** Byte index in the original command where the executable token starts. */
  start: number;
  /** Byte length of the token as it appears in the original command. */
  length: number;
} {
  if (!command) return { executable: null, start: 0, length: 0 };

  // If the command is a chain (cd X && Y ; Z | W), focus on the LAST
  // meaningful segment — that's what the model actually wants to run.
  const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/);
  const lastSegment = segments[segments.length - 1] ?? command;
  const segmentStart = command.lastIndexOf(lastSegment);

  const trimmed = lastSegment.trimStart();
  const leadSpaces = lastSegment.length - trimmed.length;
  let cursor = 0;
  // Skip env-var assignments and privilege wrappers
  while (true) {
    const match = trimmed
      .slice(cursor)
      .match(/^([A-Z_][A-Z0-9_]*=[^\s]*|sudo|nohup|exec|time|\s+)\s*/);
    if (!match) break;
    cursor += match[0].length;
  }
  // Now the next token is the executable
  const execMatch = trimmed.slice(cursor).match(/^(\S+)/);
  if (!execMatch) return { executable: null, start: 0, length: 0 };
  const raw = execMatch[1]!;
  const executable = raw.split("/").pop() ?? raw;
  // Compute the absolute position of `raw` in the original command
  const start = segmentStart + leadSpaces + cursor;
  return { executable, start, length: raw.length };
}

// ─── Public API ───────────────────────────────────────────────────

export interface TranslationResult {
  /** True if the command was rewritten. */
  translated: boolean;
  /** The command that should actually run (translated or original). */
  command: string;
  /** The original command, unchanged. */
  original: string;
  /** Human-readable explanation of the translation, for logging. */
  note?: string;
}

/**
 * Apply platform translation to a Bash command. Returns the
 * translated command + a note, or the original unchanged if no
 * translation applies. Never throws; any failure degrades to
 * returning the original command.
 */
export function translateBashCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): TranslationResult {
  const original = command;
  if (!command || !command.trim()) {
    return { translated: false, command, original };
  }
  if (platform !== "linux" && platform !== "darwin") {
    return { translated: false, command, original };
  }
  const { executable, start, length } = extractFirstExecutable(command);
  if (!executable) return { translated: false, command, original };

  for (const t of TRANSLATIONS) {
    if (t.from !== executable) continue;
    if (!t.missingOn.includes(platform)) continue;
    // Gate 1: the `from` command must NOT exist on this host.
    // If the user has installed xdg-utils on macOS, leave `open`
    // alone so the user's explicit invocation wins.
    if (commandExists(t.from)) continue;
    // Gate 2: the `to` command must exist on this host.
    const toFirstToken = t.to.split(/\s+/)[0]!;
    if (!commandExists(toFirstToken)) continue;

    // Rewrite the command: replace the executable token with `t.to`.
    // Preserves everything else (quoting, env vars, arguments).
    const translated = command.slice(0, start) + t.to + command.slice(start + length);
    const note = `[platform] translated \`${t.from}\` → \`${toFirstToken}\`: ${t.reason}`;
    log.info("bash-translate", note);
    return { translated: true, command: translated, original, note };
  }

  return { translated: false, command, original };
}
