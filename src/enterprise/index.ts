// KCode - Enterprise Module
// Re-exports for remote settings, MDM, policy limits, and OAuth

// ─── Types ──────────────────────────────────────────────────────
export type {
  RemoteSettingsResponse,
  RemoteSettingsCache,
  MdmSettings,
  PolicyRestriction,
  PolicyLimitsResponse,
  PolicyLimitsCache,
  OAuthTokens,
  OAuthConfig,
} from "./types";

// ─── Remote Settings ────────────────────────────────────────────
export {
  fetchSettings,
  getRemoteSettings,
  loadFromCache as loadRemoteSettingsFromCache,
  startPolling as startRemoteSettingsPolling,
  stopPolling as stopRemoteSettingsPolling,
  clearRemoteSettingsCache,
  computeChecksum,
} from "./remote-settings";

// ─── MDM ────────────────────────────────────────────────────────
export {
  loadMdmSettings,
  clearMdmCache,
} from "./mdm/reader";

// ─── Policy Limits ──────────────────────────────────────────────
export {
  fetchPolicyLimits,
  isPolicyAllowed,
  getPolicyLimit,
  loadPolicyCache,
  clearPolicyCache,
} from "./policy-limits";

// ─── OAuth ──────────────────────────────────────────────────────
export {
  startOAuthFlow,
  refreshToken,
  getAccessToken,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from "./oauth/flow";

export {
  saveTokens,
  loadTokens,
  clearTokens,
} from "./oauth/token-store";
