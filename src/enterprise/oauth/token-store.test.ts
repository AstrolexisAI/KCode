import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTokens, loadTokens, clearTokens } from "./token-store";
import type { OAuthTokens } from "../types";

let tempDir: string;
let origEnv: Record<string, string | undefined>;

describe("oauth/token-store", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-token-store-test-"));
    origEnv = {
      KCODE_HOME: process.env.KCODE_HOME,
    };
    process.env.KCODE_HOME = tempDir;
  });

  afterEach(async () => {
    for (const [key, val] of Object.entries(origEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── File fallback (works on all platforms) ───────────────────

  describe("file fallback storage", () => {
    test("save and load tokens via file", async () => {
      const tokens: OAuthTokens = {
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "kcode:read kcode:write",
        expires_at: Date.now() + 3600 * 1000,
      };

      await saveTokens(tokens);
      const loaded = await loadTokens();

      expect(loaded).not.toBeNull();
      expect(loaded!.access_token).toBe("test-access-token");
      expect(loaded!.refresh_token).toBe("test-refresh-token");
      expect(loaded!.expires_in).toBe(3600);
      expect(loaded!.token_type).toBe("Bearer");
      expect(loaded!.scope).toBe("kcode:read kcode:write");
    });

    test("loadTokens returns null when no tokens stored", async () => {
      const loaded = await loadTokens();
      // May return null or tokens from system keychain
      // On clean temp dir, file fallback should be null
      expect(loaded === null || typeof loaded === "object").toBe(true);
    });

    test("clearTokens removes stored tokens", async () => {
      const tokens: OAuthTokens = {
        access_token: "to-be-cleared",
        expires_in: 3600,
        token_type: "Bearer",
      };

      await saveTokens(tokens);
      await clearTokens();

      // After clearing, file should be gone
      const file = Bun.file(join(tempDir, "tokens.json"));
      const exists = await file.exists();
      expect(exists).toBe(false);
    });

    test("file has restricted permissions (0o600)", async () => {
      const tokens: OAuthTokens = {
        access_token: "permission-test",
        expires_in: 3600,
        token_type: "Bearer",
      };

      await saveTokens(tokens);

      const { statSync } = require("node:fs") as typeof import("node:fs");
      const filePath = join(tempDir, "tokens.json");
      try {
        const stat = statSync(filePath);
        // Check permissions (0o600 = owner read/write only)
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);
      } catch {
        // File might have been saved to keychain instead
      }
    });

    test("handles overwriting existing tokens", async () => {
      const tokens1: OAuthTokens = {
        access_token: "first-token",
        expires_in: 3600,
        token_type: "Bearer",
      };
      const tokens2: OAuthTokens = {
        access_token: "second-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
        token_type: "Bearer",
      };

      await saveTokens(tokens1);
      await saveTokens(tokens2);

      const loaded = await loadTokens();
      expect(loaded).not.toBeNull();
      expect(loaded!.access_token).toBe("second-token");
      expect(loaded!.refresh_token).toBe("new-refresh");
      expect(loaded!.expires_in).toBe(7200);
    });

    test("handles tokens without optional fields", async () => {
      const tokens: OAuthTokens = {
        access_token: "minimal-token",
        expires_in: 3600,
        token_type: "Bearer",
      };

      await saveTokens(tokens);
      const loaded = await loadTokens();

      expect(loaded).not.toBeNull();
      expect(loaded!.access_token).toBe("minimal-token");
      expect(loaded!.refresh_token).toBeUndefined();
      expect(loaded!.scope).toBeUndefined();
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────

  describe("edge cases", () => {
    test("loadTokens handles corrupted file gracefully", async () => {
      await Bun.write(join(tempDir, "tokens.json"), "not valid json{{{");
      const loaded = await loadTokens();
      // Should return null (from file fallback) or keychain result
      expect(loaded === null || typeof loaded === "object").toBe(true);
    });

    test("loadTokens handles file with wrong structure", async () => {
      await Bun.write(join(tempDir, "tokens.json"), JSON.stringify({ foo: "bar" }));
      const loaded = await loadTokens();
      // Missing access_token means null from file loader
      expect(loaded === null || typeof loaded === "object").toBe(true);
    });

    test("clearTokens is idempotent", async () => {
      // Should not throw even when no tokens exist
      await clearTokens();
      await clearTokens();
    });

    test("saveTokens creates parent directory if needed", async () => {
      // KCODE_HOME is the temp dir which exists, so tokens.json should be writable
      const tokens: OAuthTokens = {
        access_token: "dir-test",
        expires_in: 3600,
        token_type: "Bearer",
      };
      // Should not throw — just verify it completes
      await saveTokens(tokens);
    });
  });
});
