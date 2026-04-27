import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPolicyCache,
  fetchPolicyLimits,
  getPolicyLimit,
  isPolicyAllowed,
  loadPolicyCache,
} from "./policy-limits";

let tempDir: string;
let origEnv: Record<string, string | undefined>;

describe("policy-limits", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-policy-limits-test-"));
    origEnv = {
      KCODE_HOME: process.env.KCODE_HOME,
      KCODE_SETTINGS_URL: process.env.KCODE_SETTINGS_URL,
      KCODE_POLICY_FAIL_MODE: process.env.KCODE_POLICY_FAIL_MODE,
      KCODE_AUTH_TOKEN: process.env.KCODE_AUTH_TOKEN,
      KCODE_API_KEY: process.env.KCODE_API_KEY,
    };
    process.env.KCODE_HOME = tempDir;
    delete process.env.KCODE_SETTINGS_URL;
    delete process.env.KCODE_POLICY_FAIL_MODE;
    delete process.env.KCODE_AUTH_TOKEN;
    delete process.env.KCODE_API_KEY;
    clearPolicyCache();
  });

  afterEach(async () => {
    for (const [key, val] of Object.entries(origEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    clearPolicyCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Cache loading ────────────────────────────────────────────

  describe("cache", () => {
    test("returns null when no cache exists", async () => {
      const result = await loadPolicyCache();
      expect(result).toBeNull();
    });

    test("loads valid cache", async () => {
      const cache = {
        etag: "sha256:test",
        response: {
          restrictions: {
            allow_web_access: { allowed: true },
            allow_feedback: { allowed: false },
          },
        },
        fetchedAt: "2026-03-31T10:00:00Z",
      };
      await Bun.write(join(tempDir, "policy-limits.json"), JSON.stringify(cache));

      const result = await loadPolicyCache();
      expect(result).not.toBeNull();
      expect(result!.response.restrictions.allow_web_access!.allowed).toBe(true);
      expect(result!.response.restrictions.allow_feedback!.allowed).toBe(false);
    });

    test("returns null for invalid cache", async () => {
      await Bun.write(join(tempDir, "policy-limits.json"), "not json");
      const result = await loadPolicyCache();
      expect(result).toBeNull();
    });
  });

  // ─── isPolicyAllowed ──────────────────────────────────────────

  describe("isPolicyAllowed", () => {
    test("allows non-critical policy when no cache (fail-open)", async () => {
      const result = await isPolicyAllowed("allow_web_access");
      expect(result).toBe(true);
    });

    test("denies critical policy when no cache (fail-open)", async () => {
      const result = await isPolicyAllowed("allow_feedback");
      expect(result).toBe(false);
    });

    test("denies all policies when no cache and fail-closed mode", async () => {
      process.env.KCODE_POLICY_FAIL_MODE = "closed";
      const result = await isPolicyAllowed("allow_web_access");
      expect(result).toBe(false);
    });

    test("respects cached restriction (allowed)", async () => {
      const cache = {
        etag: "test",
        response: {
          restrictions: {
            allow_web_access: { allowed: true },
          },
        },
        fetchedAt: new Date().toISOString(),
      };
      await Bun.write(join(tempDir, "policy-limits.json"), JSON.stringify(cache));

      const result = await isPolicyAllowed("allow_web_access");
      expect(result).toBe(true);
    });

    test("respects cached restriction (denied)", async () => {
      const cache = {
        etag: "test",
        response: {
          restrictions: {
            allow_web_access: { allowed: false },
          },
        },
        fetchedAt: new Date().toISOString(),
      };
      await Bun.write(join(tempDir, "policy-limits.json"), JSON.stringify(cache));

      const result = await isPolicyAllowed("allow_web_access");
      expect(result).toBe(false);
    });

    test("allows unknown policy when cache exists", async () => {
      const cache = {
        etag: "test",
        response: {
          restrictions: {
            allow_web_access: { allowed: false },
          },
        },
        fetchedAt: new Date().toISOString(),
      };
      await Bun.write(join(tempDir, "policy-limits.json"), JSON.stringify(cache));

      const result = await isPolicyAllowed("some_unknown_policy");
      expect(result).toBe(true);
    });
  });

  // ─── getPolicyLimit ───────────────────────────────────────────

  describe("getPolicyLimit", () => {
    test("returns undefined when no cache", async () => {
      const result = await getPolicyLimit("max_sessions_per_day");
      expect(result).toBeUndefined();
    });

    test("returns limit value from cache", async () => {
      const cache = {
        etag: "test",
        response: {
          restrictions: {
            max_sessions_per_day: { allowed: true, limit: 50 },
            max_tokens_per_day: { allowed: true, limit: 1000000 },
          },
        },
        fetchedAt: new Date().toISOString(),
      };
      await Bun.write(join(tempDir, "policy-limits.json"), JSON.stringify(cache));

      expect(await getPolicyLimit("max_sessions_per_day")).toBe(50);
      expect(await getPolicyLimit("max_tokens_per_day")).toBe(1000000);
    });

    test("returns undefined for unknown policy", async () => {
      const cache = {
        etag: "test",
        response: {
          restrictions: {
            max_sessions_per_day: { allowed: true, limit: 50 },
          },
        },
        fetchedAt: new Date().toISOString(),
      };
      await Bun.write(join(tempDir, "policy-limits.json"), JSON.stringify(cache));

      expect(await getPolicyLimit("unknown_policy")).toBeUndefined();
    });

    test("returns undefined when restriction has no limit field", async () => {
      const cache = {
        etag: "test",
        response: {
          restrictions: {
            allow_web_access: { allowed: true },
          },
        },
        fetchedAt: new Date().toISOString(),
      };
      await Bun.write(join(tempDir, "policy-limits.json"), JSON.stringify(cache));

      expect(await getPolicyLimit("allow_web_access")).toBeUndefined();
    });
  });

  // ─── fetchPolicyLimits ────────────────────────────────────────

  describe("fetchPolicyLimits", () => {
    test("returns null when KCODE_SETTINGS_URL is not set", async () => {
      const result = await fetchPolicyLimits();
      expect(result).toBeNull();
    });

    test("handles 200 response", async () => {
      const mockResponse = {
        restrictions: {
          allow_web_access: { allowed: false },
          max_sessions_per_day: { allowed: true, limit: 100 },
        },
      };

      const server = Bun.serve({
        port: 19510,
        hostname: "127.0.0.1",
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/api/v1/policy-limits") {
            return new Response(JSON.stringify(mockResponse));
          }
          return new Response("Not found", { status: 404 });
        },
      });

      try {
        process.env.KCODE_SETTINGS_URL = "http://127.0.0.1:19510";
        const result = await fetchPolicyLimits();
        expect(result).not.toBeNull();
        expect(result!.restrictions.allow_web_access!.allowed).toBe(false);
        expect(result!.restrictions.max_sessions_per_day!.limit).toBe(100);

        // Verify cache was written
        clearPolicyCache();
        const cached = await loadPolicyCache();
        expect(cached).not.toBeNull();
      } finally {
        server.stop(true);
      }
    });

    test("handles 204 No Content", async () => {
      const server = Bun.serve({
        port: 19511,
        hostname: "127.0.0.1",
        fetch() {
          return new Response(null, { status: 204 });
        },
      });

      try {
        process.env.KCODE_SETTINGS_URL = "http://127.0.0.1:19511";
        const result = await fetchPolicyLimits();
        expect(result).not.toBeNull();
        expect(result!.restrictions).toEqual({});
      } finally {
        server.stop(true);
      }
    });

    test("handles 401 without retry", async () => {
      let requestCount = 0;
      const server = Bun.serve({
        port: 19512,
        hostname: "127.0.0.1",
        fetch() {
          requestCount++;
          return new Response("Unauthorized", { status: 401 });
        },
      });

      try {
        process.env.KCODE_SETTINGS_URL = "http://127.0.0.1:19512";
        await fetchPolicyLimits();
        expect(requestCount).toBe(1);
      } finally {
        server.stop(true);
      }
    });
  });

  // ─── clearPolicyCache ─────────────────────────────────────────

  describe("clearPolicyCache", () => {
    test("allows re-reading from disk", async () => {
      const cache = {
        etag: "test",
        response: { restrictions: { test: { allowed: true } } },
        fetchedAt: new Date().toISOString(),
      };
      await Bun.write(join(tempDir, "policy-limits.json"), JSON.stringify(cache));

      await loadPolicyCache(); // Load into memory
      clearPolicyCache();

      const result = await loadPolicyCache();
      expect(result).not.toBeNull();
    });
  });
});
