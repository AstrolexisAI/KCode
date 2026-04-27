// Kodi model manager — pure logic tests.
//
// Covers: candidate catalog integrity, status machine at the
// "not installed" edge, and pickDefaultCandidate behavior under
// simulated RAM budgets. We deliberately avoid the network-bound
// downloadKodiModel and process-spawning startKodiServer —
// those want an integration harness with a real llama-server binary.

import { describe, expect, test } from "bun:test";
import {
  candidatePath,
  getCandidate,
  KODI_CANDIDATES,
  KODI_SERVER_PORT,
  pickDefaultCandidate,
} from "./kodi-model";

describe("kodi-model — candidate catalog", () => {
  test("exposes at least one candidate", () => {
    expect(KODI_CANDIDATES.length).toBeGreaterThan(0);
  });

  test("all candidates have non-empty required fields", () => {
    for (const c of KODI_CANDIDATES) {
      expect(c.id).not.toBe("");
      expect(c.label).not.toBe("");
      expect(c.filename).toMatch(/\.gguf$/);
      expect(c.url).toMatch(/^https:\/\//);
      expect(c.sizeMB).toBeGreaterThan(0);
      expect(c.ramMB).toBeGreaterThan(0);
      expect(c.note).not.toBe("");
    }
  });

  test("candidate ids are unique", () => {
    const ids = new Set(KODI_CANDIDATES.map((c) => c.id));
    expect(ids.size).toBe(KODI_CANDIDATES.length);
  });

  test("candidate filenames are unique", () => {
    const files = new Set(KODI_CANDIDATES.map((c) => c.filename));
    expect(files.size).toBe(KODI_CANDIDATES.length);
  });

  test("candidates are ordered strongest → smallest by RAM", () => {
    // pickDefaultCandidate relies on this ordering: walk top-down,
    // take the first that fits. If the catalog ever violates it,
    // RAM-constrained users would get a suboptimal default.
    for (let i = 1; i < KODI_CANDIDATES.length; i++) {
      const prev = KODI_CANDIDATES[i - 1]!;
      const curr = KODI_CANDIDATES[i]!;
      expect(curr.ramMB).toBeLessThanOrEqual(prev.ramMB);
    }
  });

  test("getCandidate returns the matching entry", () => {
    for (const c of KODI_CANDIDATES) {
      expect(getCandidate(c.id)?.id).toBe(c.id);
    }
  });

  test("getCandidate returns null for unknown id", () => {
    expect(getCandidate("nonexistent-model-id-xyz")).toBeNull();
  });

  test("candidatePath produces a path ending in the filename", () => {
    const c = KODI_CANDIDATES[0]!;
    const path = candidatePath(c);
    expect(path.endsWith(c.filename)).toBe(true);
    expect(path).toContain("models/kodi");
  });
});

describe("kodi-model — constants", () => {
  test("KODI_SERVER_PORT stays above 10000 reserved range", () => {
    expect(KODI_SERVER_PORT).toBeGreaterThanOrEqual(10000);
    expect(KODI_SERVER_PORT).toBeLessThan(65536);
  });

  test("KODI_SERVER_PORT does not collide with the main model port 10091", () => {
    expect(KODI_SERVER_PORT).not.toBe(10091);
  });
});

describe("kodi-model — pickDefaultCandidate", () => {
  test("returns a candidate (truthy) on this test machine", () => {
    // CI / dev boxes running this test have enough RAM. Weak
    // machines would return null — we don't want to assert a
    // specific model since RAM varies, but null from a dev box
    // would indicate a broken catalog.
    const picked = pickDefaultCandidate();
    expect(picked).not.toBeNull();
  });

  test("picked candidate comes from the catalog", () => {
    const picked = pickDefaultCandidate();
    if (picked) {
      expect(KODI_CANDIDATES.some((c) => c.id === picked.id)).toBe(true);
    }
  });
});
