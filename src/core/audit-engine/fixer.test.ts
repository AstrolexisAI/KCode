import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "./audit-engine";
import { applyFixes, hasFixRecipe } from "./fixer";
import { getAllPatterns } from "./patterns";

describe("fixer", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kcode-fixer-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("fixes (&buffer)[N] pointer arithmetic", async () => {
    writeFileSync(
      join(tmp, "net.cpp"),
      `void write(const void *buffer, size_t length) {
    size_t bytesTotal = 0;
    while (bytesTotal < length) {
        int s = sendto(sock, (&buffer)[bytesTotal], length-bytesTotal, 0, NULL, 0);
        bytesTotal += s;
    }
}\n`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => "VERDICT: CONFIRMED\n",
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    const applied = fixes.filter((f) => f.applied);
    expect(applied.length).toBe(1);

    const content = readFileSync(join(tmp, "net.cpp"), "utf-8");
    expect(content).toContain("((const char*)buffer + bytesTotal)");
    expect(content).not.toContain("(&buffer)");
  });

  test("fixes unreachable code after return", async () => {
    writeFileSync(
      join(tmp, "peek.cpp"),
      `size_t peek() {
    int n = recv(fd, buf, sz, 0);
    if (n > 0) {
        return static_cast<size_t>(n);
        lastPacket = time(nullptr);
    }
    return 0;
}\n`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => "VERDICT: CONFIRMED\n",
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    const applied = fixes.filter((f) => f.applied);
    expect(applied.length).toBe(1);

    const content = readFileSync(join(tmp, "peek.cpp"), "utf-8");
    const lines = content.split("\n");
    // lastPacket should now be BEFORE the return
    const lastPacketIdx = lines.findIndex((l) => l.includes("lastPacket"));
    const returnIdx = lines.findIndex((l) => l.includes("return static_cast"));
    expect(lastPacketIdx).toBeLessThan(returnIdx);
  });

  test("adds size validation to decode() function", async () => {
    writeFileSync(
      join(tmp, "UsbXBox.cpp"),
      `void UsbXBox::decode(const std::vector<unsigned char>& data) {
    up.setValue(data[2] & 1);
    down.setValue(data[2] >> 1 & 1);
    trigger.setValue(data[13]);
}\n`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => "VERDICT: CONFIRMED\n",
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    const applied = fixes.filter((f) => f.applied);
    expect(applied.length).toBe(1);

    const content = readFileSync(join(tmp, "UsbXBox.cpp"), "utf-8");
    expect(content).toContain("if (data.size() <= 13)");
    expect(content).toContain("return;");
  });

  test("doesn't double-fix if size check already exists", async () => {
    writeFileSync(
      join(tmp, "safe.cpp"),
      `void safe::decode(const std::vector<unsigned char>& data) {
    if (data.size() <= 13) { return; }
    up.setValue(data[2] & 1);
    trigger.setValue(data[13]);
}\n`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => "VERDICT: CONFIRMED\n",
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    const skipped = fixes.filter((f) => !f.applied);
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.description).toContain("already exists");
  });

  // Coverage gate: any pattern registered in patterns.ts must have a
  // corresponding fix recipe (bespoke or in PATTERN_RECIPES). This test
  // fails loudly when a new pattern is added without a fix, preventing
  // `/fix` from regressing to "no auto-fix for pattern: ..." messages.
  test("every registered pattern has a fix recipe", () => {
    const missing: string[] = [];
    for (const p of getAllPatterns()) {
      if (!hasFixRecipe(p.id)) missing.push(p.id);
    }
    expect(missing).toEqual([]);
  });

  test("dart-007-json-null-check rewrites non-nullable casts to nullable+default", async () => {
    writeFileSync(
      join(tmp, "plant.dart"),
      `class Plant {
  final int id;
  final String name;
  final double capacity;

  Plant({required this.id, required this.name, required this.capacity});

  factory Plant.fromJson(Map<String, dynamic> json) {
    return Plant(
      id: json['id'] as int,
      name: json['name'] as String,
      capacity: json['capacity'] as double,
    );
  }
}
`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => "VERDICT: CONFIRMED\n",
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    const transformed = fixes.filter((f) => f.kind === "transformed");
    expect(transformed.length).toBeGreaterThanOrEqual(1);

    const content = readFileSync(join(tmp, "plant.dart"), "utf-8");
    expect(content).toContain("as int? ?? 0");
    expect(content).toContain("as String? ?? ''");
    expect(content).toContain("as double? ?? 0.0");
    // No raw non-nullable casts left.
    expect(content).not.toMatch(/as\s+int\b(?!\?)/);
    expect(content).not.toMatch(/as\s+String\b(?!\?)/);
    expect(content).not.toMatch(/as\s+double\b(?!\?)/);
  });

  test("dart-007 is idempotent — rerunning /fix does not double-wrap", async () => {
    writeFileSync(
      join(tmp, "safe.dart"),
      `class Safe {
  factory Safe.fromJson(Map<String, dynamic> json) {
    return Safe(id: json['id'] as int? ?? 0, name: json['name'] as String? ?? '');
  }
  Safe({required this.id, required this.name});
  final int id;
  final String name;
}
`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => "VERDICT: CONFIRMED\n",
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    // Either the pattern doesn't match (no unsafe cast) or the fixer skips
    // the already-safe line. Either way, zero transformed changes.
    const transformed = fixes.filter((f) => f.kind === "transformed");
    expect(transformed.length).toBe(0);

    const content = readFileSync(join(tmp, "safe.dart"), "utf-8");
    // Verify the file is still well-formed — no `as int? ?? 0? ?? 0`.
    expect(content).not.toMatch(/\?\s*\?\?\s*\w+\?\s*\?\?/);
  });

  test("generic recipes are reported as 'annotated', not 'transformed'", async () => {
    // Pick a pattern that uses the generic recipe fallback (no bespoke
    // fixer). dart-001-insecure-http is a simple regex pattern with only
    // an advisory recipe — ideal for this test.
    writeFileSync(
      join(tmp, "api.dart"),
      `import 'package:http/http.dart' as http;

Future<void> fetch() async {
  final r = await http.get(Uri.parse('http://api.example.com/data'));
  print(r.body);
}
`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => "VERDICT: CONFIRMED\n",
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    // At least one finding should be annotated (recipe-only). None of
    // these recipe-based findings should be reported as 'transformed'.
    const annotated = fixes.filter((f) => f.kind === "annotated");
    expect(annotated.length).toBeGreaterThanOrEqual(1);
    // The key property: buggy code is UNCHANGED. The `http://` URL must
    // still be in the file — an annotation did not rewrite it.
    const content = readFileSync(join(tmp, "api.dart"), "utf-8");
    expect(content).toContain("http://api.example.com/data");
    // And a KCODE-AUDIT marker comment was inserted above it.
    expect(content).toContain("KCODE-AUDIT:dart-001-insecure-http");
  });
});
