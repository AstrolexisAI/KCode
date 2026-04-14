// Tests for phase 8 — KCode self-heals stale dev watchers before refusing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  attemptInotifyRecovery,
  clearInotifyCache,
  findStaleDevWatchers,
} from "./bash-spawn-preflight";

describe("findStaleDevWatchers", () => {
  test("returns an array (may be empty depending on host state)", () => {
    const stale = findStaleDevWatchers(1800);
    expect(Array.isArray(stale)).toBe(true);
    for (const w of stale) {
      expect(typeof w.pid).toBe("number");
      expect(typeof w.comm).toBe("string");
      expect(typeof w.etimeSec).toBe("number");
      expect(w.etimeSec).toBeGreaterThanOrEqual(1800);
    }
  });

  test("respects the maxAgeSec threshold", () => {
    const youngThreshold = findStaleDevWatchers(0).length;
    const oldThreshold = findStaleDevWatchers(99999999).length;
    // Old threshold should match equal or fewer processes than young
    expect(oldThreshold).toBeLessThanOrEqual(youngThreshold);
  });
});

describe("attemptInotifyRecovery", () => {
  beforeEach(() => clearInotifyCache());
  afterEach(() => clearInotifyCache());

  test("returns recovered=true when inotify is already healthy", () => {
    // On a healthy host this is the expected path.
    const r = attemptInotifyRecovery(0.85);
    if (r.beforeRatio < 0.85) {
      expect(r.recovered).toBe(true);
      expect(r.killed).toBe(0);
    }
  });

  test("returns a structured result with all fields", () => {
    const r = attemptInotifyRecovery(0.85);
    expect(typeof r.killed).toBe("number");
    expect(Array.isArray(r.killedPids)).toBe(true);
    expect(typeof r.beforeRatio).toBe("number");
    expect(typeof r.recovered).toBe("boolean");
  });

  test("does not kill anything when inotify is below threshold", () => {
    const r = attemptInotifyRecovery(0.999); // unrealistically high → always healthy
    expect(r.killed).toBe(0);
    expect(r.recovered).toBe(true);
  });
});
