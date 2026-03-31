// KCode - CDN Fetcher
// Atomic download of plugin tarballs from CDN with integrity verification.
// Flow: download -> verify SHA -> extract -> validate manifest -> atomic swap

import { existsSync, mkdirSync, rmSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger";
import { SHATracker } from "./sha-tracker";
import { verifyPlugin } from "./verifier";
import type { CDNFetcherConfig, FetchResult } from "./types";

const DEFAULT_CONFIG: CDNFetcherConfig = {
  cdnBaseUrl: "https://cdn.kulvex.ai/plugins",
  cacheDir: "",  // Must be set by caller
  timeoutMs: 30_000,
};

export class CDNFetcher {
  private config: CDNFetcherConfig;
  private shaTracker: SHATracker;

  constructor(config: Partial<CDNFetcherConfig> & { cacheDir: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.shaTracker = new SHATracker(this.config.cacheDir);
  }

  /**
   * Fetch a plugin from the CDN.
   * Returns the path to the installed plugin directory.
   *
   * Steps:
   * 1. Check SHA sentinel — skip download if current
   * 2. Download tarball to temp directory
   * 3. Verify integrity (SHA256)
   * 4. Extract tarball
   * 5. Validate manifest
   * 6. Atomic swap (rename)
   * 7. Write SHA sentinel
   */
  async fetchPlugin(pluginName: string, version?: string): Promise<FetchResult> {
    const pluginCacheDir = join(this.config.cacheDir, pluginName);
    const currentDir = join(pluginCacheDir, "current");
    const downloadTmpDir = join(pluginCacheDir, ".download-tmp");
    const extractTmpDir = join(pluginCacheDir, ".extract-tmp");
    const prevDir = join(pluginCacheDir, ".prev");

    // [1] Check SHA sentinel
    const sentinel = this.shaTracker.getStoredSHA(pluginName);
    if (sentinel && version && sentinel.version === version) {
      if (existsSync(currentDir)) {
        return {
          pluginDir: currentDir,
          version: sentinel.version,
          sha256: sentinel.sha256,
          fromCache: true,
        };
      }
    }

    // Ensure directories exist
    mkdirSync(pluginCacheDir, { recursive: true });

    try {
      // [2] Download tarball
      this.cleanDir(downloadTmpDir);
      mkdirSync(downloadTmpDir, { recursive: true });

      const tarballUrl = `${this.config.cdnBaseUrl}/${pluginName}/${version || "latest"}.tar.gz`;
      const tarballPath = join(downloadTmpDir, "plugin.tar.gz");

      const response = await fetch(tarballUrl, {
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`CDN download failed: HTTP ${response.status} for ${tarballUrl}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(tarballPath, buffer);

      // [3] Verify integrity
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(buffer);
      const computedSHA = hasher.digest("hex");

      const expectedSHA = response.headers.get("x-content-sha256");
      if (expectedSHA && computedSHA !== expectedSHA) {
        throw new IntegrityError(
          `SHA256 mismatch for ${pluginName}: expected ${expectedSHA}, got ${computedSHA}`
        );
      }

      // [4] Extract tarball
      this.cleanDir(extractTmpDir);
      mkdirSync(extractTmpDir, { recursive: true });

      const proc = Bun.spawnSync(["tar", "xzf", tarballPath, "-C", extractTmpDir]);
      if (proc.exitCode !== 0) {
        throw new Error(`Failed to extract tarball: ${proc.stderr.toString()}`);
      }

      // [5] Validate manifest
      const verification = verifyPlugin(extractTmpDir);
      if (!verification.valid) {
        const errors = verification.issues
          .filter(i => i.severity === "error")
          .map(i => i.message)
          .join("; ");
        throw new Error(`Plugin verification failed: ${errors}`);
      }

      // Read version from extracted manifest
      const manifestPath = join(extractTmpDir, "plugin.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const resolvedVersion = manifest.version ?? version ?? "unknown";

      // Verify name matches
      if (manifest.name && manifest.name !== pluginName) {
        throw new Error(
          `Plugin name mismatch: expected "${pluginName}", manifest says "${manifest.name}"`
        );
      }

      // [6] Atomic swap
      if (existsSync(currentDir)) {
        this.cleanDir(prevDir);
        renameSync(currentDir, prevDir);
      }

      renameSync(extractTmpDir, currentDir);

      // [7] Write SHA sentinel and clean up
      this.shaTracker.setSHA(pluginName, computedSHA, resolvedVersion);
      this.cleanDir(downloadTmpDir);
      this.cleanDir(prevDir);

      log.info("marketplace", `Fetched plugin: ${pluginName} v${resolvedVersion} from CDN`);

      return {
        pluginDir: currentDir,
        version: resolvedVersion,
        sha256: computedSHA,
        fromCache: false,
      };
    } catch (err) {
      // Graceful fallback: if we have a previous version, keep it
      if (existsSync(prevDir) && !existsSync(currentDir)) {
        try {
          renameSync(prevDir, currentDir);
          log.warn("marketplace", `Download of ${pluginName} failed, rolled back to previous version`);
        } catch {
          // Best effort rollback
        }
      }

      // Clean up temp dirs
      this.cleanDir(downloadTmpDir);
      this.cleanDir(extractTmpDir);

      throw err;
    }
  }

  /**
   * Get the SHA tracker for external access.
   */
  getSHATracker(): SHATracker {
    return this.shaTracker;
  }

  /**
   * Safely remove a directory if it exists.
   */
  private cleanDir(dir: string): void {
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort
      }
    }
  }
}

/**
 * Error thrown when SHA256 integrity check fails.
 */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}
