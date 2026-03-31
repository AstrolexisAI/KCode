// KCode - Marketplace Types
// Shared interfaces for the plugin marketplace CDN system

// ─── CDN Fetcher ───────────────────────────────────────────────

export interface CDNFetcherConfig {
  /** URL base del CDN (default: cdn.kulvex.ai/plugins) */
  cdnBaseUrl: string;
  /** Directorio local de cache */
  cacheDir: string;
  /** Timeout de descarga en ms */
  timeoutMs: number;
}

export interface FetchResult {
  /** Path al plugin descargado */
  pluginDir: string;
  /** Version descargada */
  version: string;
  /** SHA256 hash del contenido */
  sha256: string;
  /** Si se uso cache (no se descargo) */
  fromCache: boolean;
}

// ─── SHA Tracker ───────────────────────────────────────────────

export interface SHASentinel {
  sha256: string;
  version: string;
  timestamp: number;
}

// ─── Verifier ──────────────────────────────────────────────────

export interface VerificationResult {
  valid: boolean;
  issues: VerificationIssue[];
}

export interface VerificationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

// ─── Auto-Updater ──────────────────────────────────────────────

export interface AutoUpdateConfig {
  /** Activate auto-update (default: true) */
  enabled: boolean;
  /** Minimum interval between checks in ms (default: 86400000 = 24h) */
  checkIntervalMs: number;
  /** Marketplace sources to check */
  marketplaces: string[];
}

export interface UpdateReport {
  /** Whether the update was skipped (too recent) */
  skipped: boolean;
  /** List of plugins that were updated */
  updated: UpdatedPlugin[];
  /** List of plugins that failed to update */
  failed: FailedUpdate[];
}

export interface UpdatedPlugin {
  name: string;
  from: string;
  to: string;
}

export interface FailedUpdate {
  name: string;
  error: string;
}

// ─── Output Style Plugin ───────────────────────────────────────

export interface PluginOutputStyle {
  /** Fully qualified name: pluginName:styleName */
  name: string;
  /** Description for the user */
  description: string;
  /** Instructions injected into the system prompt */
  instructions: string;
  /** Order of application (lower = higher priority, default: 100) */
  priority: number;
}

// ─── Marketplace Source Config ──────────────────────────────────

export interface MarketplaceSource {
  name: string;
  type: "cdn" | "git";
  url: string;
  autoUpdate: boolean;
  checkIntervalMs?: number;
}

export interface MarketplaceSettings {
  sources: MarketplaceSource[];
  allowedPlugins: string[];
  blockedPlugins: string[];
  verifyIntegrity: boolean;
}

// ─── Plugin Manifest Extended Fields ───────────────────────────

export interface ExtendedManifestFields {
  /** Agent definition files */
  agents?: string[];
  /** Output style definition files */
  outputStyles?: string[];
  /** Source marketplace identifier */
  marketplace?: string;
  /** Content SHA256 hash */
  sha256?: string;
  /** Whether the plugin passed marketplace verification */
  verified?: boolean;
  /** Download count from marketplace */
  downloads?: number;
  /** User rating from marketplace */
  rating?: number;
  /** Minimum KCode version required */
  kcode?: string;
  /** License identifier */
  license?: string;
}

// ─── Catalog (remote marketplace index) ─────────────────────────

export interface CatalogEntry {
  name: string;
  version: string;
  sha256: string;
  description?: string;
  verified?: boolean;
}
