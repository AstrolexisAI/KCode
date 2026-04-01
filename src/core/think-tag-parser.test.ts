// KCode - Think Tag Parser Tests
// Exhaustive edge-case testing for the streaming <think>/<reasoning> tag parser

import { describe, expect, test } from "bun:test";
import { createThinkTagParser, type ThinkTagEvent } from "./think-tag-parser";

// Helper: feed an array of string chunks and collect all events (including flush)
function parse(chunks: string[]): ThinkTagEvent[] {
  const parser = createThinkTagParser();
  const events: ThinkTagEvent[] = [];
  for (const chunk of chunks) {
    for (const ev of parser.feed(chunk)) events.push(ev);
  }
  for (const ev of parser.flush()) events.push(ev);
  return events;
}

// Helper: concatenate all events of a given type
function collect(events: ThinkTagEvent[], type: "thinking" | "content"): string {
  return events
    .filter((e) => e.type === type)
    .map((e) => e.text)
    .join("");
}

// ─── Basic functionality ─────────────────────────────────────────

describe("ThinkTagParser: basic", () => {
  test("plain text without tags passes through as content", () => {
    const events = parse(["Hello world"]);
    expect(collect(events, "content")).toBe("Hello world");
    expect(collect(events, "thinking")).toBe("");
  });

  test("empty input produces no events", () => {
    const events = parse([]);
    expect(events).toHaveLength(0);
  });

  test("empty string chunk produces no events", () => {
    const events = parse([""]);
    expect(events).toHaveLength(0);
  });

  test("<reasoning> block extracts thinking", () => {
    const events = parse(["<reasoning>step 1\nstep 2</reasoning>answer"]);
    expect(collect(events, "thinking")).toBe("step 1\nstep 2");
    expect(collect(events, "content")).toBe("answer");
  });

  test("<think> block extracts thinking", () => {
    const events = parse(["<think>analysis</think>result"]);
    expect(collect(events, "thinking")).toBe("analysis");
    expect(collect(events, "content")).toBe("result");
  });

  test("text before and after reasoning block", () => {
    const events = parse(["prefix<reasoning>thought</reasoning>suffix"]);
    expect(collect(events, "content")).toBe("prefixsuffix");
    expect(collect(events, "thinking")).toBe("thought");
  });
});

// ─── Token-by-token streaming (char by char) ─────────────────────

describe("ThinkTagParser: char-by-char streaming", () => {
  test("<reasoning> tag split across individual characters", () => {
    const input = "<reasoning>hello world</reasoning>answer here";
    const chunks = input.split(""); // one char per chunk
    const events = parse(chunks);
    expect(collect(events, "thinking")).toBe("hello world");
    expect(collect(events, "content")).toBe("answer here");
  });

  test("<think> tag split across individual characters", () => {
    const input = "<think>deep thought</think>42";
    const chunks = input.split("");
    const events = parse(chunks);
    expect(collect(events, "thinking")).toBe("deep thought");
    expect(collect(events, "content")).toBe("42");
  });

  test("large thinking block char-by-char", () => {
    const thinkContent = "A".repeat(5000);
    const input = `<reasoning>${thinkContent}</reasoning>done`;
    const chunks = input.split("");
    const events = parse(chunks);
    expect(collect(events, "thinking")).toBe(thinkContent);
    expect(collect(events, "content")).toBe("done");
  });
});

// ─── Realistic token sizes (2-6 chars per token) ────────────────

describe("ThinkTagParser: realistic token sizes", () => {
  test("tags split at realistic token boundaries", () => {
    const events = parse([
      "<reas",
      "oning>",
      "Let me ",
      "think about ",
      "this...",
      "</rea",
      "soning>",
      "The answer is 42.",
    ]);
    expect(collect(events, "thinking")).toBe("Let me think about this...");
    expect(collect(events, "content")).toBe("The answer is 42.");
  });

  test("close tag split across 3 chunks", () => {
    const events = parse(["<reasoning>thought", "</", "reason", "ing>", "answer"]);
    expect(collect(events, "thinking")).toBe("thought");
    expect(collect(events, "content")).toBe("answer");
  });

  test("open tag arrives in single chunk, close split", () => {
    const events = parse([
      "<reasoning>",
      "step 1\n",
      "step 2\n",
      "step 3",
      "</reasoning>",
      "final answer",
    ]);
    expect(collect(events, "thinking")).toBe("step 1\nstep 2\nstep 3");
    expect(collect(events, "content")).toBe("final answer");
  });
});

// ─── Partial tag at boundaries ───────────────────────────────────

describe("ThinkTagParser: partial tags at boundaries", () => {
  test("'<' at end of chunk doesn't emit prematurely", () => {
    const events = parse(["some text<", "reasoning>inner</reasoning>end"]);
    expect(collect(events, "content")).toBe("some textend");
    expect(collect(events, "thinking")).toBe("inner");
  });

  test("'<r' at end of chunk", () => {
    const events = parse(["text<r", "easoning>thought</reasoning>ok"]);
    expect(collect(events, "content")).toBe("textok");
    expect(collect(events, "thinking")).toBe("thought");
  });

  test("'</reaso' at end of chunk inside thinking", () => {
    const events = parse(["<reasoning>content</reaso", "ning>after"]);
    expect(collect(events, "thinking")).toBe("content");
    expect(collect(events, "content")).toBe("after");
  });

  test("false alarm: '<' followed by non-tag text", () => {
    const events = parse(["<div>not a tag</div>"]);
    expect(collect(events, "content")).toBe("<div>not a tag</div>");
    expect(collect(events, "thinking")).toBe("");
  });

  test("'<reason' that doesn't become '<reasoning>'", () => {
    const events = parse(["<reason", " for this is simple"]);
    expect(collect(events, "content")).toBe("<reason for this is simple");
    expect(collect(events, "thinking")).toBe("");
  });

  test("'<thi' that doesn't become '<think>'", () => {
    const events = parse(["<thi", "s is content"]);
    expect(collect(events, "content")).toBe("<this is content");
    expect(collect(events, "thinking")).toBe("");
  });
});

// ─── Multiple thinking blocks ────────────────────────────────────

describe("ThinkTagParser: multiple blocks", () => {
  test("two consecutive reasoning blocks", () => {
    const events = parse(["<reasoning>first</reasoning>mid<reasoning>second</reasoning>end"]);
    expect(collect(events, "thinking")).toBe("firstsecond");
    expect(collect(events, "content")).toBe("midend");
  });

  test("mixed think and reasoning tags", () => {
    const events = parse(["<think>thought1</think>text1<reasoning>thought2</reasoning>text2"]);
    expect(collect(events, "thinking")).toBe("thought1thought2");
    expect(collect(events, "content")).toBe("text1text2");
  });

  test("three blocks with content between", () => {
    const events = parse([
      "A<reasoning>1</reasoning>B<reasoning>2</reasoning>C<reasoning>3</reasoning>D",
    ]);
    expect(collect(events, "thinking")).toBe("123");
    expect(collect(events, "content")).toBe("ABCD");
  });
});

// ─── Unclosed tags (stream ends mid-thinking) ────────────────────

describe("ThinkTagParser: unclosed tags", () => {
  test("stream ends inside <reasoning> block", () => {
    const events = parse(["<reasoning>incomplete thinking"]);
    expect(collect(events, "thinking")).toBe("incomplete thinking");
    expect(collect(events, "content")).toBe("");
  });

  test("stream ends inside <think> block", () => {
    const events = parse(["<think>partial"]);
    expect(collect(events, "thinking")).toBe("partial");
  });

  test("stream ends with partial close tag", () => {
    const events = parse(["<reasoning>thought</reaso"]);
    // The partial close tag should be flushed as thinking content
    expect(collect(events, "thinking")).toBe("thought</reaso");
  });

  test("stream ends right after open tag", () => {
    const events = parse(["<reasoning>"]);
    expect(events).toHaveLength(0); // nothing to emit (empty thinking)
  });

  test("stream ends with partial open tag", () => {
    const events = parse(["some text<reaso"]);
    // partial tag can't be resolved, flush as content
    expect(collect(events, "content")).toBe("some text<reaso");
  });
});

// ─── Large content stress test ───────────────────────────────────

describe("ThinkTagParser: stress tests", () => {
  test("100KB thinking block", () => {
    const bigThought = "x".repeat(100_000);
    const events = parse([`<reasoning>${bigThought}</reasoning>done`]);
    expect(collect(events, "thinking")).toBe(bigThought);
    expect(collect(events, "content")).toBe("done");
  });

  test("100KB thinking block streamed in 100-char chunks", () => {
    const bigThought = "y".repeat(100_000);
    const full = `<reasoning>${bigThought}</reasoning>ok`;
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += 100) {
      chunks.push(full.slice(i, i + 100));
    }
    const events = parse(chunks);
    expect(collect(events, "thinking")).toBe(bigThought);
    expect(collect(events, "content")).toBe("ok");
  });

  test("1000 tiny reasoning blocks", () => {
    let input = "";
    for (let i = 0; i < 1000; i++) {
      input += `<reasoning>t${i}</reasoning>c${i}`;
    }
    const events = parse([input]);
    const thinkTotal = events.filter((e) => e.type === "thinking");
    const contentTotal = events.filter((e) => e.type === "content");
    expect(thinkTotal.length).toBeGreaterThan(0);
    expect(contentTotal.length).toBeGreaterThan(0);
    // Verify content integrity
    let expectedThinking = "";
    let expectedContent = "";
    for (let i = 0; i < 1000; i++) {
      expectedThinking += `t${i}`;
      expectedContent += `c${i}`;
    }
    expect(collect(events, "thinking")).toBe(expectedThinking);
    expect(collect(events, "content")).toBe(expectedContent);
  });

  test("100 blocks streamed char-by-char", () => {
    let input = "";
    for (let i = 0; i < 100; i++) {
      input += `<reasoning>think${i}</reasoning>out${i}`;
    }
    const chunks = input.split("");
    const events = parse(chunks);
    let expectedThinking = "";
    let expectedContent = "";
    for (let i = 0; i < 100; i++) {
      expectedThinking += `think${i}`;
      expectedContent += `out${i}`;
    }
    expect(collect(events, "thinking")).toBe(expectedThinking);
    expect(collect(events, "content")).toBe(expectedContent);
  });

  test("random chunk sizes (fuzz-like)", () => {
    const thinkContent = "The quick brown fox jumps over the lazy dog. ".repeat(50);
    const answer = "42 is the answer to everything.";
    const full = `prefix<reasoning>${thinkContent}</reasoning>${answer}`;

    // Split into random-sized chunks (1-20 chars)
    const chunks: string[] = [];
    let pos = 0;
    let seed = 12345;
    while (pos < full.length) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const size = (seed % 20) + 1;
      chunks.push(full.slice(pos, pos + size));
      pos += size;
    }

    const events = parse(chunks);
    expect(collect(events, "thinking")).toBe(thinkContent);
    expect(collect(events, "content")).toBe("prefix" + answer);
  });
});

// ─── Special content inside thinking ─────────────────────────────

describe("ThinkTagParser: special content", () => {
  test("HTML-like tags inside thinking block", () => {
    const events = parse(["<reasoning><div>not closing</div> <b>bold</b></reasoning>ok"]);
    expect(collect(events, "thinking")).toBe("<div>not closing</div> <b>bold</b>");
    expect(collect(events, "content")).toBe("ok");
  });

  test("newlines and special chars in thinking", () => {
    const events = parse(["<reasoning>\n\ttab\n  spaces\n```code```\n</reasoning>done"]);
    expect(collect(events, "thinking")).toBe("\n\ttab\n  spaces\n```code```\n");
  });

  test("unicode and emoji in thinking", () => {
    const events = parse(["<reasoning>思考中 🧠 análisis ñ</reasoning>結果"]);
    expect(collect(events, "thinking")).toBe("思考中 🧠 análisis ñ");
    expect(collect(events, "content")).toBe("結果");
  });

  test("XML-like content that looks like close tag", () => {
    const events = parse(["<reasoning>check </reason but not </reasoning>ok"]);
    expect(collect(events, "thinking")).toBe("check </reason but not ");
    expect(collect(events, "content")).toBe("ok");
  });

  test("nested reasoning tag (inner one treated as text)", () => {
    const events = parse([
      "<reasoning>outer<reasoning>inner</reasoning>still thinking?</reasoning>end",
    ]);
    // First </reasoning> closes the block
    expect(collect(events, "thinking")).toBe("outer<reasoning>inner");
    // "still thinking?" + "</reasoning>end" — the </reasoning> won't match since we're outside
    expect(collect(events, "content")).toContain("still thinking?");
  });

  test("empty reasoning block", () => {
    const events = parse(["<reasoning></reasoning>content"]);
    expect(collect(events, "thinking")).toBe("");
    expect(collect(events, "content")).toBe("content");
  });

  test("reasoning block with only whitespace", () => {
    const events = parse(["<reasoning>   \n\n  </reasoning>ok"]);
    expect(collect(events, "thinking")).toBe("   \n\n  ");
    expect(collect(events, "content")).toBe("ok");
  });
});

// ─── Parser reset ────────────────────────────────────────────────

describe("ThinkTagParser: reset", () => {
  test("reset clears state for reuse", () => {
    const parser = createThinkTagParser();
    const events1: ThinkTagEvent[] = [];
    for (const ev of parser.feed("<reasoning>first")) events1.push(ev);
    // Don't flush — reset instead
    parser.reset();

    const events2: ThinkTagEvent[] = [];
    for (const ev of parser.feed("<reasoning>second</reasoning>ok")) events2.push(ev);
    for (const ev of parser.flush()) events2.push(ev);

    expect(collect(events2, "thinking")).toBe("second");
    expect(collect(events2, "content")).toBe("ok");
  });
});

// ─── Edge case: tags that almost match ───────────────────────────

describe("ThinkTagParser: near-miss tags", () => {
  test("'<reasoning' without '>' is not a tag", () => {
    const events = parse(["<reasoning is cool</reasoning>"]);
    // '<reasoning' without '>' → not a tag, passes as content
    expect(collect(events, "content")).toBe("<reasoning is cool</reasoning>");
    expect(collect(events, "thinking")).toBe("");
  });

  test("'<think ' with space is not a tag", () => {
    const events = parse(["<think about this</think>"]);
    expect(collect(events, "content")).toBe("<think about this</think>");
  });

  test("'<REASONING>' uppercase is not recognized", () => {
    const events = parse(["<REASONING>text</REASONING>"]);
    expect(collect(events, "content")).toBe("<REASONING>text</REASONING>");
    expect(collect(events, "thinking")).toBe("");
  });

  test("'< reasoning>' with space is not recognized", () => {
    const events = parse(["< reasoning>text</ reasoning>"]);
    expect(collect(events, "content")).toBe("< reasoning>text</ reasoning>");
  });
});

// ─── Ordering guarantees ─────────────────────────────────────────

describe("ThinkTagParser: ordering", () => {
  test("events maintain original order", () => {
    const events = parse(["A<reasoning>B</reasoning>C<think>D</think>E"]);
    const types = events.map((e) => e.type);
    const texts = events.map((e) => e.text);

    // Should be: content(A), thinking(B), content(C), thinking(D), content(E)
    expect(types).toEqual(["content", "thinking", "content", "thinking", "content"]);
    expect(texts).toEqual(["A", "B", "C", "D", "E"]);
  });

  test("no duplicate or lost content", () => {
    const original = "Hello<reasoning>world</reasoning>foo<think>bar</think>baz";
    const events = parse(original.split(""));
    const reconstructed = collect(events, "content") + "|" + collect(events, "thinking");
    expect(reconstructed).toBe("Hellofoobaz|worldbar");
  });
});

// ─── Performance ─────────────────────────────────────────────────

describe("ThinkTagParser: performance", () => {
  test("1MB of content without tags in <50ms", () => {
    const bigContent = "x".repeat(1_000_000);
    const chunks: string[] = [];
    for (let i = 0; i < bigContent.length; i += 1000) {
      chunks.push(bigContent.slice(i, i + 1000));
    }
    const start = performance.now();
    const events = parse(chunks);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(collect(events, "content")).toBe(bigContent);
  });

  test("1MB of thinking content in <50ms", () => {
    const bigThought = "y".repeat(1_000_000);
    const full = `<reasoning>${bigThought}</reasoning>`;
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += 1000) {
      chunks.push(full.slice(i, i + 1000));
    }
    const start = performance.now();
    const events = parse(chunks);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(collect(events, "thinking")).toBe(bigThought);
  });

  test("10K blocks in <200ms", () => {
    let input = "";
    for (let i = 0; i < 10_000; i++) {
      input += `<reasoning>${i}</reasoning>${i}`;
    }
    const chunks: string[] = [];
    for (let i = 0; i < input.length; i += 500) {
      chunks.push(input.slice(i, i + 500));
    }
    const start = performance.now();
    parse(chunks);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
