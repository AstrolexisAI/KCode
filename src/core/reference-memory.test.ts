// Tests for reference-memory (issue #111 v305, ordinal resolution).

import { beforeEach, describe, expect, it } from "bun:test";
import {
  allReferences,
  bumpTurnCounter,
  detectOrdinalReference,
  extractRankedListFromText,
  getLastRankedList,
  hasDestructiveActionIntent,
  recordRankedList,
  resetReferences,
  resolveOrdinal,
} from "./reference-memory";

beforeEach(() => {
  resetReferences();
});

describe("extractRankedListFromText", () => {
  it("captures a 3-item numbered list with URLs", () => {
    const text = `Here are the repos:

1. openmct — telemetry viewer (https://github.com/nasa/openmct)
2. fprime — flight software (https://github.com/nasa/fprime)
3. cumulus — cloud pipeline (https://github.com/nasa/cumulus)

Which one?`;
    const items = extractRankedListFromText(text);
    expect(items.length).toBe(3);
    expect(items[0]!.rank).toBe(1);
    expect(items[0]!.title).toContain("openmct");
    expect(items[2]!.rank).toBe(3);
    expect(items[2]!.url).toBe("https://github.com/nasa/cumulus");
  });

  it("captures a [#N] bracket-prefixed list", () => {
    const text = `Top results:
[#1] alpha — something (https://example.com/a)
[#2] beta — something (https://example.com/b)
[#3] gamma — something (https://example.com/c)
[#4] delta — something (https://example.com/d)`;
    const items = extractRankedListFromText(text);
    expect(items.length).toBe(4);
    expect(items[3]!.rank).toBe(4);
  });

  it("ignores single stray '1.' preambles", () => {
    const text = `1. Let me look at this.\n\nThis is the analysis.`;
    expect(extractRankedListFromText(text).length).toBe(0);
  });

  it("handles a 10-item list and preserves order", () => {
    const lines = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(`${i}. project${i} — desc (https://example.com/p${i})`);
    }
    const items = extractRankedListFromText(lines.join("\n"));
    expect(items.length).toBe(10);
    expect(items[5]!.rank).toBe(6);
    expect(items[5]!.title).toContain("project6");
  });
});

describe("detectOrdinalReference", () => {
  it("parses '#N' form", () => {
    expect(detectOrdinalReference("clone #4 please")).toEqual({
      rank: 4,
      snippet: "#4",
    });
  });

  it("parses 'proyecto N' form", () => {
    expect(detectOrdinalReference("clona el proyecto 6")).toEqual({
      rank: 6,
      snippet: "#6",
    });
  });

  it("parses 'repo N' form", () => {
    expect(detectOrdinalReference("open repo 2")).toEqual({
      rank: 2,
      snippet: "#2",
    });
  });

  it("parses Spanish ordinal words", () => {
    const r = detectOrdinalReference("el sexto que listaste");
    expect(r?.rank).toBe(6);
  });

  it("parses English ordinal words", () => {
    const r = detectOrdinalReference("the seventh one");
    expect(r?.rank).toBe(7);
  });

  it("returns null for non-ordinal text", () => {
    expect(detectOrdinalReference("clone openmct")).toBeNull();
  });
});

describe("resolveOrdinal", () => {
  it("resolves 'proyecto 6' against recently-captured list of NASA repos", () => {
    recordRankedList("repos", [
      { rank: 1, id: "openmct", title: "openmct", url: "https://github.com/nasa/openmct" },
      { rank: 2, id: "fprime", title: "fprime", url: "https://github.com/nasa/fprime" },
      { rank: 3, id: "trick", title: "trick", url: "https://github.com/nasa/trick" },
      { rank: 4, id: "harvest", title: "harvest", url: "https://github.com/nasa/harvest" },
      { rank: 5, id: "daphne", title: "daphne", url: "https://github.com/nasa/daphne" },
      { rank: 6, id: "cumulus", title: "cumulus", url: "https://github.com/nasa/cumulus" },
      { rank: 7, id: "ogma", title: "ogma", url: "https://github.com/nasa/ogma" },
    ]);
    const r = resolveOrdinal("clona el proyecto 6");
    expect(r).not.toBeNull();
    expect(r!.rank).toBe(6);
    expect(r!.item.title).toBe("cumulus");
    expect(r!.item.url).toBe("https://github.com/nasa/cumulus");
  });

  it("returns null when no prior list was captured", () => {
    expect(resolveOrdinal("clona el proyecto 6")).toBeNull();
  });

  it("returns null when the list is >3 turns old (staleness)", () => {
    recordRankedList("repos", [
      { rank: 1, id: "a", title: "a" },
      { rank: 2, id: "b", title: "b" },
      { rank: 3, id: "c", title: "c" },
    ]);
    bumpTurnCounter();
    bumpTurnCounter();
    bumpTurnCounter();
    bumpTurnCounter();
    bumpTurnCounter();
    expect(resolveOrdinal("clone #2")).toBeNull();
  });

  it("returns null when rank is out of range", () => {
    recordRankedList("repos", [
      { rank: 1, id: "a", title: "a" },
      { rank: 2, id: "b", title: "b" },
      { rank: 3, id: "c", title: "c" },
    ]);
    expect(resolveOrdinal("clone #99")).toBeNull();
  });

  it("prefers the most recent list when two lists are in history", () => {
    recordRankedList("first", [
      { rank: 1, id: "x", title: "x" },
      { rank: 2, id: "y", title: "y" },
      { rank: 3, id: "z", title: "z" },
    ]);
    bumpTurnCounter();
    recordRankedList("second", [
      { rank: 1, id: "alpha", title: "alpha" },
      { rank: 2, id: "beta", title: "beta" },
      { rank: 3, id: "gamma", title: "gamma" },
    ]);
    const r = resolveOrdinal("clone #2");
    expect(r!.item.title).toBe("beta");
  });
});

describe("hasDestructiveActionIntent", () => {
  it("detects clone/clona", () => {
    expect(hasDestructiveActionIntent("clona el proyecto 6")).toBe(true);
    expect(hasDestructiveActionIntent("clone #2")).toBe(true);
  });

  it("detects install/instala, delete/borra", () => {
    expect(hasDestructiveActionIntent("instala ese paquete")).toBe(true);
    expect(hasDestructiveActionIntent("delete #3")).toBe(true);
  });

  it("does not match plain questions", () => {
    expect(hasDestructiveActionIntent("which one is the best?")).toBe(false);
    expect(hasDestructiveActionIntent("cuál me recomiendas?")).toBe(false);
  });
});

describe("getLastRankedList + history cap", () => {
  it("caps history at 8 entries, oldest dropped first", () => {
    for (let i = 0; i < 12; i++) {
      recordRankedList(`list${i}`, [
        { rank: 1, id: `a${i}`, title: `a${i}` },
        { rank: 2, id: `b${i}`, title: `b${i}` },
        { rank: 3, id: `c${i}`, title: `c${i}` },
      ]);
    }
    expect(allReferences().length).toBeLessThanOrEqual(8);
    const last = getLastRankedList();
    expect(last?.kind).toBe("ranked_list");
    if (last?.kind === "ranked_list") expect(last.label).toBe("list11");
  });
});
