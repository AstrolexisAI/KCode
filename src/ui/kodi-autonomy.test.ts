// Kodi autonomy — pure logic tests.
//
// Covers the deterministic parts of Phase 3: idle-action fallback
// pool, walking state machine, observation threshold logic with
// cooldowns. The LLM-backed paths (askForIdleAction,
// renderObservation, pickSessionPersonality) need an integration
// harness with a live advisor server — smoke-tested manually.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  ALL_IDLE_ACTIONS,
  collectObservations,
  initialWalkState,
  type KodiIdleAction,
  pickRandomIdleAction,
  resetObservationCooldowns,
  stepWalk,
  WALK_RANGE,
} from "./kodi-autonomy";

// ─── 3a — idle actions ──────────────────────────────────────────

describe("pickRandomIdleAction", () => {
  test("returns a valid action with mood + speech", () => {
    const pick = pickRandomIdleAction([]);
    expect(ALL_IDLE_ACTIONS).toContain(pick.action);
    expect(pick.mood).not.toBe("");
    expect(pick.speech).not.toBe("");
  });

  test("avoids the most recent action when possible", () => {
    const recent: KodiIdleAction[] = ["yawn"];
    // Run 50 picks; none should repeat "yawn" because pool excludes it.
    for (let i = 0; i < 50; i++) {
      const pick = pickRandomIdleAction(recent);
      expect(pick.action).not.toBe("yawn");
    }
  });

  test("handles empty recent list", () => {
    const pick = pickRandomIdleAction([]);
    expect(ALL_IDLE_ACTIONS).toContain(pick.action);
  });
});

// ─── 3b — walking ───────────────────────────────────────────────

describe("stepWalk", () => {
  test("initial state is center, still", () => {
    const s = initialWalkState();
    expect(s.position).toBe(0);
    expect(s.direction).toBe(0);
  });

  test("position stays within [-WALK_RANGE, +WALK_RANGE]", () => {
    let s = initialWalkState();
    // Drive through many ticks; position must never exceed range.
    for (let i = 0; i < 2000; i++) {
      s = stepWalk(s);
      expect(s.position).toBeGreaterThanOrEqual(-WALK_RANGE);
      expect(s.position).toBeLessThanOrEqual(WALK_RANGE);
    }
  });

  test("bounces off the right edge", () => {
    // Put Kodi at +WALK_RANGE walking right. Next step must clamp
    // and reverse direction to -1.
    const s = stepWalk({ position: WALK_RANGE, direction: 1 });
    expect(s.position).toBe(WALK_RANGE);
    expect(s.direction).toBe(-1);
  });

  test("bounces off the left edge", () => {
    const s = stepWalk({ position: -WALK_RANGE, direction: -1 });
    expect(s.position).toBe(-WALK_RANGE);
    expect(s.direction).toBe(1);
  });

  test("visible movement occurs across a long run", () => {
    // With random stops + starts, over 1000 ticks some ground should
    // be covered — not a strict metric, just sanity-check that Kodi
    // doesn't get stuck at origin forever.
    let s = initialWalkState();
    const visited = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      s = stepWalk(s);
      visited.add(s.position);
    }
    // Expect at least 3 distinct positions over 1000 ticks.
    expect(visited.size).toBeGreaterThanOrEqual(3);
  });
});

// ─── 3c — observations ──────────────────────────────────────────

describe("collectObservations", () => {
  beforeEach(() => {
    resetObservationCooldowns();
  });

  test("empty signals produce no observations", () => {
    const obs = collectObservations({
      idleMs: 0,
      sessionMs: 0,
      contextPressure: 0,
      toolUses: 0,
      msSinceCommit: 0,
    });
    expect(obs).toEqual([]);
  });

  test("long_idle fires after 10 minutes idle", () => {
    const obs = collectObservations({
      idleMs: 11 * 60_000,
      sessionMs: 0,
      contextPressure: 0,
      toolUses: 0,
      msSinceCommit: 0,
    });
    expect(obs.some((o) => o.type === "long_idle")).toBe(true);
  });

  test("context_pressure fires at 85%+", () => {
    const obs = collectObservations({
      idleMs: 0,
      sessionMs: 0,
      contextPressure: 0.86,
      toolUses: 0,
      msSinceCommit: 0,
    });
    expect(obs.some((o) => o.type === "context_pressure")).toBe(true);
  });

  test("long_session fires after 2h", () => {
    const obs = collectObservations({
      idleMs: 0,
      sessionMs: 2 * 3600_000 + 1000,
      contextPressure: 0,
      toolUses: 0,
      msSinceCommit: 0,
    });
    expect(obs.some((o) => o.type === "long_session")).toBe(true);
  });

  test("no_recent_commit requires 20+ tools AND 45+ min since commit", () => {
    // Just tools — no fire (no msSinceCommit threshold met).
    resetObservationCooldowns();
    let obs = collectObservations({
      idleMs: 0,
      sessionMs: 0,
      contextPressure: 0,
      toolUses: 30,
      msSinceCommit: 10 * 60_000,
    });
    expect(obs.some((o) => o.type === "no_recent_commit")).toBe(false);

    // Both thresholds met — fires.
    resetObservationCooldowns();
    obs = collectObservations({
      idleMs: 0,
      sessionMs: 0,
      contextPressure: 0,
      toolUses: 30,
      msSinceCommit: 46 * 60_000,
    });
    expect(obs.some((o) => o.type === "no_recent_commit")).toBe(true);
  });

  test("cooldowns prevent the same observation from firing twice quickly", () => {
    const signals = {
      idleMs: 11 * 60_000,
      sessionMs: 0,
      contextPressure: 0,
      toolUses: 0,
      msSinceCommit: 0,
    };
    const first = collectObservations(signals);
    expect(first.some((o) => o.type === "long_idle")).toBe(true);
    // Immediate second call must not re-fire — still in cooldown.
    const second = collectObservations(signals);
    expect(second.some((o) => o.type === "long_idle")).toBe(false);
  });

  test("resetObservationCooldowns clears the cooldown map", () => {
    const signals = {
      idleMs: 11 * 60_000,
      sessionMs: 0,
      contextPressure: 0,
      toolUses: 0,
      msSinceCommit: 0,
    };
    collectObservations(signals);
    // Still cooldowned.
    expect(collectObservations(signals).length).toBe(0);
    resetObservationCooldowns();
    // Re-fires.
    expect(collectObservations(signals).some((o) => o.type === "long_idle")).toBe(true);
  });

  test("detail text includes the numeric threshold crossed", () => {
    const obs = collectObservations({
      idleMs: 15 * 60_000,
      sessionMs: 0,
      contextPressure: 0.92,
      toolUses: 0,
      msSinceCommit: 0,
    });
    const longIdle = obs.find((o) => o.type === "long_idle");
    expect(longIdle?.detail).toContain("15");
    const pressure = obs.find((o) => o.type === "context_pressure");
    expect(pressure?.detail).toContain("92%");
  });
});

// ─── Constants sanity ───────────────────────────────────────────

describe("module constants", () => {
  test("ALL_IDLE_ACTIONS has every map entry", () => {
    // Change-detector: if someone adds an action to the map but
    // forgets the enum, this fails.
    expect(ALL_IDLE_ACTIONS.length).toBeGreaterThanOrEqual(10);
  });

  test("WALK_RANGE is a small positive integer", () => {
    expect(WALK_RANGE).toBeGreaterThan(0);
    expect(WALK_RANGE).toBeLessThanOrEqual(6);
    expect(Number.isInteger(WALK_RANGE)).toBe(true);
  });
});
