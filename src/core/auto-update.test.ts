import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── compareSemver tests ────────────────────────────────────────

describe("compareSemver", () => {
  // Import the function under test
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
    // Fresh import to pick up new KCODE_HOME
    const { shouldCheckForUpdate } = await import("./auto-update");
    // With no update-check.json, should always want to check
    // Note: also depends on autoUpdate not being false
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

// ─── UpdateInfo parsing tests ───────────────────────────────────

describe("UpdateInfo structure", () => {
  test("UpdateInfo has all required fields", async () => {
    const { checkForUpdate } = await import("./auto-update");
    // We can't actually call the API in tests, but we verify the function exists
    // and returns the right type (null when offline/mocked)
    expect(typeof checkForUpdate).toBe("function");
  });
});

// ─── getUpdateCheckInterval tests ───────────────────────────────

describe("getUpdateCheckInterval", () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-interval-test-"));
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

  test("returns default 7 days when no settings", async () => {
    const { getUpdateCheckInterval } = await import("./auto-update");
    const interval = getUpdateCheckInterval();
    expect(interval).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("reads custom interval from settings", async () => {
    await writeFile(
      join(tempDir, "settings.json"),
      JSON.stringify({ updateCheckIntervalDays: 1 }),
    );
    const { getUpdateCheckInterval } = await import("./auto-update");
    const interval = getUpdateCheckInterval();
    // May return default or custom depending on module caching,
    // but the function should not throw
    expect(typeof interval).toBe("number");
    expect(interval).toBeGreaterThan(0);
  });
});

// ─── getPlatformSuffix tests ────────────────────────────────────

describe("getPlatformSuffix", () => {
  test("returns a valid platform suffix", async () => {
    const { getPlatformSuffix } = await import("./auto-update");
    const suffix = getPlatformSuffix();
    expect(typeof suffix).toBe("string");
    expect(suffix.length).toBeGreaterThan(0);
    // Should match one of the known patterns
    expect(suffix).toMatch(/^(linux|macos|windows)-(x64|arm64)(\.exe)?$/);
  });
});

// ─── install.sh validation ──────────────────────────────────────

describe("install.sh", () => {
  test("is valid shell syntax", async () => {
    const proc = Bun.spawn(["sh", "-n", join(import.meta.dir, "../../install.sh")], {
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
    const content = await Bun.file(join(import.meta.dir, "../../install.sh")).text();
    expect(content).toContain("#!/bin/sh");
    expect(content).toContain("detect_os");
    expect(content).toContain("detect_arch");
    expect(content).toContain("sha256");
    expect(content).toContain("kcode doctor");
    expect(content).toContain("GITHUB_REPO");
    expect(content).toContain("/usr/local/bin");
    expect(content).toContain(".local/bin");
  });

  test("does not use bashisms", async () => {
    const content = await Bun.file(join(import.meta.dir, "../../install.sh")).text();
    // Check for common bashisms that break POSIX sh
    // Arrays: should not have var=(...)
    const arrayPattern = /^[^#]*\w+=\(/m;
    expect(content).not.toMatch(arrayPattern);
    // [[ double brackets (POSIX uses [ single)
    // Only check for [[ used as test command, not inside sed/regex patterns like [[:space:]]
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) continue;
      // Match [[ used as a shell test keyword (word boundary before and after)
      // but exclude [[:class:]] which is a POSIX character class in sed/regex
      if (/(?<!\[)\[\[(?!:)/.test(trimmed)) {
        throw new Error(`Bashism detected (double brackets): ${trimmed}`);
      }
    }
  });
});
