// Phase 2 — advisor parser and trigger filter.
//
// The advisor only emits `advice` (mood + speech stay on the
// deterministic engine path). parseKodiAdvisorJson must:
//   - tolerate markdown fences and preamble prose from small models,
//   - drop null / "null" / fluff advice,
//   - truncate to 120 chars,
//   - return null when nothing usable remains.
//
// shouldCallAdvisor gates LLM calls to events with real info content.

import { describe, expect, test } from "bun:test";
import { parseKodiAdvisorJson, shouldCallAdvisor } from "./Kodi";

describe("parseKodiAdvisorJson — happy path", () => {
  test("parses a specific actionable advice", () => {
    const raw = '{"advice":"src/core/models.ts: missing import of Opus 4.7 constant"}';
    const r = parseKodiAdvisorJson(raw);
    expect(r).not.toBeNull();
    expect(r!.advice).toBe("src/core/models.ts: missing import of Opus 4.7 constant");
  });

  test("truncates advice to 120 chars", () => {
    const raw = `{"advice":"${"x".repeat(500)}"}`;
    const r = parseKodiAdvisorJson(raw);
    expect(r).not.toBeNull();
    expect(r!.advice!.length).toBeLessThanOrEqual(120);
  });

  test("trims leading/trailing whitespace", () => {
    const raw = '{"advice":"   src/a.ts line 42   "}';
    const r = parseKodiAdvisorJson(raw);
    expect(r!.advice).toBe("src/a.ts line 42");
  });
});

describe("parseKodiAdvisorJson — tolerant to small-model messiness", () => {
  test("strips labeled markdown fences", () => {
    const raw = '```json\n{"advice":"test file expects Opus 4.7"}\n```';
    const r = parseKodiAdvisorJson(raw);
    expect(r).not.toBeNull();
    expect(r!.advice).toBe("test file expects Opus 4.7");
  });

  test("strips unlabeled fences", () => {
    const raw = '```\n{"advice":"check src/a.ts import order"}\n```';
    const r = parseKodiAdvisorJson(raw);
    expect(r!.advice).toBe("check src/a.ts import order");
  });

  test("extracts JSON from preamble prose", () => {
    const raw = 'Sure! Here is my response: {"advice":"Qwen tokenizer mismatch in models.ts:42"}';
    const r = parseKodiAdvisorJson(raw);
    expect(r!.advice).toBe("Qwen tokenizer mismatch in models.ts:42");
  });
});

describe("parseKodiAdvisorJson — fluff filter", () => {
  test("rejects 'consider X' hedge", () => {
    const raw = '{"advice":"consider refactoring src/core/kodi.ts"}';
    expect(parseKodiAdvisorJson(raw)).toBeNull();
  });

  test("rejects 'maybe check' hedge", () => {
    const raw = '{"advice":"maybe check if the file exists"}';
    expect(parseKodiAdvisorJson(raw)).toBeNull();
  });

  test("rejects 'should X' hedge", () => {
    const raw = '{"advice":"you should split conversation.ts"}';
    expect(parseKodiAdvisorJson(raw)).toBeNull();
  });

  test("rejects 'ensure' hedge", () => {
    const raw = '{"advice":"ensure everything works as expected"}';
    expect(parseKodiAdvisorJson(raw)).toBeNull();
  });

  test("rejects 'might want to' hedge", () => {
    const raw = '{"advice":"you might want to run tests"}';
    expect(parseKodiAdvisorJson(raw)).toBeNull();
  });

  test("rejects 'try to' hedge", () => {
    const raw = '{"advice":"try to check the import"}';
    expect(parseKodiAdvisorJson(raw)).toBeNull();
  });

  test("rejects 'recommended' hedge", () => {
    const raw = '{"advice":"it is recommended to split the file"}';
    expect(parseKodiAdvisorJson(raw)).toBeNull();
  });
});

describe("parseKodiAdvisorJson — rejection", () => {
  test("null advice is rejected", () => {
    expect(parseKodiAdvisorJson('{"advice":null}')).toBeNull();
  });

  test("string 'null' advice is rejected", () => {
    expect(parseKodiAdvisorJson('{"advice":"null"}')).toBeNull();
  });

  test("empty advice string is rejected", () => {
    expect(parseKodiAdvisorJson('{"advice":""}')).toBeNull();
  });

  test("whitespace-only advice is rejected", () => {
    expect(parseKodiAdvisorJson('{"advice":"   "}')).toBeNull();
  });

  test("returns null on non-JSON garbage", () => {
    expect(parseKodiAdvisorJson("I don't know how to respond.")).toBeNull();
  });

  test("returns null on empty input", () => {
    expect(parseKodiAdvisorJson("")).toBeNull();
  });

  test("returns null on malformed JSON", () => {
    expect(parseKodiAdvisorJson("{unbalanced")).toBeNull();
  });

  test("returns null when advice field is missing", () => {
    expect(parseKodiAdvisorJson('{"other":"field"}')).toBeNull();
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
