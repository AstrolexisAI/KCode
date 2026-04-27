// KCode - Tests for v2.10.329 structured-first PR generator (Sprint 4).
//
// Validates:
//   - Body is built from audit JSON (counts, coverage, findings, fix_support).
//   - Testing checklist is ecosystem-aware (cmake/cargo/go/bun/npm/pip).
//   - LLM output is constrained to the executive-summary placeholder; even
//     when it returns chain-of-thought / hallucinations, the rest of the
//     body stays correct.
//   - sanitizeExecutiveSummary strips paths and wraps brand terms.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createPr } from "./pr-generator";
import { execSync } from "node:child_process";
import type { AuditResult } from "./types";

let TMP: string;

beforeEach(() => {
  TMP = `/tmp/kcode-pr-structured-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(TMP, { recursive: true });
  // Make TMP a tiny git repo so createPr's git/status calls don't fail.
  execSync(
    "git init -q -b main && git config user.email t@t && git config user.name t",
    { cwd: TMP, stdio: ["pipe", "pipe", "pipe"] },
  );
});
afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function seedAudit(
  ecosystem: "cmake" | "cargo" | "go" | "bun" | "npm" | "pip" = "cmake",
): AuditResult {
  // Drop a marker file so detectEcosystem picks the requested one.
  if (ecosystem === "cmake") writeFileSync(`${TMP}/CMakeLists.txt`, "project(t)");
  if (ecosystem === "cargo") writeFileSync(`${TMP}/Cargo.toml`, "[package]\nname = \"t\"\n");
  if (ecosystem === "go") writeFileSync(`${TMP}/go.mod`, "module t\ngo 1.21\n");
  if (ecosystem === "bun") writeFileSync(`${TMP}/bun.lockb`, "");
  if (ecosystem === "npm") writeFileSync(`${TMP}/package.json`, "{}");
  if (ecosystem === "pip") writeFileSync(`${TMP}/pyproject.toml`, "[project]\nname=\"t\"\n");

  // Add a real source file + uncommitted change so /pr's "uncommitted"
  // check passes without going through resume mode.
  writeFileSync(`${TMP}/src.c`, "int main(void){return 0;}\n");
  execSync("git add -A && git commit -q -m base", { cwd: TMP, stdio: ["pipe", "pipe", "pipe"] });
  writeFileSync(`${TMP}/src.c`, "int main(void){return 1;}\n");

  const result: AuditResult = {
    project: TMP,
    timestamp: "2026-04-25",
    languages_detected: ["c"],
    files_scanned: 10,
    candidates_found: 5,
    confirmed_findings: 2,
    false_positives: 3,
    findings: [
      {
        pattern_id: "fsw-010-cmd-arg-before-validate",
        pattern_title: "Cmd arg unvalidated",
        severity: "high",
        file: `${TMP}/Svc/X.cpp`,
        line: 42,
        matched_text: "X_cmdHandler",
        context: "void X::X_cmdHandler(...)",
        verification: {
          verdict: "confirmed",
          reasoning: "Ground command path-arg unvalidated.",
          execution_path: "Ground -> X_cmdHandler -> Os::File::open",
          suggested_fix: "Length check + cmdResponse_VALIDATION_ERROR.",
        },
        cwe: "CWE-22",
        fix_support: "rewrite",
        // biome-ignore lint/suspicious/noExplicitAny: optional v326 fields
      } as any,
      {
        pattern_id: "fsw-005-buffer-getdata-unchecked",
        pattern_title: "Buffer null-check",
        severity: "medium",
        file: `${TMP}/Svc/Hub.cpp`,
        line: 131,
        matched_text: "fwBuffer.getData()",
        context: "...",
        verification: { verdict: "confirmed", reasoning: "no null check" },
        cwe: "CWE-476",
        fix_support: "annotate",
        // biome-ignore lint/suspicious/noExplicitAny: optional v326 fields
      } as any,
    ],
    false_positives_detail: [
      {
        pattern_id: "cpp-012-loop-unvalidated-bound",
        pattern_title: "Loop bound",
        severity: "high",
        file: `${TMP}/Svc/Demoted.cpp`,
        line: 99,
        matched_text: "for (...)",
        context: "...",
        verification: {
          verdict: "false_positive",
          reasoning: "[reviewer demoted] bounded by FW_ASSERT upstream",
        },
        // biome-ignore lint/suspicious/noExplicitAny: optional v326 fields
        review_state: "demoted_fp" as any,
        // biome-ignore lint/suspicious/noExplicitAny: optional v326 fields
        review_reason: "trusted_boundary" as any,
        // biome-ignore lint/suspicious/noExplicitAny: optional v326 fields
      } as any,
    ],
    needs_context: 0,
    needs_context_detail: [],
    coverage: {
      totalCandidateFiles: 10,
      scannedFiles: 10,
      skippedByLimit: 0,
      truncated: false,
      maxFiles: 500,
      capSource: "adaptive",
    },
    // biome-ignore lint/suspicious/noExplicitAny: optional v326 fields
    fix_support_summary: { rewrite: 1, annotate: 1, manual: 0 } as any,
    elapsed_ms: 12345,
  };
  writeFileSync(`${TMP}/AUDIT_REPORT.json`, JSON.stringify(result, null, 2));
  return result;
}

describe("/pr v2.10.329 — structured-first body", () => {
  it("body comes from JSON even when LLM returns chain-of-thought garbage", async () => {
    seedAudit("cmake");
    // LLM that emits the v320-class garbage we're guarding against.
    const llm = async () =>
      "Here's a thinking process:\n1. Analyze...\n2. ...";
    const result = await createPr({
      projectRoot: TMP,
      llmCallback: llm,
      dryRun: true,
    });

    const body = result.prDescription;
    // Structured sections must be present regardless of LLM output.
    expect(body).toContain("Security and code-quality audit");
    expect(body).toContain("**Findings:** 2 confirmed");
    expect(body).toContain("**Coverage:** 10/10");
    expect(body).toContain("Fix support");
    expect(body).toContain("CWE-22");
    expect(body).toContain("Svc/X.cpp");
    expect(body).toContain("fix-support");
    // Chain-of-thought must NOT leak into the body.
    expect(body).not.toContain("Here's a thinking process");
    expect(body).not.toContain("Analyze User Input");
  });

  it("includes review_reason annotation for demoted findings", async () => {
    seedAudit("cmake");
    const result = await createPr({
      projectRoot: TMP,
      llmCallback: async () => "Brief executive summary, two paragraphs.",
      dryRun: true,
    });
    // CL.7 (v2.10.377) — section was renamed to "Ignored / demoted"
    // and now combines reviewer-ignored findings with verifier-FPs
    // demoted by the reviewer. The trusted_boundary reason still
    // appears in the per-row label.
    expect(result.prDescription).toContain("Ignored / demoted");
    expect(result.prDescription).toContain("trusted_boundary");
  });

  it("ecosystem detection drives the testing checklist", async () => {
    seedAudit("cargo");
    const r = await createPr({
      projectRoot: TMP,
      llmCallback: async () => "summary",
      dryRun: true,
    });
    expect(r.prDescription).toContain("`cargo test --all-features`");
    expect(r.prDescription).not.toContain("`cmake -B build");
  });

  it("go ecosystem is detected via go.mod", async () => {
    seedAudit("go");
    const r = await createPr({
      projectRoot: TMP,
      llmCallback: async () => "summary",
      dryRun: true,
    });
    expect(r.prDescription).toContain("`go test ./...`");
    expect(r.prDescription).toContain("`go vet ./...`");
  });

  it("bun ecosystem maps to bun test", async () => {
    seedAudit("bun");
    const r = await createPr({
      projectRoot: TMP,
      llmCallback: async () => "summary",
      dryRun: true,
    });
    expect(r.prDescription).toContain("`bun test`");
  });
});

describe("/pr v2.10.329 — LLM summary fallback", () => {
  it("falls back to a one-line stand-in when LLM returns nothing", async () => {
    seedAudit("cmake");
    const llm = async () => "";
    const result = await createPr({
      projectRoot: TMP,
      llmCallback: llm,
      dryRun: true,
    });
    expect(result.prDescription).toContain("See findings below");
    // CL.7 — "Findings and fixes" was split into Fixed/Manual/Ignored
    // sections. At least one of the bucketed headers must appear.
    expect(result.prDescription).toMatch(/### Fixed findings|### Manual findings|### Ignored \/ demoted/);
    expect(result.prDescription).toContain("Methodology");
    expect(result.prDescription).toContain("Testing");
  });

  it("falls back when LLM throws", async () => {
    seedAudit("cmake");
    const llm = async () => {
      throw new Error("network");
    };
    const result = await createPr({
      projectRoot: TMP,
      llmCallback: llm,
      dryRun: true,
    });
    expect(result.prDescription).toContain("Security and code-quality audit");
    expect(result.prDescription).toMatch(/### Fixed findings|### Manual findings/);
  });
});

// CL.7 (v2.10.377) — explicit Fixed / Manual / Ignored section
// counts must be internally consistent so a CI gate can verify them
// against AUDIT_REPORT.json without re-deriving the totals.
describe("/pr CL.7 — section counts consistent with AUDIT_REPORT.json", () => {
  it("Fixed count = confirmed findings with fix_support='rewrite'", async () => {
    seedAudit("cmake");
    const result = await createPr({
      projectRoot: TMP,
      llmCallback: async () => "summary",
      dryRun: true,
    });
    // The seeded audit has 1 rewrite + 1 annotate confirmed finding.
    expect(result.prDescription).toMatch(/### Fixed findings \(1\)/);
    expect(result.prDescription).toMatch(/### Manual findings \(1\)/);
  });

  it("Ignored count = ignored findings + demoted_fp FPs", async () => {
    seedAudit("cmake");
    const result = await createPr({
      projectRoot: TMP,
      llmCallback: async () => "summary",
      dryRun: true,
    });
    // The seeded audit has 1 demoted_fp in false_positives_detail
    // and 0 ignored confirmed findings. Total = 1.
    expect(result.prDescription).toMatch(/### Ignored \/ demoted \(1\)/);
  });

  it("each section has a body line, not just the header", async () => {
    seedAudit("cmake");
    const r = await createPr({
      projectRoot: TMP,
      llmCallback: async () => "summary",
      dryRun: true,
    });
    // Fixed section has the explanation line.
    expect(r.prDescription).toContain("patched mechanically by `/fix`");
    // Manual section has its explanation.
    expect(r.prDescription).toContain("need human review");
    // Ignored section has its explanation.
    expect(r.prDescription).toContain("explicitly chose not to act on");
  });
});
