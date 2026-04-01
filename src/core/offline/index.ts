// KCode - Offline Module
// Re-exports for convenient imports

export { CacheWarmer } from "./cache-warmer";
export { localSearch, searchManPages } from "./local-search";
export { getOfflineMode, initOfflineMode, OfflineMode, resetOfflineMode } from "./mode";
export { isLocalHost, OfflineError, offlineAwareFetch } from "./network-guard";
export type {
  CacheWarmerConfig,
  LocalResources,
  LocalSearchResult,
  LocalSearchSettings,
  LocalSearchSource,
  OfflineSettings,
  OfflineState,
  WarmupReport,
} from "./types";
