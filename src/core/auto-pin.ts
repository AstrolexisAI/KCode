// KCode - Intelligent Auto-Pin
// Automatically pins files to context based on access frequency,
// recent edits, and git commit references. Auto-unpins when context pressure is high.

import { existsSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import { listPinnedFiles, pinFile, unpinFile } from "./context-pin";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface AutoPinConfig {
  /** Enable auto-pinning. Default: true */
  enabled: boolean;
  /** Minimum access count before auto-pinning. Default: 3 */
  minAccessCount: number;
  /** Max auto-pinned files (within the overall 10-file limit). Default: 5 */
  maxAutoPinned: number;
  /** Auto-unpin threshold (context usage percentage). Default: 0.80 */
  unpinThreshold: number;
  /** Time window for access tracking (ms). Default: 10 minutes */
  windowMs: number;
}

interface FileAccessRecord {
  path: string;
  accessCount: number;
  lastAccess: number;
  wasEdited: boolean;
}

const DEFAULT_CONFIG: AutoPinConfig = {
  enabled: true,
  minAccessCount: 3,
  maxAutoPinned: 5,
  unpinThreshold: 0.8,
  windowMs: 10 * 60 * 1000, // 10 minutes
};

// ─── Auto-Pin Manager ──────────────────────────────────────────

export class AutoPinManager {
  private config: AutoPinConfig;
  private cwd: string;
  private accessLog = new Map<string, FileAccessRecord>();
  private autoPinnedFiles = new Set<string>();

  constructor(cwd: string, config?: Partial<AutoPinConfig>) {
    this.cwd = cwd;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Record a file access (from Read, Edit, or other tool use) */
  recordAccess(filePath: string, wasEdited: boolean = false): void {
    if (!this.config.enabled) return;

    const existing = this.accessLog.get(filePath);
    if (existing) {
      existing.accessCount++;
      existing.lastAccess = Date.now();
      if (wasEdited) existing.wasEdited = true;
    } else {
      this.accessLog.set(filePath, {
        path: filePath,
        accessCount: 1,
        lastAccess: Date.now(),
        wasEdited,
      });
    }

    // Check if file should be auto-pinned
    this.evaluateAutoPin(filePath);
  }

  /** Record files from the latest git commit as recently relevant */
  recordCommitFiles(filePaths: string[]): void {
    for (const path of filePaths) {
      this.recordAccess(path, true);
    }
  }

  /**
   * Auto-unpin files if context usage exceeds threshold.
   * Call this before building the system prompt.
   * Returns list of unpinned file paths.
   */
  autoUnpinIfNeeded(contextUsageRatio: number): string[] {
    if (contextUsageRatio < this.config.unpinThreshold) return [];

    const unpinned: string[] = [];

    // Only auto-unpin files that were auto-pinned (not manually pinned)
    const autoPinned = [...this.autoPinnedFiles];
    // Sort by access count ascending (least accessed first)
    autoPinned.sort((a, b) => {
      const aRecord = this.accessLog.get(a);
      const bRecord = this.accessLog.get(b);
      return (aRecord?.accessCount ?? 0) - (bRecord?.accessCount ?? 0);
    });

    // Unpin until we're under pressure
    for (const path of autoPinned) {
      if (contextUsageRatio < this.config.unpinThreshold) break;
      const result = unpinFile(path, this.cwd);
      if (result.success) {
        this.autoPinnedFiles.delete(path);
        unpinned.push(path);
        log.info("auto-pin", `Auto-unpinned: ${relative(this.cwd, path)} (context pressure)`);
        // Rough estimate: each file reduces context by ~2%
        contextUsageRatio -= 0.02;
      }
    }

    return unpinned;
  }

  /** Get candidates ranked by relevance (for /autopin suggestions) */
  getCandidates(): Array<{ path: string; score: number; reason: string }> {
    const now = Date.now();
    const candidates: Array<{ path: string; score: number; reason: string }> = [];

    for (const [path, record] of this.accessLog) {
      // Skip files outside the time window
      if (now - record.lastAccess > this.config.windowMs) continue;
      // Skip already pinned files
      if (this.autoPinnedFiles.has(path)) continue;

      let score = record.accessCount;
      const reasons: string[] = [];

      if (record.wasEdited) {
        score *= 2;
        reasons.push("recently edited");
      }

      // Recency bonus
      const recencyMinutes = (now - record.lastAccess) / 60_000;
      if (recencyMinutes < 2) {
        score *= 1.5;
        reasons.push("accessed just now");
      }

      reasons.push(`${record.accessCount} accesses`);

      candidates.push({
        path,
        score,
        reason: reasons.join(", "),
      });
    }

    return candidates.sort((a, b) => b.score - a.score);
  }

  /** Get stats */
  getStats(): {
    trackedFiles: number;
    autoPinnedCount: number;
    topCandidates: Array<{ path: string; score: number }>;
  } {
    const candidates = this.getCandidates().slice(0, 5);
    return {
      trackedFiles: this.accessLog.size,
      autoPinnedCount: this.autoPinnedFiles.size,
      topCandidates: candidates.map(({ path, score }) => ({ path, score })),
    };
  }

  /** Clean up old entries outside the time window */
  cleanup(): void {
    const now = Date.now();
    for (const [path, record] of this.accessLog) {
      if (now - record.lastAccess > this.config.windowMs * 2) {
        this.accessLog.delete(path);
      }
    }
  }

  // ─── Internal ────────────────────────────────────────────────

  private evaluateAutoPin(filePath: string): void {
    const record = this.accessLog.get(filePath);
    if (!record) return;

    // Check if meets threshold
    if (record.accessCount < this.config.minAccessCount) return;

    // Check limits
    if (this.autoPinnedFiles.size >= this.config.maxAutoPinned) return;
    const currentPinned = listPinnedFiles();
    if (currentPinned.length >= 10) return; // Global limit

    // Check file exists and is small enough
    if (!existsSync(filePath)) return;
    try {
      const stat = statSync(filePath);
      if (stat.size > 8000) return; // Too large
    } catch {
      return;
    }

    // Auto-pin
    const result = pinFile(filePath, this.cwd);
    if (result.success) {
      this.autoPinnedFiles.add(filePath);
      log.info(
        "auto-pin",
        `Auto-pinned: ${relative(this.cwd, filePath)} (${record.accessCount} accesses)`,
      );
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────

let _manager: AutoPinManager | null = null;

export function getAutoPinManager(cwd: string, config?: Partial<AutoPinConfig>): AutoPinManager {
  if (!_manager || _manager["cwd"] !== cwd) {
    _manager = new AutoPinManager(cwd, config);
  }
  return _manager;
}

export function _resetAutoPinManager(): void {
  _manager = null;
}
