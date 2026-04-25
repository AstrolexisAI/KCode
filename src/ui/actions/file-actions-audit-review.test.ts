// KCode - Tests for /review v2 (Sprint 2).
//
// /review now supports list / promote / demote / tag / untag in addition
// to the legacy keep / drop / all / none. Indices are global across the
// three buckets (confirmed / FP / uncertain) and stable across reruns
// because they're driven by JSON array order. Decisions persist via
// review_state, review_reason, and review_tags fields added in v2.10.326.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { handleAuditAction } from "./file-actions-audit";

let TMP: string;
beforeEach(() => {
  TMP = `/tmp/kcode-review-v2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(TMP, { recursive: true });
});
afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function seedAudit(): void {
  const audit = {
    project: TMP,
    timestamp: "2026-04-25",
    languages_detected: ["c", "cpp"],
    files_scanned: 100,
    candidates_found: 6,
    confirmed_findings: 2,
    false_positives: 2,
    needs_context: 2,
    findings: [
      {
        pattern_id: "fsw-010-cmd-arg",
        pattern_title: "Cmd arg unvalidated",
        severity: "high",
        file: `${TMP}/Svc/FileManager.cpp`,
        line: 46,
        matched_text: "...",
        context: "...",
        verification: { verdict: "confirmed", reasoning: "ground command unvalidated" },
      },
      {
        pattern_id: "fsw-005-buffer-getdata",
        pattern_title: "Buffer null-check",
        severity: "high",
        file: `${TMP}/Svc/Hub.cpp`,
        line: 131,
        matched_text: "...",
        context: "...",
        verification: { verdict: "confirmed", reasoning: "buffer getData unchecked" },
      },
    ],
    false_positives_detail: [
      {
        pattern_id: "cpp-012-loop-bound",
        pattern_title: "Loop bound",
        severity: "high",
        file: `${TMP}/FppTestProject/x.cpp`,
        line: 42,
        matched_text: "...",
        context: "...",
        verification: { verdict: "false_positive", reasoning: "test code, bounded" },
      },
      {
        pattern_id: "cpp-001-ptr",
        pattern_title: "Ptr arithmetic",
        severity: "medium",
        file: `${TMP}/Utils/foo.cpp`,
        line: 7,
        matched_text: "...",
        context: "...",
        verification: { verdict: "false_positive", reasoning: "compile-time bounded" },
      },
    ],
    needs_context_detail: [
      {
        pattern_id: "fsw-003-assert",
        pattern_title: "Assert as validation",
        severity: "medium",
        file: `${TMP}/Svc/Logger.cpp`,
        line: 31,
        matched_text: "...",
        context: "...",
        verification: { verdict: "needs_context", reasoning: "context unclear" },
      },
      {
        pattern_id: "crypto-005-timing",
        pattern_title: "Non-constant compare",
        severity: "high",
        file: `${TMP}/Auth/check.cpp`,
        line: 99,
        matched_text: "...",
        context: "...",
        verification: { verdict: "needs_context", reasoning: "may already be constant-time" },
      },
    ],
    coverage: {
      totalCandidateFiles: 100,
      scannedFiles: 100,
      skippedByLimit: 0,
      truncated: false,
      maxFiles: 500,
      capSource: "adaptive" as const,
    },
    elapsed_ms: 1234,
  };
  writeFileSync(`${TMP}/AUDIT_REPORT.json`, JSON.stringify(audit, null, 2));
}

function readAudit(): {
  findings: Array<{
    pattern_id: string;
    review_state?: string;
    review_reason?: string;
    review_tags?: string[];
    verification: { verdict: string; reasoning: string };
  }>;
  false_positives_detail: Array<{ pattern_id: string; review_state?: string; verification: { verdict: string; reasoning: string } }>;
  needs_context_detail: Array<{ pattern_id: string; review_state?: string }>;
  confirmed_findings: number;
  false_positives: number;
  needs_context: number;
} {
  return JSON.parse(readFileSync(`${TMP}/AUDIT_REPORT.json`, "utf-8"));
}

function ctx(args: string) {
  return {
    appConfig: { workingDirectory: "/tmp" },
    args,
    // biome-ignore lint/suspicious/noExplicitAny: ActionContext has more fields the test path doesn't touch
  } as any;
}

// Indices in the seeded audit:
//   #1 = findings[0] = FileManager.cpp (confirmed)
//   #2 = findings[1] = Hub.cpp (confirmed)
//   #3 = false_positives_detail[0] = FppTestProject/x.cpp (fp)
//   #4 = false_positives_detail[1] = Utils/foo.cpp (fp)
//   #5 = needs_context_detail[0] = Svc/Logger.cpp (uncertain)
//   #6 = needs_context_detail[1] = Auth/check.cpp (uncertain)

describe("/review v2 — dashboard", () => {
  it("prints all three buckets when no subcommand", async () => {
    seedAudit();
    const out = await handleAuditAction("review", ctx(TMP));
    expect(out).toContain("2 confirmed");
    expect(out).toContain("2 false-positive");
    expect(out).toContain("2 uncertain");
    expect(out).toContain("FileManager.cpp:46");
    expect(out).toContain("Logger.cpp:31");
    // Commands list visible
    expect(out).toContain("promote");
    expect(out).toContain("demote");
    expect(out).toContain("tag ");
  });
});

describe("/review v2 — list", () => {
  it("list confirmed shows only the confirmed bucket", async () => {
    seedAudit();
    const out = await handleAuditAction("review", ctx(`${TMP} list confirmed`));
    expect(out).toContain("CONFIRMED");
    expect(out).toContain("FileManager.cpp:46");
    expect(out).not.toContain("FppTestProject");
    expect(out).not.toContain("Logger.cpp:31");
  });

  it("list uncertain shows only needs_context", async () => {
    seedAudit();
    const out = await handleAuditAction("review", ctx(`${TMP} list uncertain`));
    expect(out).toContain("UNCERTAIN");
    expect(out).toContain("Logger.cpp:31");
    expect(out).toContain("Auth/check.cpp:99");
    expect(out).not.toContain("FileManager.cpp:46");
  });

  it("list fp shows false positives", async () => {
    seedAudit();
    const out = await handleAuditAction("review", ctx(`${TMP} list fp`));
    expect(out).toContain("FP");
    expect(out).toContain("FppTestProject");
    expect(out).not.toContain("FileManager.cpp:46");
  });
});

describe("/review v2 — promote", () => {
  it("promotes #5 (uncertain) → confirmed and stamps review_state", async () => {
    seedAudit();
    await handleAuditAction("review", ctx(`${TMP} promote 5`));
    const a = readAudit();
    expect(a.confirmed_findings).toBe(3);
    expect(a.needs_context).toBe(1);
    const promoted = a.findings.find((f) => f.pattern_id === "fsw-003-assert");
    expect(promoted).toBeDefined();
    expect(promoted!.review_state).toBe("promoted");
    expect(promoted!.review_reason).toBe("manual_confirmation");
  });

  it("promotes multiple indices in one call", async () => {
    seedAudit();
    await handleAuditAction("review", ctx(`${TMP} promote 5,6`));
    const a = readAudit();
    expect(a.confirmed_findings).toBe(4);
    expect(a.needs_context).toBe(0);
  });
});

describe("/review v2 — demote", () => {
  it("demotes #2 (confirmed) → fp and rewrites the verdict + reasoning", async () => {
    seedAudit();
    await handleAuditAction("review", ctx(`${TMP} demote 2`));
    const a = readAudit();
    expect(a.confirmed_findings).toBe(1);
    expect(a.false_positives).toBe(3);
    const demoted = a.false_positives_detail.find((f) => f.pattern_id === "fsw-005-buffer-getdata");
    expect(demoted).toBeDefined();
    expect(demoted!.review_state).toBe("demoted_fp");
    expect(demoted!.verification.verdict).toBe("false_positive");
    expect(demoted!.verification.reasoning).toContain("[reviewer demoted]");
  });
});

describe("/review v2 — tag / untag", () => {
  it("tag 1 trusted_boundary persists review_reason", async () => {
    seedAudit();
    await handleAuditAction("review", ctx(`${TMP} tag 1 trusted_boundary`));
    const a = readAudit();
    expect(a.findings[0]!.review_reason).toBe("trusted_boundary");
  });

  it("untag 1 clears review_reason", async () => {
    seedAudit();
    await handleAuditAction("review", ctx(`${TMP} tag 1 test_only`));
    await handleAuditAction("review", ctx(`${TMP} untag 1`));
    const a = readAudit();
    expect(a.findings[0]!.review_reason).toBeUndefined();
  });

  it("rejects an unknown reason", async () => {
    seedAudit();
    const out = await handleAuditAction("review", ctx(`${TMP} tag 1 not_a_real_reason`));
    expect(out).toContain("Unknown reason");
  });
});

describe("/review v2 — legacy compat", () => {
  it("legacy keep 1 demotes #2 (the other confirmed)", async () => {
    seedAudit();
    await handleAuditAction("review", ctx(`${TMP} keep 1`));
    const a = readAudit();
    expect(a.confirmed_findings).toBe(1);
    expect(a.findings[0]!.pattern_id).toBe("fsw-010-cmd-arg");
  });

  it("legacy drop 1 demotes only #1", async () => {
    seedAudit();
    await handleAuditAction("review", ctx(`${TMP} drop 1`));
    const a = readAudit();
    expect(a.confirmed_findings).toBe(1);
    expect(a.findings[0]!.pattern_id).toBe("fsw-005-buffer-getdata");
  });

  it("legacy none demotes ALL confirmed", async () => {
    seedAudit();
    await handleAuditAction("review", ctx(`${TMP} none`));
    const a = readAudit();
    expect(a.confirmed_findings).toBe(0);
    expect(a.false_positives).toBe(4);
  });
});
