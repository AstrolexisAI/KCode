// Tests for v2.10.307 coverage + ranking + FP-detail additions.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "./audit-engine";
import { generateMarkdownReport } from "./report-generator";
import {
  defaultMaxFiles,
  enumerateSourceFiles,
  scanProject,
  scoreFileForAudit,
  selectFilesForAudit,
} from "./scanner";

// v2.10.351 P0 — AuditResult grew several fields since these test
// fixtures were written (needs_context, needs_context_detail,
// fix_support_summary, pattern_metrics, etc.). The tests below
// only exercise Markdown rendering, so we cast the partial fixture
// to the runtime input type — keeps the assertions readable
// without forcing every test to thread fields it doesn't care
// about.
type _MdInput = Parameters<typeof generateMarkdownReport>[0];
const renderMd = (partial: Partial<_MdInput>): string =>
  generateMarkdownReport(partial as _MdInput);

// ─── Fixture helpers ─────────────────────────────────────────────

let TMP: string;

beforeEach(() => {
  TMP = `/tmp/kcode-audit-coverage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function w(relpath: string, content = "int main() {}\n"): void {
  const full = join(TMP, relpath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

// ─── defaultMaxFiles ─────────────────────────────────────────────

describe("defaultMaxFiles", () => {
  it("returns total for small repos (<=800)", () => {
    expect(defaultMaxFiles(100)).toBe(100);
    expect(defaultMaxFiles(800)).toBe(800);
  });

  it("bumps medium repos to 1500", () => {
    expect(defaultMaxFiles(1500)).toBe(1500);
    expect(defaultMaxFiles(2999)).toBe(1500);
  });

  it("caps large repos at 2000", () => {
    expect(defaultMaxFiles(3000)).toBe(2000);
    expect(defaultMaxFiles(10000)).toBe(2000);
  });
});

// ─── scoreFileForAudit ───────────────────────────────────────────

describe("scoreFileForAudit", () => {
  it("scores main-code src files higher than test/doc files", () => {
    const srcScore = scoreFileForAudit("/repo/src/net/parser.c");
    const testScore = scoreFileForAudit("/repo/tests/parser_test.c");
    const docScore = scoreFileForAudit("/repo/docs/tutorial.md");
    expect(srcScore).toBeGreaterThan(testScore);
    expect(srcScore).toBeGreaterThan(docScore);
  });

  it("ranks src/auth.c above docs/tutorial.md", () => {
    expect(scoreFileForAudit("/repo/src/auth.c")).toBeGreaterThan(
      scoreFileForAudit("/repo/docs/tutorial.md"),
    );
  });

  it("ranks src/net/parser.py above tests/foo_test.py", () => {
    expect(scoreFileForAudit("/repo/src/net/parser.py")).toBeGreaterThan(
      scoreFileForAudit("/repo/tests/foo_test.py"),
    );
  });

  it("penalizes vendor/third_party even if the extension is main-code", () => {
    expect(scoreFileForAudit("/repo/third_party/ssl/x.c")).toBeLessThan(
      scoreFileForAudit("/repo/src/ssl/x.c"),
    );
  });

  it("penalizes build-time directories (cmake/scripts/autocoder/tools) — v313", () => {
    const buildTimePaths = [
      "/repo/cmake/autocoder/scripts/gen.py",
      "/repo/scripts/setup.sh",
      "/repo/autocoder/helpers/convert.py",
      "/repo/tools/lint.py",
      "/repo/ci/release.sh",
      "/repo/.github/workflows/build.yml.py",
    ];
    const runtimePath = "/repo/Svc/ComQueue/ComQueueHandler.cpp";
    for (const btp of buildTimePaths) {
      expect(scoreFileForAudit(btp)).toBeLessThan(scoreFileForAudit(runtimePath));
    }
  });

  it("penalizes project-named test trees (FppTestProject, MyAppTests) — v321", () => {
    const testNamedPaths = [
      "/fprime/FppTestProject/FppTest/topology/types/DataBuffer.cpp",
      "/repo/MyComponentTest/handler.cpp",
      "/repo/IntegrationTests/runner.cpp",
      "/repo/TestHarness/main.cpp",
    ];
    const realRuntime = "/fprime/Svc/PrmDb/PrmDbImpl.cpp";
    for (const p of testNamedPaths) {
      expect(scoreFileForAudit(p)).toBeLessThan(scoreFileForAudit(realRuntime));
    }
  });

  it("boosts embedded/flight-software directories (Fw/Svc/Drv) — v313", () => {
    expect(scoreFileForAudit("/fprime/Svc/ComQueue/x.cpp")).toBeGreaterThan(
      scoreFileForAudit("/fprime/cmake/scripts/x.py"),
    );
    expect(scoreFileForAudit("/fprime/Fw/Com/ComPacket.cpp")).toBeGreaterThan(
      scoreFileForAudit("/fprime/docs/guide.md"),
    );
    expect(scoreFileForAudit("/fprime/Drv/TcpClient/TcpClient.cpp")).toBeGreaterThan(
      scoreFileForAudit("/fprime/third_party/cppcheck/cppcheck.cpp"),
    );
  });

  it("handles Windows-style separators", () => {
    const winSrc = scoreFileForAudit("C:\\repo\\src\\auth.c");
    const winTest = scoreFileForAudit("C:\\repo\\tests\\foo_test.c");
    expect(winSrc).toBeGreaterThan(winTest);
  });
});

// ─── selectFilesForAudit ─────────────────────────────────────────

describe("selectFilesForAudit", () => {
  it("returns all files when total <= maxFiles", () => {
    const files = ["/repo/a.c", "/repo/b.c", "/repo/c.c"];
    const res = selectFilesForAudit(files, 10);
    expect(res.selected.length).toBe(3);
    expect(res.total).toBe(3);
    expect(res.truncated).toBe(false);
  });

  it("ranks high-score files first when truncating", () => {
    const files = [
      "/repo/tests/one_test.c",
      "/repo/docs/guide.md",
      "/repo/src/net/auth.c",
      "/repo/src/lib/core.c",
      "/repo/third_party/vendor/x.c",
    ];
    const res = selectFilesForAudit(files, 2);
    expect(res.selected.length).toBe(2);
    expect(res.truncated).toBe(true);
    // src/ files should win over tests/docs/vendor
    expect(res.selected).toContain("/repo/src/net/auth.c");
    expect(res.selected).toContain("/repo/src/lib/core.c");
    expect(res.selected).not.toContain("/repo/docs/guide.md");
    expect(res.selected).not.toContain("/repo/third_party/vendor/x.c");
  });

  it("reports correct truncation metadata", () => {
    const files = Array.from({ length: 10 }, (_, i) => `/repo/f${i}.c`);
    const res = selectFilesForAudit(files, 4);
    expect(res.total).toBe(10);
    expect(res.selected.length).toBe(4);
    expect(res.truncated).toBe(true);
    expect(res.maxFiles).toBe(4);
  });
});

// ─── scanProject coverage ────────────────────────────────────────

describe("scanProject → coverage", () => {
  it("reports truncated=false for small repos", async () => {
    w("a.c", "int a;\n");
    w("b.c", "int b;\n");
    w("c.c", "int c;\n");
    const { coverage } = await scanProject(TMP);
    expect(coverage.totalCandidateFiles).toBe(3);
    expect(coverage.scannedFiles).toBe(3);
    expect(coverage.skippedByLimit).toBe(0);
    expect(coverage.truncated).toBe(false);
  });

  it("reports truncated=true + skippedByLimit when user caps below total", async () => {
    for (let i = 0; i < 15; i++) w(`f${i}.c`, `int v${i};\n`);
    const { coverage } = await scanProject(TMP, { maxFiles: 5 });
    expect(coverage.totalCandidateFiles).toBe(15);
    expect(coverage.scannedFiles).toBe(5);
    expect(coverage.skippedByLimit).toBe(10);
    expect(coverage.truncated).toBe(true);
    expect(coverage.capSource).toBe("user");
    expect(coverage.maxFiles).toBe(5);
  });

  it("capSource='adaptive' when no explicit cap passed", async () => {
    w("a.c");
    w("b.c");
    const { coverage } = await scanProject(TMP);
    expect(coverage.capSource).toBe("adaptive");
  });

  it("adaptive cap does not truncate a small project", async () => {
    for (let i = 0; i < 20; i++) w(`f${i}.c`);
    const { coverage } = await scanProject(TMP);
    expect(coverage.truncated).toBe(false);
    expect(coverage.maxFiles).toBe(20);
  });
});

// ─── Full pipeline (skipVerification mode) ───────────────────────

describe("runAudit → false_positives_detail + coverage", () => {
  it("persists coverage in AuditResult", async () => {
    w("a.c", "int a = 0;\n");
    w("b.c", "int b = 0;\n");
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () => '{"verdict":"confirmed","reasoning":"test"}',
      skipVerification: true,
    });
    expect(result.coverage).toBeDefined();
    expect(result.coverage.totalCandidateFiles).toBe(2);
    expect(result.coverage.scannedFiles).toBe(2);
    expect(result.coverage.truncated).toBe(false);
  });

  it("persists false_positives_detail (not just counter)", async () => {
    // Craft a simple pattern match via a known regex. Use memset(ptr, 0, sizeof(ptr)) — CWE 464.
    const code = `#include <string.h>
void f(char *p) {
    memset(p, 0, sizeof(p));
}
`;
    w("bug.c", code);
    const fpVerifier = async (): Promise<string> =>
      JSON.stringify({
        verdict: "false_positive",
        reasoning: "Not actually a bug in this context.",
      });
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: fpVerifier,
    });
    // candidates may or may not hit depending on pattern coverage, but
    // if any candidate was emitted and rejected, it must be persisted.
    expect(result.false_positives_detail).toBeDefined();
    if (result.false_positives > 0) {
      expect(result.false_positives_detail.length).toBe(result.false_positives);
      const first = result.false_positives_detail[0]!;
      expect(first.pattern_id).toBeTruthy();
      expect(first.file).toBeTruthy();
      expect(first.verification.verdict).toBe("false_positive");
      expect(first.verification.reasoning).toContain("Not actually a bug");
    }
  });
});

// ─── Markdown report ─────────────────────────────────────────────

describe("generateMarkdownReport — coverage + FP section", () => {
  it("includes Coverage section with truncated=yes warning", () => {
    const md = renderMd({
      project: "/repo",
      timestamp: "2026-04-24",
      languages_detected: ["c"],
      files_scanned: 500,
      candidates_found: 0,
      confirmed_findings: 0,
      false_positives: 0,
      findings: [],
      false_positives_detail: [],
      coverage: {
        totalCandidateFiles: 1505,
        scannedFiles: 500,
        skippedByLimit: 1005,
        truncated: true,
        maxFiles: 500,
        capSource: "adaptive",
      },
      elapsed_ms: 3700,
    });
    expect(md).toContain("## Coverage");
    expect(md).toContain("500");
    expect(md).toContain("1505");
    expect(md).toContain("Truncated: **yes**");
    expect(md).toContain("1005 files skipped");
    expect(md).toMatch(/Re-run with `--max-files \d+`/);
  });

  it("omits truncation warning when truncated=false", () => {
    const md = renderMd({
      project: "/repo",
      timestamp: "2026-04-24",
      languages_detected: ["c"],
      files_scanned: 10,
      candidates_found: 0,
      confirmed_findings: 0,
      false_positives: 0,
      findings: [],
      false_positives_detail: [],
      coverage: {
        totalCandidateFiles: 10,
        scannedFiles: 10,
        skippedByLimit: 0,
        truncated: false,
        maxFiles: 500,
        capSource: "adaptive",
      },
      elapsed_ms: 300,
    });
    expect(md).toContain("## Coverage");
    expect(md).toContain("Truncated: no");
    expect(md).not.toMatch(/Re-run with/);
  });

  it("renders 'Verifier rejections' section with top 10 + count of rest", () => {
    const fpDetail = Array.from({ length: 27 }, (_, i) => ({
      pattern_id: `test-pat-${i}`,
      pattern_title: "Test pattern",
      severity: "medium" as const,
      file: `/repo/src/file${i}.c`,
      line: i + 1,
      matched_text: "abc",
      context: "line",
      verification: {
        verdict: "false_positive" as const,
        reasoning: `Reason ${i}`,
      },
      cwe: undefined,
    }));
    const md = renderMd({
      project: "/repo",
      timestamp: "2026-04-24",
      languages_detected: ["c"],
      files_scanned: 500,
      candidates_found: 27,
      confirmed_findings: 0,
      false_positives: 27,
      findings: [],
      false_positives_detail: fpDetail,
      coverage: {
        totalCandidateFiles: 500,
        scannedFiles: 500,
        skippedByLimit: 0,
        truncated: false,
        maxFiles: 500,
        capSource: "adaptive",
      },
      elapsed_ms: 3000,
    });
    expect(md).toContain("## Verifier rejections");
    expect(md).toContain("rejected **27** candidates");
    expect(md).toContain("test-pat-0");
    expect(md).toContain("test-pat-9");
    // Only first 10 shown
    expect(md).not.toContain("test-pat-15");
    expect(md).toMatch(/…and 17 more/);
  });

  it("does NOT render FP section when false_positives_detail is empty", () => {
    const md = renderMd({
      project: "/repo",
      timestamp: "2026-04-24",
      languages_detected: ["c"],
      files_scanned: 10,
      candidates_found: 0,
      confirmed_findings: 0,
      false_positives: 0,
      findings: [],
      false_positives_detail: [],
      coverage: {
        totalCandidateFiles: 10,
        scannedFiles: 10,
        skippedByLimit: 0,
        truncated: false,
        maxFiles: 500,
        capSource: "adaptive",
      },
      elapsed_ms: 50,
    });
    expect(md).not.toContain("## Verifier rejections");
  });
});

// v2.10.351 P1.1 — Audit Confidence header rendering.
describe("generateMarkdownReport — Audit Confidence header (v2.10.351 P1)", () => {
  // Explicit Partial<_MdInput> return type so the empty-array literals
  // below don't infer as `never[]` and trip TS2345 against the typed
  // helper. Same pattern as `renderMd` — fixtures are intentionally
  // partial and we cast at the call site.
  const baseAudit = (overrides: Record<string, unknown>): Partial<_MdInput> => ({
    project: "/repo",
    timestamp: "2026-04-25",
    languages_detected: ["c"],
    files_scanned: 100,
    candidates_found: 10,
    confirmed_findings: 2,
    false_positives: 8,
    findings: [],
    false_positives_detail: [],
    coverage: {
      totalCandidateFiles: 100,
      scannedFiles: 100,
      skippedByLimit: 0,
      truncated: false,
      maxFiles: 500,
      capSource: "adaptive" as const,
    },
    elapsed_ms: 1000,
    ...overrides,
  });

  it("renders coverage, verifier, findings, autofix lines for a clean run", () => {
    const md = renderMd(
      baseAudit({
        verification_mode: "verified",
        fix_support_summary: { rewrite: 1, annotate: 1, manual: 0 },
      }),
    );
    expect(md).toContain("## Audit Confidence");
    expect(md).toContain("**Coverage:** 100 / 100 files (100%) — full scan");
    expect(md).toContain("**Verifier:** active");
    expect(md).toContain("**Findings:** 2 confirmed · 8 false-positive · 0 needs-context");
    expect(md).toContain("**Autofix:** 1 rewrite · 1 annotate · 0 manual-only");
    // No warnings on a clean run.
    expect(md).not.toContain("⚠ Warnings");
  });

  it("emits skip-verify warning + 'static-only' label when verification was skipped", () => {
    const md = renderMd(
      baseAudit({
        verification_mode: "skipped",
        confirmed_findings: 10,
        false_positives: 0,
      }),
    );
    expect(md).toContain("**Verifier:** skipped (static-only output");
    expect(md).toContain("⚠ Warnings");
    expect(md).toContain("Verifier was skipped");
  });

  it("emits truncation warning when coverage truncated=true", () => {
    const md = renderMd(
      baseAudit({
        coverage: {
          totalCandidateFiles: 1500,
          scannedFiles: 500,
          skippedByLimit: 1000,
          truncated: true,
          maxFiles: 500,
          capSource: "user" as const,
        },
      }),
    );
    expect(md).toContain("Coverage truncated");
    expect(md).toMatch(/Re-run with `--max-files \d+`/);
  });

  it("renders diff-mode label when coverage.since is set", () => {
    const md = renderMd(
      baseAudit({
        coverage: {
          totalCandidateFiles: 100,
          scannedFiles: 5,
          skippedByLimit: 0,
          truncated: false,
          maxFiles: 500,
          capSource: "adaptive" as const,
          since: "main",
          changedFilesInDiff: 5,
        },
      }),
    );
    expect(md).toContain("diff scan since `main`");
  });

  it("emits AST-degraded warning when at least one grammar failed to load", () => {
    const md = renderMd(
      baseAudit({
        ast_grammar_status: [
          { language: "python", patterns_attempted: 4, loaded: true },
          {
            language: "go",
            patterns_attempted: 2,
            loaded: false,
            last_error: "tree-sitter-go.wasm not found",
          },
        ],
      }),
    );
    expect(md).toContain("**AST grammars:** 1 loaded, 1 missing (go)");
    expect(md).toContain("AST coverage degraded");
    expect(md).toContain("kcode grammars install");
  });

  it("surfaces top-noise patterns when ≥3 sites with <50% confirm rate", () => {
    const md = renderMd(
      baseAudit({
        pattern_metrics: {
          "noisy-pattern": {
            hits: 20,
            unique_sites: 10,
            confirmed: 1,
            false_positive: 9,
            needs_context: 0,
            confirmed_rate: 0.1,
            false_positive_rate: 0.9,
          },
          "clean-pattern": {
            hits: 5,
            unique_sites: 5,
            confirmed: 5,
            false_positive: 0,
            needs_context: 0,
            confirmed_rate: 1.0,
            false_positive_rate: 0.0,
          },
          "small-sample": {
            hits: 1,
            unique_sites: 1,
            confirmed: 0,
            false_positive: 1,
            needs_context: 0,
            confirmed_rate: 0.0,
            false_positive_rate: 1.0,
          },
        },
      }),
    );
    // Scope assertions to the Audit Confidence section — the lower
    // 'Pattern hit-rate' table renders every pattern regardless of
    // signal, so we'd otherwise hit those entries by accident.
    const confSection = md.split("## Audit Confidence")[1]!.split("---")[0]!;
    expect(confSection).toContain("Top noise");
    expect(confSection).toContain("noisy-pattern");
    expect(confSection).toContain("10% confirm");
    // small-sample has only 1 site — under the threshold, must NOT
    // appear in the top-noise line (one-off noise isn't actionable).
    expect(confSection).not.toContain("small-sample");
    // clean-pattern has 100% confirm — must NOT appear in noise list.
    expect(confSection).not.toContain("clean-pattern");
  });
});

// v2.10.351 P0.9 — review_state filtering in the Markdown report.
describe("generateMarkdownReport — review_state filtering", () => {
  const baseFinding = (overrides: Record<string, unknown>) => ({
    pattern_id: "test-001",
    pattern_title: "Test pattern",
    severity: "high" as const,
    file: "/repo/src/x.c",
    line: 10,
    matched_text: "bad();",
    context: "ctx",
    verification: { verdict: "confirmed" as const, reasoning: "test" },
    cwe: undefined,
    ...overrides,
  });

  it("excludes 'ignored' findings from severity breakdown and Findings list", () => {
    const md = renderMd({
      project: "/repo",
      timestamp: "2026-04-25",
      languages_detected: ["c"],
      files_scanned: 5,
      candidates_found: 2,
      confirmed_findings: 2,
      false_positives: 0,
      findings: [
        baseFinding({ pattern_id: "p1", line: 10 }),
        baseFinding({
          pattern_id: "p2-ignored",
          line: 20,
          review_state: "ignored",
          review_reason: "trusted_boundary",
        }),
      ],
      false_positives_detail: [],
      coverage: {
        totalCandidateFiles: 5,
        scannedFiles: 5,
        skippedByLimit: 0,
        truncated: false,
        maxFiles: 500,
        capSource: "adaptive",
      },
      elapsed_ms: 100,
    });
    // Counts header shows the post-review delta.
    expect(md).toContain("Confirmed findings: **1** (of 2 pre-review)");
    expect(md).toContain("Reviewer-ignored: **1**");
    // Severity breakdown counts the actionable bucket only.
    const severityRow = md.match(/HIGH \| (\d+)/);
    expect(severityRow?.[1]).toBe("1");
    // The ignored finding does NOT appear in the main Findings list.
    expect(md).not.toMatch(/### \d+\..*p2-ignored/);
    // But it DOES appear in the Reviewer-ignored section.
    expect(md).toContain("## Reviewer-ignored findings");
    expect(md).toContain("p2-ignored");
    expect(md).toContain("trusted_boundary");
  });

  it("renders 'all ignored' message when every finding is ignored", () => {
    const md = renderMd({
      project: "/repo",
      timestamp: "2026-04-25",
      languages_detected: ["c"],
      files_scanned: 5,
      candidates_found: 1,
      confirmed_findings: 1,
      false_positives: 0,
      findings: [
        baseFinding({
          pattern_id: "p1",
          review_state: "ignored",
          review_reason: "test_only",
        }),
      ],
      false_positives_detail: [],
      coverage: {
        totalCandidateFiles: 5,
        scannedFiles: 5,
        skippedByLimit: 0,
        truncated: false,
        maxFiles: 500,
        capSource: "adaptive",
      },
      elapsed_ms: 50,
    });
    expect(md).toContain("All 1 confirmed finding(s) were tagged as ignored");
    // Still shows the Reviewer-ignored section so the reader sees the
    // detail.
    expect(md).toContain("## Reviewer-ignored findings");
  });

  it("renders the standard summary when there are NO ignored findings", () => {
    const md = renderMd({
      project: "/repo",
      timestamp: "2026-04-25",
      languages_detected: ["c"],
      files_scanned: 5,
      candidates_found: 1,
      confirmed_findings: 1,
      false_positives: 0,
      findings: [baseFinding({})],
      false_positives_detail: [],
      coverage: {
        totalCandidateFiles: 5,
        scannedFiles: 5,
        skippedByLimit: 0,
        truncated: false,
        maxFiles: 500,
        capSource: "adaptive",
      },
      elapsed_ms: 50,
    });
    // Plain count, no parenthetical or ignored row.
    expect(md).toContain("Confirmed findings: **1**");
    expect(md).not.toContain("pre-review");
    expect(md).not.toContain("Reviewer-ignored");
  });
});

// Unused imports kept for completeness
void enumerateSourceFiles;
