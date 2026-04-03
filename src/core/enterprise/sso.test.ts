import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeJWTPayload,
  exchangeOIDCCode,
  initiateOIDCFlow,
  isSSOEnabled,
  loadSSOConfig,
  refreshSSOSession,
  type SSOConfig,
  type SSOSession,
  validateSAMLResponse,
  validateSSOSession,
} from "./sso";

// ─── Test Helpers ───────────────────────────────────────────────

function makeSAMLResponse(opts: {
  status?: string;
  issuer?: string;
  email?: string;
  name?: string;
  groups?: string[];
  digest?: string;
  cert?: string;
  notOnOrAfter?: string;
}): string {
  const status = opts.status ?? "Success";
  const issuer = opts.issuer ?? "https://idp.example.com";
  const email = opts.email ?? "alice@example.com";
  const digest = opts.digest ?? "abc123base64digest==";
  const cert = opts.cert ?? "MIIC8DCCAdigAwIBAgIQc/test";
  const notOnOrAfter = opts.notOnOrAfter ?? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

  let attributes = "";
  if (opts.name) {
    attributes += `<saml:Attribute Name="displayName"><saml:AttributeValue>${opts.name}</saml:AttributeValue></saml:Attribute>`;
  }
  if (opts.groups && opts.groups.length > 0) {
    const values = opts.groups
      .map((g) => `<saml:AttributeValue>${g}</saml:AttributeValue>`)
      .join("");
    attributes += `<saml:Attribute Name="groups">${values}</saml:Attribute>`;
  }

  const xml = `
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
                xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
  <saml:Issuer>${issuer}</saml:Issuer>
  <samlp:Status>
    <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:${status}"/>
  </samlp:Status>
  <saml:Assertion>
    <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
      <ds:SignedInfo>
        <ds:DigestValue>${digest}</ds:DigestValue>
      </ds:SignedInfo>
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>${cert}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </ds:Signature>
    <saml:Subject>
      <saml:NameID>${email}</saml:NameID>
      <saml:SubjectConfirmation>
        <saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotOnOrAfter="${notOnOrAfter}"/>
    <saml:AttributeStatement>
      ${attributes}
    </saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>`;

  return Buffer.from(xml).toString("base64");
}

function makeJWT(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from("fake-signature").toString("base64url");
  return `${header}.${body}.${sig}`;
}

function makeSAMLConfig(overrides?: Partial<SSOConfig>): SSOConfig {
  return {
    provider: "saml",
    entityId: "https://idp.example.com",
    ssoUrl: "https://idp.example.com/sso",
    certificate: "MIIC8DCCAdigAwIBAgIQc/test",
    callbackUrl: "http://localhost:10500/sso/callback",
    ...overrides,
  };
}

function makeOIDCConfig(overrides?: Partial<SSOConfig>): SSOConfig {
  return {
    provider: "oidc",
    clientId: "kcode-enterprise",
    clientSecret: "secret-123",
    issuer: "https://auth.example.com",
    authorizationEndpoint: "https://auth.example.com/authorize",
    tokenEndpoint: "https://auth.example.com/token",
    userInfoEndpoint: "https://auth.example.com/userinfo",
    callbackUrl: "http://localhost:10500/oidc/callback",
    ...overrides,
  };
}

function makeSession(overrides?: Partial<SSOSession>): SSOSession {
  return {
    userId: "abc123",
    email: "alice@example.com",
    provider: "oidc",
    issuedAt: Date.now() - 60_000,
    expiresAt: Date.now() + 3600_000,
    accessToken: "at-123",
    refreshToken: "rt-456",
    ...overrides,
  };
}

// ─── Config Loading ─────────────────────────────────────────────

describe("SSO Config Loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `kcode-sso-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadSSOConfig returns null when no config file exists", async () => {
    // Override cwd and home to point to empty dirs
    const origCwd = process.cwd;
    const origEnv = process.env.KCODE_HOME;
    process.cwd = () => join(tmpDir, "workspace");
    process.env.KCODE_HOME = join(tmpDir, "home");

    try {
      const config = await loadSSOConfig();
      expect(config).toBeNull();
    } finally {
      process.cwd = origCwd;
      process.env.KCODE_HOME = origEnv ?? (undefined as unknown as string);
      if (!origEnv) delete process.env.KCODE_HOME;
    }
  });

  it("loadSSOConfig loads SAML config from workspace enterprise.json", async () => {
    const kcodeDir = join(tmpDir, "workspace", ".kcode");
    mkdirSync(kcodeDir, { recursive: true });
    writeFileSync(
      join(kcodeDir, "enterprise.json"),
      JSON.stringify({
        sso: {
          provider: "saml",
          entityId: "https://idp.corp.com",
          ssoUrl: "https://idp.corp.com/sso",
          certificate: "MIIC-CERT",
        },
      }),
    );

    const origCwd = process.cwd;
    const origEnv = process.env.KCODE_HOME;
    process.cwd = () => join(tmpDir, "workspace");
    process.env.KCODE_HOME = join(tmpDir, "home-empty");

    try {
      const config = await loadSSOConfig();
      expect(config).not.toBeNull();
      expect(config!.provider).toBe("saml");
      expect(config!.entityId).toBe("https://idp.corp.com");
    } finally {
      process.cwd = origCwd;
      process.env.KCODE_HOME = origEnv ?? (undefined as unknown as string);
      if (!origEnv) delete process.env.KCODE_HOME;
    }
  });

  it("loadSSOConfig loads OIDC config from global enterprise.json", async () => {
    const homeDir = join(tmpDir, "home");
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, "enterprise.json"),
      JSON.stringify({
        sso: {
          provider: "oidc",
          clientId: "kcode-ent",
          clientSecret: "s3cret",
          issuer: "https://auth.corp.com",
        },
      }),
    );

    const origCwd = process.cwd;
    const origEnv = process.env.KCODE_HOME;
    process.cwd = () => join(tmpDir, "workspace-empty");
    process.env.KCODE_HOME = homeDir;

    try {
      const config = await loadSSOConfig();
      expect(config).not.toBeNull();
      expect(config!.provider).toBe("oidc");
      expect(config!.clientId).toBe("kcode-ent");
    } finally {
      process.cwd = origCwd;
      process.env.KCODE_HOME = origEnv ?? (undefined as unknown as string);
      if (!origEnv) delete process.env.KCODE_HOME;
    }
  });

  it("loadSSOConfig rejects invalid provider", async () => {
    const kcodeDir = join(tmpDir, "workspace", ".kcode");
    mkdirSync(kcodeDir, { recursive: true });
    writeFileSync(join(kcodeDir, "enterprise.json"), JSON.stringify({ sso: { provider: "ldap" } }));

    const origCwd = process.cwd;
    const origEnv = process.env.KCODE_HOME;
    process.cwd = () => join(tmpDir, "workspace");
    process.env.KCODE_HOME = join(tmpDir, "home-empty");

    try {
      const config = await loadSSOConfig();
      expect(config).toBeNull();
    } finally {
      process.cwd = origCwd;
      process.env.KCODE_HOME = origEnv ?? (undefined as unknown as string);
      if (!origEnv) delete process.env.KCODE_HOME;
    }
  });

  it("loadSSOConfig rejects SAML missing required fields", async () => {
    const kcodeDir = join(tmpDir, "workspace", ".kcode");
    mkdirSync(kcodeDir, { recursive: true });
    writeFileSync(
      join(kcodeDir, "enterprise.json"),
      JSON.stringify({ sso: { provider: "saml", entityId: "https://idp.corp.com" } }),
    );

    const origCwd = process.cwd;
    const origEnv = process.env.KCODE_HOME;
    process.cwd = () => join(tmpDir, "workspace");
    process.env.KCODE_HOME = join(tmpDir, "home-empty");

    try {
      const config = await loadSSOConfig();
      expect(config).toBeNull();
    } finally {
      process.cwd = origCwd;
      process.env.KCODE_HOME = origEnv ?? (undefined as unknown as string);
      if (!origEnv) delete process.env.KCODE_HOME;
    }
  });

  it("isSSOEnabled returns false when no config exists", async () => {
    const origCwd = process.cwd;
    const origEnv = process.env.KCODE_HOME;
    process.cwd = () => join(tmpDir, "workspace-empty");
    process.env.KCODE_HOME = join(tmpDir, "home-empty");

    try {
      expect(await isSSOEnabled()).toBe(false);
    } finally {
      process.cwd = origCwd;
      process.env.KCODE_HOME = origEnv ?? (undefined as unknown as string);
      if (!origEnv) delete process.env.KCODE_HOME;
    }
  });
});

// ─── SAML Response Validation ───────────────────────────────────

describe("SAML Response Validation", () => {
  const config = makeSAMLConfig();

  it("validates a well-formed SAML response", () => {
    const saml = makeSAMLResponse({ email: "alice@example.com" });
    const result = validateSAMLResponse(saml, config);
    expect(result.valid).toBe(true);
    expect(result.session).toBeDefined();
    expect(result.session!.email).toBe("alice@example.com");
    expect(result.session!.provider).toBe("saml");
    expect(result.session!.userId).toHaveLength(16);
  });

  it("extracts display name and groups", () => {
    const saml = makeSAMLResponse({
      email: "bob@example.com",
      name: "Bob Smith",
      groups: ["engineering", "admins"],
    });
    const result = validateSAMLResponse(saml, config);
    expect(result.valid).toBe(true);
    expect(result.session!.name).toBe("Bob Smith");
    expect(result.session!.groups).toEqual(["engineering", "admins"]);
  });

  it("rejects non-SAML provider config", () => {
    const oidcConfig = makeOIDCConfig();
    const saml = makeSAMLResponse({});
    const result = validateSAMLResponse(saml, oidcConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not SAML");
  });

  it("rejects invalid Base64 input", () => {
    const result = validateSAMLResponse("!!!not-base64!!!", config);
    // Buffer.from with base64 is lenient, so it may decode to garbage
    // which will fail the SAML response check
    expect(result.valid).toBe(false);
  });

  it("rejects non-SAML XML", () => {
    const notSaml = Buffer.from("<html><body>Not SAML</body></html>").toString("base64");
    const result = validateSAMLResponse(notSaml, config);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Not a valid SAML response");
  });

  it("rejects failed SAML status", () => {
    const saml = makeSAMLResponse({ status: "Requester" });
    const result = validateSAMLResponse(saml, config);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Requester");
  });

  it("rejects mismatched certificate fingerprint", () => {
    const saml = makeSAMLResponse({ cert: "DIFFERENT-CERTIFICATE-CONTENT" });
    const result = validateSAMLResponse(saml, config);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("fingerprint mismatch");
  });

  it("enforces domain restrictions", () => {
    const restrictedConfig = makeSAMLConfig({ allowedDomains: ["corp.com"] });
    const saml = makeSAMLResponse({ email: "alice@example.com" });
    const result = validateSAMLResponse(saml, restrictedConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in the allowed domains");
  });

  it("allows email from permitted domain", () => {
    const restrictedConfig = makeSAMLConfig({ allowedDomains: ["example.com"] });
    const saml = makeSAMLResponse({ email: "alice@example.com" });
    const result = validateSAMLResponse(saml, restrictedConfig);
    expect(result.valid).toBe(true);
  });

  it("respects NotOnOrAfter for session expiry", () => {
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const saml = makeSAMLResponse({ notOnOrAfter: future });
    const result = validateSAMLResponse(saml, config);
    expect(result.valid).toBe(true);
    // Session expiry should be close to the NotOnOrAfter value
    const diff = Math.abs(result.session!.expiresAt - new Date(future).getTime());
    expect(diff).toBeLessThan(1000);
  });
});

// ─── OIDC Flow ──────────────────────────────────────────────────

describe("OIDC Flow Initiation", () => {
  it("generates a valid authorization URL", () => {
    const config = makeOIDCConfig();
    const { url, state, nonce } = initiateOIDCFlow(config);

    expect(url).toContain("https://auth.example.com/authorize?");
    expect(url).toContain("response_type=code");
    expect(url).toContain("client_id=kcode-enterprise");
    expect(url).toContain("scope=openid+email+profile");
    expect(url).toContain(`state=${state}`);
    expect(url).toContain(`nonce=${nonce}`);
    expect(state).toHaveLength(64); // 32 bytes hex
    expect(nonce).toHaveLength(64);
  });

  it("throws for non-OIDC provider", () => {
    const config = makeSAMLConfig();
    expect(() => initiateOIDCFlow(config)).toThrow("not OIDC");
  });

  it("throws when missing required OIDC fields", () => {
    const config = makeOIDCConfig({ authorizationEndpoint: undefined });
    expect(() => initiateOIDCFlow(config)).toThrow("missing required fields");
  });
});

describe("OIDC Code Exchange", () => {
  it("rejects non-OIDC provider", async () => {
    const config = makeSAMLConfig();
    const result = await exchangeOIDCCode("auth-code", config);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not OIDC");
  });

  it("rejects when missing required fields", async () => {
    const config = makeOIDCConfig({ tokenEndpoint: undefined });
    const result = await exchangeOIDCCode("auth-code", config);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("missing required fields");
  });
});

// ─── Session Validation ─────────────────────────────────────────

describe("SSO Session Validation", () => {
  it("rejects expired session", async () => {
    const session = makeSession({ expiresAt: Date.now() - 1000 });
    const result = await validateSSOSession(session);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("rejects session when SSO is no longer configured", async () => {
    const origCwd = process.cwd;
    const origEnv = process.env.KCODE_HOME;
    const tmpDir = join(tmpdir(), `kcode-sso-sess-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.cwd = () => join(tmpDir, "empty-workspace");
    process.env.KCODE_HOME = join(tmpDir, "empty-home");

    try {
      const session = makeSession();
      const result = await validateSSOSession(session);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("no longer configured");
    } finally {
      process.cwd = origCwd;
      process.env.KCODE_HOME = origEnv ?? (undefined as unknown as string);
      if (!origEnv) delete process.env.KCODE_HOME;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects session with wrong domain when allowedDomains is set", async () => {
    const tmpDir = join(tmpdir(), `kcode-sso-domain-${Date.now()}`);
    const kcodeDir = join(tmpDir, "workspace", ".kcode");
    mkdirSync(kcodeDir, { recursive: true });
    writeFileSync(
      join(kcodeDir, "enterprise.json"),
      JSON.stringify({
        sso: {
          provider: "oidc",
          clientId: "kcode",
          clientSecret: "s3c",
          issuer: "https://auth.corp.com",
          allowedDomains: ["corp.com"],
        },
      }),
    );

    const origCwd = process.cwd;
    const origEnv = process.env.KCODE_HOME;
    process.cwd = () => join(tmpDir, "workspace");
    process.env.KCODE_HOME = join(tmpDir, "home-empty");

    try {
      const session = makeSession({ email: "alice@example.com" });
      const result = await validateSSOSession(session);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("no longer in the allowed domains");
    } finally {
      process.cwd = origCwd;
      process.env.KCODE_HOME = origEnv ?? (undefined as unknown as string);
      if (!origEnv) delete process.env.KCODE_HOME;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("validates a good session with matching config", async () => {
    const tmpDir = join(tmpdir(), `kcode-sso-valid-${Date.now()}`);
    const kcodeDir = join(tmpDir, "workspace", ".kcode");
    mkdirSync(kcodeDir, { recursive: true });
    writeFileSync(
      join(kcodeDir, "enterprise.json"),
      JSON.stringify({
        sso: {
          provider: "oidc",
          clientId: "kcode",
          clientSecret: "s3c",
          issuer: "https://auth.corp.com",
          allowedDomains: ["example.com"],
        },
      }),
    );

    const origCwd = process.cwd;
    const origEnv = process.env.KCODE_HOME;
    process.cwd = () => join(tmpDir, "workspace");
    process.env.KCODE_HOME = join(tmpDir, "home-empty");

    try {
      const session = makeSession({ email: "alice@example.com" });
      const result = await validateSSOSession(session);
      expect(result.valid).toBe(true);
      expect(result.session).toBeDefined();
    } finally {
      process.cwd = origCwd;
      process.env.KCODE_HOME = origEnv ?? (undefined as unknown as string);
      if (!origEnv) delete process.env.KCODE_HOME;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects session with provider mismatch", async () => {
    const tmpDir = join(tmpdir(), `kcode-sso-mismatch-${Date.now()}`);
    const kcodeDir = join(tmpDir, "workspace", ".kcode");
    mkdirSync(kcodeDir, { recursive: true });
    writeFileSync(
      join(kcodeDir, "enterprise.json"),
      JSON.stringify({
        sso: {
          provider: "saml",
          entityId: "https://idp.corp.com",
          ssoUrl: "https://idp.corp.com/sso",
          certificate: "CERT",
        },
      }),
    );

    const origCwd = process.cwd;
    const origEnv = process.env.KCODE_HOME;
    process.cwd = () => join(tmpDir, "workspace");
    process.env.KCODE_HOME = join(tmpDir, "home-empty");

    try {
      const session = makeSession({ provider: "oidc" });
      const result = await validateSSOSession(session);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("provider mismatch");
    } finally {
      process.cwd = origCwd;
      process.env.KCODE_HOME = origEnv ?? (undefined as unknown as string);
      if (!origEnv) delete process.env.KCODE_HOME;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── SSO Enforcement ────────────────────────────────────────────

describe("SSO Enforcement (forceSSO)", () => {
  it("forceSSO flag is preserved in config", async () => {
    const tmpDir = join(tmpdir(), `kcode-sso-force-${Date.now()}`);
    const kcodeDir = join(tmpDir, "workspace", ".kcode");
    mkdirSync(kcodeDir, { recursive: true });
    writeFileSync(
      join(kcodeDir, "enterprise.json"),
      JSON.stringify({
        sso: {
          provider: "oidc",
          clientId: "kcode",
          clientSecret: "s3c",
          issuer: "https://auth.corp.com",
          forceSSO: true,
        },
      }),
    );

    const origCwd = process.cwd;
    const origEnv = process.env.KCODE_HOME;
    process.cwd = () => join(tmpDir, "workspace");
    process.env.KCODE_HOME = join(tmpDir, "home-empty");

    try {
      const config = await loadSSOConfig();
      expect(config).not.toBeNull();
      expect(config!.forceSSO).toBe(true);
    } finally {
      process.cwd = origCwd;
      process.env.KCODE_HOME = origEnv ?? (undefined as unknown as string);
      if (!origEnv) delete process.env.KCODE_HOME;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("forceSSO defaults to undefined when not set", async () => {
    const tmpDir = join(tmpdir(), `kcode-sso-noforce-${Date.now()}`);
    const kcodeDir = join(tmpDir, "workspace", ".kcode");
    mkdirSync(kcodeDir, { recursive: true });
    writeFileSync(
      join(kcodeDir, "enterprise.json"),
      JSON.stringify({
        sso: {
          provider: "oidc",
          clientId: "kcode",
          clientSecret: "s3c",
          issuer: "https://auth.corp.com",
        },
      }),
    );

    const origCwd = process.cwd;
    const origEnv = process.env.KCODE_HOME;
    process.cwd = () => join(tmpDir, "workspace");
    process.env.KCODE_HOME = join(tmpDir, "home-empty");

    try {
      const config = await loadSSOConfig();
      expect(config).not.toBeNull();
      expect(config!.forceSSO).toBeUndefined();
    } finally {
      process.cwd = origCwd;
      process.env.KCODE_HOME = origEnv ?? (undefined as unknown as string);
      if (!origEnv) delete process.env.KCODE_HOME;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── Session Refresh ────────────────────────────────────────────

describe("SSO Session Refresh", () => {
  it("rejects refresh for SAML sessions", async () => {
    const session = makeSession({ provider: "saml" });
    const result = await refreshSSOSession(session);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Only OIDC");
  });

  it("rejects refresh without refresh token", async () => {
    const session = makeSession({ refreshToken: undefined });
    const result = await refreshSSOSession(session);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("no refresh token");
  });
});

// ─── JWT Decode Helper ──────────────────────────────────────────

describe("decodeJWTPayload", () => {
  it("decodes a valid JWT payload", () => {
    const jwt = makeJWT({ email: "alice@corp.com", name: "Alice", groups: ["eng"] });
    const payload = decodeJWTPayload(jwt);
    expect(payload.email).toBe("alice@corp.com");
    expect(payload.name).toBe("Alice");
    expect(payload.groups).toEqual(["eng"]);
  });

  it("returns empty object for invalid JWT", () => {
    expect(decodeJWTPayload("not-a-jwt")).toEqual({});
    expect(decodeJWTPayload("")).toEqual({});
    expect(decodeJWTPayload("a.b")).toEqual({});
  });
});
