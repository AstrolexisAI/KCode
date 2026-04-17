// Phase 2 — advisor-mode parsers and trigger filter.
//
// Covers parseKodiAdvisorJson's tolerance to messy small-model
// outputs (code fences, trailing prose, missing fields) and
// shouldCallAdvisor's event filtering so the advisor stays quiet
// during mechanical tool flow.

import { describe, expect, test } from "bun:test";
import { parseKodiAdvisorJson, shouldCallAdvisor, type KodiReaction } from "./Kodi";

describe("parseKodiAdvisorJson — happy path", () => {
  test("parses a clean JSON object", () => {
    const raw = '{"mood":"worried","speech":"cyclic?","advice":"a.ts imports b.ts imports a.ts"}';
    const r = parseKodiAdvisorJson(raw) as KodiReaction;
    expect(r).not.toBeNull();
    expect(r.mood).toBe("worried");
    expect(r.speech).toBe("cyclic?");
    expect(r.advice).toBe("a.ts imports b.ts imports a.ts");
  });

  test("truncates speech to 14 chars", () => {
    const raw = '{"mood":"happy","speech":"wayyyyyy too long for the bubble","advice":null}';
    const r = parseKodiAdvisorJson(raw);
    expect(r).not.toBeNull();
    expect(r!.speech!.length).toBeLessThanOrEqual(14);
  });

  test("truncates advice to 120 chars", () => {
    const long = "x".repeat(500);
    const raw = `{"mood":"happy","speech":"ok","advice":"${long}"}`;
    const r = parseKodiAdvisorJson(raw);
    expect(r).not.toBeNull();
    expect(r!.advice!.length).toBeLessThanOrEqual(120);
  });
});

describe("parseKodiAdvisorJson — tolerant to small-model messiness", () => {
  test("strips markdown fences", () => {
    const raw = '```json\n{"mood":"excited","speech":"lgtm","advice":null}\n```';
    const r = parseKodiAdvisorJson(raw);
    expect(r).not.toBeNull();
    expect(r!.mood).toBe("excited");
    expect(r!.speech).toBe("lgtm");
  });

  test("strips unlabeled fences", () => {
    const raw = '```\n{"mood":"happy","speech":"ok"}\n```';
    const r = parseKodiAdvisorJson(raw);
    expect(r!.mood).toBe("happy");
  });

  test("extracts JSON from preamble prose", () => {
    const raw = 'Sure! Here is my response: {"mood":"smug","speech":"nice","advice":null}';
    const r = parseKodiAdvisorJson(raw);
    expect(r!.mood).toBe("smug");
  });

  test("null advice is dropped (not included as a string)", () => {
    const raw = '{"mood":"happy","speech":"ok","advice":null}';
    const r = parseKodiAdvisorJson(raw);
    expect(r!.advice).toBeUndefined();
  });

  test('string "null" as advice is also dropped', () => {
    // Small models sometimes emit the literal word
    const raw = '{"mood":"happy","speech":"ok","advice":"null"}';
    const r = parseKodiAdvisorJson(raw);
    expect(r!.advice).toBeUndefined();
  });

  test("invalid mood falls through — advisor keeps using current mood", () => {
    const raw = '{"mood":"bogus_mood_name","speech":"ok","advice":null}';
    const r = parseKodiAdvisorJson(raw);
    expect(r!.mood).toBeUndefined();
    expect(r!.speech).toBe("ok");
  });

  test("new moods (flex, dance, waving) are accepted", () => {
    for (const m of ["flex", "dance", "waving"]) {
      const r = parseKodiAdvisorJson(`{"mood":"${m}","speech":"hi"}`);
      expect(r!.mood).toBe(m);
    }
  });
});

describe("parseKodiAdvisorJson — rejection", () => {
  test("returns null on non-JSON garbage", () => {
    expect(parseKodiAdvisorJson("I don't know how to respond.")).toBeNull();
  });

  test("returns null on empty input", () => {
    expect(parseKodiAdvisorJson("")).toBeNull();
  });

  test("returns null when all fields are missing or invalid", () => {
    const raw = '{"mood":"invalid","speech":"","advice":null}';
    expect(parseKodiAdvisorJson(raw)).toBeNull();
  });

  test("returns null on malformed JSON even if text contains braces", () => {
    expect(parseKodiAdvisorJson("{unbalanced")).toBeNull();
  });
});

describe("shouldCallAdvisor — gate", () => {
  test("fires on commit / test_pass / test_fail / compaction", () => {
    expect(shouldCallAdvisor({ type: "commit" }, 0)).toBe(true);
    expect(shouldCallAdvisor({ type: "test_pass" }, 0)).toBe(true);
    expect(shouldCallAdvisor({ type: "test_fail" }, 0)).toBe(true);
    expect(shouldCallAdvisor({ type: "compaction" }, 0)).toBe(true);
  });

  test("fires on turn_end + error + agent outcomes", () => {
    expect(shouldCallAdvisor({ type: "turn_end" }, 0)).toBe(true);
    expect(shouldCallAdvisor({ type: "error" }, 0)).toBe(true);
    expect(shouldCallAdvisor({ type: "agent_done" }, 0)).toBe(true);
    expect(shouldCallAdvisor({ type: "agent_failed" }, 0)).toBe(true);
  });

  test("tool_error only fires after a 3-error streak", () => {
    expect(shouldCallAdvisor({ type: "tool_error" }, 0)).toBe(false);
    expect(shouldCallAdvisor({ type: "tool_error" }, 2)).toBe(false);
    expect(shouldCallAdvisor({ type: "tool_error" }, 3)).toBe(true);
    expect(shouldCallAdvisor({ type: "tool_error" }, 5)).toBe(true);
  });

  test("stays silent on mechanical events", () => {
    expect(shouldCallAdvisor({ type: "tool_start" }, 0)).toBe(false);
    expect(shouldCallAdvisor({ type: "tool_done" }, 0)).toBe(false);
    expect(shouldCallAdvisor({ type: "thinking" }, 0)).toBe(false);
    expect(shouldCallAdvisor({ type: "streaming" }, 0)).toBe(false);
    expect(shouldCallAdvisor({ type: "idle" }, 0)).toBe(false);
    expect(shouldCallAdvisor({ type: "agent_spawn" }, 0)).toBe(false);
    expect(shouldCallAdvisor({ type: "agent_progress" }, 0)).toBe(false);
  });
});
