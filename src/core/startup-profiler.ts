// Startup Profiler
// Records timestamps at key init phases for performance analysis.
// Activated via KCODE_PROFILE_STARTUP=1 or always in dev mode.

interface ProfileEntry {
  name: string;
  timestamp: number; // ms since process start
  delta: number;     // ms since previous checkpoint
}

const _entries: ProfileEntry[] = [];
const _startTime = performance.now();

/** Whether profiling is active */
export function isProfilingEnabled(): boolean {
  return process.env.KCODE_PROFILE_STARTUP === "1" ||
         process.env.NODE_ENV === "development";
}

/** Record a checkpoint with the given name. No-op if profiling is disabled. */
export function profileCheckpoint(name: string): void {
  if (!isProfilingEnabled()) return;

  const now = performance.now();
  const timestamp = Math.round(now - _startTime);
  const prevTimestamp = _entries.length > 0 ? _entries[_entries.length - 1].timestamp : 0;
  const delta = timestamp - prevTimestamp;

  _entries.push({ name, timestamp, delta });
}

/** Get all recorded profile entries */
export function getProfileReport(): ProfileEntry[] {
  return [..._entries];
}

/** Format and print the profile report to stderr */
export function printProfileReport(): void {
  if (_entries.length === 0) {
    console.error("  No startup profile data recorded.");
    console.error("  Set KCODE_PROFILE_STARTUP=1 to enable profiling.");
    return;
  }

  console.error("\x1b[1mStartup Profile:\x1b[0m");
  for (const entry of _entries) {
    const ts = String(entry.timestamp).padStart(6);
    const delta = entry.delta > 0 ? `  (+${entry.delta}ms)` : "";
    const slow = entry.delta > 100 ? "  \x1b[33m[SLOW]\x1b[0m" : "";
    console.error(`  ${entry.name.padEnd(24)} ${ts}ms${delta}${slow}`);
  }

  // Total
  if (_entries.length > 0) {
    const total = _entries[_entries.length - 1].timestamp;
    const status = total < 200 ? "\x1b[32m[OK]\x1b[0m" : total < 500 ? "\x1b[33m[SLOW]\x1b[0m" : "\x1b[31m[VERY SLOW]\x1b[0m";
    console.error(`  ${"total".padEnd(24)} ${String(total).padStart(6)}ms  ${status}`);
  }
}

/** Reset all entries (for testing) */
export function _resetProfiler(): void {
  _entries.length = 0;
}

export type { ProfileEntry };
