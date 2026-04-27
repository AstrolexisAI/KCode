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

// F6 (v2.10.369) — --annotate and --all modes.
describe("/fix --annotate", () => {
  test("forces every finding into the annotation path; bypasses bespoke rewriters", async () => {
    seedFix();
    const result = await handleAuditAction("fix", ctx(`${TMP} --annotate`));
    const out = result as string;
    // Header carries the annotate label.
    expect(out).toContain("--annotate mode");
    // No bespoke rewriter runs — every confirmed finding either
    // takes the recipe (annotation) path or degrades to manual when
    // there's no recipe entry. cpp-001 has a bespoke fixer but no
    // recipe, so under --annotate it becomes manual.
    expect(out).toMatch(/✅ Rewritten:\s+0/);
    expect(out).toMatch(/📝 Annotated:\s+1/); // dart-001-insecure-http (has recipe)
    expect(out).toMatch(/✋ Manual:\s+2/);     // cpp-001 (no recipe) + non-existent-pattern (no recipe)
  });

  test("--annotate emits the mode label and the no-rewrites note", async () => {
    seedFix();
    const result = await handleAuditAction("fix", ctx(`${TMP} --annotate`));
    const out = result as string;
    expect(out).toContain("no code rewrites");
    expect(out).toContain("audit-note comments only");
  });
});

describe("/fix --all", () => {
  test("--all is an alias for the default behavior", async () => {
    seedFix();
    const withAll = await handleAuditAction("fix", ctx(`${TMP} --all`));
    const out = withAll as string;
    expect(out).toContain("(--all mode)");
    // Same counts as the no-flag case: 1 rewrite + 1 annotate + 1 manual.
    expect(out).toMatch(/✅ Rewritten:\s+1/);
    expect(out).toMatch(/📝 Annotated:\s+1/);
    expect(out).toMatch(/✋ Manual:\s+1/);
  });
});

describe("/fix mode mutual exclusion", () => {
  test("--safe-only + --annotate together is rejected", async () => {
    seedFix();
    const result = await handleAuditAction("fix", ctx(`${TMP} --safe-only --annotate`));
    const out = result as string;
    expect(out).toContain("mutually exclusive");
    // Should NOT have run the fixer at all.
    expect(out).not.toContain("KCode Auto-Fixer");
  });
});

// CL.8 (v2.10.378) — --ci is an alias for --safe-only on /fix.
// CI pipelines should never auto-apply audit-note comments or claim
// a manual-tier finding was "fixed"; --safe-only is the right
// semantics. Naming it --ci makes the intent obvious at the call
// site without forcing the reviewer to remember which flag is safe.
describe("/fix --ci alias", () => {
  test("--ci behaves identically to --safe-only", async () => {
    seedFix();
    const ciResult = await handleAuditAction("fix", ctx(`${TMP} --ci`));
    const ciOut = ciResult as string;
    expect(ciOut).toContain("--ci mode → --safe-only");
    // Same outcome as --safe-only: 1 rewrite applied, 2 held back.
    expect(ciOut).toMatch(/✅ Rewritten:\s+1/);
    expect(ciOut).toMatch(/📝 Annotated:\s+0/);
    expect(ciOut).toMatch(/✋ Manual:\s+0/);
    expect(ciOut).toContain("--safe-only held back 2 finding(s)");
  });

  test("--ci + --annotate is rejected with a clear message", async () => {
    seedFix();
    const result = await handleAuditAction("fix", ctx(`${TMP} --ci --annotate`));
    const out = result as string;
    expect(out).toContain("mutually exclusive");
    expect(out).toContain("--ci");
    expect(out).toContain("alias for --safe-only");
  });

  test("--ci + --safe-only together is fine (both safe)", async () => {
    seedFix();
    const result = await handleAuditAction("fix", ctx(`${TMP} --ci --safe-only`));
    const out = result as string;
    // Should run the fixer (no rejection); --ci wins on label
    // because the explicit --ci flag is more specific.
    expect(out).toContain("--ci mode");
    expect(out).toMatch(/✅ Rewritten:\s+1/);
  });
});
