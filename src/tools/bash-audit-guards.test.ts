// Tests for Bash tool's audit-file redirection guard.
// Prevents bypassing the Write-tool audit discipline via `cat > file`, tee, etc.

import { describe, expect, test } from "bun:test";
import { extractRedirectionTargets, isAuditFilename } from "../core/audit-guards";
import { executeBash } from "./bash";

describe("audit-guards: filename detection", () => {
  test("detects common audit filenames", () => {
    expect(isAuditFilename("AUDIT_REPORT.md")).toBe(true);
    expect(isAuditFilename("audit_report.md")).toBe(true);
    expect(isAuditFilename("FIXES_SUMMARY.txt")).toBe(true);
    expect(isAuditFilename("FIXES_APPLIED.txt")).toBe(true);
    expect(isAuditFilename("AUDIT_INDEX.md")).toBe(true);
    expect(isAuditFilename("FINAL_AUDIT_REPORT.md")).toBe(true);
    expect(isAuditFilename("REMEDIATION_FIXES.md")).toBe(true);
    expect(isAuditFilename("security-audit.md")).toBe(true);
    expect(isAuditFilename("audit_certificate.txt")).toBe(true);
    expect(isAuditFilename("/some/path/AUDIT_SUMMARY.txt")).toBe(true);
  });

  test("does not flag normal filenames", () => {
    expect(isAuditFilename("README.md")).toBe(false);
    expect(isAuditFilename("notes.md")).toBe(false);
    expect(isAuditFilename("todo.txt")).toBe(false);
    expect(isAuditFilename("main.cpp")).toBe(false);
    expect(isAuditFilename("hiderport.md")).toBe(false); // "report" substring without separator
  });
});

describe("audit-guards: redirection extraction", () => {
  test("extracts simple > redirection", () => {
    const targets = extractRedirectionTargets("echo hello > output.txt");
    expect(targets).toContain("output.txt");
  });

  test("extracts >> append redirection", () => {
    const targets = extractRedirectionTargets("echo hello >> log.txt");
    expect(targets).toContain("log.txt");
  });

  test("extracts heredoc redirection target", () => {
    const targets = extractRedirectionTargets(
      "cat > AUDIT_REPORT.md << 'EOF'\ncontent\nEOF",
    );
    expect(targets).toContain("AUDIT_REPORT.md");
  });

  test("extracts tee target", () => {
    const targets = extractRedirectionTargets("echo x | tee output.log");
    expect(targets).toContain("output.log");
  });

  test("extracts tee -a target", () => {
    const targets = extractRedirectionTargets("echo x | tee -a output.log");
    expect(targets).toContain("output.log");
  });

  test("extracts quoted path", () => {
    const targets = extractRedirectionTargets(`echo x > "path with spaces.txt"`);
    expect(targets).toContain("path with spaces.txt");
  });

  test("does not match stderr redirection 2>&1", () => {
    const targets = extractRedirectionTargets("cmd 2>&1 > real.log");
    // 2>&1 should not add &1 or 1 as target
    expect(targets).not.toContain("&1");
    expect(targets).not.toContain("1");
    expect(targets).toContain("real.log");
  });
});

describe("audit-guards: Bash tool integration", () => {
  test("blocks cat > AUDIT_REPORT.md", async () => {
    const result = await executeBash({
      command: "cat > /tmp/AUDIT_REPORT.md << 'EOF'\nfake\nEOF",
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("AUDIT_REPORT.md");
    expect(result.content).toContain("shell redirection");
  });

  test("blocks echo > FIXES_SUMMARY.txt", async () => {
    const result = await executeBash({
      command: "echo stuff > /tmp/FIXES_SUMMARY.txt",
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
  });

  test("blocks tee FINAL_AUDIT.md", async () => {
    const result = await executeBash({
      command: "echo x | tee /tmp/FINAL_AUDIT.md",
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
  });

  test("allows normal > redirection to non-audit file", async () => {
    const result = await executeBash({
      command: "echo hello > /tmp/kcode-normal-test.txt",
    });
    // Should NOT be blocked by audit guard (may still fail for other reasons)
    expect(result.content).not.toContain("audit-report file");
  });
});

describe("audit-guards: Bash records reads and greps", () => {
  test("cat foo.cpp records the file as Read in session tracker", async () => {
    const { resetReads, wasRead, readCount } = await import("../core/session-tracker");
    resetReads();
    // Create a file to cat
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "kcode-bash-record-"));
    const file = join(tmp, "test.cpp");
    writeFileSync(file, "int x = 1;\n");

    await executeBash({ command: `cat ${file}` });
    // Give the async import in bash.ts time to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(wasRead(file)).toBe(true);
    expect(readCount()).toBeGreaterThanOrEqual(1);
  });

  test("grep via bash increments grepCount", async () => {
    const { resetReads, grepCount } = await import("../core/session-tracker");
    resetReads();

    await executeBash({ command: "grep -r data /tmp/nonexistent-path-kcode" });
    await new Promise((r) => setTimeout(r, 50));

    expect(grepCount()).toBeGreaterThanOrEqual(1);
  });
});
