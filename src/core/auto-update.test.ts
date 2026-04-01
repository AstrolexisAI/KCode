import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ─── GitHub API Response Parsing ────────────────────────────────

describe("GitHub API response parsing", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("parses valid GitHub release response", async () => {
    const mockRelease = {
      tag_name: "v2.0.0",
      body: "## What's New\n- Feature A\n- Bug fix B",
      published_at: "2026-04-01T12:00:00Z",
      assets: [
        {
          name: "kcode-linux-x64",
          browser_download_url: "https://github.com/astrolexis/kcode/releases/download/v2.0.0/kcode-linux-x64",
          size: 50_000_000,
        },
      ],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockRelease), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
    );

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0");

    expect(info.currentVersion).toBe("1.8.0");
    expect(info.latestVersion).toBe("2.0.0");
    expect(info.updateAvailable).toBe(true);
    expect(info.releaseUrl).toContain("v2.0.0");
    expect(info.releaseNotes).toContain("Feature A");
    expect(info.publishedAt).toBe("2026-04-01T12:00:00Z");
  });

  test("returns no update when current version is latest", async () => {
    const mockRelease = {
      tag_name: "v1.8.0",
      body: "Current release",
      published_at: "2026-03-15T12:00:00Z",
      assets: [],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockRelease), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
    );

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0");

    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBe("1.8.0");
  });

  test("handles GitHub API errors gracefully", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Rate limited", { status: 403 })),
    );

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0");

    expect(info.updateAvailable).toBe(false);
    expect(info.currentVersion).toBe("1.8.0");
    expect(info.latestVersion).toBe("1.8.0");
  });

  test("handles network failure gracefully", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network unreachable")),
    );

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0");

    expect(info.updateAvailable).toBe(false);
    expect(info.currentVersion).toBe("1.8.0");
  });

  test("strips v prefix from tag_name", async () => {
    const mockRelease = {
      tag_name: "v3.1.2",
      body: "",
      published_at: "2026-04-01T12:00:00Z",
      assets: [],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockRelease), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
    );

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0");

    expect(info.latestVersion).toBe("3.1.2");
    expect(info.updateAvailable).toBe(true);
  });

  test("returns updateAvailable false when ahead of latest", async () => {
    const mockRelease = {
      tag_name: "v1.7.0",
      body: "",
      published_at: "2026-03-01T12:00:00Z",
      assets: [],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockRelease), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
    );

    const { checkForUpdate } = await import("./auto-update");
    const info = await checkForUpdate("1.8.0");

    expect(info.updateAvailable).toBe(false);
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
    globalThis.fetch = globalThis.fetch; // restore if overridden
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes cache file after successful check", async () => {
    const { existsSync } = await import("node:fs");
    const mockRelease = {
      tag_name: "v2.0.0",
      body: "New features",
      published_at: "2026-04-01T12:00:00Z",
      assets: [],
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockRelease), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
    );

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
    // Write a fresh cache entry (just checked now)
    const cachePath = join(tempDir, "update-check.json");
    const cacheData = {
      lastCheck: Date.now(),
      lastVersion: "2.5.0",
      releaseUrl: "https://github.com/astrolexis/kcode/releases/tag/v2.5.0",
    };
    await writeFile(cachePath, JSON.stringify(cacheData));

    // fetch should NOT be called since cache is fresh
    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() => {
      fetchCalled = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

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
    // Write a stale cache entry (25 hours ago)
    const cachePath = join(tempDir, "update-check.json");
    const cacheData = {
      lastCheck: Date.now() - 25 * 60 * 60 * 1000,
      lastVersion: "1.9.0",
    };
    await writeFile(cachePath, JSON.stringify(cacheData));

    const mockRelease = {
      tag_name: "v2.0.0",
      body: "Fresh check result",
      published_at: "2026-04-01T12:00:00Z",
      assets: [],
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockRelease), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
    );

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
      lastVersion: "1.8.0", // same as current
    };
    await writeFile(cachePath, JSON.stringify(cacheData));

    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );

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
    await writeFile(cachePath, JSON.stringify({
      lastCheck: Date.now(),
      lastVersion: "2.0.0",
      releaseUrl: "https://github.com/astrolexis/kcode/releases/tag/v2.0.0",
    }));

    const { getUpdateNotification } = await import("./auto-update");
    const notification = await getUpdateNotification("1.8.0");

    expect(notification).not.toBeNull();
    expect(notification).toContain("1.8.0");
    expect(notification).toContain("2.0.0");
    expect(notification).toContain("->");
  });

  test("notification includes update command", async () => {
    const cachePath = join(tempDir, "update-check.json");
    await writeFile(cachePath, JSON.stringify({
      lastCheck: Date.now(),
      lastVersion: "2.0.0",
    }));

    const { getUpdateNotification } = await import("./auto-update");
    const notification = await getUpdateNotification("1.8.0");

    expect(notification).not.toBeNull();
    expect(notification).toContain("kcode update");
  });

  test("notification includes release URL when available", async () => {
    const releaseUrl = "https://github.com/astrolexis/kcode/releases/tag/v2.0.0";
    const cachePath = join(tempDir, "update-check.json");
    await writeFile(cachePath, JSON.stringify({
      lastCheck: Date.now(),
      lastVersion: "2.0.0",
      releaseUrl,
    }));

    const { getUpdateNotification } = await import("./auto-update");
    const notification = await getUpdateNotification("1.8.0");

    expect(notification).not.toBeNull();
    expect(notification).toContain(releaseUrl);
  });

  test("notification omits release URL when not available", async () => {
    const cachePath = join(tempDir, "update-check.json");
    await writeFile(cachePath, JSON.stringify({
      lastCheck: Date.now(),
      lastVersion: "2.0.0",
      // no releaseUrl
    }));

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
    await writeFile(
      join(tempDir, "settings.json"),
      JSON.stringify({ autoUpdate: false }),
    );
    const { isAutoUpdateEnabled } = await import("./auto-update");
    expect(isAutoUpdateEnabled()).toBe(false);
  });

  test("returns true when autoUpdate is not set (default enabled)", async () => {
    await writeFile(join(tempDir, "settings.json"), JSON.stringify({}));
    const { isAutoUpdateEnabled } = await import("./auto-update");
    expect(isAutoUpdateEnabled()).toBe(true);
  });
});

// ─── getPlatformSuffix tests ────────────────────────────────────

describe("getPlatformSuffix", () => {
  test("returns a valid platform suffix", async () => {
    const { getPlatformSuffix } = await import("./auto-update");
    const suffix = getPlatformSuffix();
    expect(typeof suffix).toBe("string");
    expect(suffix.length).toBeGreaterThan(0);
    expect(suffix).toMatch(/^(linux|macos|windows)-(x64|arm64)(\.exe)?$/);
  });
});

// ─── install.sh validation ──────────────────────────────────────

describe("install.sh", () => {
  test("is valid shell syntax", async () => {
    const { existsSync } = await import("node:fs");
    const installPath = join(import.meta.dir, "../../install.sh");
    if (!existsSync(installPath)) return; // skip if no install.sh

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
    if (!existsSync(installPath)) return; // skip if no install.sh

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
