// KCode - Offline Module
// Re-exports for convenient imports

export { OfflineMode, getOfflineMode, initOfflineMode, resetOfflineMode } from "./mode";
export { isLocalHost, OfflineError, offlineAwareFetch } from "./network-guard";
export { CacheWarmer } from "./cache-warmer";
export { localSearch, searchManPages } from "./local-search";
export type {
  OfflineState,
  LocalResources,
  OfflineSettings,
  CacheWarmerConfig,
  LocalSearchSettings,
  LocalSearchSource,
  LocalSearchResult,
  WarmupReport,
} from "./types";
