// KCode - Bash Spawn Preflight
//
// Operator-mind primitive (phase 2): refuse to spawn a background server
// when the system already has the resource we'd be trying to claim.
// Catches the two failure modes that bricked the Artemis session:
//
//   1. Port collision — `PORT=15423 npm run dev` when something is
//      already listening on 15423. The new spawn races, fails with
//      EADDRINUSE, leaves an orphan, model retries.
//
//   2. inotify saturation — when /proc/sys/fs/inotify/max_user_instances
//      is >85% used, the next watch-mode dev server boots into EMFILE
//      and crashes silently. Each retry leaks more watchers.
//
// Both checks are CHEAP: ~1ms ss + ~50ms /proc walk. Run only when the
// command matches a server-spawn pattern (so one-shot Bash calls like
// `ls` are unaffected).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { detectServerSpawn, extractDeclaredPort } from "./bash-spawn-verifier.js";
import { log } from "./logger.js";

// ─── Port collision check ─────────────────────────────────────────

/**
 * Returns the PID currently listening on the given TCP port, or null
 * if the port is free. Uses `ss -tlnp` (Linux) — falls back to null on
 * any error so the preflight degrades gracefully on macOS/Windows.
 */
export function findListeningPid(port: number): number | null {
  try {
    const result = spawnSync("ss", ["-tlnp"], { encoding: "utf-8", timeout: 2000 });
    if (result.status !== 0 || !result.stdout) return null;
    // Lines look like:
    //   LISTEN 0 511 *:15423 *:* users:(("next-server (v1",pid=2346182,fd=22))
    const lines = result.stdout.split("\n");
    const portRe = new RegExp(`[:.](?:0\\.0\\.0\\.0:|\\*:|\\[::\\]:|::)?${port}\\b`);
    for (const ln of lines) {
      if (!ln.includes("LISTEN")) continue;
      if (!portRe.test(ln)) continue;
      const m = ln.match(/pid=(\d+)/);
      if (m) return parseInt(m[1]!, 10);
      // Listening but ss didn't expose pid (no privileges). Still a hit.
      return -1;
    }
    return null;
  } catch (err) {
    log.debug("preflight", `findListeningPid failed: ${err}`);
    return null;
  }
}

/** Best-effort process name for a PID, for nicer diagnostics. */
export function processNameFor(pid: number): string | null {
  if (pid <= 0) return null;
  try {
    const cmd = readFileSync(`/proc/${pid}/comm`, "utf-8").trim();
    return cmd || null;
  } catch {
    return null;
  }
}

// ─── inotify saturation check ─────────────────────────────────────

export interface InotifyState {
  /** Current count of inotify instances open on the system. */
  used: number;
  /** Configured per-user limit (max_user_instances). */
  limit: number;
  /** Ratio used/limit, in [0..1+]. */
  ratio: number;
}

let _inotifyCache: { state: InotifyState; ts: number } | null = null;
const INOTIFY_CACHE_TTL_MS = 30_000;

/**
 * Snapshot inotify usage from /proc. Cached for 30s because walking
 * `/proc/<pid>/fd` is moderately expensive (~50ms on busy systems).
 */
export function checkInotifyState(): InotifyState | null {
  if (_inotifyCache && Date.now() - _inotifyCache.ts < INOTIFY_CACHE_TTL_MS) {
    return _inotifyCache.state;
  }
  try {
    const limit = parseInt(
      readFileSync("/proc/sys/fs/inotify/max_user_instances", "utf-8").trim(),
      10,
    );
    if (!Number.isFinite(limit) || limit <= 0) return null;
    // Walk /proc/*/fd looking for symlinks to anon_inode:inotify
    const result = spawnSync(
      "sh",
      [
        "-c",
        "find /proc/*/fd -lname 'anon_inode:inotify' 2>/dev/null | wc -l",
      ],
      { encoding: "utf-8", timeout: 3000 },
    );
    if (result.status !== 0) return null;
    const used = parseInt(result.stdout.trim(), 10);
    if (!Number.isFinite(used) || used < 0) return null;
    const state: InotifyState = { used, limit, ratio: used / limit };
    _inotifyCache = { state, ts: Date.now() };
    return state;
  } catch (err) {
    log.debug("preflight", `checkInotifyState failed: ${err}`);
    return null;
  }
}

/** Drop the cached inotify snapshot — for tests. */
export function clearInotifyCache(): void {
  _inotifyCache = null;
}

// ─── Combined preflight ───────────────────────────────────────────

export interface PreflightRefusal {
  refused: true;
  /** Multi-line operator report — safe to inline as a tool result. */
  report: string;
}

/**
 * Run all preflight checks for a candidate background spawn. Returns
 * null if the spawn should proceed normally, or a refusal object if
 * something is wrong with the system right now.
 *
 * This is intentionally conservative: only fires for commands that
 * match the server-spawn pattern set, leaving normal Bash calls alone.
 */
export function runSpawnPreflight(
  command: string,
  cwd: string,
): PreflightRefusal | null {
  const detection = detectServerSpawn(command);
  if (!detection) return null;

  const lines: string[] = [];

  // Check 1: Port collision
  const port = extractDeclaredPort(command, detection.defaultPort);
  if (port !== null) {
    const occupant = findListeningPid(port);
    if (occupant !== null) {
      const occupantName = occupant > 0 ? processNameFor(occupant) : null;
      lines.push(`✗ Port ${port} is already in use.`);
      if (occupant > 0) {
        lines.push(`  occupant: PID ${occupant}${occupantName ? ` (${occupantName})` : ""}`);
      } else {
        lines.push(`  occupant: detected by ss but PID hidden (insufficient privileges)`);
      }
      lines.push(`  Spawning ${detection.framework} on this port would race and fail.`);
      lines.push(`  Options:`);
      lines.push(`    - reuse the existing server (it may already serve what you need)`);
      lines.push(`    - kill the occupant first (e.g. 'kill ${occupant > 0 ? occupant : "<pid>"}')`);
      lines.push(`    - pick a different port (PORT=N or --port N)`);
      return { refused: true, report: lines.join("\n") };
    }
  }

  // Check 2: inotify saturation (only meaningful for watch-mode frameworks)
  const usesWatcher = /\b(?:next|vite|astro|nodemon|live-server|webpack|node-dev)\b/.test(
    detection.framework,
  );
  if (usesWatcher) {
    const ino = checkInotifyState();
    if (ino && ino.ratio >= 0.85) {
      lines.push(`✗ inotify is saturated: ${ino.used}/${ino.limit} instances used (${Math.round(ino.ratio * 100)}%).`);
      lines.push(`  Spawning a watch-mode dev server right now would EMFILE on boot`);
      lines.push(`  and you'd see "Watchpack Error (watcher): EMFILE: too many open files".`);
      lines.push(`  The previous server would also lose hot-reload but appear to keep running.`);
      lines.push(`  Options:`);
      lines.push(`    - kill leaked dev servers from this UID:`);
      lines.push(`        pgrep -af 'next-server|bun --watch|nodemon' && pkill -9 -u $USER -f 'next-server'`);
      lines.push(`    - raise the limit (one-shot, requires sudo):`);
      lines.push(`        sudo sysctl -w fs.inotify.max_user_instances=1024`);
      lines.push(`    - persist the limit:`);
      lines.push(`        echo 'fs.inotify.max_user_instances=1024' | sudo tee /etc/sysctl.d/99-inotify.conf`);
      void cwd; // keep param for future use
      return { refused: true, report: lines.join("\n") };
    }
  }

  return null;
}
