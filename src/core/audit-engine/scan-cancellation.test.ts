// Regression tests for /scan cancellation (Esc → ScanCancelledError).
//
// Wired in v2.10.385 so users can stop a long-running /scan without
// killing KCode with Ctrl+C. The cancel signal flows:
//   InputPrompt.useInput → scanState.cancelled = true
//     → file-actions-audit's poller → controller.abort()
//     → audit-engine.ts checks signal at phase boundaries
//     → verifier.ts checks signal at the top of every iteration
//     → ScanCancelledError thrown → /scan handler emits soft message
//
// These tests cover the verifier-loop slice (the inner-most check)
// and the scan-state plumbing.

import { describe, expect, test } from "bun:test";
import {
  isScanCancelled,
  requestScanCancel,
  resetScanState,
  ScanCancelledError,
  scanState,
} from "./scan-state.ts";
import type { Candidate } from "./types.ts";
import { verifyAllCandidates } from "./verifier.ts";

describe("scan-state cancellation plumbing", () => {
  test("ScanCancelledError is the exported sentinel and inherits Error", () => {
    const e = new ScanCancelledError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ScanCancelledError");
    expect(e.message).toBe("Scan cancelled by user");
  });

  test("isScanCancelled is false after reset", () => {
    resetScanState();
    expect(isScanCancelled()).toBe(false);
  });

  test("requestScanCancel is a no-op when no scan is active", () => {
    resetScanState();
    requestScanCancel();
    expect(scanState.cancelled).toBe(false);
  });

  test("requestScanCancel sets cancelled when scan is active", () => {
    resetScanState();
    scanState.active = true;
    requestScanCancel();
    expect(scanState.cancelled).toBe(true);
    expect(isScanCancelled()).toBe(true);
    resetScanState();
  });

  test("resetScanState clears cancelled flag", () => {
    scanState.active = true;
    scanState.cancelled = true;
    resetScanState();
    expect(scanState.cancelled).toBe(false);
    expect(scanState.active).toBe(false);
  });
});

describe("verifier respects AbortSignal", () => {
  function dummyCandidate(file: string, line: number): Candidate {
    return {
      pattern_id: "js-001-eval-with-user-input",
      file,
      line,
      severity: "high",
      cwe: "CWE-95",
      title: "test",
      description: "test",
      matched_text: "eval(req.body)",
      context_lines: ["eval(req.body);"],
    };
  }

  test("verifier throws ScanCancelledError when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const candidates = [
      dummyCandidate("a.js", 1),
      dummyCandidate("b.js", 1),
      dummyCandidate("c.js", 1),
    ];
    let llmCalls = 0;
    await expect(
      verifyAllCandidates(candidates, {
        llmCallback: async () => {
          llmCalls++;
          return JSON.stringify({ verdict: "confirmed", reasoning: "x" });
        },
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ScanCancelledError);
    // Should bail before any LLM call
    expect(llmCalls).toBe(0);
  });

  test("verifier throws after the iteration where abort fires", async () => {
    const controller = new AbortController();
    const candidates = [
      dummyCandidate("a.js", 1),
      dummyCandidate("b.js", 1),
      dummyCandidate("c.js", 1),
      dummyCandidate("d.js", 1),
    ];
    let progressFires = 0;
    const result = verifyAllCandidates(candidates, {
      llmCallback: async () =>
        JSON.stringify({ verdict: "confirmed", reasoning: "ok" }),
      // onProgress fires at the top of each iteration BEFORE the LLM call.
      // Aborting inside i=1's onProgress means iteration i=2's pre-loop
      // signal check is the very next thing to run — that's where the
      // throw happens.
      onProgress: (i) => {
        progressFires++;
        if (i === 1) controller.abort();
      },
      signal: controller.signal,
    });
    await expect(result).rejects.toBeInstanceOf(ScanCancelledError);
    // Confirm we ran past iteration 1 and didn't reach iteration 3 (i=3).
    expect(progressFires).toBeGreaterThanOrEqual(2);
    expect(progressFires).toBeLessThan(candidates.length);
  });

  test("verifier completes normally when signal is never aborted", async () => {
    const controller = new AbortController();
    const candidates = [dummyCandidate("a.js", 1), dummyCandidate("b.js", 1)];
    // Don't assert specific verdict — sanityCheckVerdict and the
    // post-verification logic can downgrade outputs based on content.
    // What matters for the cancellation test is that the loop runs to
    // completion when the signal stays unaborted.
    const results = await verifyAllCandidates(candidates, {
      llmCallback: async () =>
        JSON.stringify({ verdict: "confirmed", reasoning: "test" }),
      signal: controller.signal,
    });
    expect(results.length).toBe(2);
    // Both items processed without throw — that's the cancellation invariant.
    expect(results.every((r) => r.candidate !== undefined)).toBe(true);
  });

  test("verifier works without a signal (backward compat)", async () => {
    const candidates = [dummyCandidate("a.js", 1)];
    const results = await verifyAllCandidates(candidates, {
      llmCallback: async () =>
        JSON.stringify({ verdict: "confirmed", reasoning: "test" }),
    });
    expect(results.length).toBe(1);
  });
});
