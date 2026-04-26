// Tests for v2.10.307 coverage + ranking + FP-detail additions.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runAudit } from "./audit-engine";
import {
  defaultMaxFiles,
  enumerateSourceFiles,
  scanProject,
  scoreFileForAudit,
  selectFilesForAudit,
} from "./scanner";
import { generateMarkdownReport } from "./report-generator";

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
  it("reports truncated=false for small repos", () => {
    w("a.c", "int a;\n");
    w("b.c", "int b;\n");
    w("c.c", "int c;\n");
    const { coverage } = scanProject(TMP);
    expect(coverage.totalCandidateFiles).toBe(3);
    expect(coverage.scannedFiles).toBe(3);
    expect(coverage.skippedByLimit).toBe(0);
    expect(coverage.truncated).toBe(false);
  });

  it("reports truncated=true + skippedByLimit when user caps below total", () => {
    for (let i = 0; i < 15; i++) w(`f${i}.c`, `int v${i};\n`);
    const { coverage } = scanProject(TMP, { maxFiles: 5 });
    expect(coverage.totalCandidateFiles).toBe(15);
    expect(coverage.scannedFiles).toBe(5);
    expect(coverage.skippedByLimit).toBe(10);
    expect(coverage.truncated).toBe(true);
    expect(coverage.capSource).toBe("user");
    expect(coverage.maxFiles).toBe(5);
  });

  it("capSource='adaptive' when no explicit cap passed", () => {
    w("a.c");
    w("b.c");
    const { coverage } = scanProject(TMP);
    expect(coverage.capSource).toBe("adaptive");
  });

  it("adaptive cap does not truncate a small project", () => {
    for (let i = 0; i < 20; i++) w(`f${i}.c`);
    const { coverage } = scanProject(TMP);
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
