import { describe, expect, test } from "bun:test";
import { detectRepetitionLoop } from "./conversation-streaming";

describe("detectRepetitionLoop", () => {
  test("returns null for short text", () => {
    expect(detectRepetitionLoop("hello world")).toBeNull();
  });

  test("returns null for text below minimum length", () => {
    expect(detectRepetitionLoop("x".repeat(199))).toBeNull();
  });

  test("returns null for unique content", () => {
    // Each line is unique because of the index
    const text = Array.from({ length: 30 }, (_, i) =>
      `Line ${i}: unique content number ${i * 7 + 3} about topic ${String.fromCharCode(65 + (i % 26))}`
    ).join("\n");
    expect(detectRepetitionLoop(text)).toBeNull();
  });

  test("returns null for normal prose with repeated words", () => {
    // Prose naturally repeats common words/phrases but not consecutive blocks
    const text = "The system should handle this case properly. " +
      "The user needs to configure the settings. " +
      "The application processes requests efficiently. " +
      "The database stores records permanently. " +
      "The server handles multiple connections. ";
    expect(detectRepetitionLoop(text.repeat(2))).toBeNull();
  });

  test("detects obvious slash command loop", () => {
    // Exact failure mode from the bug report
    const prefix = "Here are some commands:\n";
    const repeated = "/now, /today, /tomorrow, /yesterday, ";
    const text = prefix + repeated.repeat(20);
    const result = detectRepetitionLoop(text);
    expect(result).not.toBeNull();
  });

  test("detects repeated table rows", () => {
    const header = "| Command | Description |\n|---|---|\n";
    const row = "| `/command` | Does something useful |\n";
    const text = header + row.repeat(20);
    const result = detectRepetitionLoop(text);
    expect(result).not.toBeNull();
  });

  test("detects repeated separator lines", () => {
    const text = "Result:\n" + "─".repeat(20) + "\n" + ("─".repeat(20) + "\n").repeat(10);
    const result = detectRepetitionLoop(text);
    expect(result).not.toBeNull();
  });

  test("detects stuck-in-a-loop phrase", () => {
    const text = "STUCK IN A LOOP! ".repeat(15);
    const result = detectRepetitionLoop(text);
    expect(result).not.toBeNull();
  });

  test("detects repetition after good content", () => {
    // Model starts fine then degenerates
    const goodPart = Array.from({ length: 10 }, (_, i) =>
      `Step ${i + 1}: Do something unique for task ${i * 3}\n`
    ).join("");
    const loopPart = "checking status... ".repeat(15);
    const text = goodPart + loopPart;
    const result = detectRepetitionLoop(text);
    expect(result).not.toBeNull();
  });

  test("does not false-positive on code with similar structure", () => {
    // Code has repeated patterns but different variable names/values
    const code = Array.from({ length: 20 }, (_, i) =>
      `  const item${i} = await fetch("/api/resource/${i}");\n` +
      `  results.push({ id: ${i}, data: item${i} });\n`
    ).join("");
    expect(detectRepetitionLoop(code)).toBeNull();
  });

  test("does not false-positive on numbered list items", () => {
    const list = Array.from({ length: 20 }, (_, i) =>
      `${i + 1}. Configure the ${["database", "server", "cache", "queue", "worker"][i % 5]} for environment ${i}\n`
    ).join("");
    expect(detectRepetitionLoop(list)).toBeNull();
  });

  test("detects multi-line repeated block", () => {
    const block = "First line of block\nSecond line of block\nThird line\n";
    const text = "Intro:\n" + block.repeat(8);
    const result = detectRepetitionLoop(text);
    expect(result).not.toBeNull();
  });

  test("handles unicode repetition", () => {
    const emoji = "🔄 Procesando datos... ";
    const text = emoji.repeat(15);
    const result = detectRepetitionLoop(text);
    expect(result).not.toBeNull();
  });

  test("returns truncated phrase for long repeated patterns", () => {
    const longPhrase = "A".repeat(100);
    const text = longPhrase.repeat(5);
    const result = detectRepetitionLoop(text);
    expect(result).not.toBeNull();
    // Should be truncated to ~63 chars (60 + "...")
    expect(result!.length).toBeLessThanOrEqual(63);
  });
});
