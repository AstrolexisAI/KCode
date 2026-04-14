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
