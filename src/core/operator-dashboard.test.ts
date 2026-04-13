// Tests for operator-dashboard (phase 5 of operator-mind).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearOperatorDashboardState,
  formatOperatorBanner,
  type Finding,
  probeInotifySaturation,
  probeOperatorState,
  probeOrphanDevServers,
  probeRecentRetries,
  selectFindingsForTurn,
} from "./operator-dashboard";
import { clearBashHistory, recordBashAttempt } from "./bash-spawn-history";
import { clearEditHistory, recordEditAttempt } from "./file-edit-history";

describe("formatOperatorBanner", () => {
  test("returns empty string when no findings", () => {
    expect(formatOperatorBanner([])).toBe("");
  });

  test("renders findings with severity icons and hints", () => {
    const findings: Finding[] = [
      { severity: "warn", code: "X", message: "thing happened", hint: "do this" },
      { severity: "alert", code: "Y", message: "bad" },
    ];
    const out = formatOperatorBanner(findings);
    expect(out).toContain("[OPERATOR]");
    expect(out).toContain("thing happened");
    expect(out).toContain("→ do this");
    expect(out).toContain("bad");
    expect(out).toContain("⚠");
    expect(out).toContain("✗");
  });
});

describe("selectFindingsForTurn — throttling", () => {
  beforeEach(() => clearOperatorDashboardState());

  test("first occurrence of a code passes through", () => {
    const f: Finding = { severity: "warn", code: "FOO", message: "m" };
    expect(selectFindingsForTurn([f])).toEqual([f]);
  });

  test("same code is suppressed in the next 3 turns", () => {
    const f: Finding = { severity: "warn", code: "FOO", message: "m" };
    selectFindingsForTurn([f]); // turn 1: shown
    expect(selectFindingsForTurn([f])).toEqual([]); // turn 2: suppressed
    expect(selectFindingsForTurn([f])).toEqual([]); // turn 3: suppressed
    expect(selectFindingsForTurn([f])).toEqual([]); // turn 4: suppressed
  });

  test("same code is allowed again after the cooldown window", () => {
    const f: Finding = { severity: "warn", code: "FOO", message: "m" };
    selectFindingsForTurn([f]);
    selectFindingsForTurn([]);
    selectFindingsForTurn([]);
    selectFindingsForTurn([]);
    selectFindingsForTurn([]);
    // Now 4+ turns have passed since the last show
    expect(selectFindingsForTurn([f])).toEqual([f]);
  });

  test("different codes are independent", () => {
    const a: Finding = { severity: "warn", code: "A", message: "a" };
    const b: Finding = { severity: "warn", code: "B", message: "b" };
    expect(selectFindingsForTurn([a, b])).toEqual([a, b]);
    expect(selectFindingsForTurn([a])).toEqual([]);
    expect(selectFindingsForTurn([b])).toEqual([]);
  });
});

describe("probeRecentRetries", () => {
  beforeEach(() => {
    clearBashHistory();
    clearEditHistory();
  });
  afterEach(() => {
    clearBashHistory();
    clearEditHistory();
  });

  test("returns null when no recent failures", () => {
    expect(probeRecentRetries()).toBeNull();
  });

  test("returns null with fewer than 3 failures", () => {
    recordBashAttempt("npm run dev", "/x", true, "boom");
    recordBashAttempt("npm run dev", "/x", true, "boom");
    expect(probeRecentRetries()).toBeNull();
  });

  test("fires at 3 failures", () => {
    recordBashAttempt("npm run dev", "/x", true, "boom");
    recordEditAttempt("Edit", { file_path: "/y", old_string: "a", new_string: "b" }, true, "boom");
    recordEditAttempt(
      "Write",
      { file_path: "/z", content: "x" },
      true,
      "EACCES",
    );
    const f = probeRecentRetries();
    expect(f).not.toBeNull();
    expect(f!.code).toBe("RECENT_RETRIES");
    expect(f!.severity).toBe("warn");
    expect(f!.message).toContain("3");
  });

  test("severity escalates to alert at 5+ failures", () => {
    for (let i = 0; i < 5; i++) {
      recordBashAttempt(`vite --port ${5000 + i}`, "/x", true, "boom");
    }
    const f = probeRecentRetries();
    expect(f!.severity).toBe("alert");
  });

  test("ignores successful attempts", () => {
    for (let i = 0; i < 10; i++) {
      recordBashAttempt(`npm run dev`, `/x-${i}`, false, "OK");
    }
    expect(probeRecentRetries()).toBeNull();
  });
});

describe("probeInotifySaturation", () => {
  test("returns Finding or null without throwing", () => {
    const f = probeInotifySaturation();
    if (f === null) return; // healthy or non-Linux
    expect(f.code).toBe("INOTIFY_HIGH");
    expect(["warn", "alert"]).toContain(f.severity);
    expect(f.message).toMatch(/inotify usage/);
  });
});

describe("probeOrphanDevServers", () => {
  test("returns null for an empty/missing cwd", () => {
    expect(probeOrphanDevServers("/this/path/does/not/exist")).toBeNull();
  });

  test("returns null for a cwd with no dev servers", () => {
    expect(probeOrphanDevServers("/tmp")).toBeNull();
  });
});

describe("probeOperatorState — high level", () => {
  beforeEach(() => {
    clearBashHistory();
    clearEditHistory();
    clearOperatorDashboardState();
  });

  test("returns a result object with findings array", () => {
    const r = probeOperatorState("/tmp");
    expect(Array.isArray(r.findings)).toBe(true);
  });

  test("aggregates findings from all probes", () => {
    // Force a recent-retries finding by recording 4 errors
    for (let i = 0; i < 4; i++) {
      recordBashAttempt(`vite --port ${6000 + i}`, "/x", true, "boom");
    }
    const r = probeOperatorState("/tmp");
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("RECENT_RETRIES");
  });
});
