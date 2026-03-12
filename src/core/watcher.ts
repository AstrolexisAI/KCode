// KCode - File Watcher
// Watch files for changes with debouncing, using fs.watch (no external deps)

import { watch, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FSWatcher } from "node:fs";

// ─── Types ──────────────────────────────────────────────────────

type ChangeCallback = (changedPath: string) => void;

// ─── FileWatcher ────────────────────────────────────────────────

export class FileWatcher {
  private watchers: FSWatcher[] = [];
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private debounceMs: number;
  private stopped = false;

  constructor(debounceMs: number = 300) {
    this.debounceMs = debounceMs;
  }

  /**
   * Watch a set of file/directory patterns for changes.
   * Patterns are simple path globs: supports * for matching within a directory.
   * For directories, watches all files recursively.
   * @param patterns Array of file paths or simple glob patterns
   * @param callback Called with the changed file path (debounced)
   */
  watch(patterns: string[], callback: ChangeCallback): void {
    if (this.stopped) return;

    for (const pattern of patterns) {
      const resolved = resolve(pattern);

      // If the path exists as-is, watch it directly
      if (existsSync(resolved)) {
        this.watchPath(resolved, callback);
        continue;
      }

      // Try to expand simple glob patterns (e.g., "src/*.ts")
      const expanded = this.expandPattern(pattern);
      for (const path of expanded) {
        this.watchPath(path, callback);
      }
    }
  }

  /**
   * Stop all active watchers and clear timers.
   */
  stop(): void {
    this.stopped = true;

    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore close errors
      }
    }
    this.watchers = [];

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Whether the watcher is currently active.
   */
  get isWatching(): boolean {
    return !this.stopped && this.watchers.length > 0;
  }

  // ─── Internal ───────────────────────────────────────────────

  private watchPath(filePath: string, callback: ChangeCallback): void {
    try {
      const isDir = statSync(filePath).isDirectory();

      const watcher = watch(
        filePath,
        { recursive: isDir },
        (_eventType, filename) => {
          const changedPath = filename
            ? isDir
              ? join(filePath, filename)
              : filePath
            : filePath;

          this.debouncedCallback(changedPath, callback);
        },
      );

      watcher.on("error", () => {
        // Silently handle watcher errors (file deleted, etc.)
      });

      this.watchers.push(watcher);
    } catch {
      // Path doesn't exist or can't be watched
    }
  }

  private debouncedCallback(changedPath: string, callback: ChangeCallback): void {
    // Clear existing timer for this path
    const existing = this.debounceTimers.get(changedPath);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new debounce timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(changedPath);
      if (!this.stopped) {
        callback(changedPath);
      }
    }, this.debounceMs);

    this.debounceTimers.set(changedPath, timer);
  }

  /**
   * Expand a simple glob pattern into matching file paths.
   * Only supports * wildcard within a single directory level.
   */
  private expandPattern(pattern: string): string[] {
    const lastSlash = pattern.lastIndexOf("/");
    if (lastSlash === -1) return [];

    const dir = resolve(pattern.slice(0, lastSlash));
    const filePattern = pattern.slice(lastSlash + 1);

    if (!existsSync(dir)) return [];

    // Convert simple glob to regex (only * wildcard)
    const regexStr = "^" + filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
    const regex = new RegExp(regexStr);

    try {
      return readdirSync(dir)
        .filter((f) => regex.test(f))
        .map((f) => join(dir, f));
    } catch {
      return [];
    }
  }
}
