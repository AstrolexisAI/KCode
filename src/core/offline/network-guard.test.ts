import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initOfflineMode, OfflineMode, resetOfflineMode } from "./mode";
import { isLocalHost, OfflineError, offlineAwareFetch } from "./network-guard";

describe("network-guard", () => {
  afterEach(() => {
    resetOfflineMode();
  });

  // ─── isLocalHost ─────────────────────────────────────────────

  describe("isLocalHost", () => {
    test("localhost is local", () => {
      expect(isLocalHost("http://localhost:10091/health")).toBe(true);
    });

    test("127.0.0.1 is local", () => {
      expect(isLocalHost("http://127.0.0.1:11434/api/tags")).toBe(true);
    });

    test("::1 is local", () => {
      expect(isLocalHost("http://[::1]:8080/")).toBe(true);
    });

    test("0.0.0.0 is local", () => {
      expect(isLocalHost("http://0.0.0.0:10091/v1/models")).toBe(true);
    });

    test("192.168.x.x is local", () => {
      expect(isLocalHost("http://192.168.1.100:8080/")).toBe(true);
    });

    test("10.x.x.x is local", () => {
      expect(isLocalHost("http://10.0.0.5:3000/")).toBe(true);
    });

    test("172.16.x.x is local", () => {
      expect(isLocalHost("http://172.16.0.1:8080/")).toBe(true);
    });

    test("172.31.x.x is local", () => {
      expect(isLocalHost("http://172.31.255.255:80/")).toBe(true);
    });

    test("172.15.x.x is NOT local", () => {
      expect(isLocalHost("http://172.15.0.1:80/")).toBe(false);
    });

    test("172.32.x.x is NOT local", () => {
      expect(isLocalHost("http://172.32.0.1:80/")).toBe(false);
    });

    test("public host is not local", () => {
      expect(isLocalHost("https://api.openai.com/v1/chat")).toBe(false);
    });

    test("another public host", () => {
      expect(isLocalHost("https://plugins.kulvex.ai/api/v1")).toBe(false);
    });

    test("invalid URL returns false", () => {
      expect(isLocalHost("not a url")).toBe(false);
    });
  });

  // ─── OfflineError ────────────────────────────────────────────

  describe("OfflineError", () => {
    test("is an instance of Error", () => {
      const err = new OfflineError("test");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("OfflineError");
      expect(err.message).toBe("test");
    });
  });

  // ─── offlineAwareFetch ───────────────────────────────────────

  describe("offlineAwareFetch", () => {
    test("blocks remote URL when offline", async () => {
      initOfflineMode({ forced: true });

      try {
        await offlineAwareFetch("https://api.openai.com/v1/chat");
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(OfflineError);
        expect((err as OfflineError).message).toContain("api.openai.com");
        expect((err as OfflineError).message).toContain("offline mode active");
      }
    });

    test("allows localhost URL when offline", async () => {
      initOfflineMode({ forced: true });

      // This will likely fail with connection refused, but NOT with OfflineError
      try {
        await offlineAwareFetch("http://localhost:59999/nonexistent");
      } catch (err) {
        // Should be a network error, NOT an OfflineError
        expect(err).not.toBeInstanceOf(OfflineError);
      }
    });

    test("allows all URLs when online", async () => {
      // Default: not offline
      initOfflineMode();

      // This should not throw OfflineError — it will throw a network error
      try {
        await offlineAwareFetch("https://definitely-does-not-exist.example.invalid/test");
      } catch (err) {
        expect(err).not.toBeInstanceOf(OfflineError);
      }
    });

    test("handles URL object input", async () => {
      initOfflineMode({ forced: true });

      try {
        await offlineAwareFetch(new URL("https://example.com/test"));
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(OfflineError);
      }
    });
  });
});
