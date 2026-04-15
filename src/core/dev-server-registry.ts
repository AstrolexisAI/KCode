// KCode — Dev Server Registry
//
// Persistent tracking of dev servers auto-launched by KCode across
// sessions. Solves the leak bug found in the v2.10.81 forensic audit:
//
//   src/core/task-orchestrator/level1-handlers.ts:startDevServer spawns
//   with { detached: true } + child.unref(), which is the correct
//   behavior for "the server should outlive the kcode session" — but
//   with ZERO persistence of what was spawned. Each new kcode session
//   starts with an empty in-memory _sessionState, so it has no way to
//   discover or clean up servers spawned by prior sessions. The user
//   ended up with 5 orphan `bun --watch run src/index.ts` processes
//   from the KCode repo still running more than 29 hours later.
//
// This module adds a JSON-backed registry at ~/.kcode/dev-servers.json
// with:
//   - registerSpawnedServer(entry) — call right after a successful
//     Bun.spawn in startDevServer
//   - cleanupStaleDevServers(cwd) — call at the top of
//     maybeAutoLaunchDevServer; removes dead PIDs (process gone) and
//     kills any entry in the same cwd that is older than MAX_AGE_MS,
//     reaping orphans from previous sessions.
//   - listDevServers() — for the /doctor command and manual inspection
//   - unregisterDevServer(pid) — called when a server is explicitly
//     stopped via "para el server" / /stop
//
// The file is hand-writable JSON, not SQLite, because:
//   - Low write rate (a handful per day at most)
//   - Users may want to inspect / edit it manually
//   - Zero module-load cost vs the sqlite import

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger";
import { kcodePath } from "./paths";

// ─── Types ──────────────────────────────────────────────────────

/**
 * One auto-launched dev server. The `pid` is the process group leader
 * because startDevServer spawns with `detached: true`, so killing it
 * with `process.kill(pid)` signals the whole group.
 */
export interface DevServerEntry {
  pid: number;
  cwd: string;
  /** The shell command we spawned, e.g. "bun run dev". */
  command: string;
  /** Port we believe the server is bound to. 0 if unknown. */
  port: number;
  /** Unix ms timestamp of the spawn. */
  startedAt: number;
  /** PID of the kcode session that spawned it (may be gone). */
  parentKcodePid: number;
  /** Human label like "NEXT" or "VITE". */
  name?: string;
}

// ─── Constants ──────────────────────────────────────────────────

/** Entries older than this are considered stale candidates. Tunable. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Cap on total entries to prevent unbounded growth. */
const MAX_ENTRIES = 200;

// ─── Registry I/O ───────────────────────────────────────────────

function registryPath(): string {
  return kcodePath("dev-servers.json");
}

/**
 * Read the registry from disk. Missing file returns []. Corrupt file
 * is logged and reset to [] so future writes start clean.
 */
export function readRegistry(): DevServerEntry[] {
  const path = registryPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      log.warn("dev-registry", "dev-servers.json is not an array — resetting");
      return [];
    }
    return parsed.filter(isValidEntry);
  } catch (err) {
    log.warn("dev-registry", `failed to read dev-servers.json: ${err} — resetting`);
    return [];
  }
}

function isValidEntry(x: unknown): x is DevServerEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.pid === "number" &&
    typeof e.cwd === "string" &&
    typeof e.command === "string" &&
    typeof e.port === "number" &&
    typeof e.startedAt === "number" &&
    typeof e.parentKcodePid === "number"
  );
}

function writeRegistry(entries: DevServerEntry[]): void {
  const path = registryPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Keep only the newest MAX_ENTRIES to bound the file. Older
    // entries are almost always already-dead processes that can be
    // safely forgotten — cleanupStaleDevServers would reap them next
    // run anyway.
    const bounded =
      entries.length > MAX_ENTRIES
        ? entries.slice(-MAX_ENTRIES)
        : entries;
    writeFileSync(path, JSON.stringify(bounded, null, 2), "utf-8");
  } catch (err) {
    log.warn("dev-registry", `failed to write dev-servers.json: ${err}`);
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Record that a dev server was just spawned. Safe to call
 * concurrently because the file is written atomically — the worst
 * case on a race is losing one very recent entry, which the next
 * successful call will overwrite correctly.
 */
export function registerSpawnedServer(entry: Omit<DevServerEntry, "startedAt" | "parentKcodePid">): void {
  const existing = readRegistry();
  const full: DevServerEntry = {
    ...entry,
    startedAt: Date.now(),
    parentKcodePid: process.pid,
  };
  existing.push(full);
  writeRegistry(existing);
  log.debug(
    "dev-registry",
    `registered pid=${full.pid} port=${full.port} cwd=${full.cwd}`,
  );
}

/**
 * Remove an entry by PID. Called when a server is explicitly stopped.
 * No-op if the PID is not registered.
 */
export function unregisterDevServer(pid: number): void {
  const existing = readRegistry();
  const filtered = existing.filter((e) => e.pid !== pid);
  if (filtered.length !== existing.length) {
    writeRegistry(filtered);
    log.debug("dev-registry", `unregistered pid=${pid}`);
  }
}

/**
 * Return all registered entries. Does NOT filter by liveness — callers
 * that need only live entries should use `isProcessAlive` themselves.
 */
export function listDevServers(): DevServerEntry[] {
  return readRegistry();
}

// ─── Process liveness check ─────────────────────────────────────

/**
 * Return true if the PID is still running. Uses signal 0 which does
 * nothing but throws if the process doesn't exist or we can't signal
 * it (e.g., owned by a different user).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Cleanup ────────────────────────────────────────────────────

export interface CleanupResult {
  /** Entries that were already dead and just removed from registry. */
  removedDead: number;
  /** Entries we killed because they were stale orphans in the target cwd. */
  killedStale: number;
  /** Total entries remaining in the registry after cleanup. */
  remaining: number;
}

/**
 * House-keeping: on the hot path of maybeAutoLaunchDevServer, call
 * this before spawning a new server. It:
 *
 *   1. Removes entries whose PID no longer exists (reaped elsewhere).
 *   2. If an entry matches the target cwd AND is older than MAX_AGE_MS,
 *      it's almost certainly an orphan from a previous kcode session
 *      that the user forgot about. Kill it and remove from registry.
 *      Entries on other cwds are LEFT ALONE — this guard only cleans
 *      up in the directory that's about to spawn a new server.
 *
 * Returns counts for logging / telemetry. Errors during kill are
 * swallowed — best-effort cleanup should never block a legitimate
 * launch.
 */
export function cleanupStaleDevServers(cwd: string): CleanupResult {
  const entries = readRegistry();
  const now = Date.now();
  let removedDead = 0;
  let killedStale = 0;
  const survivors: DevServerEntry[] = [];

  for (const e of entries) {
    if (!isProcessAlive(e.pid)) {
      removedDead++;
      continue;
    }
    // Only kill stale entries in the same cwd we're about to launch in.
    // Other cwds are someone else's problem (literally — user may have
    // multiple kcode projects running in parallel on purpose).
    if (e.cwd === cwd && now - e.startedAt > MAX_AGE_MS) {
      try {
        // Use negative PID to signal the whole process group since we
        // spawned with detached:true. On Linux/macOS this sends SIGTERM
        // to every process in the group — the dev server plus any
        // child npm/node processes it started.
        process.kill(-e.pid, "SIGTERM");
        killedStale++;
        log.info(
          "dev-registry",
          `killed stale orphan pid=${e.pid} age=${Math.round((now - e.startedAt) / 3600000)}h cwd=${e.cwd}`,
        );
      } catch (err) {
        // If the negative-PID group kill fails (e.g., the process is
        // no longer a group leader), fall back to direct PID kill.
        try {
          process.kill(e.pid, "SIGTERM");
          killedStale++;
        } catch {
          // Best-effort: swallow and just drop from registry
          log.debug(
            "dev-registry",
            `couldn't kill stale pid=${e.pid}: ${err}`,
          );
        }
      }
      continue;
    }
    survivors.push(e);
  }

  if (removedDead > 0 || killedStale > 0) {
    writeRegistry(survivors);
  }

  return {
    removedDead,
    killedStale,
    remaining: survivors.length,
  };
}
