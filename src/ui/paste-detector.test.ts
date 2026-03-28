import { describe, test, expect } from "bun:test";
import { PasteDetector } from "./paste-detector";

function createDetector(opts: { detectMs?: number; settleMs?: number; burstThreshold?: number } = {}) {
  let clock = 0;
  const detector = new PasteDetector({
    detectMs: opts.detectMs ?? 50,
    settleMs: opts.settleMs ?? 100,
    burstThreshold: opts.burstThreshold ?? 5,
    now: () => clock,
  });
  const advance = (ms: number) => { clock += ms; };
  return { detector, advance };
}

describe("PasteDetector", () => {
  test("starts inactive", () => {
    const { detector } = createDetector();
    expect(detector.isActive).toBe(false);
  });

  test("does not activate on slow typing", () => {
    const { detector, advance } = createDetector();

    // Type 10 chars at 80ms intervals (fast but not paste-fast)
    for (let i = 0; i < 10; i++) {
      advance(80);
      detector.recordInput();
    }

    expect(detector.isActive).toBe(false);
  });

  test("does not activate on short rapid burst (2-3 chars)", () => {
    const { detector, advance } = createDetector();

    // Type 3 chars at 10ms intervals — fast typing, not paste
    advance(10);
    detector.recordInput();
    advance(10);
    detector.recordInput();
    advance(10);
    detector.recordInput();

    expect(detector.isActive).toBe(false);
  });

  test("activates after burst threshold of rapid inputs", () => {
    const { detector, advance } = createDetector({ burstThreshold: 5 });

    // Simulate paste: 6 chars at 5ms intervals
    for (let i = 0; i < 6; i++) {
      advance(5);
      detector.recordInput();
    }

    expect(detector.isActive).toBe(true);
  });

  test("Enter inserts newline during active paste", () => {
    const { detector, advance } = createDetector({ burstThreshold: 5 });

    // Rapid paste
    for (let i = 0; i < 6; i++) {
      advance(5);
      detector.recordInput();
    }

    // Enter arrives rapidly
    advance(5);
    expect(detector.shouldInsertNewline()).toBe(true);
  });

  test("Enter submits when paste is not active", () => {
    const { detector, advance } = createDetector();

    // Type slowly
    advance(100);
    detector.recordInput();
    advance(100);
    detector.recordInput();

    // Enter after slow typing
    advance(100);
    expect(detector.shouldInsertNewline()).toBe(false);
  });

  test("Enter submits after paste has settled", async () => {
    const { detector, advance } = createDetector({ settleMs: 100 });

    // Rapid paste
    for (let i = 0; i < 6; i++) {
      advance(5);
      detector.recordInput();
    }
    expect(detector.isActive).toBe(true);

    // Wait for settle
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(detector.isActive).toBe(false);

    // Enter after settle
    advance(200);
    expect(detector.shouldInsertNewline()).toBe(false);
  });

  test("fast typing 2 chars then Enter does not insert newline", () => {
    const { detector, advance } = createDetector({ burstThreshold: 5 });

    // Type "hi" fast — only 2 rapid inputs, below threshold
    advance(10);
    detector.recordInput(); // h
    advance(10);
    detector.recordInput(); // i

    // Enter — burst count is 2, below threshold of 5
    advance(10);
    expect(detector.shouldInsertNewline()).toBe(false);
  });

  test("fast typing 4 chars then Enter does not insert newline", () => {
    const { detector, advance } = createDetector({ burstThreshold: 5 });

    // Type "abcd" fast — 4 rapid inputs, still below threshold
    advance(10);
    detector.recordInput(); // a
    advance(10);
    detector.recordInput(); // b
    advance(10);
    detector.recordInput(); // c
    advance(10);
    detector.recordInput(); // d

    // Enter — burst count is 4, below threshold of 5.
    // Enter must NOT count toward the burst.
    advance(10);
    expect(detector.shouldInsertNewline()).toBe(false);
  });

  test("burst resets when gap exceeds detectMs", () => {
    const { detector, advance } = createDetector({ burstThreshold: 5, detectMs: 50 });

    // 3 rapid chars
    advance(10);
    detector.recordInput();
    advance(10);
    detector.recordInput();
    advance(10);
    detector.recordInput();

    // Slow gap resets burst
    advance(100);
    detector.recordInput();

    // 3 more rapid chars — burst restarts from 0
    advance(10);
    detector.recordInput();
    advance(10);
    detector.recordInput();

    expect(detector.isActive).toBe(false);
  });

  test("reset clears all state", () => {
    const { detector, advance } = createDetector({ burstThreshold: 3 });

    // Activate
    for (let i = 0; i < 4; i++) {
      advance(5);
      detector.recordInput();
    }
    expect(detector.isActive).toBe(true);

    detector.reset();
    expect(detector.isActive).toBe(false);

    // After reset, Enter should submit
    advance(100);
    expect(detector.shouldInsertNewline()).toBe(false);
  });

  test("multiline paste captures all newlines", () => {
    const { detector, advance } = createDetector({ burstThreshold: 5 });

    // Simulate pasting "line1\nline2\nline3"
    // "line1" = 5 chars
    for (let i = 0; i < 5; i++) {
      advance(1);
      detector.recordInput();
    }
    // Now activated
    expect(detector.isActive).toBe(true);

    // \n
    advance(1);
    expect(detector.shouldInsertNewline()).toBe(true);

    // "line2" = 5 chars
    for (let i = 0; i < 5; i++) {
      advance(1);
      detector.recordInput();
    }

    // \n
    advance(1);
    expect(detector.shouldInsertNewline()).toBe(true);

    // "line3" = 5 chars
    for (let i = 0; i < 5; i++) {
      advance(1);
      detector.recordInput();
    }

    // Still active through the whole paste
    expect(detector.isActive).toBe(true);
  });

  test("Enter arriving just at detectMs boundary does not activate", () => {
    const { detector, advance } = createDetector({ detectMs: 50, burstThreshold: 5 });

    // 6 chars at exactly 50ms — at boundary, should NOT count as rapid
    for (let i = 0; i < 6; i++) {
      advance(50);
      detector.recordInput();
    }

    expect(detector.isActive).toBe(false);
    advance(50);
    expect(detector.shouldInsertNewline()).toBe(false);
  });

  test("dispose is alias for reset", () => {
    const { detector, advance } = createDetector({ burstThreshold: 3 });

    for (let i = 0; i < 4; i++) {
      advance(5);
      detector.recordInput();
    }
    expect(detector.isActive).toBe(true);

    detector.dispose();
    expect(detector.isActive).toBe(false);
  });
});
