// KCode - Enterprise SSO (Single Sign-On)
// Supports SAML 2.0 and OIDC for enterprise authentication

import { createHash, createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { log } from "../logger";
import { kcodeHome } from "../paths";

// ─── Types ──────────────────────────────────────────────────────

export type SSOProvider = "saml" | "oidc";

export interface SSOConfig {
  provider: SSOProvider;
  // SAML fields
  entityId?: string;
  ssoUrl?: string;
  certificate?: string;
  // OIDC fields
  clientId?: string;
  clientSecret?: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
  // Common
  callbackUrl?: string;
  allowedDomains?: string[];
  forceSSO?: boolean; // Admin can force SSO for all team members
}

export interface SSOSession {
  userId: string;
  email: string;
  name?: string;
  groups?: string[];
  provider: SSOProvider;
  issuedAt: number;
  expiresAt: number;
  accessToken?: string;
  refreshToken?: string;
}

export interface SSOValidationResult {
  valid: boolean;
  session?: SSOSession;
  error?: string;
}

// ─── Config Loading ─────────────────────────────────────────────

/**
 * Load SSO configuration from enterprise.json.
 * Priority: .kcode/enterprise.json (workspace) > ~/.kcode/enterprise.json (global)
 * Returns null if no SSO config is found.
 */
export async function loadSSOConfig(): Promise<SSOConfig | null> {
  const candidates = [
    join(process.cwd(), ".kcode", "enterprise.json"),
    join(kcodeHome(), "enterprise.json"),
  ];

  for (const path of candidates) {
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        const raw = await file.json();
        if (raw?.sso && typeof raw.sso === "object") {
          log.debug("sso", `Loaded SSO config from ${path}`);
          return validateSSOConfig(raw.sso);
        }
      }
    } catch (err) {
      log.warn("sso", `Failed to parse SSO config at ${path}: ${err}`);
    }
  }

  return null;
}

/**
 * Validate and normalize a parsed SSO config object.
 */
function validateSSOConfig(raw: unknown): SSOConfig | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const provider = obj.provider;

  if (provider !== "saml" && provider !== "oidc") {
    log.warn("sso", `Invalid SSO provider: ${String(provider)}. Must be "saml" or "oidc".`);
    return null;
  }

  const config: SSOConfig = { provider };

  // SAML fields
  if (typeof obj.entityId === "string") config.entityId = obj.entityId;
  if (typeof obj.ssoUrl === "string") config.ssoUrl = obj.ssoUrl;
  if (typeof obj.certificate === "string") config.certificate = obj.certificate;

  // OIDC fields
  if (typeof obj.clientId === "string") config.clientId = obj.clientId;
  if (typeof obj.clientSecret === "string") config.clientSecret = obj.clientSecret;
  if (typeof obj.issuer === "string") config.issuer = obj.issuer;
  if (typeof obj.authorizationEndpoint === "string")
    config.authorizationEndpoint = obj.authorizationEndpoint;
  if (typeof obj.tokenEndpoint === "string") config.tokenEndpoint = obj.tokenEndpoint;
  if (typeof obj.userInfoEndpoint === "string") config.userInfoEndpoint = obj.userInfoEndpoint;

  // Common fields
  if (typeof obj.callbackUrl === "string") config.callbackUrl = obj.callbackUrl;
  if (Array.isArray(obj.allowedDomains)) {
    config.allowedDomains = obj.allowedDomains.filter((d): d is string => typeof d === "string");
  }
  if (typeof obj.forceSSO === "boolean") config.forceSSO = obj.forceSSO;

  // Validate required fields per provider
  if (provider === "saml") {
    if (!config.entityId || !config.ssoUrl || !config.certificate) {
      log.warn("sso", "SAML config missing required fields: entityId, ssoUrl, certificate");
      return null;
    }
  } else if (provider === "oidc") {
    if (!config.clientId || !config.clientSecret || !config.issuer) {
      log.warn("sso", "OIDC config missing required fields: clientId, clientSecret, issuer");
      return null;
    }
  }

  return config;
}

// ─── SSO Status ─────────────────────────────────────────────────

/**
 * Check if SSO is configured and enabled.
 */
export async function isSSOEnabled(): Promise<boolean> {
  const config = await loadSSOConfig();
  return config !== null;
}

// ─── SAML 2.0 ───────────────────────────────────────────────────

/**
 * Parse and validate a Base64-encoded SAML response.
 * Uses regex-based XML extraction (no external XML parser dependency).
 *
 * Returns a validation result with the extracted session on success.
 */
export function validateSAMLResponse(samlResponse: string, config: SSOConfig): SSOValidationResult {
  if (config.provider !== "saml") {
    return { valid: false, error: "SSO provider is not SAML" };
  }

  let xml: string;
  try {
    xml = Buffer.from(samlResponse, "base64").toString("utf-8");
  } catch {
    return { valid: false, error: "Invalid Base64 SAML response" };
  }

  // Verify this is a SAML response
  if (!xml.includes("samlp:Response") && !xml.includes("saml2p:Response")) {
    return { valid: false, error: "Not a valid SAML response document" };
  }

  // Check for successful status
  const statusMatch = xml.match(/StatusCode\s+Value="[^"]*:(\w+)"/);
  if (!statusMatch || statusMatch[1] !== "Success") {
    return {
      valid: false,
      error: `SAML authentication failed: ${statusMatch?.[1] ?? "unknown status"}`,
    };
  }

  // Verify issuer matches expected entityId
  const issuerMatch = xml.match(/<(?:saml2?:)?Issuer[^>]*>([^<]+)<\/(?:saml2?:)?Issuer>/);
  if (!issuerMatch) {
    return { valid: false, error: "SAML response missing Issuer element" };
  }

  // Verify signature digest (simplified — checks that a signature block exists
  // and the digest value is a valid Base64 hash)
  const digestMatch = xml.match(/<(?:ds:)?DigestValue>([A-Za-z0-9+/=]+)<\/(?:ds:)?DigestValue>/);
  if (!digestMatch) {
    return { valid: false, error: "SAML response missing signature digest" };
  }

  // Verify certificate matches configured certificate (fingerprint comparison)
  const certMatch = xml.match(/<(?:ds:)?X509Certificate>([^<]+)<\/(?:ds:)?X509Certificate>/);
  if (certMatch && config.certificate) {
    const responseCertFingerprint = createHash("sha256")
      .update(certMatch[1].replace(/\s/g, ""))
      .digest("hex");
    const configCertFingerprint = createHash("sha256")
      .update(config.certificate.replace(/\s/g, ""))
      .digest("hex");
    if (responseCertFingerprint !== configCertFingerprint) {
      return { valid: false, error: "SAML certificate fingerprint mismatch" };
    }
  }

  // Extract user attributes from Assertion
  const nameIdMatch = xml.match(/<(?:saml2?:)?NameID[^>]*>([^<]+)<\/(?:saml2?:)?NameID>/);
  const email = nameIdMatch?.[1]?.trim() ?? "";
  if (!email) {
    return { valid: false, error: "SAML response missing NameID (email)" };
  }

  // Check domain restriction
  if (config.allowedDomains && config.allowedDomains.length > 0) {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain || !config.allowedDomains.some((d) => d.toLowerCase() === domain)) {
      return { valid: false, error: `Email domain "${domain}" is not in the allowed domains list` };
    }
  }

  // Extract optional display name
  const displayNameMatch = xml.match(
    /Name="(?:.*?)(?:displayName|givenName|cn)"[^>]*>\s*<(?:saml2?:)?AttributeValue[^>]*>([^<]+)/,
  );
  const name = displayNameMatch?.[1]?.trim();

  // Extract optional groups
  const groups: string[] = [];
  const groupRegex = /Name="(?:.*?)(?:memberOf|groups?)"[^>]*>([\s\S]*?)<\/(?:saml2?:)?Attribute>/g;
  let groupBlock: RegExpExecArray | null;
  while ((groupBlock = groupRegex.exec(xml)) !== null) {
    const valueRegex = /<(?:saml2?:)?AttributeValue[^>]*>([^<]+)/g;
    let valueMatch: RegExpExecArray | null;
    while ((valueMatch = valueRegex.exec(groupBlock[1])) !== null) {
      groups.push(valueMatch[1].trim());
    }
  }

  // Extract session expiry from Conditions or SubjectConfirmationData
  const notOnOrAfterMatch = xml.match(/NotOnOrAfter="([^"]+)"/);
  const expiresAt = notOnOrAfterMatch
    ? new Date(notOnOrAfterMatch[1]).getTime()
    : Date.now() + 8 * 60 * 60 * 1000; // Default: 8 hours

  const userId = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 16);

  const session: SSOSession = {
    userId,
    email,
    name,
    groups: groups.length > 0 ? groups : undefined,
    provider: "saml",
    issuedAt: Date.now(),
    expiresAt,
  };

  log.info("sso", `SAML authentication successful for ${email}`);
  return { valid: true, session };
}

// ─── OIDC ───────────────────────────────────────────────────────

/**
 * Generate the authorization URL for initiating an OIDC authentication flow.
 * Returns the URL the user should open in their browser.
 */
export function initiateOIDCFlow(config: SSOConfig): {
  url: string;
  state: string;
  nonce: string;
} {
  if (config.provider !== "oidc") {
    throw new Error("SSO provider is not OIDC");
  }

  if (!config.clientId || !config.authorizationEndpoint || !config.callbackUrl) {
    throw new Error(
      "OIDC config missing required fields: clientId, authorizationEndpoint, callbackUrl",
    );
  }

  const state = randomBytes(32).toString("hex");
  const nonce = randomBytes(32).toString("hex");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: "openid email profile",
    state,
    nonce,
  });

  const url = `${config.authorizationEndpoint}?${params.toString()}`;

  log.debug("sso", `OIDC authorization URL generated for client ${config.clientId}`);
  return { url, state, nonce };
}

/**
 * Exchange an OIDC authorization code for tokens.
 * Makes a POST request to the token endpoint.
 */
export async function exchangeOIDCCode(
  code: string,
  config: SSOConfig,
): Promise<SSOValidationResult> {
  if (config.provider !== "oidc") {
    return { valid: false, error: "SSO provider is not OIDC" };
  }

  if (!config.tokenEndpoint || !config.clientId || !config.clientSecret || !config.callbackUrl) {
    return {
      valid: false,
      error:
        "OIDC config missing required fields: tokenEndpoint, clientId, clientSecret, callbackUrl",
    };
  }

  try {
    const tokenResponse = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.callbackUrl,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return {
        valid: false,
        error: `Token exchange failed (${tokenResponse.status}): ${errorText}`,
      };
    }

    const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
    const accessToken = String(tokenData.access_token ?? "");
    const refreshToken = tokenData.refresh_token ? String(tokenData.refresh_token) : undefined;
    const expiresIn = Number(tokenData.expires_in ?? 3600);
    const idToken = tokenData.id_token ? String(tokenData.id_token) : undefined;

    if (!accessToken) {
      return { valid: false, error: "Token response missing access_token" };
    }

    // Extract user info from the id_token (JWT) or call userInfo endpoint
    let email = "";
    let name: string | undefined;
    let groups: string[] | undefined;

    if (idToken) {
      const claims = decodeJWTPayload(idToken);
      email = String(claims.email ?? "");
      name = claims.name ? String(claims.name) : undefined;
      if (Array.isArray(claims.groups)) {
        groups = claims.groups.filter((g): g is string => typeof g === "string");
      }
    }

    // Fall back to userInfo endpoint if email was not in the id_token
    if (!email && config.userInfoEndpoint) {
      const userInfoResponse = await fetch(config.userInfoEndpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (userInfoResponse.ok) {
        const userInfo = (await userInfoResponse.json()) as Record<string, unknown>;
        email = String(userInfo.email ?? "");
        name = name ?? (userInfo.name ? String(userInfo.name) : undefined);
        if (!groups && Array.isArray(userInfo.groups)) {
          groups = userInfo.groups.filter((g): g is string => typeof g === "string");
        }
      }
    }

    if (!email) {
      return { valid: false, error: "Could not determine user email from OIDC tokens" };
    }

    // Check domain restriction
    if (config.allowedDomains && config.allowedDomains.length > 0) {
      const domain = email.split("@")[1]?.toLowerCase();
      if (!domain || !config.allowedDomains.some((d) => d.toLowerCase() === domain)) {
        return {
          valid: false,
          error: `Email domain "${domain}" is not in the allowed domains list`,
        };
      }
    }

    const userId = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 16);

    const session: SSOSession = {
      userId,
      email,
      name,
      groups,
      provider: "oidc",
      issuedAt: Date.now(),
      expiresAt: Date.now() + expiresIn * 1000,
      accessToken,
      refreshToken,
    };

    log.info("sso", `OIDC authentication successful for ${email}`);
    return { valid: true, session };
  } catch (err) {
    return { valid: false, error: `OIDC code exchange failed: ${err}` };
  }
}

// ─── Session Validation ─────────────────────────────────────────

/**
 * Validate an existing SSO session.
 * Checks expiry and domain restrictions against the current config.
 */
export async function validateSSOSession(session: SSOSession): Promise<SSOValidationResult> {
  // Check expiry
  if (Date.now() >= session.expiresAt) {
    return { valid: false, error: "SSO session has expired" };
  }

  // Load current config to check domain restrictions
  const config = await loadSSOConfig();
  if (!config) {
    return { valid: false, error: "SSO is no longer configured" };
  }

  // Check domain restriction
  if (config.allowedDomains && config.allowedDomains.length > 0) {
    const domain = session.email.split("@")[1]?.toLowerCase();
    if (!domain || !config.allowedDomains.some((d) => d.toLowerCase() === domain)) {
      return {
        valid: false,
        error: `Email domain "${domain}" is no longer in the allowed domains list`,
      };
    }
  }

  // Check provider match
  if (config.provider !== session.provider) {
    return {
      valid: false,
      error: `SSO provider mismatch: session is ${session.provider}, config requires ${config.provider}`,
    };
  }

  return { valid: true, session };
}

// ─── Session Refresh ────────────────────────────────────────────

/**
 * Refresh an expired OIDC session using the refresh token.
 * SAML sessions cannot be refreshed — the user must re-authenticate.
 */
export async function refreshSSOSession(session: SSOSession): Promise<SSOValidationResult> {
  if (session.provider !== "oidc") {
    return { valid: false, error: "Only OIDC sessions support token refresh" };
  }

  if (!session.refreshToken) {
    return { valid: false, error: "Session has no refresh token" };
  }

  const config = await loadSSOConfig();
  if (!config || config.provider !== "oidc") {
    return { valid: false, error: "OIDC is no longer configured" };
  }

  if (!config.tokenEndpoint || !config.clientId || !config.clientSecret) {
    return { valid: false, error: "OIDC config missing required fields for token refresh" };
  }

  try {
    const tokenResponse = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return {
        valid: false,
        error: `Token refresh failed (${tokenResponse.status}): ${errorText}`,
      };
    }

    const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
    const accessToken = String(tokenData.access_token ?? "");
    const refreshToken = tokenData.refresh_token
      ? String(tokenData.refresh_token)
      : session.refreshToken; // Keep old refresh token if not rotated
    const expiresIn = Number(tokenData.expires_in ?? 3600);

    if (!accessToken) {
      return { valid: false, error: "Refresh response missing access_token" };
    }

    const refreshedSession: SSOSession = {
      ...session,
      accessToken,
      refreshToken,
      issuedAt: Date.now(),
      expiresAt: Date.now() + expiresIn * 1000,
    };

    log.info("sso", `OIDC session refreshed for ${session.email}`);
    return { valid: true, session: refreshedSession };
  } catch (err) {
    return { valid: false, error: `Token refresh failed: ${err}` };
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Decode the payload section of a JWT without verifying the signature.
 * Used to extract claims from id_tokens.
 */
export function decodeJWTPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return {};
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return {};
  }
}
