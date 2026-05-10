// KCode - RAG Auto-Indexing
// Connects the file watcher to the RAG engine for incremental re-indexing.
// Debounces changes and indexes in background during idle.

import type { FileChangeEvent } from "../file-watcher";
import { log } from "../logger";

// ─── Types ──────────────────────────────────────────────────────

export interface AutoIndexConfig {
  /** Debounce delay before triggering re-index (ms). Default: 5000 */
  debounceMs: number;
  /** Maximum files to re-index per batch. Default: 50 */
  maxFilesPerBatch: number;
  /** Whether auto-indexing is enabled. Default: true */
  enabled: boolean;
}

const DEFAULT_CONFIG: AutoIndexConfig = {
  debounceMs: 5000,
  maxFilesPerBatch: 50,
  enabled: true,
};

// ─── Auto-Indexer ──────────────────────────────────────────────

export class RagAutoIndexer {
  private config: AutoIndexConfig;
  private projectDir: string;
  private pendingFiles = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private indexing = false;
  private totalReindexed = 0;

  constructor(projectDir: string, config?: Partial<AutoIndexConfig>) {
    this.projectDir = projectDir;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Handle file change events from the file watcher */
  onFileChanges(changes: FileChangeEvent[]): void {
    if (!this.config.enabled) return;

    for (const change of changes) {
      this.pendingFiles.add(change.path);
    }

    // Debounce: wait for changes to settle before indexing
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.triggerReindex(), this.config.debounceMs);
  }

  /**
   * Run a one-shot initial index of the project. Idempotent — relies on
   * the engine's checksum-based incremental update so already-indexed
   * files are skipped. Safe to call on every TUI startup.
   *
   * Returns the number of files actually re-indexed (not the project
   * total). Returns 0 if disabled, already running, or the project
   * looks too large to risk a foreground delay.
   */
  async kickoffInitialIndex(): Promise<number> {
    if (!this.config.enabled || this.indexing) return 0;
    this.indexing = true;
    try {
      const { getRAGEngine } = await import("./engine");
      const engine = getRAGEngine(this.projectDir);
      const start = Date.now();
      const report = await engine.updateIndex(this.projectDir);
      this.totalReindexed += report.filesProcessed;
      const elapsed = Date.now() - start;
      if (report.filesProcessed > 0) {
        log.info(
          "rag",
          `Initial index: ${report.filesProcessed} files, ${report.chunksCreated} chunks in ${elapsed}ms`,
        );
      } else {
        log.debug("rag", `Initial index: project up-to-date (${elapsed}ms)`);
      }
      return report.filesProcessed;
    } catch (err) {
      log.debug("rag", `Initial index failed (non-fatal): ${err}`);
      return 0;
    } finally {
      this.indexing = false;
    }
  }

  /** Manually trigger a re-index of pending files */
  async triggerReindex(): Promise<number> {
    if (this.indexing || this.pendingFiles.size === 0) return 0;
    this.indexing = true;

    const filesToIndex = [...this.pendingFiles].slice(0, this.config.maxFilesPerBatch);
    this.pendingFiles.clear();

    try {
      const { getRAGEngine } = await import("./engine");
      const engine = getRAGEngine(this.projectDir);
      const report = await engine.updateIndex(this.projectDir);

      this.totalReindexed += report.filesProcessed;
      log.info(
        "rag",
        `Auto-indexed ${report.filesProcessed} files (${report.chunksCreated} chunks) in ${report.durationMs}ms`,
      );

      return report.filesProcessed;
    } catch (err) {
      log.debug("rag", `Auto-index failed: ${err}`);
      return 0;
    } finally {
      this.indexing = false;

      // If more changes arrived while indexing, schedule another run
      if (this.pendingFiles.size > 0) {
        this.debounceTimer = setTimeout(() => this.triggerReindex(), this.config.debounceMs);
      }
    }
  }

  /** Get stats */
  getStats(): { pendingFiles: number; totalReindexed: number; isIndexing: boolean } {
    return {
      pendingFiles: this.pendingFiles.size,
      totalReindexed: this.totalReindexed,
      isIndexing: this.indexing,
    };
  }

  /** Stop auto-indexing and clear pending */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingFiles.clear();
    this.config.enabled = false;
  }

  /** Enable auto-indexing */
  enable(): void {
    this.config.enabled = true;
  }
}

// ─── Singleton ─────────────────────────────────────────────────

let _autoIndexer: RagAutoIndexer | null = null;

export function getRagAutoIndexer(
  projectDir: string,
  config?: Partial<AutoIndexConfig>,
): RagAutoIndexer {
  if (!_autoIndexer || _autoIndexer["projectDir"] !== projectDir) {
    _autoIndexer = new RagAutoIndexer(projectDir, config);
  }
  return _autoIndexer;
}

export function _resetRagAutoIndexer(): void {
  _autoIndexer?.stop();
  _autoIndexer = null;
}
