// Auth type definitions

export interface OAuthConfig {
  provider: "anthropic" | "openai" | "openai-codex" | "gemini" | "kcode-cloud" | "custom";
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  /** Local port for OAuth callback server */
  redirectPort: number;
  /** Optional: extra params appended to the authorization URL */
  extraAuthParams?: Record<string, string>;
  /** If true, the OAuth token is exchanged for a permanent API key (e.g., Anthropic) */
  exchangeForApiKey?: boolean;
  /** Human-readable label shown in UI */
  label?: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // Unix timestamp
  tokenType: string;
  scope?: string;
}

export interface KeychainEntry {
  service: string;
  account: string;
  secret: string;
}

export interface AuthSession {
  provider: string;
  tokens: OAuthTokens;
  createdAt: number;
  lastRefreshed: number;
}
