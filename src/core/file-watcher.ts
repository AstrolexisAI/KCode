// KCode - File Watcher
// Watches project directory for external file changes and auto-refreshes codebase index

import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface FileChangeEvent {
  type: "create" | "modify" | "delete";
  path: string;
  timestamp: number;
  /** @deprecated Use `path` instead */
  relativePath: string;
}

export type FileChangeCallback = (changes: FileChangeEvent[]) => void;

// ─── Constants ──────────────────────────────────────────────────

const WATCH_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".vue",
  ".svelte",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
]);

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "__pycache__",
  "venv",
  ".next",
  ".nuxt",
  "target",
  "vendor",
  ".kcode",
  "coverage",
  "data",
]);

// Debounce interval in ms — batch rapid changes
const DEBOUNCE_MS = 2000;

// ─── File Watcher ──────────────────────────────────────────────

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private cwd: string;
  private callback: FileChangeCallback | null = null;
  private pendingChanges: Map<string, FileChangeEvent> = new Map();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _changeCount = 0;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Start watching the project directory for file changes.
   * Uses recursive fs.watch (supported on Linux inotify and macOS FSEvents).
   */
  start(callback: FileChangeCallback): void {
    if (this.watcher) return; // Already watching

    // Safety: don't recursively watch home directory, root, or non-project dirs
    // A project dir should have at least one project marker file
    if (!isProjectDirectory(this.cwd)) {
      log.info("watcher", `Skipping file watcher — "${this.cwd}" is not a project directory`);
      return;
    }

    this.callback = callback;

    try {
      this.watcher = watch(this.cwd, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // Filter by extension
        const ext = extname(filename);
        if (!WATCH_EXTENSIONS.has(ext)) return;

        // Ignore watched directories (check path segments, not substring)
        const segments = filename.split("/");
        if (segments.some((seg) => IGNORE_DIRS.has(seg) || seg.startsWith("."))) return;

        const relPath = filename;
        // Distinguish create vs delete on rename events by checking if file exists
        let changeType: FileChangeEvent["type"];
        if (eventType === "rename") {
          try {
            statSync(join(this.cwd, filename));
            changeType = "create";
          } catch {
            changeType = "delete";
          }
        } else {
          changeType = "modify";
        }

        this.pendingChanges.set(relPath, {
          type: changeType,
          path: relPath,
          timestamp: Date.now(),
          relativePath: relPath,
        });

        // Debounce: batch rapid changes
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.flush(), DEBOUNCE_MS);
      });

      // Handle async errors from recursive watch (e.g. EACCES on restricted subdirectories)
      this.watcher.on("error", (err) => {
        log.warn(
          "watcher",
          `Watch error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      log.info("watcher", `File watcher started for ${this.cwd}`);
    } catch (err) {
      log.warn(
        "watcher",
        `Failed to start file watcher: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private flush(): void {
    if (this.pendingChanges.size === 0) return;

    const changes = Array.from(this.pendingChanges.values());
    this._changeCount += changes.length;
    this.pendingChanges.clear();

    log.info("watcher", `Detected ${changes.length} file change(s)`);

    if (this.callback) {
      try {
        this.callback(changes);
      } catch (err) {
        log.error("watcher", `Callback error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      log.info("watcher", "File watcher stopped");
    }
  }

  /**
   * Number of changes detected since start.
   */
  get changeCount(): number {
    return this._changeCount;
  }

  /**
   * Whether the watcher is currently active.
   */
  get isWatching(): boolean {
    return this.watcher !== null;
  }
}

// ─── Safety ────────────────────────────────────────────────────

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Makefile",
  "CMakeLists.txt",
  "tsconfig.json",
  "pom.xml",
  "build.gradle",
  ".kcode",
  "KCODE.md",
  "CLAUDE.md",
];

/** Check if a directory looks like a project root (not home/root/random dir). */
function isProjectDirectory(dir: string): boolean {
  const home = homedir();
  const normalized = dir.endsWith("/") && dir.length > 1 ? dir.slice(0, -1) : dir;
  // Never watch home directory itself or root
  if (normalized === home || normalized === "/" || normalized === "/tmp") return false;

  // Check for at least one project marker
  return PROJECT_MARKERS.some((marker) => {
    try {
      return existsSync(`${normalized}/${marker}`);
    } catch {
      return false;
    }
  });
}

// ─── File Change Suggester ───────────────────────────────────────

const SUGGEST_DEBOUNCE_MS = 500;

const CONFIG_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "tsconfig.json",
  "webpack.config.js",
  "webpack.config.ts",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "rollup.config.js",
  "rollup.config.ts",
]);

export type SuggestionCallback = (suggestions: string[]) => void;

/**
 * Accumulates file change events and generates intelligent suggestions
 * based on change patterns (test files, config changes, bulk edits, etc.).
 */
export class FileChangeSuggester {
  private pending: FileChangeEvent[] = [];
  private suggestions: string[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  onSuggestion: SuggestionCallback | null = null;

  /**
   * Feed a batch of file change events into the suggester.
   * Suggestions are generated after a 500ms debounce window.
   */
  addChanges(changes: FileChangeEvent[]): void {
    this.pending.push(...changes);
    // Cap pending to prevent unbounded memory growth
    if (this.pending.length > 500) {
      this.pending = this.pending.slice(-500);
    }

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.process(), SUGGEST_DEBOUNCE_MS);
  }

  /**
   * Returns pending suggestions and clears them.
   */
  getSuggestions(): string[] {
    const result = [...this.suggestions];
    this.suggestions = [];
    return result;
  }

  /**
   * Whether there are pending suggestions ready to be consumed.
   */
  get hasSuggestions(): boolean {
    return this.suggestions.length > 0;
  }

  private process(): void {
    if (this.pending.length === 0) return;

    const events = this.pending.splice(0);
    const newSuggestions: string[] = [];
    const seen = new Set<string>();

    const add = (s: string): void => {
      if (!seen.has(s)) {
        seen.add(s);
        newSuggestions.push(s);
      }
    };

    // Group changes by directory
    const dirChanges = new Map<string, FileChangeEvent[]>();
    for (const ev of events) {
      const lastSlash = ev.path.lastIndexOf("/");
      const dir = lastSlash > 0 ? ev.path.slice(0, lastSlash) : ".";
      const group = dirChanges.get(dir) ?? [];
      group.push(ev);
      dirChanges.set(dir, group);
    }

    for (const ev of events) {
      const name = ev.path.split("/").pop() ?? ev.path;
      const ext = extname(name);

      // Test file modified → suggest running tests
      if (name.includes(".test.") || name.includes(".spec.") || name.includes("_test.")) {
        add(`Run tests? (${ev.path})`);
        continue;
      }

      // package.json / lockfile modified → suggest install
      if (name === "package.json" || name === "package-lock.json" || name === "bun.lockb") {
        add("Run npm/bun install? (package.json changed)");
        continue;
      }

      // .env or config file → suggest restart
      if (CONFIG_FILES.has(name) || name.startsWith(".env")) {
        add(`Restart server? (${name} changed)`);
        continue;
      }

      // New file created
      if (ev.type === "create") {
        add(`New file: ${ev.path} — add to index?`);
        continue;
      }

      // File deleted
      if (ev.type === "delete") {
        add(`File deleted: ${ev.path} — update imports?`);
      }
    }

    // Multiple source files in same directory → bulk change suggestion
    for (const [dir, group] of dirChanges) {
      const sourceFiles = group.filter((e) => {
        const n = e.path.split("/").pop() ?? "";
        return (
          !n.includes(".test.") &&
          !n.includes(".spec.") &&
          !CONFIG_FILES.has(n) &&
          n !== "package.json"
        );
      });
      if (sourceFiles.length >= 2) {
        add(`${sourceFiles.length} files changed in ${dir}/ — review changes?`);
      }
    }

    if (newSuggestions.length > 0) {
      this.suggestions.push(...newSuggestions);
      // Cap the suggestions buffer. Without this, if nothing ever
      // drains via getSuggestions (e.g. the callback is broken or
      // the UI stops consuming them), the array grows unbounded
      // under high-churn scenarios like node_modules reinstalls.
      // v2.10.82 audit flagged this as a memory-pressure risk —
      // keeping the most recent 200 is more than the UI can show
      // anyway.
      if (this.suggestions.length > 200) {
        this.suggestions = this.suggestions.slice(-200);
      }
      if (this.onSuggestion) {
        try {
          this.onSuggestion(newSuggestions);
        } catch {
          // Don't let callback errors break the suggester
        }
      }
    }
  }

  /**
   * Clear all pending events and suggestions.
   */
  clear(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pending = [];
    this.suggestions = [];
  }
}

// ─── Singletons ─────────────────────────────────────────────────

let _watcher: FileWatcher | null = null;

export function getFileWatcher(cwd: string): FileWatcher {
  if (!_watcher || (_watcher as unknown as { cwd: string }).cwd !== cwd) {
    _watcher?.stop();
    _watcher = new FileWatcher(cwd);
  }
  return _watcher;
}

let _suggester: FileChangeSuggester | null = null;

/**
 * Returns a singleton FileChangeSuggester.
 * Automatically wires itself to the FileWatcher for the given cwd.
 */
export function getFileChangeSuggester(cwd: string): FileChangeSuggester {
  if (!_suggester) {
    _suggester = new FileChangeSuggester();
  }

  // Always wire to the current watcher (handles cwd changes)
  const watcher = getFileWatcher(cwd);
  if (!(watcher as FileWatcher & { _suggesterWired?: boolean })._suggesterWired) {
    const originalStart = watcher.start.bind(watcher);
    watcher.start = (callback: FileChangeCallback) => {
      originalStart((changes) => {
        _suggester!.addChanges(changes);
        callback(changes);
      });
    };
    (watcher as FileWatcher & { _suggesterWired?: boolean })._suggesterWired = true;
  }
  return _suggester;
}
