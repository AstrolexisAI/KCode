import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRemoteSettingsCache,
  computeChecksum,
  fetchSettings,
  getRemoteSettings,
  loadFromCache,
  startPolling,
  stopPolling,
} from "./remote-settings";

let tempDir: string;
let origEnv: Record<string, string | undefined>;

describe("remote-settings", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-remote-settings-test-"));
    origEnv = {
      KCODE_HOME: process.env.KCODE_HOME,
      KCODE_SETTINGS_URL: process.env.KCODE_SETTINGS_URL,
      KCODE_SETTINGS_POLL_INTERVAL: process.env.KCODE_SETTINGS_POLL_INTERVAL,
      KCODE_AUTH_TOKEN: process.env.KCODE_AUTH_TOKEN,
      KCODE_API_KEY: process.env.KCODE_API_KEY,
    };
    process.env.KCODE_HOME = tempDir;
    delete process.env.KCODE_SETTINGS_URL;
    delete process.env.KCODE_SETTINGS_POLL_INTERVAL;
    delete process.env.KCODE_AUTH_TOKEN;
    delete process.env.KCODE_API_KEY;
    clearRemoteSettingsCache();
  });

  afterEach(async () => {
    stopPolling();
    // Restore env
    for (const [key, val] of Object.entries(origEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    clearRemoteSettingsCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── computeChecksum ─────────────────────────────────────────

  describe("computeChecksum", () => {
    test("produces consistent hash for same input", async () => {
      const a = await computeChecksum({ model: "test", apiKey: "sk-123" });
      const b = await computeChecksum({ model: "test", apiKey: "sk-123" });
      expect(a).toBe(b);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    test("produces same hash regardless of key order", async () => {
      const a = await computeChecksum({ b: 2, a: 1 });
      const b = await computeChecksum({ a: 1, b: 2 });
      expect(a).toBe(b);
    });

    test("produces different hash for different input", async () => {
      const a = await computeChecksum({ model: "a" });
      const b = await computeChecksum({ model: "b" });
      expect(a).not.toBe(b);
    });
  });

  // ─── loadFromCache / getRemoteSettings ────────────────────────

  describe("cache loading", () => {
    test("returns null when no cache file exists", async () => {
      const result = await loadFromCache();
      expect(result).toBeNull();
    });

    test("loads valid cache file", async () => {
      const cache = {
        etag: "sha256:abc123",
        response: {
          version: "2026-03-31T10:00:00Z",
          checksum: "sha256:abc123",
          settings: { model: "test-model" },
        },
        fetchedAt: "2026-03-31T10:00:00Z",
      };
      await Bun.write(join(tempDir, "remote-settings.json"), JSON.stringify(cache));

      const result = await loadFromCache();
      expect(result).not.toBeNull();
      expect(result!.response.settings.model).toBe("test-model");
    });

    test("getRemoteSettings returns empty object when no cache", async () => {
      const settings = await getRemoteSettings();
      expect(settings).toEqual({});
    });

    test("getRemoteSettings returns cached settings", async () => {
      const cache = {
        etag: "sha256:abc123",
        response: {
          version: "2026-03-31T10:00:00Z",
          checksum: "sha256:abc123",
          settings: { model: "cached-model", maxBudgetUsd: 50 },
        },
        fetchedAt: "2026-03-31T10:00:00Z",
      };
      await Bun.write(join(tempDir, "remote-settings.json"), JSON.stringify(cache));

      const settings = await getRemoteSettings();
      expect(settings.model).toBe("cached-model");
      expect(settings.maxBudgetUsd).toBe(50);
    });

    test("returns null for invalid cache JSON", async () => {
      await Bun.write(join(tempDir, "remote-settings.json"), "not json");
      const result = await loadFromCache();
      expect(result).toBeNull();
    });

    test("returns null for cache missing required fields", async () => {
      await Bun.write(join(tempDir, "remote-settings.json"), JSON.stringify({ foo: "bar" }));
      const result = await loadFromCache();
      expect(result).toBeNull();
    });
  });

  // ─── fetchSettings ────────────────────────────────────────────

  describe("fetchSettings", () => {
    test("returns null when KCODE_SETTINGS_URL is not set", async () => {
      const result = await fetchSettings();
      expect(result).toBeNull();
    });

    test("handles 200 response with valid settings", async () => {
      const mockResponse = {
        version: "2026-03-31T10:00:00Z",
        checksum: "sha256:test",
        settings: { model: "remote-model", permissionMode: "auto" },
      };

      // Start a local HTTP server to mock the settings endpoint
      const server = Bun.serve({
        port: 19500,
        hostname: "127.0.0.1",
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/api/v1/settings") {
            return new Response(JSON.stringify(mockResponse), {
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response("Not found", { status: 404 });
        },
      });

      try {
        process.env.KCODE_SETTINGS_URL = "http://127.0.0.1:19500";
        const result = await fetchSettings();
        expect(result).not.toBeNull();
        expect(result!.settings.model).toBe("remote-model");

        // Verify cache was written
        clearRemoteSettingsCache();
        const cached = await loadFromCache();
        expect(cached).not.toBeNull();
        expect(cached!.response.settings.model).toBe("remote-model");
      } finally {
        server.stop(true);
      }
    });

    test("handles 304 Not Modified", async () => {
      // Pre-populate cache
      const cache = {
        etag: "sha256:abc123",
        response: {
          version: "2026-03-31T10:00:00Z",
          checksum: "sha256:abc123",
          settings: { model: "cached-model" },
        },
        fetchedAt: "2026-03-31T10:00:00Z",
      };
      await Bun.write(join(tempDir, "remote-settings.json"), JSON.stringify(cache));

      const server = Bun.serve({
        port: 19501,
        hostname: "127.0.0.1",
        fetch(req) {
          if (req.headers.get("If-None-Match")) {
            return new Response(null, { status: 304 });
          }
          return new Response("Unexpected", { status: 500 });
        },
      });

      try {
        process.env.KCODE_SETTINGS_URL = "http://127.0.0.1:19501";
        const result = await fetchSettings();
        expect(result).not.toBeNull();
        expect(result!.settings.model).toBe("cached-model");
      } finally {
        server.stop(true);
      }
    });

    test("handles 204 No Content", async () => {
      const server = Bun.serve({
        port: 19502,
        hostname: "127.0.0.1",
        fetch() {
          return new Response(null, { status: 204 });
        },
      });

      try {
        process.env.KCODE_SETTINGS_URL = "http://127.0.0.1:19502";
        const result = await fetchSettings();
        expect(result).not.toBeNull();
        expect(result!.settings).toEqual({});
      } finally {
        server.stop(true);
      }
    });

    test("handles 404 Not Found", async () => {
      const server = Bun.serve({
        port: 19503,
        hostname: "127.0.0.1",
        fetch() {
          return new Response("Not found", { status: 404 });
        },
      });

      try {
        process.env.KCODE_SETTINGS_URL = "http://127.0.0.1:19503";
        const result = await fetchSettings();
        expect(result).not.toBeNull();
        expect(result!.settings).toEqual({});
      } finally {
        server.stop(true);
      }
    });

    test("handles 401 without retry", async () => {
      let requestCount = 0;
      const server = Bun.serve({
        port: 19504,
        hostname: "127.0.0.1",
        fetch() {
          requestCount++;
          return new Response("Unauthorized", { status: 401 });
        },
      });

      try {
        process.env.KCODE_SETTINGS_URL = "http://127.0.0.1:19504";
        const result = await fetchSettings();
        expect(result).toBeNull();
        // Should only make 1 request (no retry for 401)
        expect(requestCount).toBe(1);
      } finally {
        server.stop(true);
      }
    });

    test("handles 403 without retry", async () => {
      let requestCount = 0;
      const server = Bun.serve({
        port: 19505,
        hostname: "127.0.0.1",
        fetch() {
          requestCount++;
          return new Response("Forbidden", { status: 403 });
        },
      });

      try {
        process.env.KCODE_SETTINGS_URL = "http://127.0.0.1:19505";
        const result = await fetchSettings();
        expect(result).toBeNull();
        expect(requestCount).toBe(1);
      } finally {
        server.stop(true);
      }
    });

    test("sends auth header when KCODE_AUTH_TOKEN is set", async () => {
      let receivedAuth: string | null = null;
      const server = Bun.serve({
        port: 19506,
        hostname: "127.0.0.1",
        fetch(req) {
          receivedAuth = req.headers.get("Authorization");
          return new Response(
            JSON.stringify({
              version: "v1",
              checksum: "test",
              settings: {},
            }),
          );
        },
      });

      try {
        process.env.KCODE_SETTINGS_URL = "http://127.0.0.1:19506";
        process.env.KCODE_AUTH_TOKEN = "test-token-123";
        await fetchSettings();
        expect(receivedAuth).toBe("Bearer test-token-123");
      } finally {
        server.stop(true);
      }
    });

    test("sends X-KCode-OS header", async () => {
      let receivedOS: string | null = null;
      const server = Bun.serve({
        port: 19507,
        hostname: "127.0.0.1",
        fetch(req) {
          receivedOS = req.headers.get("X-KCode-OS");
          return new Response(
            JSON.stringify({
              version: "v1",
              checksum: "test",
              settings: {},
            }),
          );
        },
      });

      try {
        process.env.KCODE_SETTINGS_URL = "http://127.0.0.1:19507";
        await fetchSettings();
        expect(receivedOS).toBe(process.platform);
      } finally {
        server.stop(true);
      }
    });

    test("ignores invalid response body", async () => {
      const server = Bun.serve({
        port: 19508,
        hostname: "127.0.0.1",
        fetch() {
          return new Response(JSON.stringify({ invalid: true }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      });

      try {
        process.env.KCODE_SETTINGS_URL = "http://127.0.0.1:19508";
        const result = await fetchSettings();
        // Should return null since response has no .settings field
        expect(result).toBeNull();
      } finally {
        server.stop(true);
      }
    });
  });

  // ─── Polling ──────────────────────────────────────────────────

  describe("polling", () => {
    test("startPolling and stopPolling do not throw", () => {
      expect(() => startPolling()).not.toThrow();
      expect(() => stopPolling()).not.toThrow();
    });

    test("stopPolling is idempotent", () => {
      expect(() => stopPolling()).not.toThrow();
      expect(() => stopPolling()).not.toThrow();
    });

    test("startPolling is idempotent", () => {
      expect(() => {
        startPolling();
        startPolling(); // Should not create a second timer
      }).not.toThrow();
      stopPolling();
    });
  });

  // ─── clearRemoteSettingsCache ─────────────────────────────────

  describe("clearRemoteSettingsCache", () => {
    test("clears in-memory cache", async () => {
      // Load cache into memory
      const cache = {
        etag: "sha256:abc123",
        response: {
          version: "v1",
          checksum: "sha256:abc123",
          settings: { model: "cached" },
        },
        fetchedAt: "2026-03-31T10:00:00Z",
      };
      await Bun.write(join(tempDir, "remote-settings.json"), JSON.stringify(cache));
      await loadFromCache(); // Load into memory

      clearRemoteSettingsCache();

      // After clearing, it should re-read from disk
      const result = await loadFromCache();
      expect(result).not.toBeNull(); // Still on disk
    });
  });
});
