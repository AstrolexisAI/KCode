// Auth Session — Manages the active authentication session.
// Handles token lifecycle: load from keychain, auto-refresh, expiry.

import type { OAuthConfig, OAuthTokens, AuthSession } from "./types";
import {
  getStoredTokens,
  storeTokens,
  isTokenExpired,
  refreshAccessToken,
  clearTokens,
  getApiKey,
} from "./oauth-flow";

export class AuthSessionManager {
  private sessions: Map<string, AuthSession> = new Map();

  /** Load a session from stored tokens */
  async loadSession(provider: string): Promise<AuthSession | null> {
    const tokens = await getStoredTokens(provider);
    if (!tokens) return null;

    const session: AuthSession = {
      provider,
      tokens,
      createdAt: Date.now(),
      lastRefreshed: Date.now(),
    };
    this.sessions.set(provider, session);
    return session;
  }

  /** Get a valid access token, refreshing if needed */
  async getAccessToken(
    provider: string,
    config?: OAuthConfig,
  ): Promise<string | null> {
    let session = this.sessions.get(provider);

    if (!session) {
      session = (await this.loadSession(provider)) ?? undefined;
      if (!session) {
        // Try API key as fallback
        return getApiKey(provider);
      }
    }

    // Auto-refresh if expired
    if (isTokenExpired(session.tokens) && session.tokens.refreshToken && config) {
      try {
        const newTokens = await refreshAccessToken(
          config,
          session.tokens.refreshToken,
        );
        session.tokens = newTokens;
        session.lastRefreshed = Date.now();
        await storeTokens(provider, newTokens);
      } catch {
        // Refresh failed — clear session
        this.sessions.delete(provider);
        return null;
      }
    }

    return session.tokens.accessToken;
  }

  /** Check if we have any valid auth for a provider */
  hasAuth(provider: string): boolean {
    const session = this.sessions.get(provider);
    if (!session) return false;
    return !isTokenExpired(session.tokens);
  }

  /** Clear session and stored tokens */
  async logout(provider: string): Promise<void> {
    this.sessions.delete(provider);
    await clearTokens(provider);
  }

  /** Clear all sessions */
  async logoutAll(): Promise<void> {
    const providers = Array.from(this.sessions.keys());
    for (const provider of providers) {
      await this.logout(provider);
    }
  }

  /** Get all active session providers */
  getActiveProviders(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Get session info (for UI display) */
  getSessionInfo(provider: string): {
    provider: string;
    authenticated: boolean;
    expiresAt?: number;
    lastRefreshed: number;
  } | null {
    const session = this.sessions.get(provider);
    if (!session) return null;
    return {
      provider: session.provider,
      authenticated: !isTokenExpired(session.tokens),
      expiresAt: session.tokens.expiresAt,
      lastRefreshed: session.lastRefreshed,
    };
  }
}

// Singleton
let _manager: AuthSessionManager | undefined;

export function getAuthSessionManager(): AuthSessionManager {
  if (!_manager) {
    _manager = new AuthSessionManager();
  }
  return _manager;
}

export function _resetAuthSessionManager(): void {
  _manager = undefined;
}
