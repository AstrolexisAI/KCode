// Tests for audit-report discipline guards in Write tool

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordGrep, recordRead, resetReads } from "../core/session-tracker";
import { executeWrite } from "./write";

describe("audit-report discipline guards", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kcode-guard-test-"));
    resetReads();
    // Minimum reconnaissance so existing tests can create audit files
    recordGrep();
    recordRead("/p/f1.cpp");
    recordRead("/p/f2.cpp");
    recordRead("/p/f3.cpp");
    recordRead("/p/f4.cpp");
    recordRead("/p/f5.cpp");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("blocks creating FIXES_SUMMARY.txt when AUDIT_REPORT.md already exists", async () => {
    // Create an existing audit report
    writeFileSync(join(tmp, "AUDIT_REPORT.md"), "# Existing audit\n");

    const result = await executeWrite({
      file_path: join(tmp, "FIXES_SUMMARY.txt"),
      content: "summary companion file",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("AUDIT_REPORT.md");
    expect(result.content).toContain("UPDATE the existing");
  });

  test("blocks FINAL_AUDIT_REPORT.md companion to AUDIT_REPORT.md", async () => {
    writeFileSync(join(tmp, "AUDIT_REPORT.md"), "# Existing\n");

    const result = await executeWrite({
      file_path: join(tmp, "FINAL_AUDIT_REPORT.md"),
      content: "another report",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
  });

  test("allows updating AUDIT_REPORT.md itself (same file)", async () => {
    writeFileSync(join(tmp, "AUDIT_REPORT.md"), "# Old\n");

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content: "# Updated audit\n",
    });

    expect(result.is_error).toBeUndefined();
  });

  test("allows first audit report in empty directory", async () => {
    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content: "# First audit\n",
    });

    expect(result.is_error).toBeUndefined();
  });

  test("blocks audit with fabricated proof-of-work checklist", async () => {
    // Record that we Read only 2 files in this session
    recordRead("/fake/src/foo.cpp");
    recordRead("/fake/src/bar.cpp");

    const content = `# Audit Report

## Files read in full (proof of work)
1. src/foo.cpp — 100 lines — checked for: leaks
2. src/bar.cpp — 200 lines — checked for: bounds
3. src/never_read.cpp — 300 lines — checked for: pointers
4. src/also_fake.cpp — 150 lines — checked for: overflow
`;

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content,
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("NEVER opened with the Read tool");
    expect(result.content).toContain("never_read.cpp");
    expect(result.content).toContain("also_fake.cpp");
    // Should NOT list the actually-read files as fabricated
    expect(result.content).not.toContain("- foo.cpp");
  });

  test("allows audit with honest proof-of-work checklist", async () => {
    recordRead(join(tmp, "src/foo.cpp"));
    recordRead(join(tmp, "src/bar.cpp"));

    const content = `# Audit Report

## Files read in full (proof of work)
1. ${join(tmp, "src/foo.cpp")} — 100 lines — checked for: leaks
2. ${join(tmp, "src/bar.cpp")} — 200 lines — checked for: bounds
`;

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content,
    });

    expect(result.is_error).toBeUndefined();
  });

  test("basename matching works for proof-of-work validation", async () => {
    // Model Reads absolute path, lists relative/basename in report
    recordRead("/project/deep/path/UsbDevice.cpp");

    const content = `# Audit

## Files read in full (proof of work)
1. UsbDevice.cpp — 50 lines — checked for: leaks
`;

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content,
    });

    expect(result.is_error).toBeUndefined();
  });

  test("blocks audit write when no Grep was called in session", async () => {
    resetReads(); // wipe the 5 reads + 1 grep from beforeEach
    // Record 5 reads but NO grep
    recordRead("/p/a.cpp");
    recordRead("/p/b.cpp");
    recordRead("/p/c.cpp");
    recordRead("/p/d.cpp");
    recordRead("/p/e.cpp");

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content: "# Audit\n",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("Grep tool ONCE");
  });

  test("blocks audit write when fewer than 5 files were Read", async () => {
    resetReads();
    recordGrep();
    recordRead("/p/only1.cpp");
    recordRead("/p/only2.cpp");

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content: "# Audit\n",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("Read only 2 file");
  });

  test("non-audit files bypass audit guards entirely", async () => {
    // Recording no reads, creating a normal file with fake checklist-like content
    const result = await executeWrite({
      file_path: join(tmp, "notes.md"),
      content: "## Files read in full (proof of work)\n1. fake.cpp — 100 lines\n",
    });

    expect(result.is_error).toBeUndefined();
  });
});
