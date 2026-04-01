// Auth type definitions

export interface OAuthConfig {
  provider: "anthropic" | "openai" | "kcode-cloud" | "custom";
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  /** Local port for OAuth callback server */
  redirectPort: number;
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
