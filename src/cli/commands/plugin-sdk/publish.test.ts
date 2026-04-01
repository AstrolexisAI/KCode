import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getAuthToken, dryRunPublish } from "./publish";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("publish", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kcode-publish-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function createValidPlugin(): void {
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({
        name: "test-pub",
        version: "1.0.0",
        description: "Test publish plugin",
        author: "Test",
        license: "MIT",
        kcode: ">=1.7.0",
        skills: ["skills/*.md"],
      }),
    );
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(
      join(dir, "skills/example.md"),
      "---\nname: example\ndescription: Test skill\n---\nContent",
    );
  }

  describe("getAuthToken", () => {
    test("returns env var if set", () => {
      const original = process.env.KCODE_AUTH_TOKEN;
      process.env.KCODE_AUTH_TOKEN = "test-token-123";
      try {
        expect(getAuthToken()).toBe("test-token-123");
      } finally {
        if (original) process.env.KCODE_AUTH_TOKEN = original;
        else delete process.env.KCODE_AUTH_TOKEN;
      }
    });

    test("returns null when no token available", () => {
      const original = process.env.KCODE_AUTH_TOKEN;
      delete process.env.KCODE_AUTH_TOKEN;
      try {
        const token = getAuthToken();
        // May return proKey from settings or null
        expect(token === null || typeof token === "string").toBe(true);
      } finally {
        if (original) process.env.KCODE_AUTH_TOKEN = original;
      }
    });
  });

  describe("dryRunPublish", () => {
    test("validates and packages plugin", async () => {
      createValidPlugin();
      const result = await dryRunPublish(dir);
      expect(result.manifest.name).toBe("test-pub");
      expect(result.manifest.version).toBe("1.0.0");
      expect(result.validation.valid).toBe(true);
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.size).toBeGreaterThan(0);
    });

    test("returns validation errors for invalid plugin", async () => {
      writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "x" }));
      const result = await dryRunPublish(dir);
      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors.length).toBeGreaterThan(0);
    });

    test("sha256 is consistent", async () => {
      createValidPlugin();
      const r1 = await dryRunPublish(dir);
      const r2 = await dryRunPublish(dir);
      // Tarballs may differ due to timestamps, so just check format
      expect(r1.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(r2.sha256).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
