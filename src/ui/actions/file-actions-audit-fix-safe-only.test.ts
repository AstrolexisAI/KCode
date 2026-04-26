// KCode - Tests for `/fix --safe-only` flag (v2.10.353).
//
// /fix without --safe-only acts on every confirmed finding regardless
// of tier (rewrite / annotate / manual). With --safe-only, only the
// 'rewrite' tier reaches applyFixes; annotate and manual entries are
// held back with a message telling the reviewer how to apply them
// later. These tests pin both branches.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { handleAuditAction } from "./file-actions-audit";

let TMP: string;

beforeEach(() => {
  TMP = `/tmp/kcode-fix-safeonly-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch { /* noop */ }
});

function ctx(args: string) {
  return {
    appConfig: { workingDirectory: "/tmp" },
    args,
  } as Parameters<typeof handleAuditAction>[1];
}

/**
 * Seed an AUDIT_REPORT.json with a mix of three fix_support tiers
 * pointing at three real source files so applyFixes can be exercised.
 *
 *   bad.cpp   — cpp-001-ptr-address-index → rewrite (real fix)
 *   api.dart  — dart-001-insecure-http → annotate (audit-note insertion)
 *   x.py      — py-021-* → manual (no recipe, no rewriter)
 */
function seedFix(): void {
  writeFileSync(
    join(TMP, "bad.cpp"),
    `void f(const void *buf) {
    size_t n = 0;
    int s = sendto(0, (&buf)[n], 0, 0, NULL, 0);
}\n`,
  );
  writeFileSync(
    join(TMP, "api.dart"),
    `Future<void> fetch() async {
  final r = await http.get(Uri.parse('http://api.example.com/data'));
  print(r.body);
}\n`,
  );
  writeFileSync(
    join(TMP, "x.py"),
    `def manual_only_pattern():\n    return 1\n`,
  );

  const audit = {
    project: TMP,
    timestamp: "2026-04-25",
    languages_detected: ["cpp", "dart", "python"],
    files_scanned: 3,
    candidates_found: 3,
    confirmed_findings: 3,
    false_positives: 0,
    needs_context: 0,
    findings: [
      {
        pattern_id: "cpp-001-ptr-address-index",
        pattern_title: "Suspicious pointer arithmetic",
        severity: "high",
        file: join(TMP, "bad.cpp"),
        line: 3,
        matched_text: "(&buf)[n]",
        context: "ctx",
        verification: { verdict: "confirmed", reasoning: "test" },
        fix_support: "rewrite",
      },
      {
        pattern_id: "dart-001-insecure-http",
        pattern_title: "Insecure HTTP URL",
        severity: "medium",
        file: join(TMP, "api.dart"),
        line: 2,
        matched_text: "http://api.example.com/data",
        context: "ctx",
        verification: { verdict: "confirmed", reasoning: "test" },
        fix_support: "annotate",
      },
      {
        pattern_id: "non-existent-pattern-no-recipe",
        pattern_title: "Manual-only test pattern",
        severity: "high",
        file: join(TMP, "x.py"),
        line: 1,
        matched_text: "manual_only_pattern",
        context: "ctx",
        verification: { verdict: "confirmed", reasoning: "test" },
        fix_support: "manual",
      },
    ],
    false_positives_detail: [],
    needs_context_detail: [],
    coverage: {
      totalCandidateFiles: 3, scannedFiles: 3, skippedByLimit: 0,
      truncated: false, maxFiles: 3, capSource: "user",
    },
    elapsed_ms: 0,
  };
  writeFileSync(`${TMP}/AUDIT_REPORT.json`, JSON.stringify(audit, null, 2));
}

describe("/fix --safe-only", () => {
  test("without --safe-only: processes all three tiers", async () => {
    seedFix();
    const result = await handleAuditAction("fix", ctx(TMP));
    expect(typeof result).toBe("string");
    const out = result as string;
    // Header should NOT carry the safe-only label.
    expect(out).toContain("KCode Auto-Fixer");
    expect(out).not.toContain("(--safe-only mode)");
    // All three tiers should appear in their respective sections.
    expect(out).toMatch(/✅ Rewritten:\s+1/);
    expect(out).toMatch(/📝 Annotated:\s+1/);
    expect(out).toMatch(/✋ Manual:\s+1/);
    // No held-back message.
    expect(out).not.toContain("--safe-only held back");
  });

  test("with --safe-only: only rewrite reaches the fixer; annotate + manual held back", async () => {
    seedFix();
    const result = await handleAuditAction("fix", ctx(`${TMP} --safe-only`));
    expect(typeof result).toBe("string");
    const out = result as string;
    // Header carries the safe-only label.
    expect(out).toContain("KCode Auto-Fixer  (--safe-only mode)");
    // Only the rewrite tier appears as Rewritten.
    expect(out).toMatch(/✅ Rewritten:\s+1/);
    // Annotated and Manual counts are 0 in safe-only mode (those
    // entries didn't reach applyFixes at all).
    expect(out).toMatch(/📝 Annotated:\s+0/);
    expect(out).toMatch(/✋ Manual:\s+0/);
    // Held-back message tells the reviewer there are 2 deferred
    // findings and how to apply them.
    expect(out).toContain("--safe-only held back 2 finding(s)");
    expect(out).toContain("re-run");
  });

  test("--safe-only with NO rewrite-tier findings produces an empty Rewritten section + held-back count", async () => {
    seedFix();
    // Drop the rewrite-tier finding from the JSON; only annotate +
    // manual remain.
    const audit = JSON.parse(
      (await import("node:fs")).readFileSync(`${TMP}/AUDIT_REPORT.json`, "utf-8"),
    );
    audit.findings = audit.findings.filter(
      (f: { fix_support?: string }) => f.fix_support !== "rewrite",
    );
    audit.confirmed_findings = audit.findings.length;
    writeFileSync(`${TMP}/AUDIT_REPORT.json`, JSON.stringify(audit, null, 2));

    const result = await handleAuditAction("fix", ctx(`${TMP} --safe-only`));
    const out = result as string;
    expect(out).toMatch(/✅ Rewritten:\s+0/);
    expect(out).toContain("--safe-only held back 2 finding(s)");
  });
});
