import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { CloudClient, CloudClientError } from "./client";
import type { KCodeCloudConfig, CloudAuthResult, CloudTeam, TeamAnalytics, TeamPolicies } from "./types";

// ─── Test fixtures ─────────────────────────────────────────────

const TEST_CONFIG: KCodeCloudConfig = {
  url: "https://cloud.kulvex.ai",
  token: "test-token-abc123",
  teamId: "team-001",
  features: {
    sessionSync: true,
    sharedMemory: true,
    analytics: true,
    policies: true,
    audit: true,
  },
};

const TEST_TEAM: CloudTeam = {
  id: "team-001",
  name: "Test Team",
  members: [
    {
      id: "user-001",
      email: "owner@example.com",
      name: "Owner",
      role: "owner",
      joinedAt: "2026-01-01T00:00:00Z",
      lastActive: "2026-03-31T12:00:00Z",
    },
  ],
  plan: "team",
  usage: {
    sessionsThisMonth: 100,
    tokensThisMonth: 500000,
    storageUsedMb: 50,
  },
  limits: {
    maxMembers: 10,
    maxSessions: 1000,
    maxStorageMb: 500,
    maxTokensPerMonth: 5000000,
  },
};

const TEST_ANALYTICS: TeamAnalytics = {
  period: "month",
  totalSessions: 150,
  totalTokens: 750000,
  totalCostUsd: 25.5,
  activeMembers: 4,
  topModels: [
    { model: "llama-3", sessions: 80 },
    { model: "gpt-4", sessions: 70 },
  ],
  topTools: [
    { tool: "Read", count: 300 },
    { tool: "Edit", count: 200 },
  ],
};

const TEST_POLICIES: TeamPolicies = {
  allowedModels: ["llama-3", "gpt-4"],
  maxCostPerSession: 5.0,
  requireReview: false,
  auditEnabled: true,
  sessionRetentionDays: 90,
};

// ─── Helpers ───────────────────────────────────────────────────

let fetchMock: ReturnType<typeof mock>;
const originalFetch = globalThis.fetch;

function mockFetchResponse(data: any, status = 200) {
  return mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

function mockFetchError(status: number, body = "Error") {
  return mock(() =>
    Promise.resolve(
      new Response(body, {
        status,
        headers: { "Content-Type": "text/plain" },
      }),
    ),
  );
}

// ─── Tests ─────────────────────────────────────────────────────

describe("CloudClient", () => {
  beforeEach(() => {
    fetchMock = mockFetchResponse({});
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("isConfigured", () => {
    test("returns true when config is provided", () => {
      const client = new CloudClient(TEST_CONFIG);
      expect(client.isConfigured()).toBe(true);
    });

    test("returns false when no config is provided", () => {
      const client = new CloudClient();
      expect(client.isConfigured()).toBe(false);
    });
  });

  describe("getConfig", () => {
    test("returns config when provided", () => {
      const client = new CloudClient(TEST_CONFIG);
      expect(client.getConfig()).toEqual(TEST_CONFIG);
    });

    test("returns null when no config", () => {
      const client = new CloudClient();
      expect(client.getConfig()).toBeNull();
    });
  });

  describe("login", () => {
    test("authenticates and returns auth result", async () => {
      const authResult: CloudAuthResult = {
        token: "new-token-xyz",
        teamId: "team-002",
        expiresAt: "2026-04-30T00:00:00Z",
      };
      globalThis.fetch = mockFetchResponse(authResult) as any;

      // Use a config with url but we need to avoid saving to disk
      const client = new CloudClient(TEST_CONFIG);
      const result = await client.login("user@example.com", "password123");

      expect(result.token).toBe("new-token-xyz");
      expect(result.teamId).toBe("team-002");
      expect(result.expiresAt).toBe("2026-04-30T00:00:00Z");
    });

    test("sends correct request body", async () => {
      const authResult: CloudAuthResult = {
        token: "tok",
        teamId: "t",
        expiresAt: "2026-12-31T00:00:00Z",
      };
      const fetchFn = mockFetchResponse(authResult);
      globalThis.fetch = fetchFn as any;

      const client = new CloudClient(TEST_CONFIG);
      await client.login("test@test.com", "pass");

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://cloud.kulvex.ai/api/v1/auth/login");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body as string);
      expect(body.email).toBe("test@test.com");
      expect(body.password).toBe("pass");
    });

    test("throws on 401 invalid credentials", async () => {
      globalThis.fetch = mockFetchError(401, "Unauthorized") as any;

      const client = new CloudClient(TEST_CONFIG);
      await expect(
        client.login("bad@example.com", "wrong"),
      ).rejects.toThrow("Invalid email or password");
    });

    test("throws on server error during login", async () => {
      globalThis.fetch = mockFetchError(500, "Internal Server Error") as any;

      const client = new CloudClient(TEST_CONFIG);
      await expect(
        client.login("user@example.com", "pass"),
      ).rejects.toThrow("Login failed");
    });
  });

  describe("getTeam", () => {
    test("returns parsed team data", async () => {
      globalThis.fetch = mockFetchResponse(TEST_TEAM) as any;

      const client = new CloudClient(TEST_CONFIG);
      const team = await client.getTeam();

      expect(team.id).toBe("team-001");
      expect(team.name).toBe("Test Team");
      expect(team.plan).toBe("team");
      expect(team.members).toHaveLength(1);
      expect(team.members[0].role).toBe("owner");
      expect(team.usage.sessionsThisMonth).toBe(100);
      expect(team.limits.maxSessions).toBe(1000);
    });

    test("calls correct endpoint", async () => {
      const fetchFn = mockFetchResponse(TEST_TEAM);
      globalThis.fetch = fetchFn as any;

      const client = new CloudClient(TEST_CONFIG);
      await client.getTeam();

      const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://cloud.kulvex.ai/api/v1/teams/team-001");
    });
  });

  describe("inviteMember", () => {
    test("sends correct invite request", async () => {
      const fetchFn = mockFetchResponse({});
      globalThis.fetch = fetchFn as any;

      const client = new CloudClient(TEST_CONFIG);
      await client.inviteMember("new@example.com", "admin");

      const [url, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "https://cloud.kulvex.ai/api/v1/teams/team-001/members",
      );
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body as string);
      expect(body.email).toBe("new@example.com");
      expect(body.role).toBe("admin");
    });

    test("defaults role to member", async () => {
      const fetchFn = mockFetchResponse({});
      globalThis.fetch = fetchFn as any;

      const client = new CloudClient(TEST_CONFIG);
      await client.inviteMember("new@example.com");

      const [, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.role).toBe("member");
    });
  });

  describe("removeMember", () => {
    test("sends DELETE request with member ID", async () => {
      const fetchFn = mockFetchResponse({});
      globalThis.fetch = fetchFn as any;

      const client = new CloudClient(TEST_CONFIG);
      await client.removeMember("user-042");

      const [url, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "https://cloud.kulvex.ai/api/v1/teams/team-001/members/user-042",
      );
      expect(opts.method).toBe("DELETE");
    });
  });

  describe("request helper", () => {
    test("adds Authorization header", async () => {
      const fetchFn = mockFetchResponse({ ok: true });
      globalThis.fetch = fetchFn as any;

      const client = new CloudClient(TEST_CONFIG);
      await client.request("GET", "/api/v1/test");

      const [, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-token-abc123");
    });

    test("adds Content-Type and User-Agent headers", async () => {
      const fetchFn = mockFetchResponse({ ok: true });
      globalThis.fetch = fetchFn as any;

      const client = new CloudClient(TEST_CONFIG);
      await client.request("GET", "/api/v1/test");

      const [, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["User-Agent"]).toBe("kcode-cli");
    });

    test("includes body for POST requests", async () => {
      const fetchFn = mockFetchResponse({ ok: true });
      globalThis.fetch = fetchFn as any;

      const client = new CloudClient(TEST_CONFIG);
      await client.request("POST", "/api/v1/test", { foo: "bar" });

      const [, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(opts.body as string)).toEqual({ foo: "bar" });
    });

    test("omits body for GET requests", async () => {
      const fetchFn = mockFetchResponse({ ok: true });
      globalThis.fetch = fetchFn as any;

      const client = new CloudClient(TEST_CONFIG);
      await client.request("GET", "/api/v1/test");

      const [, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(opts.body).toBeUndefined();
    });
  });

  describe("error handling", () => {
    test("throws CloudClientError on 403", async () => {
      globalThis.fetch = mockFetchError(403) as any;

      const client = new CloudClient(TEST_CONFIG);
      try {
        await client.request("GET", "/api/v1/secret");
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(CloudClientError);
        expect((err as CloudClientError).statusCode).toBe(403);
        expect((err as CloudClientError).message).toContain("Permission denied");
      }
    });

    test("throws descriptive error on 401", async () => {
      globalThis.fetch = mockFetchError(401) as any;

      const client = new CloudClient(TEST_CONFIG);
      await expect(
        client.request("GET", "/api/v1/data"),
      ).rejects.toThrow("Authentication expired");
    });

    test("throws descriptive error on 404", async () => {
      globalThis.fetch = mockFetchError(404) as any;

      const client = new CloudClient(TEST_CONFIG);
      await expect(
        client.request("GET", "/api/v1/missing"),
      ).rejects.toThrow("Resource not found");
    });

    test("throws descriptive error on 429", async () => {
      globalThis.fetch = mockFetchError(429) as any;

      const client = new CloudClient(TEST_CONFIG);
      await expect(
        client.request("GET", "/api/v1/data"),
      ).rejects.toThrow("Rate limit exceeded");
    });

    test("throws descriptive error on 500", async () => {
      globalThis.fetch = mockFetchError(500) as any;

      const client = new CloudClient(TEST_CONFIG);
      await expect(
        client.request("GET", "/api/v1/data"),
      ).rejects.toThrow("Cloud service error");
    });

    test("throws network error when fetch fails", async () => {
      globalThis.fetch = mock(() =>
        Promise.reject(new Error("ECONNREFUSED")),
      ) as any;

      const client = new CloudClient(TEST_CONFIG);
      await expect(
        client.request("GET", "/api/v1/data"),
      ).rejects.toThrow("unable to connect");
    });
  });

  describe("getAnalytics", () => {
    test("returns analytics for day period", async () => {
      globalThis.fetch = mockFetchResponse(TEST_ANALYTICS) as any;

      const client = new CloudClient(TEST_CONFIG);
      const analytics = await client.getAnalytics("day");

      expect(analytics.totalSessions).toBe(150);
      expect(analytics.topModels).toHaveLength(2);
    });

    test("passes period as query param", async () => {
      const fetchFn = mockFetchResponse(TEST_ANALYTICS);
      globalThis.fetch = fetchFn as any;

      const client = new CloudClient(TEST_CONFIG);
      await client.getAnalytics("week");

      const [url] = fetchFn.mock.calls[0] as [string];
      expect(url).toContain("period=week");
    });

    test("returns analytics for month period", async () => {
      globalThis.fetch = mockFetchResponse(TEST_ANALYTICS) as any;

      const client = new CloudClient(TEST_CONFIG);
      const analytics = await client.getAnalytics("month");

      expect(analytics.totalCostUsd).toBe(25.5);
      expect(analytics.activeMembers).toBe(4);
      expect(analytics.topTools).toHaveLength(2);
    });
  });

  describe("getPolicies", () => {
    test("returns team policies", async () => {
      globalThis.fetch = mockFetchResponse(TEST_POLICIES) as any;

      const client = new CloudClient(TEST_CONFIG);
      const policies = await client.getPolicies();

      expect(policies.allowedModels).toEqual(["llama-3", "gpt-4"]);
      expect(policies.maxCostPerSession).toBe(5.0);
      expect(policies.auditEnabled).toBe(true);
    });
  });

  describe("updatePolicies", () => {
    test("sends PATCH with partial policies", async () => {
      const fetchFn = mockFetchResponse({});
      globalThis.fetch = fetchFn as any;

      const client = new CloudClient(TEST_CONFIG);
      await client.updatePolicies({ requireReview: true });

      const [url, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/policies");
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body as string);
      expect(body.requireReview).toBe(true);
    });
  });
});
