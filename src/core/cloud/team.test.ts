import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { TeamMemory, type TeamMemoryEntry } from "./team";
import { CloudClient } from "./client";
import type { KCodeCloudConfig, TeamAnalytics, TeamPolicies } from "./types";

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

function makeMemory(
  key: string,
  value: string,
  updatedAt: string,
  updatedBy = "user-001",
): TeamMemoryEntry {
  return {
    id: `mem-${key}`,
    key,
    value,
    scope: "team",
    updatedAt,
    updatedBy,
  };
}

// ─── Tests ─────────────────────────────────────────────────────

describe("TeamMemory", () => {
  let client: CloudClient;
  let teamMemory: TeamMemory;

  beforeEach(() => {
    globalThis.fetch = mockFetchResponse([]) as any;
    client = new CloudClient(TEST_CONFIG);
    teamMemory = new TeamMemory(client);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("mergeMemories", () => {
    test("keeps local-only entries", () => {
      const local = [makeMemory("key-a", "local-val", "2026-03-01T00:00:00Z")];
      const remote: TeamMemoryEntry[] = [];

      const result = teamMemory.mergeMemories(local, remote);
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe("key-a");
      expect(result[0].value).toBe("local-val");
    });

    test("keeps remote-only entries", () => {
      const local: TeamMemoryEntry[] = [];
      const remote = [
        makeMemory("key-b", "remote-val", "2026-03-15T00:00:00Z"),
      ];

      const result = teamMemory.mergeMemories(local, remote);
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe("key-b");
      expect(result[0].value).toBe("remote-val");
    });

    test("gives precedence to newer remote entry", () => {
      const local = [
        makeMemory("shared", "old-local", "2026-03-01T00:00:00Z"),
      ];
      const remote = [
        makeMemory("shared", "new-remote", "2026-03-15T00:00:00Z"),
      ];

      const result = teamMemory.mergeMemories(local, remote);
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe("new-remote");
    });

    test("keeps newer local entry over older remote", () => {
      const local = [
        makeMemory("shared", "new-local", "2026-03-20T00:00:00Z"),
      ];
      const remote = [
        makeMemory("shared", "old-remote", "2026-03-01T00:00:00Z"),
      ];

      const result = teamMemory.mergeMemories(local, remote);
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe("new-local");
    });

    test("remote wins on equal timestamps (tie-break)", () => {
      const timestamp = "2026-03-15T12:00:00Z";
      const local = [makeMemory("key-tie", "local-val", timestamp)];
      const remote = [makeMemory("key-tie", "remote-val", timestamp)];

      const result = teamMemory.mergeMemories(local, remote);
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe("remote-val");
    });

    test("merges multiple entries correctly", () => {
      const local = [
        makeMemory("only-local", "val-1", "2026-03-01T00:00:00Z"),
        makeMemory("shared-1", "local-old", "2026-03-01T00:00:00Z"),
        makeMemory("shared-2", "local-new", "2026-03-20T00:00:00Z"),
      ];
      const remote = [
        makeMemory("only-remote", "val-2", "2026-03-10T00:00:00Z"),
        makeMemory("shared-1", "remote-new", "2026-03-15T00:00:00Z"),
        makeMemory("shared-2", "remote-old", "2026-03-05T00:00:00Z"),
      ];

      const result = teamMemory.mergeMemories(local, remote);
      expect(result).toHaveLength(4);

      const byKey = new Map(result.map((r) => [r.key, r]));
      expect(byKey.get("only-local")!.value).toBe("val-1");
      expect(byKey.get("only-remote")!.value).toBe("val-2");
      expect(byKey.get("shared-1")!.value).toBe("remote-new");
      expect(byKey.get("shared-2")!.value).toBe("local-new");
    });

    test("handles empty inputs", () => {
      expect(teamMemory.mergeMemories([], [])).toEqual([]);
    });
  });

  describe("syncMemories", () => {
    test("uploads local memories and returns merged result", async () => {
      const remoteMemories = [
        makeMemory("remote-key", "remote-val", "2026-03-20T00:00:00Z"),
      ];
      globalThis.fetch = mockFetchResponse(remoteMemories) as any;
      client = new CloudClient(TEST_CONFIG);
      teamMemory = new TeamMemory(client);

      const localMemories = [
        makeMemory("local-key", "local-val", "2026-03-10T00:00:00Z"),
      ];

      const result = await teamMemory.syncMemories(localMemories);
      expect(result).toHaveLength(2);
    });

    test("sends local memories in request body", async () => {
      const fetchFn = mockFetchResponse([]);
      globalThis.fetch = fetchFn as any;
      client = new CloudClient(TEST_CONFIG);
      teamMemory = new TeamMemory(client);

      const localMemories = [
        makeMemory("k1", "v1", "2026-03-01T00:00:00Z"),
      ];

      await teamMemory.syncMemories(localMemories);

      const [, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].key).toBe("k1");
    });
  });

  describe("policy management", () => {
    test("getTeamPolicies delegates to client", async () => {
      const policies: TeamPolicies = {
        allowedModels: ["llama-3"],
        maxCostPerSession: 10,
        requireReview: true,
        auditEnabled: true,
        sessionRetentionDays: 30,
      };
      globalThis.fetch = mockFetchResponse(policies) as any;
      client = new CloudClient(TEST_CONFIG);
      teamMemory = new TeamMemory(client);

      const result = await teamMemory.getTeamPolicies();
      expect(result.allowedModels).toEqual(["llama-3"]);
      expect(result.requireReview).toBe(true);
    });

    test("updateTeamPolicies delegates to client", async () => {
      const fetchFn = mockFetchResponse({});
      globalThis.fetch = fetchFn as any;
      client = new CloudClient(TEST_CONFIG);
      teamMemory = new TeamMemory(client);

      await teamMemory.updateTeamPolicies({ maxCostPerSession: 20 });

      const [url, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/policies");
      expect(opts.method).toBe("PATCH");
    });
  });

  describe("analytics", () => {
    test("getTeamAnalytics delegates to client", async () => {
      const analytics: TeamAnalytics = {
        period: "week",
        totalSessions: 50,
        totalTokens: 200000,
        totalCostUsd: 8.5,
        activeMembers: 3,
        topModels: [{ model: "llama-3", sessions: 30 }],
        topTools: [{ tool: "Edit", count: 100 }],
      };
      globalThis.fetch = mockFetchResponse(analytics) as any;
      client = new CloudClient(TEST_CONFIG);
      teamMemory = new TeamMemory(client);

      const result = await teamMemory.getTeamAnalytics("week");
      expect(result.period).toBe("week");
      expect(result.totalSessions).toBe(50);
    });
  });
});
