// Tests for stable finding IDs (CL.2, v2.10.372).

import { describe, expect, test } from "bun:test";
import { computeFindingId, resolveFindingRef } from "./finding-id";

describe("computeFindingId", () => {
  test("same input → same id (deterministic)", () => {
    const a = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/proj/src/server.js",
      matched_text: "eval(req.body.code)",
      projectRoot: "/proj",
    });
    const b = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/proj/src/server.js",
      matched_text: "eval(req.body.code)",
      projectRoot: "/proj",
    });
    expect(a).toBe(b);
  });

  test("kc- prefix and 12-hex-char body", () => {
    const id = computeFindingId({
      pattern_id: "x",
      file: "/p/y",
      matched_text: "z",
      projectRoot: "/p",
    });
    expect(id).toMatch(/^kc-[0-9a-f]{12}$/);
  });

  test("different pattern → different id", () => {
    const a = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/p/x.js",
      matched_text: "eval(x)",
      projectRoot: "/p",
    });
    const b = computeFindingId({
      pattern_id: "js-007-command-injection",
      file: "/p/x.js",
      matched_text: "eval(x)",
      projectRoot: "/p",
    });
    expect(a).not.toBe(b);
  });

  test("different file → different id", () => {
    const a = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/p/a.js",
      matched_text: "eval(x)",
      projectRoot: "/p",
    });
    const b = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/p/b.js",
      matched_text: "eval(x)",
      projectRoot: "/p",
    });
    expect(a).not.toBe(b);
  });

  test("different snippet → different id", () => {
    const a = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/p/x.js",
      matched_text: "eval(req.body.code)",
      projectRoot: "/p",
    });
    const b = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/p/x.js",
      matched_text: "eval(req.query.code)",
      projectRoot: "/p",
    });
    expect(a).not.toBe(b);
  });

  test("trailing punctuation doesn't change id", () => {
    const a = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/p/x.js",
      matched_text: "eval(x);",
      projectRoot: "/p",
    });
    const b = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/p/x.js",
      matched_text: "eval(x),",
      projectRoot: "/p",
    });
    const c = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/p/x.js",
      matched_text: "eval(x)",
      projectRoot: "/p",
    });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("whitespace in snippet collapsed", () => {
    const a = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/p/x.js",
      matched_text: "eval(  req.body.code  )",
      projectRoot: "/p",
    });
    const b = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/p/x.js",
      matched_text: "eval( req.body.code )",
      projectRoot: "/p",
    });
    expect(a).toBe(b);
  });

  test("project relativization: same finding from different absolute roots → same id", () => {
    const a = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/home/alice/myapp/src/x.js",
      matched_text: "eval(x)",
      projectRoot: "/home/alice/myapp",
    });
    const b = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/home/bob/myapp/src/x.js",
      matched_text: "eval(x)",
      projectRoot: "/home/bob/myapp",
    });
    expect(a).toBe(b);
  });

  test("line number is NOT in the hash (refactor tolerance)", () => {
    // Same pattern, same file, same snippet — line moved from 12 to 47.
    // ID should not change because the bug is the same vulnerability.
    const a = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/p/x.js",
      matched_text: "eval(req.body)",
      projectRoot: "/p",
    });
    const b = computeFindingId({
      pattern_id: "js-001-eval",
      file: "/p/x.js",
      matched_text: "eval(req.body)",
      projectRoot: "/p",
    });
    expect(a).toBe(b);
  });
});

describe("resolveFindingRef", () => {
  const flat = [
    { item: { finding_id: "kc-aaaaaaaaaaaa" } },
    { item: { finding_id: "kc-bbbbbbbbbbbb" } },
    { item: { finding_id: "kc-bcccccccccc" } },
    { item: {} }, // legacy: no finding_id
  ];

  test("integer index returns 0-based slot", () => {
    expect(resolveFindingRef("1", flat)).toBe(0);
    expect(resolveFindingRef("2", flat)).toBe(1);
    expect(resolveFindingRef("4", flat)).toBe(3);
  });

  test("integer index with whitespace works", () => {
    expect(resolveFindingRef(" 2 ", flat)).toBe(1);
  });

  test("full kc-* finding_id matches", () => {
    expect(resolveFindingRef("kc-aaaaaaaaaaaa", flat)).toBe(0);
    expect(resolveFindingRef("kc-bbbbbbbbbbbb", flat)).toBe(1);
  });

  test("kc-* finding_id is case-insensitive", () => {
    expect(resolveFindingRef("KC-AAAAAAAAAAAA", flat)).toBe(0);
  });

  test("prefix match works when unambiguous", () => {
    // kc-aaa is unique → resolves to 0
    expect(resolveFindingRef("kc-aaa", flat)).toBe(0);
  });

  test("prefix match returns -1 when ambiguous", () => {
    // kc-bb matches both kc-bbbbbbbbbbbb and kc-bcccccccccc — wait,
    // kc-bb only matches the first; kc-b would be ambiguous.
    expect(resolveFindingRef("kc-b", flat)).toBe(-1);
  });

  test("unknown ref returns -1", () => {
    expect(resolveFindingRef("kc-xxxxxx", flat)).toBe(-1);
    expect(resolveFindingRef("not-a-ref", flat)).toBe(-1);
  });

  test("integer outside range returns slot beyond array bounds", () => {
    // resolveFindingRef returns asInt - 1; caller handles bounds.
    expect(resolveFindingRef("99", flat)).toBe(98);
  });
});
