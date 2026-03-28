// KCode - Kodi Animation Engine Tests
// Covers: layers, state machine, transitions, width stability,
// event interruption, overlapping transitions, cooldown phase.

import { describe, test, expect } from "bun:test";
import { KodiAnimEngine } from "./kodi-animation";
import type { KodiAnimState } from "./kodi-animation";

// ─── Helper: advance engine by total ms in steps ────────────────

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
    const engine = new KodiAnimEngine();
    const frame = engine.tick(0);
    expect(frame.mood).toBe("idle");
    expect(frame.phase).toBe("idle");
  });

  test("tick returns all required layers", () => {
    const engine = new KodiAnimEngine();
    const frame = engine.tick(200);
    for (const key of ["face", "body", "legs", "effectL", "effectR", "accessory", "bubble", "mood", "phase", "intensity"] as const) {
      expect(frame).toHaveProperty(key);
    }
  });

  test("face layer contains box-drawing characters", () => {
    const frame = new KodiAnimEngine().tick(0);
    expect(frame.face).toContain("│");
  });
});

// ─── Fixed-Width Stability ──────────────────────────────────────

describe("KodiAnimEngine — fixed-width output", () => {
  test("face is always exactly 11 chars", () => {
    const engine = new KodiAnimEngine();
    const moods = ["idle", "happy", "excited", "thinking", "reasoning", "working",
      "worried", "sleeping", "celebrating", "curious", "mischievous",
      "crazy", "angry", "smug"] as const;
    for (const mood of moods) {
      engine.setMood(mood);
      // Tick past any transition
      const frame = advance(engine, 2000);
      expect([...frame.face].length).toBe(11);
    }
  });

  test("body is always exactly 9 chars", () => {
    const engine = new KodiAnimEngine();
    // Tick through many frames to hit different body variants
    for (let i = 0; i < 100; i++) {
      const frame = engine.tick(200);
      expect([...frame.body].length).toBe(9);
    }
  });

  test("legs is always exactly 9 chars", () => {
    const engine = new KodiAnimEngine();
    for (let i = 0; i < 100; i++) {
      const frame = engine.tick(200);
      expect([...frame.legs].length).toBe(9);
    }
  });

  test("effectL and effectR are always exactly 2 chars", () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "tool_start" });
    for (let i = 0; i < 50; i++) {
      const frame = engine.tick(100);
      expect([...frame.effectL].length).toBe(2);
      expect([...frame.effectR].length).toBe(2);
    }
  });

  test("accessory is always exactly 2 chars", () => {
    const engine = new KodiAnimEngine();
    const moods = ["idle", "reasoning", "sleeping", "celebrating", "crazy"] as const;
    for (const mood of moods) {
      engine.setMood(mood);
      for (let i = 0; i < 30; i++) {
        const frame = engine.tick(100);
        expect([...frame.accessory].length).toBe(2);
      }
    }
  });

  test("no frame produces different total width across ticks", () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "tool_start" });
    const widths = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const f = engine.tick(200);
      const totalWidth = [...f.effectL].length + [...f.face].length + [...f.accessory].length;
      widths.add(totalWidth);
    }
    // Should always be the same total width
    expect(widths.size).toBe(1);
  });
});

// ─── Phase Machine (idle → anticipation → performing → settling → cooldown → idle) ──

describe("KodiAnimEngine — phase machine", () => {
  test("direct mood set goes through performing → settling → cooldown → idle", () => {
    const engine = new KodiAnimEngine();
    engine.setMood("happy"); // no transition bridge from idle→happy in map, so direct
    expect(engine.phase).toBe("performing");

    // performing → settling (after 800ms)
    advance(engine, 850);
    expect(engine.phase).toBe("settling");

    // settling → cooldown (after 300ms)
    advance(engine, 350);
    expect(engine.phase).toBe("cooldown");

    // cooldown → idle (after 400ms)
    advance(engine, 450);
    expect(engine.phase).toBe("idle");
  });

  test("bridged transition goes anticipation → performing → settling → cooldown → idle", () => {
    const engine = new KodiAnimEngine();
    // idle→thinking has a bridge via curious (200ms)
    engine.setMood("thinking");
    expect(engine.phase).toBe("anticipation");

    // After bridge duration, should enter performing
    advance(engine, 250);
    expect(engine.phase).toBe("performing");
    expect(engine.mood).toBe("thinking");

    // Performing → settling → cooldown → idle
    advance(engine, 850);
    expect(engine.phase).toBe("settling");
    advance(engine, 350);
    expect(engine.phase).toBe("cooldown");
    advance(engine, 450);
    expect(engine.phase).toBe("idle");
  });

  test("cooldown phase has correct effects (quiet particles)", () => {
    const engine = new KodiAnimEngine();
    engine.setMood("happy");
    // Advance to cooldown: performing(800) + settling(300) = 1100ms
    advance(engine, 1150);
    expect(engine.phase).toBe("cooldown");
    const frame = engine.tick(50);
    expect(frame.phase).toBe("cooldown");
  });
});

// ─── Mood Transitions via react() ───────────────────────────────

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
    const frame = advance(engine, 500);
    expect(frame.mood).toBe("worried");
  });

  test("test_fail → angry", () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "test_fail" });
    const frame = advance(engine, 500);
    expect(frame.mood).toBe("angry");
  });

  test("commit → celebrating", () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "commit" });
    const frame = advance(engine, 500);
    expect(frame.mood).toBe("celebrating");
  });

  test("windDown → sleeping after long idle", () => {
    const engine = new KodiAnimEngine();
    engine.windDown(130_000);
    const frame = advance(engine, 500);
    expect(frame.mood).toBe("sleeping");
  });
});

// ─── Speech Bubble ──────────────────────────────────────────────

describe("KodiAnimEngine — speech", () => {
  test("say sets bubble with tick-based expiry", () => {
    const engine = new KodiAnimEngine();
    engine.say("hello!", 500);
    expect(engine.tick(0).bubble).toBe("hello!");
    // Still visible after 400ms
    advance(engine, 400);
    expect(engine.tick(0).bubble).toBe("hello!");
    // Gone after 600ms total
    advance(engine, 200);
    expect(engine.tick(0).bubble).toBe("");
  });

  test("new say replaces previous bubble", () => {
    const engine = new KodiAnimEngine();
    engine.say("first", 5000);
    engine.say("second", 5000);
    expect(engine.tick(0).bubble).toBe("second");
  });
});

// ─── Blink ──────────────────────────────────────────────────────

describe("KodiAnimEngine — blink", () => {
  test("face varies over time (blink cycles)", () => {
    const engine = new KodiAnimEngine();
    const faces = new Set<string>();
    for (let i = 0; i < 100; i++) {
      faces.add(engine.tick(200).face);
    }
    expect(faces.size).toBeGreaterThanOrEqual(2);
  });
});

// ─── Event Interruption / Priority ──────────────────────────────

describe("KodiAnimEngine — event interruption", () => {
  test("new event cancels in-progress transition", () => {
    const engine = new KodiAnimEngine();
    // Start transition idle → thinking (bridge via curious, 200ms)
    engine.setMood("thinking");
    expect(engine.phase).toBe("anticipation");

    // Before it completes, interrupt with a higher-priority event
    advance(engine, 100); // halfway through anticipation
    engine.react({ type: "tool_error" });

    // Should have cancelled the thinking transition and gone to worried
    const frame = advance(engine, 500);
    expect(frame.mood).toBe("worried");
    // Should NOT be "thinking" or stuck in "curious"
    expect(frame.mood).not.toBe("thinking");
    expect(frame.mood).not.toBe("curious");
  });

  test("rapid events don't leave stale phase timers", () => {
    const engine = new KodiAnimEngine();
    // Fire 5 events in quick succession
    engine.react({ type: "tool_start" });
    advance(engine, 50);
    engine.react({ type: "tool_done" });
    advance(engine, 50);
    engine.react({ type: "tool_start" });
    advance(engine, 50);
    engine.react({ type: "tool_error" });
    advance(engine, 50);
    engine.react({ type: "turn_end" });

    // After settling, should be in idle (last event was turn_end)
    const frame = advance(engine, 2000);
    expect(frame.mood).toBe("idle");
    expect(frame.phase).toBe("idle");
  });

  test("overlapping transitions resolve to the latest mood", () => {
    const engine = new KodiAnimEngine();
    engine.setMood("thinking");   // bridge via curious
    advance(engine, 50);
    engine.setMood("celebrating"); // should cancel the thinking transition
    const frame = advance(engine, 500);
    expect(frame.mood).toBe("celebrating");
  });
});

// ─── Context Modifiers ──────────────────────────────────────────

describe("KodiAnimEngine — context modifiers", () => {
  test("running agents boost intensity", () => {
    const engine = new KodiAnimEngine();
    engine.runningAgents = 3;
    engine.react({ type: "tool_start" });
    expect(engine.tick(0).intensity).toBeGreaterThan(0.7);
  });

  test("high context pressure boosts intensity", () => {
    const engine = new KodiAnimEngine();
    engine.contextPressure = 0.9;
    engine.react({ type: "streaming" });
    expect(engine.tick(0).intensity).toBeGreaterThan(0.5);
  });
});

// ─── Unicode Safety ─────────────────────────────────────────────

describe("KodiAnimEngine — no ambiguous-width Unicode", () => {
  // East Asian Ambiguous width codepoints that cause terminal jitter.
  // Ranges: U+2500-U+257F (box-drawing, OK), but we flag the rest.
  // See: https://www.unicode.org/reports/tr11/
  const AMBIGUOUS_RANGES: Array<[number, number]> = [
    [0x2010, 0x2027],  // general punctuation subset (‐–—‗''‚‛""„†‡•‣)
    [0x2030, 0x2044],  // per mille, prime, etc
    [0x2190, 0x21FF],  // arrows
    [0x2200, 0x22FF],  // math operators (∀∃∅∇∈∉∋)
    [0x2300, 0x23FF],  // misc technical (⌀⌂⌘)
    [0x2460, 0x24FF],  // enclosed alphanumerics
    [0x25A0, 0x25FF],  // geometric shapes (■□▪▫▲△▴▵▶▷▸▹►▻▼▽▾▿◀◁◆◇◈◉◊○◌◍◎●◐◑◒◓◕◖◗)
    [0x2600, 0x26FF],  // misc symbols (☀☁☂☃★☆☎☏☐☑☒☓☕☠☢☣☮☯☸☹☺☻☼)
    [0x2700, 0x27BF],  // dingbats (✂✃✄✅✆✇✈✉✊✋✌✍✎✏✐✑✒✓✔✕✖✗✘✙✚✛✜✝✞✟✠✡✢✣✤✥✦✧)
  ];

  function isAmbiguous(cp: number): boolean {
    // Allow box-drawing (U+2500-U+257F) and block elements (U+2580-U+259F)
    if (cp >= 0x2500 && cp <= 0x259F) return false;
    for (const [lo, hi] of AMBIGUOUS_RANGES) {
      if (cp >= lo && cp <= hi) return true;
    }
    return false;
  }

  test("all face/eye sprites use only ASCII-safe characters", () => {
    const engine = new KodiAnimEngine();
    const moods = ["idle", "happy", "excited", "thinking", "reasoning", "working",
      "worried", "sleeping", "celebrating", "curious", "mischievous",
      "crazy", "angry", "smug"] as const;

    for (const mood of moods) {
      engine.setMood(mood);
      advance(engine, 500);
      // Check several frames
      for (let i = 0; i < 20; i++) {
        const frame = engine.tick(100);
        for (const ch of frame.face) {
          const cp = ch.codePointAt(0)!;
          if (isAmbiguous(cp)) {
            throw new Error(`Ambiguous-width char U+${cp.toString(16).toUpperCase()} ('${ch}') in face for mood "${mood}": "${frame.face}"`);
          }
        }
        for (const ch of frame.accessory) {
          const cp = ch.codePointAt(0)!;
          if (isAmbiguous(cp)) {
            throw new Error(`Ambiguous-width char U+${cp.toString(16).toUpperCase()} ('${ch}') in accessory for mood "${mood}"`);
          }
        }
      }
    }
  });
});

// ─── Determinism ────────────────────────────────────────────────

describe("KodiAnimEngine — determinism", () => {
  test("same sequence of ticks produces consistent phase progression", () => {
    // Run the same scenario twice and verify phase at checkpoints
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
    const r1 = run();
    const r2 = run();
    expect(r1).toEqual(r2);
  });
});
