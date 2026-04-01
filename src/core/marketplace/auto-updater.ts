// KCode - Plugin Auto-Updater
// Checks for plugin updates on startup (respecting a configurable interval),
// fetches new versions via CDN, and reports results.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../logger";
import { CDNFetcher } from "./cdn-fetcher";
import type { AutoUpdateConfig, CatalogEntry, UpdateReport } from "./types";

const DEFAULT_CONFIG: AutoUpdateConfig = {
  enabled: true,
  checkIntervalMs: 86_400_000, // 24 hours
  marketplaces: ["official"],
};

/**
 * Run auto-update for installed marketplace plugins.
 *
 * Steps:
 * 1. Check if enough time has elapsed since the last check
 * 2. For each marketplace, fetch the catalog (list of plugins + versions)
 * 3. Compare installed versions with remote versions
 * 4. Download updated plugins via CDN fetcher
 * 5. Record timestamp of last check
 */
export async function autoUpdatePlugins(
  config: Partial<AutoUpdateConfig>,
  cacheDir: string,
  installedPlugins: Array<{ name: string; version: string; marketplace?: string }>,
  options?: {
    fetchCatalog?: (marketplaceUrl: string) => Promise<CatalogEntry[]>;
    cdnFetcher?: CDNFetcher;
  },
): Promise<UpdateReport> {
  const cfg: AutoUpdateConfig = { ...DEFAULT_CONFIG, ...config };
  const report: UpdateReport = { skipped: false, updated: [], failed: [] };

  if (!cfg.enabled) {
    report.skipped = true;
    return report;
  }

  // [1] Check interval
  const lastCheck = readLastCheckTimestamp(cacheDir);
  if (Date.now() - lastCheck < cfg.checkIntervalMs) {
    report.skipped = true;
    return report;
  }

  const fetcher = options?.cdnFetcher ?? new CDNFetcher({ cacheDir });
  const fetchCatalogFn = options?.fetchCatalog ?? fetchCatalogFromMarketplace;

  // [2] For each marketplace, check for updates
  for (const marketplace of cfg.marketplaces) {
    let catalog: CatalogEntry[];
    try {
      catalog = await fetchCatalogFn(marketplace);
    } catch (err) {
      log.warn(
        "marketplace",
        `Failed to fetch catalog from ${marketplace}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    // [2b] Filter installed plugins from this marketplace
    const matchingPlugins = installedPlugins.filter(
      (p) => !p.marketplace || p.marketplace === marketplace,
    );

    for (const installed of matchingPlugins) {
      const remote = catalog.find((c) => c.name === installed.name);
      if (!remote) continue;

      // [2c] Compare versions using semver-like comparison
      if (!isNewerVersion(remote.version, installed.version)) continue;

      // [2d] Download new version
      try {
        await fetcher.fetchPlugin(installed.name, remote.version);
        report.updated.push({
          name: installed.name,
          from: installed.version,
          to: remote.version,
        });
        log.info(
          "marketplace",
          `Auto-updated ${installed.name}: ${installed.version} -> ${remote.version}`,
        );
      } catch (err) {
        report.failed.push({
          name: installed.name,
          error: err instanceof Error ? err.message : String(err),
        });
        log.warn(
          "marketplace",
          `Auto-update failed for ${installed.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // [3] Save timestamp
  writeLastCheckTimestamp(cacheDir, Date.now());

  return report;
}

// ─── Timestamp Persistence ────────────────────────────────────

function timestampPath(cacheDir: string): string {
  return join(cacheDir, ".last-update-check");
}

export function readLastCheckTimestamp(cacheDir: string): number {
  try {
    const path = timestampPath(cacheDir);
    if (!existsSync(path)) return 0;
    const content = readFileSync(path, "utf-8").trim();
    const ts = parseInt(content, 10);
    return isNaN(ts) ? 0 : ts;
  } catch {
    return 0;
  }
}

export function writeLastCheckTimestamp(cacheDir: string, timestamp: number): void {
  try {
    const path = timestampPath(cacheDir);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, String(timestamp), "utf-8");
  } catch {
    // Best effort
  }
}

// ─── Version Comparison ────────────────────────────────────────

/**
 * Simple semver comparison: returns true if `remote` is newer than `local`.
 * Supports versions like "1.2.3", "0.9.0", etc.
 */
export function isNewerVersion(remote: string, local: string): boolean {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  if (!r || !l) return remote !== local;

  if (r.major !== l.major) return r.major > l.major;
  if (r.minor !== l.minor) return r.minor > l.minor;
  return r.patch > l.patch;
}

function parseVersion(v: string): { major: number; minor: number; patch: number } | null {
  // Strip leading 'v' if present
  const clean = v.replace(/^v/, "");
  const parts = clean.split(".");
  if (parts.length < 2) return null;

  const major = parseInt(parts[0]!, 10);
  const minor = parseInt(parts[1]!, 10);
  const patch = parts[2] ? parseInt(parts[2], 10) : 0;

  if (isNaN(major) || isNaN(minor) || isNaN(patch)) return null;
  return { major, minor, patch };
}

// ─── Catalog Fetching ──────────────────────────────────────────

/**
 * Fetch the plugin catalog from a marketplace.
 * Default implementation tries to fetch from the standard API endpoint.
 */
async function fetchCatalogFromMarketplace(marketplace: string): Promise<CatalogEntry[]> {
  const url = marketplace.startsWith("http")
    ? marketplace
    : `https://plugins.kulvex.ai/api/v1/${marketplace}/catalog`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as CatalogEntry[];
}
