import { describe, expect, test } from "bun:test";
import {
  detectLargeBlockRepetition,
  detectRepetitionLoop,
} from "./conversation-streaming";

describe("detectRepetitionLoop", () => {
  test("returns null for short text", () => {
    expect(detectRepetitionLoop("hello world")).toBeNull();
  });

  test("returns null for text below minimum length", () => {
    expect(detectRepetitionLoop("x".repeat(199))).toBeNull();
  });

  test("returns null for unique content", () => {
    // Each line is unique because of the index
    const text = Array.from(
      { length: 30 },
      (_, i) =>
        `Line ${i}: unique content number ${i * 7 + 3} about topic ${String.fromCharCode(65 + (i % 26))}`,
    ).join("\n");
    expect(detectRepetitionLoop(text)).toBeNull();
  });

  test("returns null for normal prose with repeated words", () => {
    // Prose naturally repeats common words/phrases but not consecutive blocks
    const text =
      "The system should handle this case properly. " +
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
    const goodPart = Array.from(
      { length: 10 },
      (_, i) => `Step ${i + 1}: Do something unique for task ${i * 3}\n`,
    ).join("");
    const loopPart = "checking status... ".repeat(15);
    const text = goodPart + loopPart;
    const result = detectRepetitionLoop(text);
    expect(result).not.toBeNull();
  });

  test("does not false-positive on code with similar structure", () => {
    // Code has repeated patterns but different variable names/values
    const code = Array.from(
      { length: 20 },
      (_, i) =>
        `  const item${i} = await fetch("/api/resource/${i}");\n` +
        `  results.push({ id: ${i}, data: item${i} });\n`,
    ).join("");
    expect(detectRepetitionLoop(code)).toBeNull();
  });

  test("does not false-positive on numbered list items", () => {
    const list = Array.from(
      { length: 20 },
      (_, i) =>
        `${i + 1}. Configure the ${["database", "server", "cache", "queue", "worker"][i % 5]} for environment ${i}\n`,
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

// ─── Phase 23: large-block repetition ─────────────────────────

describe("detectLargeBlockRepetition", () => {
  test("returns null for short text", () => {
    expect(detectLargeBlockRepetition("hello world")).toBeNull();
    expect(detectLargeBlockRepetition("x".repeat(1400))).toBeNull();
  });

  test("returns null for normal prose with no repeats", () => {
    const prose =
      "This is a normal paragraph of writing. ".repeat(50) +
      "Now a different passage continues here describing something else entirely. ".repeat(
        20,
      );
    // Different subparagraphs, no exact repeated fingerprint
    // Actually repeat(50) would catch… so use unique lorem-ish text
    const text =
      "Mission control reports all systems nominal at this time. " +
      "The primary telemetry subsystem is processing incoming data. " +
      "Guidance computers show stable trajectory parameters throughout. " +
      "Orbital mechanics are within expected tolerance bands for phase. " +
      "Ground stations in Madrid and Canberra confirm signal acquisition. " +
      "Thermal sensors indicate nominal heat dissipation on sunward side. " +
      "Life support readings well within safety margins across crew bays. " +
      "Communication latency measurements show 4 minute light-time delay. ";
    expect(detectLargeBlockRepetition(text)).toBeNull();
  });

  test("catches the Orbital-style refactor-loop (≥3 large-block repeats)", () => {
    const refactorBlock =
      "✅ Refactor Final — Barra Superior (Flight Control Room)\n" +
      "He aplicado un diseño limpio, profesional y fiel al estilo real " +
      "de una sala de control de misiones de la NASA (Flight Control " +
      "Room / MCC).\n" +
      "Código limpio (reemplaza toda la sección de la barra superior):\n" +
      "html body content goes here with many Tailwind classes and div " +
      "elements that make up the entire header section of the page.\n";
    // Repeat the block 4 times, matching the Orbital session
    const text = refactorBlock.repeat(4);
    const result = detectLargeBlockRepetition(text);
    expect(result).not.toBeNull();
  });

  test("catches 3 exact repetitions of a long block", () => {
    // Block is 400+ chars so the total text exceeds LARGE_BLOCK_MIN_TEXT (1500).
    const block =
      "The Orbital dashboard refactor step header starts here. This block " +
      "contains enough recognizable text to serve as a fingerprint across " +
      "multiple repetitions within the streaming accumulator. We want the " +
      "detector to catch repetitions like this one immediately. End block. " +
      "Padding text to make the block large enough to survive the sample offset. " +
      "Padding text to make the block large enough to survive the sample offset. ";
    const text = block.repeat(4);
    expect(detectLargeBlockRepetition(text)).not.toBeNull();
  });

  test("does NOT fire on only 2 repetitions (below threshold)", () => {
    const block =
      "Mission status report: all systems are performing within nominal " +
      "parameters and there is nothing to report at this precise time.";
    const text = block.repeat(2) + "different ending here now";
    expect(detectLargeBlockRepetition(text)).toBeNull();
  });

  test("ignores fingerprints dominated by punctuation / box-drawing chars", () => {
    // Markdown tables use many box-drawing chars that repeat legitimately
    const table =
      "┌" + "─".repeat(60) + "┐\n" +
      "│" + " ".repeat(60) + "│\n" +
      "└" + "─".repeat(60) + "┘\n";
    const text = "Here is a table:\n" + table.repeat(3) + "End of tables.";
    // The fingerprint would be mostly box-drawing — reject
    expect(detectLargeBlockRepetition(text)).toBeNull();
  });

  test("tolerates whitespace normalization between repetitions", () => {
    const base =
      "The operational flight plan section outlines key maneuvers and " +
      "checkpoints throughout the mission timeline. Each stage is documented " +
      "with its exact start time, duration, and primary objectives listed " +
      "in sequence. The flight director tracks progress against this plan. " +
      "Extra narrative padding included here to keep the fingerprint away " +
      "from the tail edge of the buffer so the sample offset still hits it. ";
    // Six repetitions with varying whitespace between — should normalize
    const text =
      base + "\n  " + base + "\n\n  " + base + "\n\n\n" + base +
      "\n\n" + base + "\n" + base;
    expect(detectLargeBlockRepetition(text)).not.toBeNull();
  });
});
