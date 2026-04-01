// KCode - Enterprise Module
// Re-exports for remote settings, MDM, policy limits, and OAuth

// ─── MDM ────────────────────────────────────────────────────────
export {
  clearMdmCache,
  loadMdmSettings,
} from "./mdm/reader";
// ─── OAuth ──────────────────────────────────────────────────────
export {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  getAccessToken,
  refreshToken,
  startOAuthFlow,
} from "./oauth/flow";
export {
  clearTokens,
  loadTokens,
  saveTokens,
} from "./oauth/token-store";

// ─── Policy Limits ──────────────────────────────────────────────
export {
  clearPolicyCache,
  fetchPolicyLimits,
  getPolicyLimit,
  isPolicyAllowed,
  loadPolicyCache,
} from "./policy-limits";
// ─── Remote Settings ────────────────────────────────────────────
export {
  clearRemoteSettingsCache,
  computeChecksum,
  fetchSettings,
  getRemoteSettings,
  loadFromCache as loadRemoteSettingsFromCache,
  startPolling as startRemoteSettingsPolling,
  stopPolling as stopRemoteSettingsPolling,
} from "./remote-settings";
// ─── Types ──────────────────────────────────────────────────────
export type {
  MdmSettings,
  OAuthConfig,
  OAuthTokens,
  PolicyLimitsCache,
  PolicyLimitsResponse,
  PolicyRestriction,
  RemoteSettingsCache,
  RemoteSettingsResponse,
} from "./types";
