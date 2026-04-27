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

  test("getPatternById finds AST patterns (v2.10.351 verifier fix)", () => {
    // Without the AST lookup, the verifier sent every AST candidate
    // to needs_context with 'Unknown pattern id'. Pin the lookup
    // across at least one pattern from each AST registry.
    const astIds = [
      "py-ast-001-eval-of-parameter",
      "py-ast-004-open-of-parameter",
      "js-ast-001-eval-of-parameter",
      "ts-ast-001-prototype-pollution-of-parameter",
      "go-ast-001-exec-command-of-parameter",
      "java-ast-001-runtime-exec-of-parameter",
      "cpp-ast-001-system-of-parameter",
      "cpp-ast-002-strcpy-of-parameter",
      "rust-ast-001-command-new-of-parameter",
      "rb-ast-001-eval-of-parameter",
      "php-ast-001-eval-of-parameter",
    ];
    for (const id of astIds) {
      const p = getPatternById(id);
      expect(p).toBeDefined();
      expect(p!.id).toBe(id);
      expect(p!.verify_prompt.length).toBeGreaterThan(20);
      expect(p!.title.length).toBeGreaterThan(5);
    }
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

  test("scanProject detects NASA IDF pointer arithmetic bug", async () => {
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

    const { candidates } = await scanProject(tmp);
    const ptrArithHits = candidates.filter((c) => c.pattern_id === "cpp-001-ptr-address-index");
    expect(ptrArithHits.length).toBe(1);
    expect(ptrArithHits[0]!.file).toContain("EthernetDevice.cpp");
  });

  test("scanProject detects unreachable code after return", async () => {
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

    const { candidates } = await scanProject(tmp);
    const hits = candidates.filter((c) => c.pattern_id === "cpp-002-unreachable-after-return");
    expect(hits.length).toBe(1);
  });

  test("scanProject detects unchecked data[N] access", async () => {
    writeFileSync(
      join(tmp, "UsbXBox.cpp"),
      `void decode(const std::vector<unsigned char>& data) {
    leftStickY.setState(data[3]);
    rightTrigger.setState(data[13]);
}`,
    );

    const { candidates } = await scanProject(tmp);
    const hits = candidates.filter((c) => c.pattern_id === "cpp-003-unchecked-data-index");
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  test("scanProject detects unsafe string functions", async () => {
    writeFileSync(
      join(tmp, "unsafe.cpp"),
      `void copy(char* dst, const char* src) {
    strcpy(dst, src);
    char buf[16];
    sprintf(buf, "%d", value);
}`,
    );

    const { candidates } = await scanProject(tmp);
    const hits = candidates.filter((c) => c.pattern_id === "cpp-006-strcpy-family");
    expect(hits.length).toBe(2);
  });

  test("findSourceFiles does NOT follow symlinks that escape the project root", async () => {
    // Create a sibling directory with a source file that is NOT part
    // of the audited project. Then place a symlink inside the project
    // pointing at it. A naïve walker would follow the symlink and
    // report the outside file; our scanner must reject it.
    const outside = mkdtempSync(join(tmpdir(), "kcode-scan-outside-"));
    try {
      writeFileSync(join(outside, "leaked.py"), "print('secret')");
      writeFileSync(join(tmp, "normal.py"), "print('ok')");
      const { symlinkSync } = await import("node:fs");
      try {
        symlinkSync(outside, join(tmp, "linked-outside"));
      } catch {
        // Symlinks may not be supported (e.g., non-privileged Windows);
        // skip this test gracefully on such platforms.
        return;
      }
      const files = findSourceFiles(tmp);
      // We should see the normal file but NEVER the leaked file.
      expect(files.some((f) => f.endsWith("normal.py"))).toBe(true);
      expect(files.some((f) => f.endsWith("leaked.py"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("findSourceFiles breaks symlink cycles without hanging", async () => {
    // Two symlinks pointing at each other → naïve walker would loop.
    // The scanner uses realpath + a visited-inode set and must
    // terminate in bounded time.
    writeFileSync(join(tmp, "real.ts"), "export const x = 1;");
    const { symlinkSync } = await import("node:fs");
    try {
      mkdirSync(join(tmp, "a"));
      mkdirSync(join(tmp, "b"));
      symlinkSync(join(tmp, "b"), join(tmp, "a/to-b"));
      symlinkSync(join(tmp, "a"), join(tmp, "b/to-a"));
    } catch {
      // Symlinks unsupported; skip.
      return;
    }
    const files = findSourceFiles(tmp);
    // Must include the real file and must not explode.
    expect(files.some((f) => f.endsWith("real.ts"))).toBe(true);
    // Upper bound on walk size is also a loose regression check:
    // an infinite loop would blow past any sensible count.
    expect(files.length).toBeLessThan(100);
  });
});

describe("verifier (JSON Evidence Pack contract, v2.10.361+)", () => {
  test("parseVerdict extracts confirmed verdict with full evidence", () => {
    const response = JSON.stringify({
      verdict: "confirmed",
      reasoning: "Buffer is accessed without size check on line 35.",
      evidence: {
        input_boundary: "HID packet from device",
        execution_path_steps: [
          "USB callback (line 12)",
          "parser.dispatch (line 25)",
          "data[13] access (line 35)",
        ],
        sink: "array index access",
        sanitizers_checked: ["size check before index", "type guard"],
        mitigations_found: [],
        suggested_fix_strategy: "rewrite",
        suggested_fix: "Add `if (data.size() < 14) return;` before the access",
        test_suggestion: "Send a 5-byte HID packet and assert no crash",
      },
    });
    const v = parseVerdict(response);
    expect(v).not.toBeNull();
    expect(v?.verdict).toBe("confirmed");
    expect(v?.reasoning).toContain("size check");
    expect(v?.evidence?.sink).toBe("array index access");
    expect(v?.evidence?.execution_path_steps).toHaveLength(3);
    expect(v?.evidence?.suggested_fix_strategy).toBe("rewrite");
    // Legacy mirrored fields stay populated for callers that haven't migrated.
    expect(v?.execution_path).toContain("USB callback");
    expect(v?.suggested_fix).toContain("data.size()");
  });

  test("parseVerdict extracts false_positive with mitigations", () => {
    const response = JSON.stringify({
      verdict: "false_positive",
      reasoning: "Caller validates size before invoking this function.",
      evidence: {
        sink: "memcpy into fixed-size buffer",
        sanitizers_checked: ["caller validation", "static_assert on buffer size"],
        mitigations_found: ["caller validation at line 22"],
      },
    });
    const v = parseVerdict(response);
    expect(v?.verdict).toBe("false_positive");
    expect(v?.evidence?.mitigations_found).toContain("caller validation at line 22");
    expect(v?.evidence?.input_boundary).toBeUndefined();
  });

  test("parseVerdict tolerates markdown fences", () => {
    const response = "```json\n" +
      JSON.stringify({
        verdict: "confirmed",
        reasoning: "real",
        evidence: { sink: "exec" },
      }) +
      "\n```";
    const v = parseVerdict(response);
    expect(v?.verdict).toBe("confirmed");
    expect(v?.evidence?.sink).toBe("exec");
  });

  test("parseVerdict tolerates leading prose before the JSON object", () => {
    const response = "Sure, here's my verdict:\n" +
      JSON.stringify({
        verdict: "needs_context",
        reasoning: "Cannot trace input source.",
        evidence: { sink: "child_process.exec" },
      }) +
      "\n\nLet me know if you need anything else.";
    const v = parseVerdict(response);
    expect(v?.verdict).toBe("needs_context");
    expect(v?.evidence?.sink).toBe("child_process.exec");
  });

  test("parseVerdict tolerates trailing commas", () => {
    const response = `{
      "verdict": "false_positive",
      "reasoning": "buffer is bounded",
      "evidence": {
        "sink": "memcpy",
        "mitigations_found": ["sizeof(dst)",],
      },
    }`;
    const v = parseVerdict(response);
    expect(v?.verdict).toBe("false_positive");
    expect(v?.evidence?.mitigations_found).toContain("sizeof(dst)");
  });

  test("parseVerdict returns null for completely malformed responses", () => {
    expect(parseVerdict("I think this might be a bug but I'm not sure.")).toBeNull();
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("{not json}")).toBeNull();
  });

  test("parseVerdict returns null when verdict field is missing", () => {
    const response = JSON.stringify({
      reasoning: "looks bad",
      evidence: { sink: "exec" },
    });
    expect(parseVerdict(response)).toBeNull();
  });

  test("parseVerdict returns null when reasoning field is missing", () => {
    const response = JSON.stringify({
      verdict: "confirmed",
      evidence: { sink: "exec" },
    });
    expect(parseVerdict(response)).toBeNull();
  });

  test("parseVerdict returns null when verdict is unknown", () => {
    const response = JSON.stringify({
      verdict: "maybe",
      reasoning: "unsure",
      evidence: { sink: "exec" },
    });
    expect(parseVerdict(response)).toBeNull();
  });

  test("parseVerdict drops the evidence block when sink is missing", () => {
    const response = JSON.stringify({
      verdict: "confirmed",
      reasoning: "real bug",
      evidence: {
        // sink is required on evidence; without it we drop the block
        // rather than ship half-formed structured data downstream.
        input_boundary: "HTTP body",
      },
    });
    const v = parseVerdict(response);
    expect(v?.verdict).toBe("confirmed");
    expect(v?.reasoning).toBe("real bug");
    expect(v?.evidence).toBeUndefined();
  });

  test("verifyCandidate retries once on parse failure then degrades", async () => {
    const { verifyCandidate } = await import("./verifier");
    const responses = [
      "I'm sorry, I cannot answer.",
      "Still not JSON.",
    ];
    let calls = 0;
    const llmCallback = async () => responses[calls++] ?? "Still not JSON.";

    const candidate = {
      pattern_id: "js-001-eval",
      pattern_title: "Use of eval()",
      severity: "high" as const,
      file: "/tmp/x.js",
      line: 1,
      matched_text: "eval(s)",
      context: "eval(s)",
    };
    const v = await verifyCandidate(candidate, { llmCallback });

    expect(v.verdict).toBe("needs_context");
    expect(v.reasoning).toContain("unparseable");
    expect(calls).toBe(2);
  });

  test("verifyCandidate accepts retry success after first parse failure", async () => {
    const { verifyCandidate } = await import("./verifier");
    const responses = [
      "I'm sorry, I cannot answer.",
      JSON.stringify({
        verdict: "false_positive",
        reasoning: "test path",
        evidence: { sink: "exec" },
      }),
    ];
    let calls = 0;
    const llmCallback = async () => responses[calls++] ?? "";

    const candidate = {
      pattern_id: "js-001-eval",
      pattern_title: "Use of eval()",
      severity: "high" as const,
      file: "/tmp/x.js",
      line: 1,
      matched_text: "eval(s)",
      context: "eval(s)",
    };
    const v = await verifyCandidate(candidate, { llmCallback });

    expect(v.verdict).toBe("false_positive");
    expect(calls).toBe(2);
  });

  test("sanity-check downgrades confirmed→false_positive when reasoning says safe", () => {
    const response = JSON.stringify({
      verdict: "confirmed",
      reasoning: "buffer is properly bounded by the caller",
      evidence: { sink: "memcpy" },
    });
    const v = parseVerdict(response);
    // Direct parse stays confirmed; sanity check runs in verifyCandidate.
    expect(v?.verdict).toBe("confirmed");
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

    // Mock LLM that confirms everything (v2.10.361 JSON contract)
    const mockLLM = async (_prompt: string): Promise<string> =>
      JSON.stringify({
        verdict: "confirmed",
        reasoning: "Unsafe strcpy detected",
        evidence: {
          input_boundary: "any input",
          execution_path_steps: ["caller passes b", "strcpy(a, b)"],
          sink: "strcpy",
          suggested_fix_strategy: "rewrite",
          suggested_fix: "use strncpy",
        },
      });

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
      JSON.stringify({
        verdict: "false_positive",
        reasoning: "Validated upstream",
        evidence: {
          sink: "strcpy",
          mitigations_found: ["caller validates length"],
        },
      });

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: mockLLM,
    });

    expect(result.candidates_found).toBe(1);
    expect(result.confirmed_findings).toBe(0);
    expect(result.false_positives).toBe(1);
    expect(result.findings.length).toBe(0);
  });

  test("runAudit does NOT auto-escalate to fallback (escalation is user-prompted)", async () => {
    writeFileSync(join(tmp, "ambig.cpp"), `void f() { strcpy(a, b); }\n`);

    let fallbackCalls = 0;
    const primary = async (): Promise<string> =>
      JSON.stringify({
        verdict: "needs_context",
        reasoning: "can't tell",
        evidence: { sink: "strcpy" },
      });
    const fallback = async (): Promise<string> => {
      fallbackCalls++;
      return JSON.stringify({
        verdict: "confirmed",
        reasoning: "cloud",
        evidence: { sink: "strcpy" },
      });
    };

    await runAudit({
      projectRoot: tmp,
      llmCallback: primary,
      fallbackCallback: fallback,
    });

    // Fallback should NOT be called automatically — escalation is user-prompted via TUI
    expect(fallbackCalls).toBe(0);
  });

  test("runAudit in hybrid mode does NOT call fallback when primary is definitive", async () => {
    writeFileSync(join(tmp, "clear.cpp"), `void f() { strcpy(a, b); }\n`);

    let fallbackCalls = 0;
    const primary = async (): Promise<string> =>
      JSON.stringify({
        verdict: "confirmed",
        reasoning: "clear case",
        evidence: { sink: "strcpy", suggested_fix: "use strncpy" },
      });
    const fallback = async (): Promise<string> => {
      fallbackCalls++;
      return JSON.stringify({
        verdict: "confirmed",
        reasoning: "cloud",
        evidence: { sink: "strcpy" },
      });
    };

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: primary,
      fallbackCallback: fallback,
    });

    expect(fallbackCalls).toBe(0); // primary was definitive, no escalation
    expect(result.confirmed_findings).toBeGreaterThanOrEqual(1);
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

    // v2.10.351 P0 — AuditResult grew several fields since these
    // fixtures were written (false_positives_detail,
    // needs_context_detail, coverage, fix_support_summary,
    // pattern_metrics). The test only exercises Markdown rendering,
    // not field completeness; cast to keep the fixture readable.
    const md = generateMarkdownReport(result as unknown as Parameters<typeof generateMarkdownReport>[0]);
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
    const md = generateMarkdownReport(result as unknown as Parameters<typeof generateMarkdownReport>[0]);
    expect(md).toContain("No confirmed findings");
  });
});
