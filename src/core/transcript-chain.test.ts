// Tests for the SHA-256 hash chain on the session transcript writer.
//
// Closes the gap NIST 800-53 AU-9 / AU-10 demand: any tampering of
// historical entries — content edit, line drop, line swap — must be
// detectable from the file alone, without external evidence.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeEntryHash,
  GENESIS_HASH,
  type TranscriptEntry,
  TranscriptManager,
  verifySessionChain,
} from "./transcript";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "kcode-chain-test-"));
  originalHome = process.env.KCODE_HOME;
  process.env.KCODE_HOME = tmpHome;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.KCODE_HOME = originalHome;
  else delete process.env.KCODE_HOME;
});

// KCODE_HOME points directly at the kcode dir (kcodePath joins from
// there), so transcripts live at <KCODE_HOME>/transcripts.
function rawTranscriptPath(filename: string): string {
  return join(tmpHome, "transcripts", filename);
}

function listTranscripts(): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  try {
    return readdirSync(join(tmpHome, "transcripts"));
  } catch {
    return [];
  }
}

describe("transcript hash chain", () => {
  test("computeEntryHash is deterministic", () => {
    const a = computeEntryHash({
      timestamp: "2026-05-06T00:00:00.000Z",
      role: "user",
      type: "user_message",
      content: "hello",
      prevHash: GENESIS_HASH,
    });
    const b = computeEntryHash({
      timestamp: "2026-05-06T00:00:00.000Z",
      role: "user",
      type: "user_message",
      content: "hello",
      prevHash: GENESIS_HASH,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("computeEntryHash changes when content changes", () => {
    const base = {
      timestamp: "2026-05-06T00:00:00.000Z",
      role: "user" as const,
      type: "user_message" as const,
      prevHash: GENESIS_HASH,
    };
    const a = computeEntryHash({ ...base, content: "hello" });
    const b = computeEntryHash({ ...base, content: "hello world" });
    expect(a).not.toBe(b);
  });

  test("appendEntry chains entries — first uses GENESIS, next uses prev hash", () => {
    const mgr = new TranscriptManager();
    mgr.startSession("first prompt");
    mgr.append("assistant", "assistant_text", "second message");
    mgr.append("assistant", "tool_use", "third message");

    const files = listTranscripts();
    expect(files.length).toBe(1);
    const lines = readFileSync(rawTranscriptPath(files[0]!), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as TranscriptEntry);

    expect(lines.length).toBe(3);
    expect(lines[0]!.prevHash).toBe(GENESIS_HASH);
    expect(lines[0]!.hash).toBeDefined();
    expect(lines[1]!.prevHash).toBe(lines[0]!.hash);
    expect(lines[2]!.prevHash).toBe(lines[1]!.hash);
  });

  test("verifySessionChain returns 'valid' on freshly written session", () => {
    const mgr = new TranscriptManager();
    mgr.startSession("hash-chain test");
    mgr.append("assistant", "assistant_text", "hi");
    mgr.append("user", "user_message", "follow-up");

    const filename = listTranscripts()[0]!;
    const result = verifySessionChain(filename);
    expect(result.status).toBe("valid");
    expect(result.totalEntries).toBe(3);
  });

  test("verifySessionChain detects content tampering", () => {
    const mgr = new TranscriptManager();
    mgr.startSession("tamper-target");
    mgr.append("assistant", "assistant_text", "original content");

    const filename = listTranscripts()[0]!;
    const path = rawTranscriptPath(filename);
    const raw = readFileSync(path, "utf-8");
    // Tamper: change "original content" → "TAMPERED"
    const tampered = raw.replace("original content", "TAMPERED");
    writeFileSync(path, tampered);

    const result = verifySessionChain(filename);
    expect(result.status).toBe("invalid");
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toContain("hash mismatch");
  });

  test("verifySessionChain detects entry deletion", () => {
    const mgr = new TranscriptManager();
    mgr.startSession("deletion-target");
    mgr.append("assistant", "assistant_text", "entry 2");
    mgr.append("assistant", "assistant_text", "entry 3");

    const filename = listTranscripts()[0]!;
    const path = rawTranscriptPath(filename);
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    // Drop the middle line — chain should break because entry-3's
    // prevHash references the (now missing) entry-2 hash.
    writeFileSync(path, `${lines[0]}\n${lines[2]}\n`);

    const result = verifySessionChain(filename);
    expect(result.status).toBe("invalid");
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toContain("prevHash mismatch");
  });

  test("verifySessionChain reports 'unchained' for legacy files", () => {
    // Simulate a transcript file that pre-dates the chain feature
    // (no prevHash / no hash on any entry).
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(tmpHome, "transcripts"), { recursive: true });
    const filename = "2025-01-01T00-00-00-legacy.jsonl";
    const path = rawTranscriptPath(filename);
    writeFileSync(
      path,
      [
        JSON.stringify({
          timestamp: "2025-01-01T00:00:00.000Z",
          role: "user",
          type: "user_message",
          content: "old session",
        }),
        JSON.stringify({
          timestamp: "2025-01-01T00:00:01.000Z",
          role: "assistant",
          type: "assistant_text",
          content: "old reply",
        }),
        "",
      ].join("\n"),
    );

    const result = verifySessionChain(filename);
    expect(result.status).toBe("unchained");
    expect(result.totalEntries).toBe(2);
  });

  test("verifySessionChain detects mixed (chained + unchained) tampering", () => {
    // Mixed file: an attacker re-inserts a fabricated unchained entry
    // into a chained transcript. The verifier rejects the file.
    const mgr = new TranscriptManager();
    mgr.startSession("chain-then-fake");
    mgr.append("assistant", "assistant_text", "real");

    const filename = listTranscripts()[0]!;
    const path = rawTranscriptPath(filename);
    const raw = readFileSync(path, "utf-8");
    const fake = JSON.stringify({
      timestamp: "2026-05-06T00:00:00.000Z",
      role: "user",
      type: "user_message",
      content: "fabricated — no hash",
    });
    writeFileSync(path, `${raw.trimEnd()}\n${fake}\n`);

    const result = verifySessionChain(filename);
    expect(result.status).toBe("invalid");
    expect(result.reason).toContain("missing hash");
  });

  test("verifySessionChain returns 'missing' for nonexistent file", () => {
    const result = verifySessionChain("does-not-exist.jsonl");
    expect(result.status).toBe("missing");
  });
});
