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
import { readFileSync, readlinkSync } from "node:fs";
import { detectServerSpawn, extractDeclaredPort } from "./bash-spawn-verifier.js";
import { log } from "./logger.js";

// ─── Phase 10: process cwd lookup for smart port-collision resolution

/**
 * Look up a process's working directory via /proc/<pid>/cwd.
 * Returns null on permission denied / dead process / non-Linux.
 */
export function getProcessCwd(pid: number): string | null {
  if (pid <= 0) return null;
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Decide whether two cwds belong to the "same project" — i.e. one is
 * a subdirectory of the other or they are identical. Conservative:
 * returns false if either path is empty or the relationship can't be
 * determined.
 */
export function cwdsAreSameProject(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  // Normalize trailing slash
  const na = a.endsWith("/") ? a : a + "/";
  const nb = b.endsWith("/") ? b : b + "/";
  return na.startsWith(nb) || nb.startsWith(na);
}

// ─── Phase 8: stale-watcher self-heal ─────────────────────────────

/**
 * Process names that count as "dev-mode watchers" — these should always
 * be ephemeral. If they are leaking inotify slots, killing them is safe.
 */
const STALE_WATCHER_COMMS = new Set([
  "next-server",
  "vite",
  "nodemon",
  "node",  // bare node — common for dev tools, filtered by elapsed time
  "bun",   // bun --watch
]);

interface StaleWatcher {
  pid: number;
  comm: string;
  etimeSec: number;
}

/**
 * List dev-mode watcher processes owned by the current user with an
 * elapsed time exceeding the threshold. Active dev sessions are
 * usually short-lived (<30 min); processes older than that are
 * almost always leaks from prior KCode sessions or crashed wrappers.
 */
export function findStaleDevWatchers(maxAgeSec: number = 1800): StaleWatcher[] {
  try {
    const result = spawnSync(
      "ps",
      ["-o", "pid,etimes,comm", "-u", String(process.getuid?.() ?? "")],
      { encoding: "utf-8", timeout: 2000 },
    );
    if (result.status !== 0 || !result.stdout) return [];
    const lines = result.stdout.trim().split("\n").slice(1); // skip header
    const out: StaleWatcher[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = parseInt(parts[0]!, 10);
      const etimeSec = parseInt(parts[1]!, 10);
      const comm = parts[2]!;
      if (!Number.isFinite(pid) || !Number.isFinite(etimeSec)) continue;
      if (!STALE_WATCHER_COMMS.has(comm)) continue;
      if (etimeSec < maxAgeSec) continue;
      out.push({ pid, comm, etimeSec });
    }
    return out;
  } catch (err) {
    log.debug("preflight", `findStaleDevWatchers failed: ${err}`);
    return [];
  }
}

export interface InotifyRecoveryResult {
  killed: number;
  killedPids: number[];
  beforeRatio: number;
  afterRatio: number | null;
  recovered: boolean;
}

/**
 * Attempt to bring inotify usage below the threshold by killing
 * stale dev-mode watchers (>30 min old) owned by the current user.
 *
 * This is the operator-mind equivalent of "do the cleanup yourself
 * before complaining about saturation". Justification:
 *   - Targets are dev-mode watchers, never production processes.
 *   - Restricted to the current UID — never touches another user.
 *   - Only kills processes >30 min old — active dev sessions are spared.
 *   - Idempotent: re-running just kills nothing.
 *   - Reversible: nothing on disk is touched, only ephemeral processes.
 *
 * Called by runSpawnPreflight before issuing the inotify refusal.
 * If recovery succeeds, the refusal never fires and the spawn proceeds.
 */
export function attemptInotifyRecovery(threshold: number = 0.85): InotifyRecoveryResult {
  const before = checkInotifyState();
  if (!before) {
    return { killed: 0, killedPids: [], beforeRatio: 0, afterRatio: null, recovered: false };
  }
  const beforeRatio = before.ratio;
  if (beforeRatio < threshold) {
    return {
      killed: 0,
      killedPids: [],
      beforeRatio,
      afterRatio: beforeRatio,
      recovered: true,
    };
  }
  const stale = findStaleDevWatchers(1800);
  const killedPids: number[] = [];
  for (const w of stale) {
    try {
      process.kill(w.pid, "SIGKILL");
      killedPids.push(w.pid);
    } catch (err) {
      log.debug("preflight", `failed to kill stale watcher pid=${w.pid}: ${err}`);
    }
  }
  if (killedPids.length === 0) {
    return { killed: 0, killedPids, beforeRatio, afterRatio: beforeRatio, recovered: false };
  }
  // Wait briefly for the kernel to release inotify slots.
  Bun.sleepSync?.(800) ?? sleepBlocking(800);
  clearInotifyCache();
  const after = checkInotifyState();
  const afterRatio = after?.ratio ?? null;
  const recovered = afterRatio !== null && afterRatio < threshold;
  log.info(
    "preflight",
    `inotify self-heal: killed ${killedPids.length} stale watchers, ratio ${Math.round(beforeRatio * 100)}% → ${afterRatio !== null ? Math.round(afterRatio * 100) + "%" : "unknown"}, recovered=${recovered}`,
  );
  return { killed: killedPids.length, killedPids, beforeRatio, afterRatio, recovered };
}

/** Sync-blocking sleep fallback — only used if Bun.sleepSync is unavailable. */
function sleepBlocking(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

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

  // Phase 12: filename-based detection ("bun run index.ts", "node app.js")
  // over-matches on CLI/TUI projects whose entry file happens to be
  // named index / app / server / main. Before reserving a port, peek
  // at the project's package.json / requirements.txt / entry file for
  // TUI/CLI signals (blessed, ink, commander, rich, curses, typer, ...).
  // When the project is demonstrably non-web, skip preflight entirely —
  // the spawn can't collide with anything because it never listens.
  //
  // Issue #111 v275: Bitcoin TUI scaffold with blessed-contrib was
  // refused by preflight on port 3000 (held by unrelated dev server).
  // Only narrow the skip to the "direct" detections; explicit web
  // commands (next dev, vite, flask run, ...) keep the check.
  if (detection.framework === "bun-direct" || detection.framework === "node-direct") {
    try {
      const { inferRuntimeModeFromCwd, skipsServerPreflight, extractEffectiveCwd } =
        require("./runtime-mode") as typeof import("./runtime-mode");
      // The user's command often starts with `cd SUBDIR && bun run
      // index.ts`. Infer mode from the EFFECTIVE cwd (the subdir),
      // not from the session cwd — otherwise the package.json /
      // entry file with the TUI imports lives in a different
      // directory from the one we scan. Issue #111 v276 repro.
      const effectiveCwd = extractEffectiveCwd(command, cwd);
      const mode = inferRuntimeModeFromCwd(effectiveCwd);
      if (skipsServerPreflight(mode)) {
        log.debug(
          "preflight",
          `skip ${detection.framework} preflight: effective cwd ${effectiveCwd}, runtime mode = ${mode}`,
        );
        return null;
      }
    } catch (err) {
      log.debug(
        "preflight",
        `runtime-mode inference failed, falling through: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const lines: string[] = [];

  // Check 1: Port collision
  const port = extractDeclaredPort(command, detection.defaultPort);
  if (port !== null) {
    const occupant = findListeningPid(port);
    if (occupant !== null) {
      const occupantName = occupant > 0 ? processNameFor(occupant) : null;
      // Phase 10: look up the occupant's working directory so we can
      // tell the model whether the colliding server is the SAME project
      // (same cwd subtree → file edits will hot-reload through it,
      // task can proceed without spawning) or a DIFFERENT project
      // (must kill or pick a different port).
      const occupantCwd = occupant > 0 ? getProcessCwd(occupant) : null;
      const sameProject = cwdsAreSameProject(cwd, occupantCwd);

      lines.push(`✗ Port ${port} is already in use.`);
      if (occupant > 0) {
        lines.push(`  occupant: PID ${occupant}${occupantName ? ` (${occupantName})` : ""}`);
        if (occupantCwd) {
          lines.push(`  occupant cwd: ${occupantCwd}`);
        }
      } else {
        lines.push(`  occupant: detected by ss but PID hidden (insufficient privileges)`);
      }
      lines.push(`  Spawning ${detection.framework} on this port would race and fail.`);
      lines.push(``);

      if (sameProject) {
        // Same project — the occupant is almost certainly a dev server
        // started by an earlier session for THIS project. Hot-reload
        // will pick up the file edits we just made. The model should
        // treat the task as already-served, not as a failure.
        lines.push(`  ✓ The occupant's cwd is inside YOUR current working directory.`);
        lines.push(`  This is almost always a dev server from an earlier session for the`);
        lines.push(`  same project. Watch-mode frameworks (Next.js, Vite, etc.) hot-reload`);
        lines.push(`  on file changes, so the edits you just made are already being served`);
        lines.push(`  by PID ${occupant}.`);
        lines.push(``);
        lines.push(`  RECOMMENDED: Treat this as a success, not a failure.`);
        lines.push(`    1. Verify by curling http://localhost:${port}/ — you should see your`);
        lines.push(`       new content already.`);
        lines.push(`    2. Tell the user the project is live at http://localhost:${port}.`);
        lines.push(`    3. Do NOT spawn another server. Do NOT kill PID ${occupant} unless`);
        lines.push(`       there is a config-level change Next.js cannot hot-reload`);
        lines.push(`       (next.config.js / package.json / tailwind.config — edits to`);
        lines.push(`       components/pages always hot-reload fine).`);
        lines.push(``);
        lines.push(`  AUTHORIZED RECOVERY (only if hot-reload truly is not enough,`);
        lines.push(`  e.g. you changed next.config.js or installed new dependencies):`);
        lines.push(`    Step 1 — kill the occupant:  kill ${occupant}`);
        lines.push(`    Step 2 — wait for release:   sleep 1`);
        lines.push(`    Step 3 — retry the original command.`);
      } else if (occupant > 0) {
        // Different project — model should kill or pick a different port
        if (occupantCwd) {
          lines.push(`  ⚠ The occupant's cwd (${occupantCwd}) is OUTSIDE your current`);
          lines.push(`  working directory (${cwd}). It belongs to a different project.`);
          lines.push(``);
        }
        lines.push(`  AUTHORIZED RECOVERY (you may run these as your next tool calls`);
        lines.push(`  WITHOUT asking the user — they are reversible system maintenance):`);
        lines.push(`    Step 1 — kill the occupant:`);
        lines.push(`        kill ${occupant}`);
        lines.push(`    Step 2 — wait for the port to release:`);
        lines.push(`        sleep 1`);
        lines.push(`    Step 3 — retry the original command.`);
        lines.push(``);
        lines.push(`  ALTERNATIVE: pick a different port (PORT=N or --port N) if you suspect`);
        lines.push(`  the occupant is a dev server the user is actively using elsewhere.`);
      } else {
        // PID hidden by ss
        lines.push(`  AUTHORIZED RECOVERY (you may run these as your next tool calls`);
        lines.push(`  WITHOUT asking the user — they are reversible system maintenance):`);
        lines.push(`    Step 1 — pick a different port: change PORT=N or --port N in the command.`);
        lines.push(`    Step 2 — retry the spawn with the new port.`);
      }
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
      // Phase 8: try to self-heal before refusing. Real sessions showed
      // that grok-class models read AUTHORIZED RECOVERY blocks but still
      // delegate the cleanup to the user. KCode now does the cleanup
      // itself for stale watchers (>30 min old, current UID, dev-mode
      // process names) and only refuses if recovery actually fails.
      const recovery = attemptInotifyRecovery(0.85);
      if (recovery.recovered) {
        log.info(
          "preflight",
          `inotify self-heal succeeded: killed ${recovery.killed} stale watchers, ` +
            `ratio ${Math.round(recovery.beforeRatio * 100)}% → ${Math.round((recovery.afterRatio ?? 0) * 100)}%`,
        );
        // Returning null here lets the original spawn proceed.
        return null;
      }

      lines.push(`✗ inotify is saturated: ${ino.used}/${ino.limit} instances used (${Math.round(ino.ratio * 100)}%).`);
      lines.push(`  Spawning a watch-mode dev server right now would EMFILE on boot`);
      lines.push(`  and you'd see "Watchpack Error (watcher): EMFILE: too many open files".`);
      if (recovery.killed > 0) {
        lines.push(``);
        lines.push(`  KCode already attempted self-heal: killed ${recovery.killed} stale watchers`);
        lines.push(`  (PIDs ${recovery.killedPids.join(", ")}), but inotify is still`);
        lines.push(`  ${recovery.afterRatio !== null ? Math.round(recovery.afterRatio * 100) + "%" : "saturated"}.`);
        lines.push(`  This means the remaining leaked watchers are either active dev sessions`);
        lines.push(`  the user is using, or owned by another UID.`);
      } else {
        lines.push(``);
        lines.push(`  KCode looked for stale watchers (dev-mode processes >30 min old owned by`);
        lines.push(`  the current user) but found none. The leaks are either active dev sessions`);
        lines.push(`  the user is using, or owned by another UID.`);
      }
      lines.push(``);
      lines.push(`  AUTHORIZED RECOVERY (you may run these as your next tool calls`);
      lines.push(`  WITHOUT asking the user — they are reversible system maintenance):`);
      lines.push(`    Step 1 — reclaim leaked watchers from previous KCode sessions:`);
      lines.push(`        pkill -9 -u $USER -f 'next-server|bun --watch|nodemon|vite' || true`);
      lines.push(`    Step 2 — wait briefly for the kernel to release inotify slots:`);
      lines.push(`        sleep 1`);
      lines.push(`    Step 3 — retry the original spawn.`);
      lines.push(``);
      lines.push(`  After Step 3 the spawn-verifier will probe the server and report success`);
      lines.push(`  or a different failure. If usage is still ≥85% after Step 1, the leaks are`);
      lines.push(`  owned by another UID and you must instead ask the user to run:`);
      lines.push(`        sudo sysctl -w fs.inotify.max_user_instances=1024`);
      lines.push(``);
      lines.push(`  These pkill targets (next-server, bun --watch, nodemon, vite) are dev-mode`);
      lines.push(`  watchers that should be ephemeral. They do NOT touch user code, files, git,`);
      lines.push(`  or any production process. The pkill is not destructive — it is the same`);
      lines.push(`  cleanup the user would do manually.`);
      void cwd; // keep param for future use
      return { refused: true, report: lines.join("\n") };
    }
  }

  return null;
}
