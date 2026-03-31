// KCode - Enterprise Types
// Shared interfaces for remote settings, MDM, policy limits, and OAuth

import type { Settings } from "../core/config";

// ─── Remote Settings ────────────────────────────────────────────

export interface RemoteSettingsResponse {
  /** ISO 8601 timestamp of the last settings change */
  version: string;
  /** SHA256 checksum of the settings payload */
  checksum: string;
  /** Partial settings to merge into the config hierarchy */
  settings: Partial<Settings>;
}

export interface RemoteSettingsCache {
  /** ETag from the last successful fetch */
  etag: string;
  /** Cached response payload */
  response: RemoteSettingsResponse;
  /** Timestamp of the last successful fetch (ISO 8601) */
  fetchedAt: string;
}

// ─── MDM Settings ───────────────────────────────────────────────

export interface MdmSettings {
  permissionMode?: string;
  allowedTools?: string[];
  blockedTools?: string[];
  maxBudgetUsd?: number;
  auditLogging?: boolean;
  disableWebAccess?: boolean;
  allowedModels?: string[];
  blockedModels?: string[];
  /** Custom system prompt injected by IT admin */
  customSystemPrompt?: string;
  /** Force specific model */
  forceModel?: string;
}

// ─── Policy Limits ──────────────────────────────────────────────

export interface PolicyRestriction {
  allowed: boolean;
  limit?: number;
}

export interface PolicyLimitsResponse {
  restrictions: Record<string, PolicyRestriction>;
}

export interface PolicyLimitsCache {
  etag: string;
  response: PolicyLimitsResponse;
  fetchedAt: string;
}

// ─── OAuth ──────────────────────────────────────────────────────

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  /** Computed absolute expiry time (epoch ms) */
  expires_at?: number;
}

export interface OAuthConfig {
  provider: "kulvex" | "github" | "custom";
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
}
