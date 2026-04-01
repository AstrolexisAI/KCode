// KCode - SHA Sentinel Tracker
// Tracks SHA256 hashes for cached plugin downloads to avoid redundant re-downloads.
// Sentinel files stored at: ~/.kcode/plugins/marketplace-cache/{name}/.sha256

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SHASentinel } from "./types";

export class SHATracker {
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  /**
   * Read the stored SHA sentinel for a plugin.
   * Returns null if no sentinel exists or if it's malformed.
   */
  getStoredSHA(pluginName: string): SHASentinel | null {
    const sentinelPath = this.sentinelPath(pluginName);
    if (!existsSync(sentinelPath)) return null;

    try {
      const content = readFileSync(sentinelPath, "utf-8").trim();
      const lines = content.split("\n");
      if (lines.length < 3) return null;

      const sha256 = lines[0]!.trim();
      const version = lines[1]!.trim();
      const timestamp = parseInt(lines[2]!.trim(), 10);

      if (!sha256 || !version || isNaN(timestamp)) return null;

      return { sha256, version, timestamp };
    } catch {
      return null;
    }
  }

  /**
   * Save a SHA sentinel after a successful download.
   */
  setSHA(pluginName: string, sha256: string, version: string): void {
    const sentinelPath = this.sentinelPath(pluginName);
    const dir = dirname(sentinelPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const content = `${sha256}\n${version}\n${Date.now()}`;
    writeFileSync(sentinelPath, content, "utf-8");
  }

  /**
   * Check if a plugin needs an update by comparing remote SHA with stored SHA.
   */
  needsUpdate(pluginName: string, remoteSHA: string): boolean {
    const stored = this.getStoredSHA(pluginName);
    if (!stored) return true;
    return stored.sha256 !== remoteSHA;
  }

  /**
   * Invalidate the cache for a plugin, forcing re-download on next fetch.
   */
  invalidate(pluginName: string): void {
    const sentinelPath = this.sentinelPath(pluginName);
    if (existsSync(sentinelPath)) {
      try {
        unlinkSync(sentinelPath);
      } catch {
        // Best effort
      }
    }
  }

  /**
   * Get the path to the sentinel file for a given plugin.
   */
  private sentinelPath(pluginName: string): string {
    return join(this.cacheDir, pluginName, ".sha256");
  }
}
