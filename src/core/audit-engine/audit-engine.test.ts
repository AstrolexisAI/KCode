// Tests for the audit engine.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "./audit-engine";
import { getAllPatterns, getPatternById } from "./patterns";
import { generateMarkdownReport } from "./report-generator";
import { findSourceFiles, scanProject } from "./scanner";
import { parseVerdict } from "./verifier";

describe("pattern library", () => {
  test("all patterns have unique IDs", () => {
    const all = getAllPatterns();
    const ids = new Set(all.map((p) => p.id));
    expect(ids.size).toBe(all.length);
  });

  test("all patterns have valid regexes", () => {
    for (const p of getAllPatterns()) {
      expect(p.regex).toBeInstanceOf(RegExp);
      expect(p.title.length).toBeGreaterThan(5);
      expect(p.verify_prompt.length).toBeGreaterThan(20);
    }
  });

  test("getPatternById finds known patterns", () => {
    expect(getPatternById("cpp-001-ptr-address-index")).toBeDefined();
    expect(getPatternById("cpp-002-unreachable-after-return")).toBeDefined();
    expect(getPatternById("nonexistent")).toBeUndefined();
  });
});

describe("scanner", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kcode-scan-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("findSourceFiles discovers C++ files", () => {
    writeFileSync(join(tmp, "a.cpp"), "int main() {}");
    writeFileSync(join(tmp, "b.hh"), "class B {};");
    writeFileSync(join(tmp, "readme.md"), "text");
    mkdirSync(join(tmp, "sub"));
    writeFileSync(join(tmp, "sub/c.c"), "int x;");

    const files = findSourceFiles(tmp);
    expect(files.length).toBe(3);
    expect(files.some((f) => f.endsWith("a.cpp"))).toBe(true);
    expect(files.some((f) => f.endsWith("b.hh"))).toBe(true);
    expect(files.some((f) => f.endsWith("c.c"))).toBe(true);
  });

  test("findSourceFiles skips build/node_modules/3rdParty", () => {
    mkdirSync(join(tmp, "build"));
    writeFileSync(join(tmp, "build/built.cpp"), "int x;");
    mkdirSync(join(tmp, "node_modules"));
    writeFileSync(join(tmp, "node_modules/vendor.cpp"), "int y;");
    mkdirSync(join(tmp, "3rdParty"));
    writeFileSync(join(tmp, "3rdParty/lib.cpp"), "int z;");
    writeFileSync(join(tmp, "main.cpp"), "int main() {}");

    const files = findSourceFiles(tmp);
    expect(files.length).toBe(1);
    expect(files[0]!.endsWith("main.cpp")).toBe(true);
  });

  test("scanProject detects NASA IDF pointer arithmetic bug", () => {
    // Recreate the EthernetDevice.cpp:160 pattern
    writeFileSync(
      join(tmp, "EthernetDevice.cpp"),
      `size_t EthernetDevice::write(const void *buffer, size_t length) {
    size_t bytesTotal = 0;
    while (bytesTotal < length) {
        int bytesSent = sendto(socketHandle, (&buffer)[bytesTotal], length-bytesTotal, 0, NULL, 0);
        bytesTotal += bytesSent;
    }
    return bytesTotal;
}`,
    );

    const { candidates } = scanProject(tmp);
    const ptrArithHits = candidates.filter((c) => c.pattern_id === "cpp-001-ptr-address-index");
    expect(ptrArithHits.length).toBe(1);
    expect(ptrArithHits[0]!.file).toContain("EthernetDevice.cpp");
  });

  test("scanProject detects unreachable code after return", () => {
    writeFileSync(
      join(tmp, "peek.cpp"),
      `size_t peek() {
    int bytesRecvd = recv(fd, buf, n, 0);
    if (bytesRecvd > 0) {
        return static_cast<size_t>(bytesRecvd);
        lastPacketArrived = std::time(nullptr);
    }
    return 0;
}`,
    );

    const { candidates } = scanProject(tmp);
    const hits = candidates.filter((c) => c.pattern_id === "cpp-002-unreachable-after-return");
    expect(hits.length).toBe(1);
  });

  test("scanProject detects unchecked data[N] access", () => {
    writeFileSync(
      join(tmp, "UsbXBox.cpp"),
      `void decode(const std::vector<unsigned char>& data) {
    leftStickY.setState(data[3]);
    rightTrigger.setState(data[13]);
}`,
    );

    const { candidates } = scanProject(tmp);
    const hits = candidates.filter((c) => c.pattern_id === "cpp-003-unchecked-data-index");
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  test("scanProject detects unsafe string functions", () => {
    writeFileSync(
      join(tmp, "unsafe.cpp"),
      `void copy(char* dst, const char* src) {
    strcpy(dst, src);
    char buf[16];
    sprintf(buf, "%d", value);
}`,
    );

    const { candidates } = scanProject(tmp);
    const hits = candidates.filter((c) => c.pattern_id === "cpp-006-strcpy-family");
    expect(hits.length).toBe(2);
  });
});

describe("verifier", () => {
  test("parseVerdict extracts CONFIRMED verdict", () => {
    const response = `VERDICT: CONFIRMED
REASONING: The buffer is accessed without size check on line 35.
EXECUTION_PATH: HID packet parser receives 5-byte packet, accesses data[13] unconditionally
FIX: Add if (data.size() < 14) return; before the access
`;
    const v = parseVerdict(response);
    expect(v.verdict).toBe("confirmed");
    expect(v.reasoning).toContain("size check");
    expect(v.execution_path).toContain("HID packet");
    expect(v.suggested_fix).toContain("data.size()");
  });

  test("parseVerdict extracts FALSE_POSITIVE verdict", () => {
    const response = `VERDICT: FALSE_POSITIVE
REASONING: The caller validates size before invoking this function.
EXECUTION_PATH: NONE
FIX: NONE
`;
    const v = parseVerdict(response);
    expect(v.verdict).toBe("false_positive");
    expect(v.execution_path).toBeUndefined();
    expect(v.suggested_fix).toBeUndefined();
  });

  test("parseVerdict handles malformed responses gracefully", () => {
    const response = `I think this might be a bug but I'm not sure.`;
    const v = parseVerdict(response);
    expect(v.verdict).toBe("needs_context");
    expect(v.reasoning.length).toBeGreaterThan(0);
  });

  test("parseVerdict handles lowercase/mixed case verdicts", () => {
    const response = `verdict: confirmed
reasoning: yep, it's real`;
    const v = parseVerdict(response);
    expect(v.verdict).toBe("confirmed");
  });
});

describe("audit-engine orchestrator", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kcode-audit-engine-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("runAudit finds and processes candidates", async () => {
    writeFileSync(
      join(tmp, "buggy.cpp"),
      `void f() { strcpy(a, b); }\n`,
    );

    // Mock LLM that confirms everything
    const mockLLM = async (prompt: string): Promise<string> =>
      `VERDICT: CONFIRMED\nREASONING: Unsafe strcpy detected\nEXECUTION_PATH: any input\nFIX: use strncpy\n`;

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: mockLLM,
    });

    expect(result.files_scanned).toBeGreaterThanOrEqual(1);
    expect(result.candidates_found).toBeGreaterThanOrEqual(1);
    expect(result.confirmed_findings).toBeGreaterThanOrEqual(1);
    expect(result.findings[0]!.pattern_id).toBe("cpp-006-strcpy-family");
  });

  test("runAudit filters out false positives", async () => {
    writeFileSync(
      join(tmp, "maybe-buggy.cpp"),
      `void f() { strcpy(a, b); }\n`,
    );

    const mockLLM = async (): Promise<string> =>
      `VERDICT: FALSE_POSITIVE\nREASONING: Validated upstream\nEXECUTION_PATH: NONE\nFIX: NONE\n`;

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: mockLLM,
    });

    expect(result.candidates_found).toBe(1);
    expect(result.confirmed_findings).toBe(0);
    expect(result.false_positives).toBe(1);
    expect(result.findings.length).toBe(0);
  });

  test("runAudit with skipVerification returns all candidates", async () => {
    writeFileSync(join(tmp, "code.cpp"), `void f() { gets(buf); }\n`);

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => "",
      skipVerification: true,
    });

    expect(result.confirmed_findings).toBeGreaterThanOrEqual(1);
  });
});

describe("report-generator", () => {
  test("generateMarkdownReport produces well-formed output", () => {
    const result = {
      project: "/tmp/test",
      timestamp: "2026-04-05",
      languages_detected: ["cpp" as const],
      files_scanned: 10,
      candidates_found: 3,
      confirmed_findings: 2,
      false_positives: 1,
      elapsed_ms: 1500,
      findings: [
        {
          pattern_id: "cpp-001-ptr-address-index",
          pattern_title: "Suspicious pointer arithmetic",
          severity: "high" as const,
          file: "/tmp/test/EthernetDevice.cpp",
          line: 160,
          matched_text: "(&buffer)[bytesTotal]",
          context: "159: while (...)\n160:     (&buffer)[bytesTotal]\n161: }",
          verification: {
            verdict: "confirmed" as const,
            reasoning: "The address-of operator on a pointer parameter is indexed.",
            execution_path: "Partial send: bytesTotal > 0",
            suggested_fix: "Use (const char*)buffer + bytesTotal",
          },
          cwe: "CWE-125",
        },
      ],
    };

    const md = generateMarkdownReport(result);
    expect(md).toContain("Audit Report — test");
    expect(md).toContain("Astrolexis.space");
    expect(md).toContain("2026-04-05");
    expect(md).toContain("🟠");
    expect(md).toContain("EthernetDevice.cpp:160");
    expect(md).toContain("CWE-125");
    expect(md).toContain("(&buffer)[bytesTotal]");
    expect(md).toContain("Suggested fix:");
  });

  test("generateMarkdownReport handles zero findings", () => {
    const result = {
      project: "/tmp/clean",
      timestamp: "2026-04-05",
      languages_detected: ["cpp" as const],
      files_scanned: 5,
      candidates_found: 0,
      confirmed_findings: 0,
      false_positives: 0,
      elapsed_ms: 100,
      findings: [],
    };
    const md = generateMarkdownReport(result);
    expect(md).toContain("No confirmed findings");
  });
});
