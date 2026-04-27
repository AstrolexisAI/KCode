// Tests for the audit-session Edit/MultiEdit guard.
// In audit sessions, source files can only be modified AFTER an
// AUDIT_REPORT.md exists and cites the file being edited.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAuditIntent, resetReads, setAuditIntent } from "../core/session-tracker";
import { executeEdit } from "./edit";
import { executeMultiEdit } from "./multi-edit";

describe("detectAuditIntent", () => {
  test("detects English keywords", () => {
    expect(detectAuditIntent("please audit this repo")).toBe(true);
    expect(detectAuditIntent("Run a security-review on this")).toBe(true);
    expect(detectAuditIntent("code review needed")).toBe(true);
  });

  test("detects Spanish keywords", () => {
    expect(detectAuditIntent("auditalo por favor")).toBe(true);
    expect(detectAuditIntent("revisa este código")).toBe(true);
    expect(detectAuditIntent("analizalo")).toBe(true);
    expect(detectAuditIntent("analizar el proyecto")).toBe(true);
  });

  test("does not flag unrelated messages", () => {
    expect(detectAuditIntent("fix the login bug")).toBe(false);
    expect(detectAuditIntent("add a new feature")).toBe(false);
    expect(detectAuditIntent("write tests for foo.ts")).toBe(false);
  });
});

describe("audit-session Edit guard", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kcode-audit-edit-"));
    resetReads();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    resetReads();
  });

  test("allows Edit in non-audit sessions", async () => {
    setAuditIntent(false);
    const file = join(tmp, "foo.cpp");
    writeFileSync(file, "int x = 1;\n");

    const result = await executeEdit({
      file_path: file,
      old_string: "int x = 1;",
      new_string: "int x = 2;",
    });

    expect(result.is_error).toBeUndefined();
  });

  test("blocks Edit on source file in audit session without report", async () => {
    setAuditIntent(true);
    const file = join(tmp, "foo.cpp");
    writeFileSync(file, "int x = 1;\n");

    const result = await executeEdit({
      file_path: file,
      old_string: "int x = 1;",
      new_string: "int x = 2;",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("no AUDIT_REPORT.md");
  });

  test("allows Edit when AUDIT_REPORT.md exists AND cites the file", async () => {
    setAuditIntent(true);
    const file = join(tmp, "foo.cpp");
    writeFileSync(file, "int x = 1;\n");
    writeFileSync(join(tmp, "AUDIT_REPORT.md"), "# Audit\n\nBug in foo.cpp:1 — wrong value\n");

    const result = await executeEdit({
      file_path: file,
      old_string: "int x = 1;",
      new_string: "int x = 2;",
    });

    expect(result.is_error).toBeUndefined();
  });

  test("blocks Edit when AUDIT_REPORT.md exists but does NOT cite the file", async () => {
    setAuditIntent(true);
    const file = join(tmp, "unrelated.cpp");
    writeFileSync(file, "int x = 1;\n");
    writeFileSync(
      join(tmp, "AUDIT_REPORT.md"),
      "# Audit\n\nBug in other.cpp:42 — something else\n",
    );

    const result = await executeEdit({
      file_path: file,
      old_string: "int x = 1;",
      new_string: "int x = 2;",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("does not cite");
    expect(result.content).toContain("unrelated.cpp");
  });

  test("allows Edit on non-source files during audit session", async () => {
    setAuditIntent(true);
    const file = join(tmp, "README.md");
    writeFileSync(file, "# Old\n");

    const result = await executeEdit({
      file_path: file,
      old_string: "# Old",
      new_string: "# New",
    });

    expect(result.is_error).toBeUndefined();
  });

  test("walks up directory tree to find AUDIT_REPORT.md", async () => {
    setAuditIntent(true);
    const nested = join(tmp, "src", "nested");
    mkdirSync(nested, { recursive: true });
    const file = join(nested, "deep.cpp");
    writeFileSync(file, "int x = 1;\n");
    writeFileSync(join(tmp, "AUDIT_REPORT.md"), "# Audit\n\nBug in deep.cpp:1 — issue\n");

    const result = await executeEdit({
      file_path: file,
      old_string: "int x = 1;",
      new_string: "int x = 2;",
    });

    expect(result.is_error).toBeUndefined();
  });

  test("MultiEdit blocks if any target file is not cited", async () => {
    setAuditIntent(true);
    const fileA = join(tmp, "a.cpp");
    const fileB = join(tmp, "b.cpp");
    writeFileSync(fileA, "int a = 1;\n");
    writeFileSync(fileB, "int b = 1;\n");
    writeFileSync(join(tmp, "AUDIT_REPORT.md"), "# Audit\n\nBug in a.cpp:1 — issue\n");

    const result = await executeMultiEdit({
      edits: [
        { file_path: fileA, old_string: "int a = 1;", new_string: "int a = 2;" },
        { file_path: fileB, old_string: "int b = 1;", new_string: "int b = 2;" },
      ],
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("b.cpp");
  });

  test("MultiEdit allows when ALL target files are cited", async () => {
    setAuditIntent(true);
    const fileA = join(tmp, "a.cpp");
    const fileB = join(tmp, "b.cpp");
    writeFileSync(fileA, "int a = 1;\n");
    writeFileSync(fileB, "int b = 1;\n");
    writeFileSync(join(tmp, "AUDIT_REPORT.md"), "# Audit\n\nBug in a.cpp:1\nBug in b.cpp:1\n");

    const result = await executeMultiEdit({
      edits: [
        { file_path: fileA, old_string: "int a = 1;", new_string: "int a = 2;" },
        { file_path: fileB, old_string: "int b = 1;", new_string: "int b = 2;" },
      ],
    });

    expect(result.is_error).toBeUndefined();
  });
});
