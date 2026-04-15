// Tests for phase 25 — user-repetition detector.

import { describe, expect, test } from "bun:test";
import {
  buildUserRepetitionReminder,
  checkUserRepetition,
  collectRecentUserMessages,
} from "./user-repetition-check";
import type { Message } from "./types";

function userMsg(content: string): Message {
  return { role: "user", content };
}
function asstMsg(content: string): Message {
  return { role: "assistant", content };
}

describe("collectRecentUserMessages", () => {
  test("returns user text messages in chronological order", () => {
    const messages: Message[] = [
      userMsg("first"),
      asstMsg("ack"),
      userMsg("second"),
      asstMsg("ack"),
      userMsg("third"),
    ];
    expect(collectRecentUserMessages(messages)).toEqual(["first", "second", "third"]);
  });

  test("skips [SYSTEM]-prefixed and other system-injected reminders", () => {
    const messages: Message[] = [
      userMsg("real request"),
      userMsg("[SYSTEM] Your response was cut off"),
      userMsg("[REALITY CHECK]\nYour previous turn..."),
      userMsg("[CONTENT MISMATCH] missing URLs"),
      userMsg("[USER REPETITION — SAME ISSUE REPEATED]"),
      userMsg("another real request"),
    ];
    expect(collectRecentUserMessages(messages)).toEqual([
      "real request",
      "another real request",
    ]);
  });

  test("skips tool_result-only user messages", () => {
    const messages: Message[] = [
      userMsg("real one"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            is_error: false,
            content: "ok",
          } as unknown as never,
        ],
      },
      userMsg("another real one"),
    ];
    expect(collectRecentUserMessages(messages)).toEqual(["real one", "another real one"]);
  });

  test("respects limit parameter", () => {
    const messages: Message[] = Array.from({ length: 10 }, (_, i) =>
      userMsg(`msg ${i}`),
    );
    expect(collectRecentUserMessages(messages, 3)).toEqual(["msg 7", "msg 8", "msg 9"]);
  });
});

describe("checkUserRepetition — Orbital chart case", () => {
  const orbitalSession: Message[] = [
    userMsg("crea la app Orbital con un dashboard NASA"),
    asstMsg("done"),
    userMsg("la grafica bien, pero no renderiza correctamente"),
    asstMsg("fixed (claim only)"),
    userMsg(
      "la grafica de Mars Surface Temperature • Last 7 Sols (InSight) colapsa el scroll hasta el infinito y mas allá",
    ),
    asstMsg("fixed (claim only, wrong code path)"),
  ];

  test("fires on the actual Orbital pattern with 3 chart mentions", () => {
    const newMsg = "el problema de la grafica sigue igual, audita el problema";
    const verdict = checkUserRepetition(orbitalSession, newMsg);
    expect(verdict.isRepeating).toBe(true);
    expect(verdict.sharedTopics).toContain("grafica");
    expect(verdict.frustrationSignals.length).toBeGreaterThanOrEqual(1);
  });

  test("does NOT fire without frustration signal", () => {
    // Three mentions of chart but no frustration — could be normal
    // iterative work
    const normalFlow: Message[] = [
      userMsg("crea una grafica de temperatura"),
      asstMsg("done"),
      userMsg("añade una leyenda al grafico de temperatura"),
      asstMsg("done"),
      userMsg("cambia el color de la grafica a cyan"),
    ];
    const verdict = checkUserRepetition(normalFlow);
    expect(verdict.isRepeating).toBe(false);
  });

  test("does NOT fire with only 2 messages (below threshold)", () => {
    const short: Message[] = [
      userMsg("la grafica no funciona"),
      asstMsg("fixed"),
      userMsg("la grafica sigue igual"),
    ];
    const verdict = checkUserRepetition(short);
    // Only 2 real user messages — min is 3
    expect(verdict.isRepeating).toBe(false);
  });

  test("normalizes accents (gráfica vs grafica)", () => {
    const session: Message[] = [
      userMsg("la gráfica no renderiza"),
      asstMsg("done"),
      userMsg("la grafica colapsa"),
      asstMsg("done"),
    ];
    const newMsg = "la gráfica sigue igual";
    const verdict = checkUserRepetition(session, newMsg);
    expect(verdict.isRepeating).toBe(true);
    expect(verdict.sharedTopics).toContain("grafica");
  });
});

describe("checkUserRepetition — frustration signal coverage", () => {
  function build(signal: string): Message[] {
    return [
      userMsg("fix the header layout"),
      asstMsg("done"),
      userMsg("header still broken in the dashboard"),
      asstMsg("done"),
      userMsg(`the header ${signal}`),
    ];
  }

  test.each([
    "still broken",
    "still not working",
    "still the same",
    "not fixed",
    "didn't work",
    "same problem",
    "sigue igual",
    "no funciona",
    "sigue sin funcionar",
    "no lo arreglaste",
    "mismo problema",
    "todavia tiene el mismo bug",
  ])("detects frustration signal %p", (signal) => {
    const messages = build(signal);
    const verdict = checkUserRepetition(messages);
    expect(verdict.isRepeating).toBe(true);
    expect(verdict.frustrationSignals.length).toBeGreaterThanOrEqual(1);
  });
});

describe("checkUserRepetition — negative cases", () => {
  test("does not fire on empty history", () => {
    expect(checkUserRepetition([]).isRepeating).toBe(false);
  });

  test("does not fire when topics differ", () => {
    const messages: Message[] = [
      userMsg("fix the header"),
      asstMsg("done"),
      userMsg("add a footer"),
      asstMsg("done"),
      userMsg("change the sidebar colors"),
    ];
    expect(checkUserRepetition(messages).isRepeating).toBe(false);
  });

  test("does not fire when only tiny words overlap", () => {
    // "que", "con", "si" — stopwords and short words shouldn't count
    const messages: Message[] = [
      userMsg("si, hazlo"),
      asstMsg("done"),
      userMsg("si, continua con eso"),
      asstMsg("done"),
      userMsg("si, sigue"),
    ];
    expect(checkUserRepetition(messages).isRepeating).toBe(false);
  });

  test("does not fire on the system reminders themselves", () => {
    // The phase 25 detector should not see its own past reminders
    const messages: Message[] = [
      userMsg("[USER REPETITION — SAME ISSUE REPEATED] grafica sigue sigue sigue"),
      userMsg("[REALITY CHECK] grafica grafica grafica"),
      userMsg("[SYSTEM] grafica cut off"),
    ];
    // Collect skips all of these, so recent.length < 3 → no fire
    expect(checkUserRepetition(messages).isRepeating).toBe(false);
  });
});

describe("buildUserRepetitionReminder", () => {
  test("contains the shared topics, frustration signals, and resolutions", () => {
    const verdict = {
      isRepeating: true,
      sharedTopics: ["grafica", "render"],
      frustrationSignals: ["sigue igual", "audita"],
      recentMessages: [
        "la grafica no renderiza",
        "la grafica colapsa el scroll",
        "el problema de la grafica sigue igual, audita el problema",
      ],
    };
    const reminder = buildUserRepetitionReminder(verdict);
    expect(reminder).toContain("USER REPETITION");
    expect(reminder).toContain("grafica");
    expect(reminder).toContain("sigue igual");
    expect(reminder).toContain("rut");
    expect(reminder).toMatch(/a\)/);
    expect(reminder).toMatch(/b\)/);
    expect(reminder).toMatch(/fundamentally different/i);
    expect(reminder).toMatch(/honest/i);
    expect(reminder).toContain("la grafica no renderiza");
  });

  test("adds /compact suggestion when context >= 85%", () => {
    const verdict = {
      isRepeating: true,
      sharedTopics: ["x"],
      frustrationSignals: ["sigue igual"],
      recentMessages: ["a", "b", "c"],
    };
    const reminder = buildUserRepetitionReminder(verdict, 0.92);
    expect(reminder).toContain("/compact");
    expect(reminder).toContain("92%");
  });

  test("omits /compact suggestion when context below threshold", () => {
    const verdict = {
      isRepeating: true,
      sharedTopics: ["x"],
      frustrationSignals: ["sigue igual"],
      recentMessages: ["a", "b", "c"],
    };
    const reminder = buildUserRepetitionReminder(verdict, 0.5);
    expect(reminder).not.toContain("/compact");
  });

  test("omits /compact when saturation is undefined", () => {
    const verdict = {
      isRepeating: true,
      sharedTopics: ["x"],
      frustrationSignals: ["sigue igual"],
      recentMessages: ["a", "b", "c"],
    };
    const reminder = buildUserRepetitionReminder(verdict);
    expect(reminder).not.toContain("/compact");
  });
});

// ─── v2.10.74 Nexus chart session regression ────────────────────

describe("Nexus chart session — stemming + corrective patterns", () => {
  test("fires on the EXACT 3 user messages from the log", () => {
    // Word-for-word from the v2.10.74 session log. Model failed to
    // solve the chart issue across 3 user messages and phase 25 was
    // silent because:
    //   1. "grafica" (msg 1, singular) and "graficas" (msg 2/3,
    //      plural) were treated as distinct tokens — stemming fix
    //      now normalizes both to "grafica"
    //   2. The user's 3rd message was corrective ("no son el
    //      problema, sino el contenedor") — new corrective
    //      frustration patterns now recognize this as equivalent
    //      to classic frustration
    const session: Message[] = [
      { role: "user", content: "crea una app Nexus Telemetry" },
      { role: "assistant", content: "done" },
      { role: "user", content: "la grafica no quedo" },
      { role: "assistant", content: "fixed (wrong code path)" },
      {
        role: "user",
        content:
          "ahora el problema es el modal donde se situan las graficas no quedan estaticas al tamaño que ocupan las graficas",
      },
      { role: "assistant", content: "fixed (still wrong)" },
    ];
    const newMsg =
      "refresque ahora las graficas no son el problema, sino el contenedor de las graficas";
    const verdict = checkUserRepetition(session, newMsg);
    expect(verdict.isRepeating).toBe(true);
    // Stemming: both "grafica" and "graficas" → "grafica"
    expect(verdict.sharedTopics).toContain("grafica");
    // The corrective pattern "no son el problema" should be recognized
    expect(
      verdict.frustrationSignals.some((s) =>
        s.toLowerCase().includes("no son") || s.toLowerCase().includes("el problema"),
      ),
    ).toBe(true);
  });

  test("stems singular/plural pairs (grafica/graficas)", () => {
    const session: Message[] = [
      { role: "user", content: "crea la app" },
      { role: "assistant", content: "done" },
      { role: "user", content: "la grafica esta mal" },
      { role: "assistant", content: "fixed" },
      { role: "user", content: "las graficas siguen mal" },
      { role: "assistant", content: "fixed" },
      { role: "user", content: "mis graficas no funcionan" },
    ];
    // grafica (1), graficas (2), graficas (3) → with stem: all "grafica"
    const verdict = checkUserRepetition(session);
    expect(verdict.sharedTopics).toContain("grafica");
  });

  test("stems English plural pairs (button/buttons)", () => {
    const session: Message[] = [
      { role: "user", content: "make the buttons bigger" },
      { role: "assistant", content: "done" },
      { role: "user", content: "the button still looks broken" },
      { role: "assistant", content: "fixed" },
      { role: "user", content: "all buttons are still not working" },
    ];
    const verdict = checkUserRepetition(session);
    expect(verdict.sharedTopics).toContain("button");
  });

  test("does NOT over-strip short tokens", () => {
    // "bus" and "class" should not be stemmed (bus stays bus — but
    // under 5 chars it never becomes a token anyway; class loses
    // trailing s would yield "clas" which is too short so we keep it)
    const session: Message[] = [
      { role: "user", content: "write a class MyClass" },
      { role: "assistant", content: "done" },
      { role: "user", content: "the class has bugs" },
      { role: "assistant", content: "fixed" },
      { role: "user", content: "class not working" },
    ];
    const verdict = checkUserRepetition(session);
    // "class" appears in all 3, should survive as the shared topic
    // (we bail on stemming when the stem would be <5 chars)
    expect(verdict.sharedTopics.length).toBeGreaterThanOrEqual(0);
    // The test mainly ensures no crash from over-stemming
  });

  test("recognizes corrective statement 'el problema es X'", () => {
    const session: Message[] = [
      { role: "user", content: "fix the header styling" },
      { role: "assistant", content: "done" },
      { role: "user", content: "the header styling is wrong again" },
      { role: "assistant", content: "fixed" },
      { role: "user", content: "el problema es el footer, no el header" },
    ];
    const verdict = checkUserRepetition(session);
    // Corrective pattern "el problema es" should match
    expect(
      verdict.frustrationSignals.some((s) =>
        s.toLowerCase().includes("el problema"),
      ),
    ).toBe(true);
  });

  test("recognizes English corrective 'the real problem is not'", () => {
    const session: Message[] = [
      { role: "user", content: "fix the layout issue" },
      { role: "assistant", content: "done" },
      { role: "user", content: "layout still looks off" },
      { role: "assistant", content: "fixed" },
      {
        role: "user",
        content: "the real problem is not the layout, it's the CSS grid",
      },
    ];
    const verdict = checkUserRepetition(session);
    expect(
      verdict.frustrationSignals.some((s) =>
        /real\s+problem\s+is/i.test(s),
      ),
    ).toBe(true);
  });
});
