import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDNFetcher, IntegrityError } from "./cdn-fetcher";
import { SHATracker } from "./sha-tracker";

let tempDir: string;
let cacheDir: string;

/**
 * Helper: create a valid .tar.gz with a plugin.json inside.
 * Returns the tarball buffer and its SHA256 hash.
 */
async function createPluginTarball(
  name: string,
  version: string,
): Promise<{ buffer: Buffer; sha256: string }> {
  // Create a temporary directory with plugin.json
  const srcDir = join(tempDir, `.tarball-src-${name}`);
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "plugin.json"),
    JSON.stringify({ name, version, description: `Test plugin ${name}` }),
  );

  // Create tarball
  const tarPath = join(tempDir, `${name}.tar.gz`);
  const proc = Bun.spawnSync(["tar", "czf", tarPath, "-C", srcDir, "."], {
    cwd: tempDir,
  });
  if (proc.exitCode !== 0) throw new Error(`tar failed: ${proc.stderr.toString()}`);

  const buffer = Buffer.from(readFileSync(tarPath));
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buffer);
  const sha256 = hasher.digest("hex");

  return { buffer, sha256 };
}

describe("CDNFetcher", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-cdn-fetcher-test-"));
    cacheDir = join(tempDir, "cache");
    mkdirSync(cacheDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("IntegrityError is an Error with correct name", () => {
    const err = new IntegrityError("test error");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("IntegrityError");
    expect(err.message).toBe("test error");
  });

  test("constructor creates fetcher with proper config", () => {
    const fetcher = new CDNFetcher({
      cacheDir,
      cdnBaseUrl: "https://example.com/plugins",
      timeoutMs: 5000,
    });
    expect(fetcher).toBeDefined();
    expect(fetcher.getSHATracker()).toBeInstanceOf(SHATracker);
  });

  test("fetchPlugin returns from cache when SHA sentinel matches version", async () => {
    const fetcher = new CDNFetcher({ cacheDir });

    // Set up cache: create current dir and SHA sentinel
    const currentDir = join(cacheDir, "test-plugin", "current");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(currentDir, "plugin.json"), JSON.stringify({ name: "test-plugin", version: "1.0.0" }));

    const shaTracker = fetcher.getSHATracker();
    shaTracker.setSHA("test-plugin", "abc123", "1.0.0");

    const result = await fetcher.fetchPlugin("test-plugin", "1.0.0");
    expect(result.fromCache).toBe(true);
    expect(result.version).toBe("1.0.0");
    expect(result.sha256).toBe("abc123");
    expect(result.pluginDir).toBe(currentDir);
  });

  test("fetchPlugin does NOT return from cache when version differs", async () => {
    const fetcher = new CDNFetcher({
      cacheDir,
      cdnBaseUrl: "http://127.0.0.1:1", // unreachable, will fail
      timeoutMs: 100,
    });

    // Set up cache with version 1.0.0
    const currentDir = join(cacheDir, "test-plugin", "current");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(currentDir, "plugin.json"), JSON.stringify({ name: "test-plugin", version: "1.0.0" }));

    const shaTracker = fetcher.getSHATracker();
    shaTracker.setSHA("test-plugin", "abc123", "1.0.0");

    // Request version 2.0.0 — should try to download (and fail since URL is unreachable)
    await expect(fetcher.fetchPlugin("test-plugin", "2.0.0")).rejects.toThrow();
  });

  test("fetchPlugin performs atomic download, extraction, and swap", async () => {
    const { buffer, sha256 } = await createPluginTarball("atomic-test", "1.0.0");

    // Start a simple HTTP server to serve the tarball
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(buffer, {
          headers: {
            "content-type": "application/gzip",
            "x-content-sha256": sha256,
          },
        });
      },
    });

    try {
      const fetcher = new CDNFetcher({
        cacheDir,
        cdnBaseUrl: `http://localhost:${server.port}`,
        timeoutMs: 5000,
      });

      const result = await fetcher.fetchPlugin("atomic-test", "1.0.0");

      expect(result.fromCache).toBe(false);
      expect(result.version).toBe("1.0.0");
      expect(result.sha256).toBe(sha256);
      expect(existsSync(result.pluginDir)).toBe(true);
      expect(existsSync(join(result.pluginDir, "plugin.json"))).toBe(true);

      // Verify SHA sentinel was written
      const sentinel = fetcher.getSHATracker().getStoredSHA("atomic-test");
      expect(sentinel).not.toBeNull();
      expect(sentinel!.sha256).toBe(sha256);
      expect(sentinel!.version).toBe("1.0.0");

      // Verify temp dirs are cleaned up
      expect(existsSync(join(cacheDir, "atomic-test", ".download-tmp"))).toBe(false);
      expect(existsSync(join(cacheDir, "atomic-test", ".extract-tmp"))).toBe(false);
      expect(existsSync(join(cacheDir, "atomic-test", ".prev"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("fetchPlugin rejects on SHA mismatch", async () => {
    const { buffer } = await createPluginTarball("sha-mismatch", "1.0.0");

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(buffer, {
          headers: {
            "content-type": "application/gzip",
            "x-content-sha256": "wrong-sha-value",
          },
        });
      },
    });

    try {
      const fetcher = new CDNFetcher({
        cacheDir,
        cdnBaseUrl: `http://localhost:${server.port}`,
        timeoutMs: 5000,
      });

      await expect(fetcher.fetchPlugin("sha-mismatch", "1.0.0")).rejects.toThrow(
        /SHA256 mismatch/
      );
    } finally {
      server.stop(true);
    }
  });

  test("fetchPlugin rolls back to previous version on failure", async () => {
    // Set up a "previous" version in current dir
    const currentDir = join(cacheDir, "rollback-test", "current");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(
      join(currentDir, "plugin.json"),
      JSON.stringify({ name: "rollback-test", version: "0.9.0" }),
    );

    const fetcher = new CDNFetcher({
      cacheDir,
      cdnBaseUrl: "http://127.0.0.1:1", // unreachable
      timeoutMs: 100,
    });

    // This should fail but the original "current" dir should remain
    await expect(fetcher.fetchPlugin("rollback-test", "2.0.0")).rejects.toThrow();

    // The current directory should still exist with the old plugin
    expect(existsSync(currentDir)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(currentDir, "plugin.json"), "utf-8"));
    expect(manifest.version).toBe("0.9.0");
  });

  test("fetchPlugin rejects on name mismatch in manifest", async () => {
    const { buffer, sha256 } = await createPluginTarball("wrong-name", "1.0.0");

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(buffer, {
          headers: {
            "content-type": "application/gzip",
            "x-content-sha256": sha256,
          },
        });
      },
    });

    try {
      const fetcher = new CDNFetcher({
        cacheDir,
        cdnBaseUrl: `http://localhost:${server.port}`,
        timeoutMs: 5000,
      });

      // Request with a different name than what the manifest says
      await expect(fetcher.fetchPlugin("expected-name", "1.0.0")).rejects.toThrow(
        /name mismatch/
      );
    } finally {
      server.stop(true);
    }
  });

  test("fetchPlugin rejects on HTTP error", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      const fetcher = new CDNFetcher({
        cacheDir,
        cdnBaseUrl: `http://localhost:${server.port}`,
        timeoutMs: 5000,
      });

      await expect(fetcher.fetchPlugin("missing-plugin", "1.0.0")).rejects.toThrow(
        /HTTP 404/
      );
    } finally {
      server.stop(true);
    }
  });
});
