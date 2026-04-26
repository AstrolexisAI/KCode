// KCode - Review History (Learning Loop)
//
// F5.4 of the audit product plan. Tracks how often each pattern_id
// gets demoted as a false_positive across runs, scoped by file-path
// glob, so the verifier can lower priority on patterns that
// consistently misfire in specific paths.
//
// Storage: ~/.kcode/review-history.json. Per-project history is
// keyed by the project's resolved absolute path so multiple projects
// on the same machine don't bleed into each other.
//
// We deliberately persist counts across runs but DON'T auto-mute
// patterns yet — the data only feeds priority adjustments at scan
// time. Auto-muting would require explicit reviewer opt-in and a
// way to surface "this pattern is silenced because you demoted it
// 47 times" in the report.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { kcodePath } from "../paths";

const HISTORY_FILE = "review-history.json";
// Threshold above which a pattern is considered "high-noise" for the
// path glob it was demoted under. Tuned so a one-off demotion doesn't
// suppress, but a sustained pattern over weeks does.
export const HIGH_NOISE_THRESHOLD = 10;

export interface PatternNoiseEntry {
  pattern_id: string;
  /** Count of distinct demotions across all paths in this project. */
  demoted_count: number;
  /**
   * Per-path-glob counts. Keys are file path globs derived from the
   * demoted file (e.g. `*/test/*`, `src/legacy/*`). Lets the runtime
   * say "this pattern is high-noise in test paths but fine in src".
   */
  by_path_glob: Record<string, number>;
  /** Last demotion timestamp (ISO 8601). */
  last_demoted_at: string;
}

interface ProjectHistory {
  /** Project root the entries belong to. Rebound on absolute path. */
  project: string;
  /** Pattern noise entries keyed by pattern_id. */
  patterns: Record<string, PatternNoiseEntry>;
}

interface ReviewHistory {
  schema_version: 1;
  /** Per-project history keyed by absolute project root. */
  projects: Record<string, ProjectHistory>;
}

function getHistoryPath(): string {
  return kcodePath(HISTORY_FILE);
}

function emptyHistory(): ReviewHistory {
  return { schema_version: 1, projects: {} };
}

function loadHistory(): ReviewHistory {
  const path = getHistoryPath();
  if (!existsSync(path)) return emptyHistory();
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as ReviewHistory;
    if (data?.schema_version !== 1 || !data.projects) return emptyHistory();
    return data;
  } catch {
    return emptyHistory();
  }
}

function saveHistory(h: ReviewHistory): void {
  const path = getHistoryPath();
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // v2.10.367 — atomic write: stage to a sibling .tmp then rename.
    // Two concurrent kcode processes won't truncate each other; readers
    // never see a partial JSON. Same-fs rename is atomic on POSIX.
    const tmpPath = `${path}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(h, null, 2));
    require("node:fs").renameSync(tmpPath, path);
  } catch {
    /* best effort — stay silent so audit doesn't fail on a write hiccup */
  }
}

/**
 * Derive a coarse path glob from a concrete file path. We want the
 * key to be stable across runs and across files in the same role
 * (test, fixture, legacy, etc.) without hand-maintaining a huge
 * taxonomy. Heuristics, in order:
 *   - any path with `/test/`, `/tests/`, `/__tests__/`, `*.test.*`,
 *     `*.spec.*` → `test:*`
 *   - any path with `/fixtures/`, `/__mocks__/`, `*.fixture.*` → `fixture:*`
 *   - any path with `/generated/`, `/autocoder/`, `/.autogen/` → `generated:*`
 *   - any path with `/vendor/`, `/node_modules/`, `/third_party/` → `vendor:*`
 *   - any path with `/build/`, `/dist/`, `/out/` → `build:*`
 *   - otherwise: the project-relative top-level dir, e.g. `src:*`
 */
export function pathGlob(file: string, projectRoot: string): string {
  // v2.10.367 — normalize Windows backslashes to forward slashes so
  // the test/vendor/build heuristics fire on every platform.
  const normalized = file.replace(/\\/g, "/");
  const normalizedRoot = projectRoot.replace(/\\/g, "/");
  const rel = normalized.startsWith(normalizedRoot)
    ? normalized.slice(normalizedRoot.length).replace(/^\//, "")
    : normalized;
  const lower = rel.toLowerCase();

  if (
    /(^|\/)(test|tests|__tests__)(\/|$)/.test(lower) ||
    /\.(test|spec)\.[a-z]+$/i.test(rel)
  ) {
    return "test:*";
  }
  if (/(^|\/)(fixtures?|__mocks__)(\/|$)/.test(lower) || /\.fixture\.[a-z]+$/i.test(rel)) {
    return "fixture:*";
  }
  if (/(^|\/)(generated|autocoder|\.autogen)(\/|$)/.test(lower)) {
    return "generated:*";
  }
  if (/(^|\/)(vendor|node_modules|third_party)(\/|$)/.test(lower)) {
    return "vendor:*";
  }
  if (/(^|\/)(build|dist|out)(\/|$)/.test(lower)) {
    return "build:*";
  }
  const topDir = rel.split("/")[0] ?? "root";
  return `${topDir}:*`;
}

/**
 * Record a single demotion event. Idempotent at the (project,
 * pattern, path_glob) tuple — calling twice for the same finding
 * still increments by two, which is intentional: each call
 * represents an independent reviewer decision.
 */
export function recordDemotion(opts: {
  projectRoot: string;
  patternId: string;
  file: string;
}): void {
  const { projectRoot, patternId, file } = opts;
  const history = loadHistory();
  const proj = history.projects[projectRoot] ?? { project: projectRoot, patterns: {} };
  const entry = proj.patterns[patternId] ?? {
    pattern_id: patternId,
    demoted_count: 0,
    by_path_glob: {},
    last_demoted_at: new Date().toISOString(),
  };
  entry.demoted_count += 1;
  const glob = pathGlob(file, projectRoot);
  entry.by_path_glob[glob] = (entry.by_path_glob[glob] ?? 0) + 1;
  entry.last_demoted_at = new Date().toISOString();
  proj.patterns[patternId] = entry;
  history.projects[projectRoot] = proj;
  saveHistory(history);
}

/**
 * Look up how often a pattern has been demoted under the given file
 * path's glob in this project. Returns 0 when there's no history,
 * which is the desired no-op default.
 */
export function getDemotionCount(opts: {
  projectRoot: string;
  patternId: string;
  file: string;
}): number {
  const { projectRoot, patternId, file } = opts;
  const history = loadHistory();
  const proj = history.projects[projectRoot];
  if (!proj) return 0;
  const entry = proj.patterns[patternId];
  if (!entry) return 0;
  const glob = pathGlob(file, projectRoot);
  return entry.by_path_glob[glob] ?? 0;
}

/**
 * Check whether a (pattern, path) is "high-noise" for this project.
 * Used by the verifier or scanner to lower priority — e.g. skip the
 * verifier call entirely and pre-mark as needs_context, or just
 * lower the candidate's rank in the scan order.
 */
export function isHighNoise(opts: {
  projectRoot: string;
  patternId: string;
  file: string;
}): boolean {
  return getDemotionCount(opts) >= HIGH_NOISE_THRESHOLD;
}

/**
 * Return the project-wide pattern noise entries for reporting.
 * Empty array when there's no history for this project.
 */
export function getProjectHistory(projectRoot: string): PatternNoiseEntry[] {
  const history = loadHistory();
  const proj = history.projects[projectRoot];
  if (!proj) return [];
  return Object.values(proj.patterns).sort((a, b) => b.demoted_count - a.demoted_count);
}

/**
 * Clear all history for a project. Used by tests and by the user
 * via `/review … forget` if they want to reset.
 */
export function forgetProjectHistory(projectRoot: string): void {
  const history = loadHistory();
  if (!history.projects[projectRoot]) return;
  delete history.projects[projectRoot];
  saveHistory(history);
}
