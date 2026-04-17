// KCode - Kodi Animation Engine Tests
// Covers: line alignment, state machine, transitions, width stability,
// event interruption, overlapping transitions, cooldown phase, Unicode safety.

import { describe, expect, test } from "bun:test";
import type { KodiAnimState } from "./kodi-animation";
import { KodiAnimEngine } from "./kodi-animation";

// ─── Helper ─────────────────────────────────────────────────────

function advance(engine: KodiAnimEngine, totalMs: number, stepMs = 50): KodiAnimState {
  let frame: KodiAnimState = engine.tick(0);
  for (let t = 0; t < totalMs; t += stepMs) {
    frame = engine.tick(stepMs);
  }
  return frame;
}

// ─── Basic State ────────────────────────────────────────────────

describe("KodiAnimEngine — basic", () => {
  test("initializes in idle mood and idle phase", () => {
    const frame = new KodiAnimEngine().tick(0);
    expect(frame.mood).toBe("idle");
    expect(frame.phase).toBe("idle");
  });

  test("tick returns 5 lines, bubble, mood, phase, intensity", () => {
    const frame = new KodiAnimEngine().tick(200);
    expect(frame.lines).toHaveLength(5);
    expect(frame).toHaveProperty("bubble");
    expect(frame).toHaveProperty("mood");
    expect(frame).toHaveProperty("phase");
    expect(frame).toHaveProperty("intensity");
  });

  test("lines contain box-drawing characters", () => {
    const frame = new KodiAnimEngine().tick(0);
    expect(frame.lines[0]).toContain("╭");
    expect(frame.lines[1]).toContain("│");
    expect(frame.lines[2]).toContain("╰");
  });
});

// ─── Line Alignment — ALL lines same width ──────────────────────

describe("KodiAnimEngine — line alignment", () => {
  const ALL_MOODS = [
    "idle",
    "happy",
    "excited",
    "thinking",
    "reasoning",
    "working",
    "worried",
    "sleeping",
    "celebrating",
    "curious",
    "mischievous",
    "crazy",
    "angry",
    "smug",
  ] as const;

  test("all 5 lines have identical width within every frame", () => {
    const engine = new KodiAnimEngine();
    for (const mood of ALL_MOODS) {
      engine.setMood(mood);
      advance(engine, 500);
      for (let i = 0; i < 30; i++) {
        const frame = engine.tick(100);
        const widths = frame.lines.map((l) => [...l].length);
        const allSame = widths.every((w) => w === widths[0]);
        if (!allSame) {
          throw new Error(
            `Width mismatch in mood "${mood}" frame ${i}: ${widths.join(",")}\n` +
              frame.lines.map((l, j) => `  [${j}] "${l}" (${[...l].length})`).join("\n"),
          );
        }
      }
    }
  });

  test("line width is consistent across different moods", () => {
    const engine = new KodiAnimEngine();
    const widthSet = new Set<number>();
    for (const mood of ALL_MOODS) {
      engine.setMood(mood);
      advance(engine, 500);
      const frame = engine.tick(0);
      widthSet.add([...frame.lines[0]].length);
    }
    // All moods should produce the same line width
    expect(widthSet.size).toBe(1);
  });

  test("line width stays stable over 200 ticks", () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "tool_start" });
    const widths = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const frame = engine.tick(100);
      widths.add([...frame.lines[0]].length);
    }
    expect(widths.size).toBe(1);
  });
});

// ─── Phase Machine ──────────────────────────────────────────────

describe("KodiAnimEngine — phase machine", () => {
  test("direct mood set: performing → settling → cooldown → idle", () => {
    const engine = new KodiAnimEngine();
    engine.setMood("happy");
    expect(engine.phase).toBe("performing");

    advance(engine, 850);
    expect(engine.phase).toBe("settling");

    advance(engine, 350);
    expect(engine.phase).toBe("cooldown");

    advance(engine, 450);
    expect(engine.phase).toBe("idle");
  });

  test("bridged transition: anticipation → performing → settling → cooldown → idle", () => {
    const engine = new KodiAnimEngine();
    engine.setMood("thinking"); // bridge via curious (200ms)
    expect(engine.phase).toBe("anticipation");

    advance(engine, 250);
    expect(engine.phase).toBe("performing");
    expect(engine.mood).toBe("thinking");

    advance(engine, 850);
    expect(engine.phase).toBe("settling");
    advance(engine, 350);
    expect(engine.phase).toBe("cooldown");
    advance(engine, 450);
    expect(engine.phase).toBe("idle");
  });
});

// ─── Mood Transitions ───────────────────────────────────────────

describe("KodiAnimEngine — react()", () => {
  test("tool_start → working", () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "tool_start", detail: "Read" });
    const frame = advance(engine, 500);
    expect(frame.mood).toBe("working");
    expect(frame.bubble).toContain("Read");
  });

  test("tool_error → worried", () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "tool_error" });
    expect(advance(engine, 500).mood).toBe("worried");
  });

  test("test_fail → angry", () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "test_fail" });
    expect(advance(engine, 500).mood).toBe("angry");
  });

  test("commit → celebrating", () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "commit" });
    expect(advance(engine, 500).mood).toBe("celebrating");
  });

  test("windDown → sleeping", () => {
    const engine = new KodiAnimEngine();
    engine.windDown(130_000);
    expect(advance(engine, 500).mood).toBe("sleeping");
  });
});

// ─── Speech ─────────────────────────────────────────────────────

describe("KodiAnimEngine — speech", () => {
  test("say sets bubble with tick-based expiry", () => {
    const engine = new KodiAnimEngine();
    engine.say("hello!", 500);
    expect(engine.tick(0).bubble).toBe("hello!");
    advance(engine, 400);
    expect(engine.tick(0).bubble).toBe("hello!");
    advance(engine, 200);
    expect(engine.tick(0).bubble).toBe("");
  });
});

// ─── Blink ──────────────────────────────────────────────────────

describe("KodiAnimEngine — blink", () => {
  test("face line varies over time", () => {
    const engine = new KodiAnimEngine();
    const faces = new Set<string>();
    for (let i = 0; i < 100; i++) faces.add(engine.tick(200).lines[1]);
    expect(faces.size).toBeGreaterThanOrEqual(2);
  });
});

// ─── Event Interruption ─────────────────────────────────────────

describe("KodiAnimEngine — event interruption", () => {
  test("new event cancels in-progress transition", () => {
    const engine = new KodiAnimEngine();
    engine.setMood("thinking");
    advance(engine, 100);
    engine.react({ type: "tool_error" });
    expect(advance(engine, 500).mood).toBe("worried");
  });

  test("rapid events resolve to the last one", () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "tool_start" });
    advance(engine, 50);
    engine.react({ type: "tool_done" });
    advance(engine, 50);
    engine.react({ type: "turn_end" });
    const frame = advance(engine, 2000);
    expect(frame.mood).toBe("idle");
    expect(frame.phase).toBe("idle");
  });

  test("overlapping transitions resolve to latest mood", () => {
    const engine = new KodiAnimEngine();
    engine.setMood("thinking");
    advance(engine, 50);
    engine.setMood("celebrating");
    expect(advance(engine, 500).mood).toBe("celebrating");
  });
});

// ─── Context Modifiers ──────────────────────────────────────────

describe("KodiAnimEngine — context", () => {
  test("running agents boost intensity", () => {
    const engine = new KodiAnimEngine();
    engine.runningAgents = 3;
    engine.react({ type: "tool_start" });
    expect(engine.tick(0).intensity).toBeGreaterThan(0.7);
  });
});

// ─── Unicode Safety ─────────────────────────────────────────────

describe("KodiAnimEngine — no ambiguous-width Unicode", () => {
  const AMBIGUOUS_RANGES: Array<[number, number]> = [
    [0x2010, 0x2027],
    [0x2030, 0x2044],
    [0x2190, 0x21ff],
    [0x2200, 0x22ff],
    [0x2300, 0x23ff],
    [0x2460, 0x24ff],
    [0x25a0, 0x25ff],
    [0x2600, 0x26ff],
    [0x2700, 0x27bf],
  ];

  function isAmbiguous(cp: number): boolean {
    if (cp >= 0x2500 && cp <= 0x259f) return false; // box-drawing OK
    for (const [lo, hi] of AMBIGUOUS_RANGES) {
      if (cp >= lo && cp <= hi) return true;
    }
    return false;
  }

  test("all lines use only ASCII-safe characters", () => {
    const engine = new KodiAnimEngine();
    const moods = [
      "idle",
      "happy",
      "excited",
      "thinking",
      "reasoning",
      "working",
      "worried",
      "sleeping",
      "celebrating",
      "curious",
      "mischievous",
      "crazy",
      "angry",
      "smug",
    ] as const;
    for (const mood of moods) {
      engine.setMood(mood);
      advance(engine, 500);
      for (let i = 0; i < 20; i++) {
        const frame = engine.tick(100);
        for (const line of frame.lines) {
          for (const ch of line) {
            const cp = ch.codePointAt(0)!;
            if (isAmbiguous(cp)) {
              throw new Error(
                `Ambiguous U+${cp.toString(16).toUpperCase()} ('${ch}') in mood "${mood}": "${line}"`,
              );
            }
          }
        }
      }
    }
  });
});

// ─── Tier & new moods ───────────────────────────────────────────

describe("KodiAnimEngine — tier flourishes", () => {
  test("default tier is free with empty badge", () => {
    const frame = new KodiAnimEngine().tick(200);
    expect(frame.tier).toBe("free");
    expect(frame.tierBadge).toBe("");
  });

  test("setTier to pro emits non-empty badge and triggers entrance flex", () => {
    const e = new KodiAnimEngine();
    e.setTier("pro");
    const frame = e.tick(50);
    expect(frame.tier).toBe("pro");
    expect(frame.tierBadge).not.toBe("");
    // pro entrance → flex mood with speech bubble
    expect(frame.mood === "flex" || frame.bubble.length > 0).toBe(true);
  });

  test("enterprise entrance mood is celebrating", () => {
    const e = new KodiAnimEngine();
    e.setTier("enterprise");
    const frame = e.tick(50);
    expect(frame.mood).toBe("celebrating");
    expect(frame.tier).toBe("enterprise");
  });

  test("tier_entrance does not refire on re-setting the same tier", () => {
    const e = new KodiAnimEngine();
    e.setTier("pro");
    advance(e, 10_000); // let the entrance settle
    e.setMood("idle");
    advance(e, 2000);
    e.setTier("pro"); // idempotent
    const frame = e.tick(50);
    expect(frame.mood).toBe("idle");
  });

  test("tier_flex on free tier is a no-op", () => {
    const e = new KodiAnimEngine();
    // tier defaults to free; flex should not change mood
    e.react({ type: "tier_flex" });
    const frame = e.tick(50);
    expect(frame.mood).toBe("idle");
  });

  test("tier_flex on enterprise kicks Kodi into dance", () => {
    const e = new KodiAnimEngine();
    e.setTier("enterprise");
    advance(e, 5000); // clear entrance
    e.setMood("idle");
    advance(e, 1000);
    e.react({ type: "tier_flex" });
    const frame = e.tick(50);
    expect(frame.mood).toBe("dance");
  });

  test("new moods produce valid 5-line output with correct width", () => {
    const e = new KodiAnimEngine();
    for (const mood of ["flex", "dance", "waving"] as const) {
      e.setMood(mood);
      const frame = e.tick(50);
      expect(frame.lines).toHaveLength(5);
      // All lines same width as the existing sprite (LINE_WIDTH = 14)
      for (const line of frame.lines) {
        expect([...line].length).toBe(14);
      }
    }
  });
});

// ─── Urges (free-will impulses) ─────────────────────────────────

describe("KodiAnimEngine — urges", () => {
  test("initial urges are zero", () => {
    const frame = new KodiAnimEngine().tick(0);
    expect(frame.urges.boredom).toBe(0);
    expect(frame.urges.curiosity).toBe(0);
    expect(frame.urges.wanderlust).toBe(0);
  });

  test("boredom builds when idle and drains on events", () => {
    const engine = new KodiAnimEngine();
    // Drive 60s of pure idle — should build substantial boredom
    advance(engine, 60_000);
    const idleFrame = engine.tick(0);
    expect(idleFrame.urges.boredom).toBeGreaterThan(0.5);
    // Now fire a meaningful event — should drain
    engine.react({ type: "tool_done", detail: "Read" });
    // Give it a tick so stepUrges runs too
    const afterFrame = engine.tick(0);
    expect(afterFrame.urges.boredom).toBeLessThan(idleFrame.urges.boredom);
  });

  test("curiosity builds over time regardless of mood", () => {
    const engine = new KodiAnimEngine();
    engine.setMood("working");
    advance(engine, 60_000);
    const frame = engine.tick(0);
    // Still builds even in working mood, just slower
    expect(frame.urges.curiosity).toBeGreaterThan(0);
  });

  test("wanderlust builds slowest of the three", () => {
    const engine = new KodiAnimEngine();
    // Keep Kodi idle so boredom and curiosity both build
    advance(engine, 120_000);
    const frame = engine.tick(0);
    expect(frame.urges.wanderlust).toBeLessThan(frame.urges.boredom);
    expect(frame.urges.wanderlust).toBeLessThan(frame.urges.curiosity);
  });

  test("boredom is capped at 1.0", () => {
    const engine = new KodiAnimEngine();
    // Drive 20 minutes of idle — far past saturation
    advance(engine, 1_200_000);
    expect(engine.tick(0).urges.boredom).toBeLessThanOrEqual(1.0);
  });

  test("drainUrge clamps at zero", () => {
    const engine = new KodiAnimEngine();
    advance(engine, 60_000);
    engine.drainUrge("boredom", 99.0);
    expect(engine.tick(0).urges.boredom).toBe(0);
  });

  test("react with non-event types (tier_entrance) does not drain urges", () => {
    const engine = new KodiAnimEngine();
    advance(engine, 60_000);
    const before = engine.tick(0).urges.boredom;
    engine.react({ type: "tier_entrance" });
    const after = engine.tick(0).urges.boredom;
    // Tier events shouldn't count as "user activity" for boredom.
    // (Small step up from the tick that ran between is fine.)
    expect(after).toBeGreaterThanOrEqual(before - 0.01);
  });

  test("boredom doesn't build when mood is not idle", () => {
    const engine = new KodiAnimEngine();
    engine.setMood("happy");
    advance(engine, 30_000);
    const frame = engine.tick(0);
    // Should have drained toward zero since mood !== idle
    expect(frame.urges.boredom).toBeLessThan(0.1);
  });
});

// ─── Door teleport ──────────────────────────────────────────────

describe("KodiAnimEngine — door teleport", () => {
  test("default side is left, not in door", () => {
    const frame = new KodiAnimEngine().tick(0);
    expect(frame.side).toBe("left");
    expect(frame.inDoor).toBe(false);
  });

  test("teleportThroughDoor flips side at halfway", () => {
    const engine = new KodiAnimEngine();
    expect(engine.side).toBe("left");
    engine.teleportThroughDoor();
    // Shortly after: still left, in door
    advance(engine, 500);
    expect(engine.tick(0).inDoor).toBe(true);
    expect(engine.side).toBe("left");
    // Past halfway: side flipped, still in door
    advance(engine, 400);
    expect(engine.side).toBe("right");
    expect(engine.tick(0).inDoor).toBe(true);
    // After full 1500ms: out of door, right side
    advance(engine, 800);
    expect(engine.tick(0).inDoor).toBe(false);
    expect(engine.side).toBe("right");
  });

  test("double teleport is a no-op when one is already running", () => {
    const engine = new KodiAnimEngine();
    engine.teleportThroughDoor();
    advance(engine, 100);
    const sideAtStart = engine.side;
    engine.teleportThroughDoor(); // should be ignored
    advance(engine, 2000);
    // Exactly one flip happened.
    expect(engine.side).not.toBe(sideAtStart);
  });

  test("door frame has uniform width across all 5 lines", () => {
    const engine = new KodiAnimEngine();
    engine.teleportThroughDoor();
    const frame = engine.tick(100);
    expect(frame.inDoor).toBe(true);
    const widths = frame.lines.map((l) => [...l].length);
    expect(new Set(widths).size).toBe(1);
  });

  test("teleport shows 'poof!' bubble", () => {
    const engine = new KodiAnimEngine();
    engine.teleportThroughDoor();
    const frame = engine.tick(50);
    expect(frame.bubble).toBe("poof!");
  });
});

// ─── Determinism ────────────────────────────────────────────────

describe("KodiAnimEngine — determinism", () => {
  test("same ticks produce same phase progression", () => {
    function run(): string[] {
      const e = new KodiAnimEngine();
      e.setMood("happy");
      const phases: string[] = [];
      for (let t = 0; t < 2000; t += 100) {
        const f = e.tick(100);
        if (t % 500 === 0) phases.push(f.phase);
      }
      return phases;
    }
    expect(run()).toEqual(run());
  });
});
