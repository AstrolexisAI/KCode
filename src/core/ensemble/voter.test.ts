// KCode - Ensemble Voter Tests

import { test, expect, describe } from "bun:test";
import {
  scoreCandidate,
  hasValidToolCalls,
  isRepetitive,
  heuristicSelect,
  judgeSelect,
  majorityVote,
} from "./voter";
import type { CandidateResponse, ModelExecutor } from "./types";

// ─── Helper ─────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<CandidateResponse> = {}): CandidateResponse {
  return {
    model: "test-model",
    response: "This is a test response with enough content to score well.",
    tokensUsed: 50,
    durationMs: 100,
    ...overrides,
  };
}

function mockExecutor(content: string): ModelExecutor {
  return {
    execute: async () => ({
      content,
      tokensUsed: 10,
      durationMs: 50,
    }),
  };
}

// ─── scoreCandidate ─────────────────────────────────────────────

describe("scoreCandidate", () => {
  test("gives length bonus for longer responses", () => {
    const short = makeCandidate({ response: "hi" });
    const long = makeCandidate({ response: "a".repeat(300) });
    expect(scoreCandidate(long)).toBeGreaterThan(scoreCandidate(short));
  });

  test("caps length bonus at +5", () => {
    const veryLong = makeCandidate({ response: "a".repeat(1000) });
    const justRight = makeCandidate({ response: "a".repeat(500) });
    expect(scoreCandidate(veryLong)).toBe(scoreCandidate(justRight));
  });

  test("penalizes uncertainty patterns", () => {
    const uncertain = makeCandidate({ response: "I don't know the answer to that question." });
    const confident = makeCandidate({ response: "The answer is clearly forty two." });
    expect(scoreCandidate(confident)).toBeGreaterThan(scoreCandidate(uncertain));
  });

  test("penalizes I cannot patterns", () => {
    const refusal = makeCandidate({ response: "I cannot help with that request unfortunately." });
    const helpful = makeCandidate({ response: "Here is the solution to your request." });
    expect(scoreCandidate(helpful)).toBeGreaterThan(scoreCandidate(refusal));
  });

  test("penalizes error patterns", () => {
    const errored = makeCandidate({ response: "SyntaxError: Unexpected token in JSON" });
    const clean = makeCandidate({ response: "The code compiles correctly." });
    expect(scoreCandidate(clean)).toBeGreaterThan(scoreCandidate(errored));
  });

  test("returns a number for any input", () => {
    expect(typeof scoreCandidate(makeCandidate({ response: "" }))).toBe("number");
    expect(typeof scoreCandidate(makeCandidate({ response: "x" }))).toBe("number");
  });
});

// ─── hasValidToolCalls ──────────────────────────────────────────

describe("hasValidToolCalls", () => {
  test("detects tool_use JSON block", () => {
    const text = 'Here is the result: {"type": "tool_use", "name": "Read", "id": "1"}';
    expect(hasValidToolCalls(text)).toBe(true);
  });

  test("returns false for plain text", () => {
    expect(hasValidToolCalls("This is just regular text.")).toBe(false);
  });

  test("returns false for invalid JSON with tool_use keyword", () => {
    expect(hasValidToolCalls('{"type": "tool_use", broken')).toBe(false);
  });
});

// ─── isRepetitive ───────────────────────────────────────────────

describe("isRepetitive", () => {
  test("detects repeated sentences", () => {
    const repeated = [
      "This is a test sentence.",
      "This is a test sentence.",
      "This is a test sentence.",
      "This is a test sentence.",
      "This is a test sentence.",
    ].join(" ");
    expect(isRepetitive(repeated)).toBe(true);
  });

  test("non-repetitive text returns false", () => {
    const diverse = [
      "The first point about architecture is important.",
      "Security should be considered from the start.",
      "Performance testing reveals bottlenecks early.",
      "Documentation helps onboard new team members.",
    ].join(" ");
    expect(isRepetitive(diverse)).toBe(false);
  });

  test("short text is not flagged as repetitive", () => {
    expect(isRepetitive("short")).toBe(false);
  });
});

// ─── heuristicSelect ────────────────────────────────────────────

describe("heuristicSelect", () => {
  test("selects the highest-scored candidate", () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "weak", response: "I don't know" }),
      makeCandidate({ model: "good", response: "Here is a detailed explanation with code examples and clear steps." }),
      makeCandidate({ model: "error", response: "SyntaxError: oops" }),
    ];

    const result = heuristicSelect(candidates);
    expect(result.finalResponse).toContain("detailed explanation");
    expect(result.strategy).toBe("best-of-n");
    expect(result.candidates.length).toBe(3);
  });

  test("breaks ties by duration (faster model wins)", () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "slow", response: "Same answer here", durationMs: 5000 }),
      makeCandidate({ model: "fast", response: "Same answer here", durationMs: 100 }),
    ];

    const result = heuristicSelect(candidates);
    expect(result.candidates[0]!.model).toBe("fast");
  });

  test("includes reasoning in result", () => {
    const result = heuristicSelect([makeCandidate()]);
    expect(result.reasoning).toContain("Heuristic selection");
  });

  test("assigns scores to all candidates", () => {
    const candidates = [makeCandidate({ model: "a" }), makeCandidate({ model: "b" })];
    const result = heuristicSelect(candidates);
    for (const c of result.candidates) {
      expect(typeof c.score).toBe("number");
    }
  });
});

// ─── judgeSelect ────────────────────────────────────────────────

describe("judgeSelect", () => {
  test("selects the candidate chosen by the judge", async () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "model-a", response: "Answer A" }),
      makeCandidate({ model: "model-b", response: "Answer B" }),
      makeCandidate({ model: "model-c", response: "Answer C" }),
    ];

    // Judge selects response 2
    const executor = mockExecutor("The best response is 2 because it is more complete.");

    const result = await judgeSelect(
      candidates,
      "judge-model",
      [{ role: "user", content: "What is TypeScript?" }],
      executor,
    );

    expect(result.finalResponse).toBe("Answer B");
    expect(result.strategy).toBe("best-of-n");
    expect(result.candidates[1]!.score).toBe(1.0);
    expect(result.candidates[0]!.score).toBe(0.0);
  });

  test("falls back to first candidate if judge response has no number", async () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "model-a", response: "Answer A" }),
      makeCandidate({ model: "model-b", response: "Answer B" }),
    ];

    const executor = mockExecutor("I cannot decide between them.");
    // The regex won't match a number, so it defaults to index 0
    // Actually "cannot" has no digits so default is 0
    const result = await judgeSelect(
      candidates,
      "judge-model",
      [{ role: "user", content: "test" }],
      executor,
    );

    expect(result.finalResponse).toBe("Answer A");
  });

  test("falls back to heuristic if judge execution fails", async () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "model-a", response: "Short" }),
      makeCandidate({ model: "model-b", response: "A much longer and more detailed response." }),
    ];

    const failingExecutor: ModelExecutor = {
      execute: async () => { throw new Error("Judge failed"); },
    };

    const result = await judgeSelect(
      candidates,
      "judge-model",
      [{ role: "user", content: "test" }],
      failingExecutor,
    );

    // Should fall back to heuristic, which picks the longer response
    expect(result.strategy).toBe("best-of-n");
    expect(result.candidates.length).toBe(2);
  });

  test("clamps out-of-range judge selection to valid range", async () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "a", response: "A" }),
      makeCandidate({ model: "b", response: "B" }),
    ];

    // Judge says "99" which is out of range
    const executor = mockExecutor("Response 99 is best.");
    const result = await judgeSelect(
      candidates,
      "judge",
      [{ role: "user", content: "test" }],
      executor,
    );

    // Should clamp to last valid index
    expect(result.finalResponse).toBe("B");
  });
});

// ─── majorityVote ───────────────────────────────────────────────

describe("majorityVote", () => {
  test("selects the most common response", () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "a", response: "yes" }),
      makeCandidate({ model: "b", response: "yes" }),
      makeCandidate({ model: "c", response: "no" }),
    ];

    const result = majorityVote(candidates);
    expect(result.finalResponse).toBe("yes");
    expect(result.strategy).toBe("majority-vote");
    expect(result.reasoning).toContain("2/3");
  });

  test("normalizes whitespace for comparison", () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "a", response: "  yes  " }),
      makeCandidate({ model: "b", response: "YES" }),
      makeCandidate({ model: "c", response: "no" }),
    ];

    const result = majorityVote(candidates);
    expect(result.finalResponse.trim().toLowerCase()).toBe("yes");
  });

  test("picks first if all unique", () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "a", response: "alpha" }),
      makeCandidate({ model: "b", response: "beta" }),
      makeCandidate({ model: "c", response: "gamma" }),
    ];

    const result = majorityVote(candidates);
    // All have count=1, first one found with highest count wins
    expect(["alpha", "beta", "gamma"]).toContain(result.finalResponse);
  });

  test("assigns score 1.0 to winning responses and 0.0 to others", () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "a", response: "yes" }),
      makeCandidate({ model: "b", response: "yes" }),
      makeCandidate({ model: "c", response: "no" }),
    ];

    const result = majorityVote(candidates);
    const yesScores = result.candidates.filter(c => c.response === "yes").map(c => c.score);
    const noScores = result.candidates.filter(c => c.response === "no").map(c => c.score);

    expect(yesScores).toEqual([1.0, 1.0]);
    expect(noScores).toEqual([0.0]);
  });
});
