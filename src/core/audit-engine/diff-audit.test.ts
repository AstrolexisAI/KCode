// KCode - Tests for v2.10.335 diff-based audit (--since).
//
// Validates:
//   - listChangedFilesSinceRef returns absolute paths of changed files.
//   - runAudit({ since }) intersects the file universe with the diff,
//     adjusting coverage accordingly.
//   - coverage.since and coverage.changedFilesInDiff round-trip
//     through the AuditResult.
//   - Report renders the diff-mode banner so a "10 of 1505" line
//     can't be misread as a coverage gap.

import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { listChangedFilesSinceRef, runAudit } from "./audit-engine";
import { generateMarkdownReport } from "./report-generator";

let TMP: string;
beforeEach(() => {
  TMP = `/tmp/kcode-diff-audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(TMP, { recursive: true });
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

function commit(msg: string): void {
  execSync(`git add -A && git commit -q -m ${JSON.stringify(msg)}`, {
    cwd: TMP,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("listChangedFilesSinceRef", () => {
  it("returns absolute paths of files modified since the ref", async () => {
    writeFileSync(join(TMP, "untouched.c"), "int a;\n");
    writeFileSync(join(TMP, "modified.c"), "int b;\n");
    commit("initial");
    // tag the initial commit so we can diff against it
    execSync("git tag base", { cwd: TMP, stdio: ["pipe", "pipe", "pipe"] });
    writeFileSync(join(TMP, "modified.c"), "int b = 42;\n");
    writeFileSync(join(TMP, "added.c"), "int c;\n");
    commit("change");

    const changed = await listChangedFilesSinceRef(TMP, "base");
    const rel = changed.map((p) => p.replace(`${TMP}/`, ""));
    expect(rel).toContain("modified.c");
    expect(rel).toContain("added.c");
    expect(rel).not.toContain("untouched.c");
  });

  it("includes uncommitted working-tree changes", async () => {
    writeFileSync(join(TMP, "a.c"), "int a;\n");
    commit("a");
    execSync("git tag base", { cwd: TMP, stdio: ["pipe", "pipe", "pipe"] });
    // Modify a.c without committing — diff against `base...HEAD`
    // wouldn't see it, but the second `git diff` form does.
    writeFileSync(join(TMP, "a.c"), "int a = 1;\n");

    const changed = await listChangedFilesSinceRef(TMP, "base");
    const rel = changed.map((p) => p.replace(`${TMP}/`, ""));
    expect(rel).toContain("a.c");
  });

  it("throws on a non-existent ref", async () => {
    writeFileSync(join(TMP, "a.c"), "int a;\n");
    commit("a");
    let threw = false;
    try {
      await listChangedFilesSinceRef(TMP, "definitely-not-a-ref-xyz");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("runAudit({ since })", () => {
  it("only scans files in the diff", async () => {
    // Two files. Both contain a strcpy that the C/C++ pack would flag
    // — but we'll modify only one and run --since against the tag.
    writeFileSync(
      join(TMP, "old.c"),
      `void f(const char* s) { char b[8]; strcpy(b, s); }\n`,
    );
    writeFileSync(
      join(TMP, "new.c"),
      `int main(void) { return 0; }\n`,
    );
    commit("initial");
    execSync("git tag base", { cwd: TMP, stdio: ["pipe", "pipe", "pipe"] });
    writeFileSync(
      join(TMP, "new.c"),
      `void g(const char* s) { char b[8]; strcpy(b, s); }\n`,
    );
    commit("add bug to new.c");

    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
      since: "base",
    });

    // Only new.c should appear in the scanned files; old.c is
    // untouched in the diff range.
    const scannedRel = result.findings.map((f) =>
      f.file.replace(`${TMP}/`, ""),
    );
    expect(scannedRel.every((p) => !p.includes("old.c"))).toBe(true);
    // coverage carries the since marker
    expect(result.coverage).toBeDefined();
    expect((result.coverage as { since?: string }).since).toBe("base");
    // changedFilesInDiff was captured
    expect(
      (result.coverage as { changedFilesInDiff?: number }).changedFilesInDiff,
    ).toBeGreaterThanOrEqual(1);
    // scannedFiles is now the diff-filtered count, not the project total
    expect(result.coverage.scannedFiles).toBeLessThan(
      result.coverage.totalCandidateFiles,
    );
  });

  it("falls back to all files when --since is omitted", async () => {
    writeFileSync(join(TMP, "a.c"), "int a = 0;\n");
    writeFileSync(join(TMP, "b.c"), "int b = 0;\n");
    commit("initial");

    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
    });
    expect((result.coverage as { since?: string }).since).toBeUndefined();
    expect(result.coverage.scannedFiles).toBe(2);
  });
});

describe("renderMarkdown — diff coverage section", () => {
  it("shows a 'Mode: diff-based audit' line when since is set", async () => {
    writeFileSync(join(TMP, "a.c"), "int a;\n");
    commit("a");
    execSync("git tag base", { cwd: TMP, stdio: ["pipe", "pipe", "pipe"] });
    writeFileSync(join(TMP, "a.c"), "int a = 1;\n");
    commit("change");

    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
      since: "base",
    });
    const md = generateMarkdownReport(result);
    expect(md).toContain("**Mode:** diff-based audit since `base`");
    expect(md).toContain("Files changed in diff:");
  });

  it("does NOT show diff banner on a normal full scan", async () => {
    writeFileSync(join(TMP, "a.c"), "int a;\n");
    commit("a");
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
    });
    const md = generateMarkdownReport(result);
    expect(md).not.toContain("Mode:** diff-based audit");
  });
});
