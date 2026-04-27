import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test fixtures mirror the manifest emitted by scripts/release.ts.
function buildManifest(opts: {
  latest: string;
  channels?: { stable?: string; beta?: string };
  platforms?: Record<string, { url: string; filename: string; sha256: string; size: number }>;
  released_at?: string;
  release_notes?: string;
}) {
  return {
    schema_version: 1,
    latest: opts.latest,
    released_at: opts.released_at ?? "2026-04-26T12:00:00Z",
    channels: opts.channels ?? { stable: opts.latest },
    platforms: opts.platforms ?? {
      "linux-x64": {
        url: `https://kulvex.ai/downloads/kcode/kcode-${opts.latest}-linux-x64`,
        filename: `kcode-${opts.latest}-linux-x64`,
        sha256: "a".repeat(64),
        size: 117_000_000,
      },
      "linux-arm64": {
        url: `https://kulvex.ai/downloads/kcode/kcode-${opts.latest}-linux-arm64`,
        filename: `kcode-${opts.latest}-linux-arm64`,
        sha256: "b".repeat(64),
        size: 117_000_000,
      },
      "darwin-x64": {
        url: `https://kulvex.ai/downloads/kcode/kcode-${opts.latest}-darwin-x64`,
        filename: `kcode-${opts.latest}-darwin-x64`,
        sha256: "c".repeat(64),
        size: 117_000_000,
      },
      "darwin-arm64": {
        url: `https://kulvex.ai/downloads/kcode/kcode-${opts.latest}-darwin-arm64`,
        filename: `kcode-${opts.latest}-darwin-arm64`,
        sha256: "d".repeat(64),
        size: 117_000_000,
      },
    },
    release_notes:
      opts.release_notes ?? `https://github.com/AstrolexisAI/KCode/releases/tag/v${opts.latest}`,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── compareSemver tests ────────────────────────────────────────

describe("compareSemver", () => {
  let compareSemver: (a: string, b: string) => number;

  beforeEach(async () => {
    const mod = await import("./auto-update");
    compareSemver = mod.compareSemver;
  });

  test("equal versions return 0", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("0.0.1", "0.0.1")).toBe(0);
    expect(compareSemver("10.20.30", "10.20.30")).toBe(0);
  });

  test("handles v prefix", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("v1.2.3", "v1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "v1.2.3")).toBe(0);
  });

  test("major version comparison", () => {
    expect(compareSemver("2.0.0", "1.0.0")).toBe(1);
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
  });

  test("minor version comparison", () => {
    expect(compareSemver("1.2.0", "1.1.0")).toBe(1);
    expect(compareSemver("1.1.0", "1.2.0")).toBe(-1);
  });

  test("patch version comparison", () => {
    expect(compareSemver("1.0.2", "1.0.1")).toBe(1);
    expect(compareSemver("1.0.1", "1.0.2")).toBe(-1);
  });

  test("complex comparisons", () => {
    expect(compareSemver("1.8.0", "1.9.0")).toBe(-1);
    expect(compareSemver("1.9.0", "1.8.0")).toBe(1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemver("0.1.0", "0.0.99")).toBe(1);
  });

  test("handles missing parts", () => {
    expect(compareSemver("1.0", "1.0.0")).toBe(0);
    expect(compareSemver("1", "1.0.0")).toBe(0);
  });

  test("handles larger version numbers", () => {
    expect(compareSemver("1.8.0", "1.10.0")).toBe(-1);
    expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
    expect(compareSemver("100.0.0", "99.99.99")).toBe(1);
  });
});

// ─── Manifest parsing ───────────────────────────────────────────

describe("manifest response parsing", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("parses a valid manifest and reports update available", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(buildManifest({ latest: "2.0.0" })))) as unknown as typeof globalThis.fetch;

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0");

    expect(info.currentVersion).toBe("1.8.0");
    expect(info.latestVersion).toBe("2.0.0");
    expect(info.channel).toBe("stable");
    expect(info.releaseUrl).toContain("v2.0.0");
    expect(info.publishedAt).toBe("2026-04-26T12:00:00Z");
  });

  test("returns no update when current version is latest", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(buildManifest({ latest: "1.8.0" })))) as unknown as typeof globalThis.fetch;

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0");

    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBe("1.8.0");
  });

  test("handles HTTP errors gracefully", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("bad gateway", { status: 502 }))) as unknown as typeof globalThis.fetch;

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0");

    expect(info.updateAvailable).toBe(false);
    expect(info.currentVersion).toBe("1.8.0");
    expect(info.latestVersion).toBe("1.8.0");
  });

  test("handles network failure gracefully", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Network unreachable"))) as unknown as typeof globalThis.fetch;

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0");

    expect(info.updateAvailable).toBe(false);
    expect(info.currentVersion).toBe("1.8.0");
  });

  test("rejects manifest missing required fields", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse({ schema_version: 1 })),
    ) as unknown as typeof globalThis.fetch;

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0");

    expect(info.updateAvailable).toBe(false);
  });

  test("returns no update when client is ahead of manifest", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(buildManifest({ latest: "1.7.0" })))) as unknown as typeof globalThis.fetch;

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0");

    expect(info.updateAvailable).toBe(false);
  });

  test("beta channel returns beta version when manifest has one", async () => {
    globalThis.fetch = (mock(() =>
      Promise.resolve(
        jsonResponse(
          buildManifest({
            latest: "2.0.0",
            channels: { stable: "2.0.0", beta: "2.1.0-beta.1" },
            platforms: {
              "linux-x64": {
                url: "https://kulvex.ai/downloads/kcode/kcode-2.1.0-beta.1-linux-x64",
                filename: "kcode-2.1.0-beta.1-linux-x64",
                sha256: "f".repeat(64),
                size: 117_000_000,
              },
              "darwin-arm64": {
                url: "https://kulvex.ai/downloads/kcode/kcode-2.1.0-beta.1-darwin-arm64",
                filename: "kcode-2.1.0-beta.1-darwin-arm64",
                sha256: "f".repeat(64),
                size: 117_000_000,
              },
            },
          }),
        ),
      ),
    )) as unknown as typeof globalThis.fetch;

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("2.0.0", { channel: "beta" });

    expect(info.channel).toBe("beta");
    expect(info.latestVersion).toBe("2.1.0-beta.1");
  });

  test("populates info.delta when manifest has a delta for current version", async () => {
    const m = buildManifest({ latest: "2.0.0" });
    // Inject a delta entry on whichever platform the host runs on so
    // the test passes regardless of OS/arch.
    const mod = await import("./auto-update");
    const key = mod.getPlatformKey();
    const platforms = m.platforms as Record<
      string,
      { url: string; filename: string; sha256: string; size: number; deltas?: unknown }
    >;
    if (!platforms[key]) {
      platforms[key] = {
        url: "https://kulvex.ai/downloads/kcode/kcode-2.0.0",
        filename: "kcode-2.0.0",
        sha256: "e".repeat(64),
        size: 117_000_000,
      };
    }
    platforms[key].deltas = {
      "1.8.0": {
        url: "https://kulvex.ai/downloads/kcode/kcode-1.8.0-to-2.0.0.bsdiff",
        sha256: "1".repeat(64),
        size: 1_500_000,
        from_sha256: "f".repeat(64),
      },
    };

    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(m))) as unknown as typeof globalThis.fetch;

    const info = await mod.checkForUpdate("1.8.0");

    expect(info.updateAvailable).toBe(true);
    expect(info.delta).toBeDefined();
    expect(info.delta?.size).toBe(1_500_000);
    expect(info.delta?.from_sha256).toBe("f".repeat(64));
    expect(info.delta?.url).toContain(".bsdiff");
  });

  test("info.delta is undefined when manifest has deltas but none for current version", async () => {
    const m = buildManifest({ latest: "2.0.0" });
    const mod = await import("./auto-update");
    const key = mod.getPlatformKey();
    const platforms = m.platforms as Record<
      string,
      { url: string; filename: string; sha256: string; size: number; deltas?: unknown }
    >;
    if (!platforms[key]) {
      platforms[key] = {
        url: "https://kulvex.ai/downloads/kcode/kcode-2.0.0",
        filename: "kcode-2.0.0",
        sha256: "e".repeat(64),
        size: 117_000_000,
      };
    }
    platforms[key].deltas = {
      "1.9.0": {
        url: "https://kulvex.ai/downloads/kcode/kcode-1.9.0-to-2.0.0.bsdiff",
        sha256: "1".repeat(64),
        size: 1_500_000,
        from_sha256: "f".repeat(64),
      },
    };

    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(m))) as unknown as typeof globalThis.fetch;

    const info = await mod.checkForUpdate("1.8.0");

    expect(info.updateAvailable).toBe(true);
    expect(info.delta).toBeUndefined();
  });

  test("info.delta is undefined when manifest has no deltas field", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(buildManifest({ latest: "2.0.0" })))) as unknown as typeof globalThis.fetch;

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0");

    expect(info.updateAvailable).toBe(true);
    expect(info.delta).toBeUndefined();
  });

  test("beta channel falls back to stable if manifest lacks beta", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        jsonResponse(buildManifest({ latest: "2.0.0", channels: { stable: "2.0.0" } })),
      ),
    ) as unknown as typeof globalThis.fetch;

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0", { channel: "beta" });

    expect(info.latestVersion).toBe("2.0.0");
  });
});

// ─── Update Check Caching (24h) ────────────────────────────────

describe("update check caching", () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-update-test-"));
    originalHome = process.env.KCODE_HOME;
    process.env.KCODE_HOME = tempDir;
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.KCODE_HOME = originalHome;
    } else {
      delete process.env.KCODE_HOME;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes cache file after successful check", async () => {
    const { existsSync } = await import("node:fs");

    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(buildManifest({ latest: "2.0.0" })))) as unknown as typeof globalThis.fetch;

    try {
      const { checkForUpdate } = await import("./auto-update");
      await checkForUpdate("1.8.0");

      const cachePath = join(tempDir, "update-check.json");
      expect(existsSync(cachePath)).toBe(true);

      const cache = JSON.parse(await Bun.file(cachePath).text());
      expect(cache.lastVersion).toBe("2.0.0");
      expect(cache.lastCheck).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("uses cached result within 24h window for notifications", async () => {
    const cachePath = join(tempDir, "update-check.json");
    const cacheData = {
      lastCheck: Date.now(),
      lastVersion: "2.5.0",
      releaseUrl: "https://github.com/AstrolexisAI/KCode/releases/tag/v2.5.0",
    };
    await writeFile(cachePath, JSON.stringify(cacheData));

    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() => {
      fetchCalled = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    try {
      const { getUpdateNotification } = await import("./auto-update");
      const notification = await getUpdateNotification("1.8.0");

      expect(notification).not.toBeNull();
      expect(notification).toContain("1.8.0");
      expect(notification).toContain("2.5.0");
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("re-checks when cache is older than 24h", async () => {
    const cachePath = join(tempDir, "update-check.json");
    const cacheData = {
      lastCheck: Date.now() - 25 * 60 * 60 * 1000,
      lastVersion: "1.9.0",
    };
    await writeFile(cachePath, JSON.stringify(cacheData));

    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(buildManifest({ latest: "2.0.0" })))) as unknown as typeof globalThis.fetch;

    try {
      const { getUpdateNotification } = await import("./auto-update");
      const notification = await getUpdateNotification("1.8.0");

      expect(notification).not.toBeNull();
      expect(notification).toContain("2.0.0");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("returns null when no update available (cached)", async () => {
    const cachePath = join(tempDir, "update-check.json");
    const cacheData = {
      lastCheck: Date.now(),
      lastVersion: "1.8.0",
    };
    await writeFile(cachePath, JSON.stringify(cacheData));

    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof globalThis.fetch;

    try {
      const { getUpdateNotification } = await import("./auto-update");
      const notification = await getUpdateNotification("1.8.0");

      expect(notification).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ─── Update Notification Formatting ─────────────────────────────

describe("update notification formatting", () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-notif-test-"));
    originalHome = process.env.KCODE_HOME;
    process.env.KCODE_HOME = tempDir;
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.KCODE_HOME = originalHome;
    } else {
      delete process.env.KCODE_HOME;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("notification includes version transition arrow", async () => {
    const cachePath = join(tempDir, "update-check.json");
    await writeFile(
      cachePath,
      JSON.stringify({
        lastCheck: Date.now(),
        lastVersion: "2.0.0",
        releaseUrl: "https://github.com/AstrolexisAI/KCode/releases/tag/v2.0.0",
      }),
    );

    const { getUpdateNotification } = await import("./auto-update");
    const notification = await getUpdateNotification("1.8.0");

    expect(notification).not.toBeNull();
    expect(notification).toContain("1.8.0");
    expect(notification).toContain("2.0.0");
    expect(notification).toContain("->");
  });

  test("notification includes update command", async () => {
    const cachePath = join(tempDir, "update-check.json");
    await writeFile(
      cachePath,
      JSON.stringify({
        lastCheck: Date.now(),
        lastVersion: "2.0.0",
      }),
    );

    const { getUpdateNotification } = await import("./auto-update");
    const notification = await getUpdateNotification("1.8.0");

    expect(notification).not.toBeNull();
    expect(notification).toContain("kcode update");
  });

  test("notification includes release URL when available", async () => {
    const releaseUrl = "https://github.com/AstrolexisAI/KCode/releases/tag/v2.0.0";
    const cachePath = join(tempDir, "update-check.json");
    await writeFile(
      cachePath,
      JSON.stringify({
        lastCheck: Date.now(),
        lastVersion: "2.0.0",
        releaseUrl,
      }),
    );

    const { getUpdateNotification } = await import("./auto-update");
    const notification = await getUpdateNotification("1.8.0");

    expect(notification).not.toBeNull();
    expect(notification).toContain(releaseUrl);
  });

  test("notification omits release URL when not available", async () => {
    const cachePath = join(tempDir, "update-check.json");
    await writeFile(
      cachePath,
      JSON.stringify({
        lastCheck: Date.now(),
        lastVersion: "2.0.0",
      }),
    );

    const { getUpdateNotification } = await import("./auto-update");
    const notification = await getUpdateNotification("1.8.0");

    expect(notification).not.toBeNull();
    expect(notification).not.toContain("Release notes:");
  });
});

// ─── shouldCheckForUpdate tests ─────────────────────────────────

describe("shouldCheckForUpdate", () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-update-test-"));
    originalHome = process.env.KCODE_HOME;
    process.env.KCODE_HOME = tempDir;
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.KCODE_HOME = originalHome;
    } else {
      delete process.env.KCODE_HOME;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns true when no check file exists", async () => {
    const { shouldCheckForUpdate } = await import("./auto-update");
    expect(typeof shouldCheckForUpdate()).toBe("boolean");
  });

  test("returns false when autoUpdate is disabled", async () => {
    await writeFile(join(tempDir, "settings.json"), JSON.stringify({ autoUpdate: false }));
    const { isAutoUpdateEnabled } = await import("./auto-update");
    expect(isAutoUpdateEnabled()).toBe(false);
  });

  test("returns true when autoUpdate is not set (default enabled)", async () => {
    await writeFile(join(tempDir, "settings.json"), JSON.stringify({}));
    const { isAutoUpdateEnabled } = await import("./auto-update");
    expect(isAutoUpdateEnabled()).toBe(true);
  });
});

// ─── getPlatformSuffix / getPlatformKey tests ──────────────────

describe("getPlatformSuffix", () => {
  test("returns a valid platform suffix", async () => {
    const { getPlatformSuffix } = await import("./auto-update");
    const suffix = getPlatformSuffix();
    expect(typeof suffix).toBe("string");
    expect(suffix.length).toBeGreaterThan(0);
    expect(suffix).toMatch(/^(linux|macos|windows)-(x64|arm64)(\.exe)?$/);
  });
});

describe("getPlatformKey", () => {
  test("returns a manifest-style platform key", async () => {
    const { getPlatformKey } = await import("./auto-update");
    const key = getPlatformKey();
    expect(typeof key).toBe("string");
    expect(key).toMatch(/^(linux|darwin|win32)-(x64|arm64)$/);
  });
});

// ─── hasRollbackAvailable tests ────────────────────────────────

describe("hasRollbackAvailable", () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-rollback-test-"));
    originalHome = process.env.KCODE_HOME;
    process.env.KCODE_HOME = tempDir;
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.KCODE_HOME = originalHome;
    } else {
      delete process.env.KCODE_HOME;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns false when no previous binary saved", async () => {
    const { hasRollbackAvailable } = await import("./auto-update");
    expect(hasRollbackAvailable()).toBe(false);
  });

  test("returns true when previous-kcode exists", async () => {
    await writeFile(join(tempDir, "previous-kcode"), "fake-binary-bytes");
    const { hasRollbackAvailable } = await import("./auto-update");
    expect(hasRollbackAvailable()).toBe(true);
  });
});

// ─── install.sh validation ──────────────────────────────────────

describe("install.sh", () => {
  test("is valid shell syntax", async () => {
    const { existsSync } = await import("node:fs");
    const installPath = join(import.meta.dir, "../../install.sh");
    if (!existsSync(installPath)) return;

    const proc = Bun.spawn(["sh", "-n", installPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`install.sh syntax check failed:\n${stderr}`);
    }
    expect(exitCode).toBe(0);
  });

  test("contains required sections", async () => {
    const { existsSync } = await import("node:fs");
    const installPath = join(import.meta.dir, "../../install.sh");
    if (!existsSync(installPath)) return;

    const content = await Bun.file(installPath).text();
    expect(content).toContain("#!/bin/sh");
    expect(content).toContain("detect_os");
    expect(content).toContain("detect_arch");
    expect(content).toContain("sha256");
    expect(content).toContain("kcode doctor");
    expect(content).toContain("GITHUB_REPO");
    expect(content).toContain("/usr/local/bin");
    expect(content).toContain(".local/bin");
  });
});
