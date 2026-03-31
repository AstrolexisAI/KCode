import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHATracker } from "./sha-tracker";

let tempDir: string;
let tracker: SHATracker;

describe("SHATracker", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-sha-tracker-test-"));
    tracker = new SHATracker(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("getStoredSHA returns null when no sentinel exists", () => {
    const result = tracker.getStoredSHA("nonexistent-plugin");
    expect(result).toBeNull();
  });

  test("setSHA writes sentinel and getStoredSHA reads it back", () => {
    tracker.setSHA("my-plugin", "abc123def456", "1.0.0");

    const result = tracker.getStoredSHA("my-plugin");
    expect(result).not.toBeNull();
    expect(result!.sha256).toBe("abc123def456");
    expect(result!.version).toBe("1.0.0");
    expect(result!.timestamp).toBeGreaterThan(0);
  });

  test("setSHA creates directories if needed", () => {
    const deepDir = join(tempDir, "deep", "nested");
    const deepTracker = new SHATracker(deepDir);

    deepTracker.setSHA("test-plugin", "sha256hash", "2.0.0");
    const result = deepTracker.getStoredSHA("test-plugin");
    expect(result).not.toBeNull();
    expect(result!.sha256).toBe("sha256hash");
  });

  test("needsUpdate returns true when no sentinel exists", () => {
    expect(tracker.needsUpdate("new-plugin", "abc123")).toBe(true);
  });

  test("needsUpdate returns false when SHA matches", () => {
    tracker.setSHA("my-plugin", "abc123", "1.0.0");
    expect(tracker.needsUpdate("my-plugin", "abc123")).toBe(false);
  });

  test("needsUpdate returns true when SHA differs", () => {
    tracker.setSHA("my-plugin", "abc123", "1.0.0");
    expect(tracker.needsUpdate("my-plugin", "def456")).toBe(true);
  });

  test("invalidate removes sentinel file", () => {
    tracker.setSHA("my-plugin", "abc123", "1.0.0");
    expect(tracker.getStoredSHA("my-plugin")).not.toBeNull();

    tracker.invalidate("my-plugin");
    expect(tracker.getStoredSHA("my-plugin")).toBeNull();
  });

  test("invalidate is safe on non-existent plugin", () => {
    expect(() => tracker.invalidate("nonexistent")).not.toThrow();
  });

  test("getStoredSHA handles malformed sentinel file", () => {
    const pluginDir = join(tempDir, "bad-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, ".sha256"), "incomplete", "utf-8");

    const result = tracker.getStoredSHA("bad-plugin");
    expect(result).toBeNull();
  });

  test("sentinel file has correct format", () => {
    tracker.setSHA("format-test", "deadbeef", "3.1.4");

    const sentinelPath = join(tempDir, "format-test", ".sha256");
    expect(existsSync(sentinelPath)).toBe(true);

    const content = readFileSync(sentinelPath, "utf-8");
    const lines = content.split("\n");
    expect(lines[0]).toBe("deadbeef");
    expect(lines[1]).toBe("3.1.4");
    expect(parseInt(lines[2]!, 10)).toBeGreaterThan(0);
  });
});
