// KCode - Offline Mode Types
// Shared types for the offline subsystem

/** State tracked by the OfflineMode controller */
export interface OfflineState {
  /** true = offline mode forced by user (--offline flag or settings) */
  forced: boolean;
  /** true = no network detected automatically */
  detected: boolean;
  /** true = either forced or detected (convenience flag) */
  active: boolean;
  /** Timestamp of last network connectivity check (ms since epoch) */
  lastNetworkCheck: number;
  /** Inventory of locally available resources */
  localResources: LocalResources;
}

export interface LocalResources {
  hasLocalModel: boolean;
  hasLocalWhisper: boolean;
  hasPluginCache: boolean;
  hasCachedDocs: boolean;
}

/** Configuration for offline behaviour (stored in settings.json under "offline") */
export interface OfflineSettings {
  enabled?: boolean;
  autoDetect?: boolean;
  cacheWarmer?: CacheWarmerConfig;
  localSearch?: LocalSearchSettings;
}

export interface CacheWarmerConfig {
  enabled?: boolean;
  maxCacheSizeMb?: number;
  warmupOnStartup?: boolean;
}

export interface LocalSearchSettings {
  enabled?: boolean;
  sources?: LocalSearchSource[];
}

export type LocalSearchSource = "cache" | "docs" | "learnings" | "codebase" | "manpages";

/** A single result returned by local-search */
export interface LocalSearchResult {
  source: LocalSearchSource;
  title: string;
  content: string;
  relevance: number; // 0-1
}

/** Report returned by the cache warmer after a warmup run */
export interface WarmupReport {
  cached: string[];
  errors: string[];
  totalSizeMb: number;
}
