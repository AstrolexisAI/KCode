import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { BillingManager } from "./billing";
import { CloudClient } from "./client";
import type { CloudTeam, KCodeCloudConfig } from "./types";

// ─── Test fixtures ─────────────────────────────────────────────

const TEST_CONFIG: KCodeCloudConfig = {
  url: "https://cloud.kulvex.ai",
  token: "test-token",
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
  members: [],
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

// ─── Tests ─────────────────────────────────────────────────────

describe("BillingManager", () => {
  let client: CloudClient;
  let billing: BillingManager;

  beforeEach(() => {
    globalThis.fetch = mockFetchResponse(TEST_TEAM) as any;
    client = new CloudClient(TEST_CONFIG);
    billing = new BillingManager(client);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("getUsage", () => {
    test("returns team usage from cloud", async () => {
      const usage = await billing.getUsage();
      expect(usage.sessionsThisMonth).toBe(100);
      expect(usage.tokensThisMonth).toBe(500000);
      expect(usage.storageUsedMb).toBe(50);
    });
  });

  describe("isWithinLimits", () => {
    test("returns true when all metrics are within limits", () => {
      const usage = { sessionsThisMonth: 100, tokensThisMonth: 500000, storageUsedMb: 50 };
      const limits = {
        maxMembers: 10,
        maxSessions: 1000,
        maxStorageMb: 500,
        maxTokensPerMonth: 5000000,
      };
      expect(billing.isWithinLimits(usage, limits)).toBe(true);
    });

    test("returns false when sessions exceed limit", () => {
      const usage = { sessionsThisMonth: 1001, tokensThisMonth: 100, storageUsedMb: 10 };
      const limits = {
        maxMembers: 10,
        maxSessions: 1000,
        maxStorageMb: 500,
        maxTokensPerMonth: 5000000,
      };
      expect(billing.isWithinLimits(usage, limits)).toBe(false);
    });

    test("returns false when tokens exceed limit", () => {
      const usage = { sessionsThisMonth: 10, tokensThisMonth: 6000000, storageUsedMb: 10 };
      const limits = {
        maxMembers: 10,
        maxSessions: 1000,
        maxStorageMb: 500,
        maxTokensPerMonth: 5000000,
      };
      expect(billing.isWithinLimits(usage, limits)).toBe(false);
    });

    test("returns false when storage exceeds limit", () => {
      const usage = { sessionsThisMonth: 10, tokensThisMonth: 100, storageUsedMb: 501 };
      const limits = {
        maxMembers: 10,
        maxSessions: 1000,
        maxStorageMb: 500,
        maxTokensPerMonth: 5000000,
      };
      expect(billing.isWithinLimits(usage, limits)).toBe(false);
    });
  });

  describe("checkLimits", () => {
    test("returns within=true with no warnings when well under limits", async () => {
      const lowUsageTeam = {
        ...TEST_TEAM,
        usage: { sessionsThisMonth: 10, tokensThisMonth: 1000, storageUsedMb: 5 },
      };
      globalThis.fetch = mockFetchResponse(lowUsageTeam) as any;
      client = new CloudClient(TEST_CONFIG);
      billing = new BillingManager(client);

      const result = await billing.checkLimits();
      expect(result.within).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test("returns warnings when sessions near 80% threshold", async () => {
      const nearLimitTeam = {
        ...TEST_TEAM,
        usage: { sessionsThisMonth: 850, tokensThisMonth: 100, storageUsedMb: 5 },
      };
      globalThis.fetch = mockFetchResponse(nearLimitTeam) as any;
      client = new CloudClient(TEST_CONFIG);
      billing = new BillingManager(client);

      const result = await billing.checkLimits();
      expect(result.within).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("Session usage");
    });

    test("returns warnings when tokens near 80% threshold", async () => {
      const nearLimitTeam = {
        ...TEST_TEAM,
        usage: { sessionsThisMonth: 10, tokensThisMonth: 4500000, storageUsedMb: 5 },
      };
      globalThis.fetch = mockFetchResponse(nearLimitTeam) as any;
      client = new CloudClient(TEST_CONFIG);
      billing = new BillingManager(client);

      const result = await billing.checkLimits();
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("Token usage");
    });

    test("returns warnings when storage near 80% threshold", async () => {
      const nearLimitTeam = {
        ...TEST_TEAM,
        usage: { sessionsThisMonth: 10, tokensThisMonth: 100, storageUsedMb: 420 },
      };
      globalThis.fetch = mockFetchResponse(nearLimitTeam) as any;
      client = new CloudClient(TEST_CONFIG);
      billing = new BillingManager(client);

      const result = await billing.checkLimits();
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("Storage usage");
    });

    test("returns within=false when over limits", async () => {
      const overLimitTeam = {
        ...TEST_TEAM,
        usage: { sessionsThisMonth: 1500, tokensThisMonth: 6000000, storageUsedMb: 600 },
      };
      globalThis.fetch = mockFetchResponse(overLimitTeam) as any;
      client = new CloudClient(TEST_CONFIG);
      billing = new BillingManager(client);

      const result = await billing.checkLimits();
      expect(result.within).toBe(false);
      expect(result.warnings.length).toBe(3);
    });
  });

  describe("formatUsage", () => {
    test("produces readable output with headers", () => {
      const usage = { sessionsThisMonth: 100, tokensThisMonth: 500000, storageUsedMb: 50 };
      const limits = {
        maxMembers: 10,
        maxSessions: 1000,
        maxStorageMb: 500,
        maxTokensPerMonth: 5000000,
      };

      const output = billing.formatUsage(usage, limits);
      expect(output).toContain("Cloud Usage Report");
      expect(output).toContain("Sessions:");
      expect(output).toContain("Tokens:");
      expect(output).toContain("Storage:");
      expect(output).toContain("10%");
    });

    test("includes percentage calculations", () => {
      const usage = { sessionsThisMonth: 500, tokensThisMonth: 2500000, storageUsedMb: 250 };
      const limits = {
        maxMembers: 10,
        maxSessions: 1000,
        maxStorageMb: 500,
        maxTokensPerMonth: 5000000,
      };

      const output = billing.formatUsage(usage, limits);
      expect(output).toContain("50%");
    });

    test("includes warnings section when near limits", () => {
      const usage = { sessionsThisMonth: 900, tokensThisMonth: 100, storageUsedMb: 5 };
      const limits = {
        maxMembers: 10,
        maxSessions: 1000,
        maxStorageMb: 500,
        maxTokensPerMonth: 5000000,
      };

      const output = billing.formatUsage(usage, limits);
      expect(output).toContain("Warnings:");
      expect(output).toContain("Session usage");
    });

    test("omits warnings section when well under limits", () => {
      const usage = { sessionsThisMonth: 10, tokensThisMonth: 100, storageUsedMb: 5 };
      const limits = {
        maxMembers: 10,
        maxSessions: 1000,
        maxStorageMb: 500,
        maxTokensPerMonth: 5000000,
      };

      const output = billing.formatUsage(usage, limits);
      expect(output).not.toContain("Warnings:");
    });
  });
});
