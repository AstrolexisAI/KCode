// Tests for audit-report discipline guards in Write tool

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordGrep,
  recordGrepHits,
  recordRead,
  resetReads,
} from "../core/session-tracker";
import { executeWrite } from "./write";

describe("audit-report discipline guards", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kcode-guard-test-"));
    resetReads();
    // Minimum reconnaissance so existing tests can create audit files.
    // Need 6 SOURCE files.
    recordGrep();
    recordRead("/p/f1.cpp");
    recordRead("/p/f2.cpp");
    recordRead("/p/f3.cpp");
    recordRead("/p/f4.cpp");
    recordRead("/p/f5.cpp");
    recordRead("/p/f6.cpp");
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

  test("blocks audit write when fewer than 6 source files were Read", async () => {
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
    expect(result.content).toContain("Read only 2 SOURCE file");
  });

  test("README.md and CMakeLists.txt do NOT count toward source-read minimum", async () => {
    resetReads();
    recordGrep();
    // Non-source files
    recordRead("/p/README.md");
    recordRead("/p/CMakeLists.txt");
    recordRead("/p/LICENSE");
    recordRead("/p/docs/guide.md");
    // Only 2 actual source files
    recordRead("/p/src/a.cpp");
    recordRead("/p/src/b.cpp");

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content: "# Audit\n",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Read only 2 SOURCE file");
  });

  test("blocks audit when grep flagged many files but most were unread", async () => {
    // Simulate: grep for "data[" matched 6 files, model only Read 1 of them
    recordGrepHits("data\\[", [
      "/p/UsbXBox.cpp",
      "/p/UsbDualShock3.cpp",
      "/p/UsbDualShock4.cpp",
      "/p/UsbWingMan.cpp",
      "/p/BtXBox.cpp",
      "/p/HidDecoder.cpp",
    ]);
    // Mark only one as Read
    recordRead("/p/HidDecoder.cpp");

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content: "# Audit\n",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("flagged");
    expect(result.content).toContain("UsbXBox.cpp");
  });

  test("allows audit when grep-hit files are mostly Read", async () => {
    recordGrepHits("data\\[", [
      "/p/UsbXBox.cpp",
      "/p/UsbDualShock4.cpp",
      "/p/HidDecoder.cpp",
    ]);
    // Read all three
    recordRead("/p/UsbXBox.cpp");
    recordRead("/p/UsbDualShock4.cpp");
    recordRead("/p/HidDecoder.cpp");

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content: "# Audit\n",
    });

    expect(result.is_error).toBeUndefined();
  });

  test("ignores grep hits from NON-dangerous patterns", async () => {
    // "TODO" is not in the dangerous patterns list, so hits shouldn't be recorded
    recordGrepHits("TODO", [
      "/p/a.cpp",
      "/p/b.cpp",
      "/p/c.cpp",
      "/p/d.cpp",
    ]);

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content: "# Audit\n",
    });

    expect(result.is_error).toBeUndefined();
  });

  test("blocks audit citing file:line for a file never Read", async () => {
    const content = `# Audit

## Findings
Bug in EthernetDevice.cpp:160 — pointer arithmetic error
Also see UsbXBox.cpp:35 for buffer indexing issue
`;

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content,
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("never opened");
    expect(result.content).toContain("EthernetDevice.cpp");
    expect(result.content).toContain("UsbXBox.cpp");
  });

  test("allows audit with citations to Read files", async () => {
    recordRead("/p/EthernetDevice.cpp");
    recordRead("/p/UsbXBox.cpp");

    const content = `# Audit

## Findings
Bug in EthernetDevice.cpp:160 — pointer arithmetic error
See also UsbXBox.cpp:35 for buffer indexing
`;

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content,
    });

    expect(result.is_error).toBeUndefined();
  });

  test("BLOCKED error includes next-step file reads when grep hits exist", async () => {
    resetReads();
    recordGrep();
    recordRead("/p/already.cpp");
    // Record grep hits on dangerous pattern
    const { recordGrepHits } = await import("../core/session-tracker");
    recordGrepHits("data\\[", [
      "/p/UsbXBox.cpp",
      "/p/EthernetDevice.cpp",
      "/p/HidDecoder.cpp",
    ]);

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content: "# Audit\n",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("NEXT STEP");
    expect(result.content).toContain('Read("');
    expect(result.content).toContain("UsbXBox.cpp");
  });

  test("BLOCKED error includes honest-summary template forbidding marketing", async () => {
    resetReads();
    recordGrep();
    recordRead("/p/only1.cpp");

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content: "# Audit\n",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("AUDIT INCOMPLETE");
    expect(result.content).toContain("MUST begin with");
    expect(result.content).toContain("production-ready");
    expect(result.content).toContain("professional-grade");
    expect(result.content).toContain("star ratings");
  });

  test("blocks audit with backtick-filename + inline-code content claim (no :line)", async () => {
    // This is the bypass pattern observed in v2.6.34:
    //   `HidGenericJoystick.cpp`: `buttons.push_back(new SingleInput(0,1));`
    // The model attaches code it claims is in the file without a :line.
    const content = `# Audit

## Findings
Raw allocations scattered across:
- \`HidGenericJoystick.cpp\`: \`buttons.push_back(new SingleInput(0,1));\`
- \`SingleCameraController.cpp\`: \`CompositeInput* zoom = new CompositeInput();\`
`;

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content,
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("HidGenericJoystick.cpp");
    expect(result.content).toContain("SingleCameraController.cpp");
  });

  test("blocks audit with **File:** header + code block for unread file", async () => {
    const content = `# Audit

### Issue 1
**File:** \`UnreadFile.cpp\`
**Severity:** HIGH

\`\`\`cpp
int x = 1;
\`\`\`

Buggy code here.
`;

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content,
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("UnreadFile.cpp");
  });

  test("allows backtick-filename claim when file was Read", async () => {
    recordRead("/p/HidDevice.cpp");
    const content = `# Audit

Found: \`HidDevice.cpp\`: \`int x = buggy_code();\`
`;

    const result = await executeWrite({
      file_path: join(tmp, "AUDIT_REPORT.md"),
      content,
    });

    expect(result.is_error).toBeUndefined();
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
