// KCode - Cache Warmer
// Pre-caches resources while network is available so they can be used offline.
// Runs in background at startup when online. Caches: plugin manifests, docs,
// recent search results, and local model metadata.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger";
import type { CacheWarmerConfig, WarmupReport } from "./types";

// ─── Paths ─────────────────────────────────────────────────────

function cacheDirs() {
  const base = join(homedir(), ".kcode", "cache");
  return {
    base,
    docs: join(base, "docs"),
    plugins: join(homedir(), ".kcode", "plugins", "marketplace-cache"),
    models: join(base, "models"),
    search: join(base, "search"),
    fetch: join(base, "fetch"),
  };
}

function ensureDirs(dirs: ReturnType<typeof cacheDirs>): void {
  for (const dir of Object.values(dirs)) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// ─── CacheWarmer ───────────────────────────────────────────────

export class CacheWarmer {
  private config: Required<CacheWarmerConfig>;
  private dirs: ReturnType<typeof cacheDirs>;

  constructor(config?: CacheWarmerConfig) {
    this.config = {
      enabled: config?.enabled ?? true,
      maxCacheSizeMb: config?.maxCacheSizeMb ?? 500,
      warmupOnStartup: config?.warmupOnStartup ?? true,
    };
    this.dirs = cacheDirs();
  }

  /** Run all warmup tasks. Returns a report of what was cached. */
  async warmup(): Promise<WarmupReport> {
    const report: WarmupReport = { cached: [], errors: [], totalSizeMb: 0 };

    if (!this.config.enabled) {
      return report;
    }

    ensureDirs(this.dirs);

    // Run cache tasks — each is independent and non-fatal
    await this.cacheModelMetadata(report);
    await this.cachePluginManifests(report);

    report.totalSizeMb = this.computeCacheSizeMb();
    log.info("cache-warmer", `Warmup complete: ${report.cached.length} items cached, ${report.errors.length} errors, ${report.totalSizeMb.toFixed(1)} MB total`);
    return report;
  }

  /** Cache metadata about locally available models (Ollama, llama.cpp) */
  private async cacheModelMetadata(report: WarmupReport): Promise<void> {
    const endpoints = [
      { name: "ollama", url: "http://localhost:11434/api/tags" },
      { name: "llama-cpp", url: "http://localhost:10091/v1/models" },
    ];

    for (const ep of endpoints) {
      try {
        const resp = await fetch(ep.url, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const data = await resp.text();
          const outPath = join(this.dirs.models, `${ep.name}.json`);
          await Bun.write(outPath, data);
          report.cached.push(`models/${ep.name}.json`);
        }
      } catch (err) {
        // Not an error — the server may simply not be running
        log.debug("cache-warmer", `Model metadata ${ep.name}: ${err}`);
      }
    }
  }

  /** Cache the marketplace plugin catalog for offline browsing */
  private async cachePluginManifests(report: WarmupReport): Promise<void> {
    try {
      const registryUrl = "https://plugins.kulvex.ai/api/v1/plugins";
      const resp = await fetch(registryUrl, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.text();
        const outPath = join(this.dirs.plugins, "catalog.json");
        if (!existsSync(this.dirs.plugins)) mkdirSync(this.dirs.plugins, { recursive: true });
        await Bun.write(outPath, data);
        report.cached.push("plugins/catalog.json");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`plugin manifests: ${msg}`);
      log.debug("cache-warmer", `Plugin manifest cache failed: ${msg}`);
    }
  }

  /** Compute total size of the cache directory in MB */
  private computeCacheSizeMb(): number {
    try {
      return dirSizeMb(this.dirs.base);
    } catch {
      return 0;
    }
  }

  /** Whether this warmer is enabled */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Whether warmup should run at startup */
  shouldWarmOnStartup(): boolean {
    return this.config.enabled && this.config.warmupOnStartup;
  }

  /** Get the cache directories for external inspection */
  getCacheDirs(): Readonly<ReturnType<typeof cacheDirs>> {
    return this.dirs;
  }
}

// ─── Helpers ───────────────────────────────────────────────────

/** Recursively compute directory size in MB */
function dirSizeMb(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += dirSizeMb(fullPath);
      } else {
        try {
          total += statSync(fullPath).size;
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* dir may not exist or not be readable */ }
  return total / (1024 * 1024);
}
