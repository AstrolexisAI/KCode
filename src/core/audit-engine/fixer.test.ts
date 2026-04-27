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
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
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
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
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
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
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
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    const skipped = fixes.filter((f) => !f.applied);
    // v2.10.389 (P1.1) — site-level dedupe means data[2] and data[13]
    // are two distinct findings on different lines instead of one
    // collapsed pattern. Each one independently sees the upstream
    // size check and skips its own fix attempt.
    expect(skipped.length).toBe(2);
    for (const s of skipped) {
      expect(s.description).toContain("already exists");
    }
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
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
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
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
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

  test("dart-007 does NOT rewrite non-json as-casts (business logic safety)", async () => {
    // This file intentionally has:
    //   (a) a real json[...] as int cast that SHOULD be fixed
    //   (b) an unrelated `users.length as int` that MUST be left alone
    //   (c) a generic `result as String` that MUST be left alone
    writeFileSync(
      join(tmp, "mixed.dart"),
      `class Mixed {
  final int id;
  final int count;
  final String label;

  Mixed({required this.id, required this.count, required this.label});

  factory Mixed.fromJson(Map<String, dynamic> json) {
    final users = [1, 2, 3];
    final count = users.length as int;
    final result = someCall();
    return Mixed(
      id: json['id'] as int,
      count: count,
      label: result as String,
    );
  }
  static dynamic someCall() => 'hi';
}
`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    const transformed = fixes.filter((f) => f.kind === "transformed");

    const content = readFileSync(join(tmp, "mixed.dart"), "utf-8");
    // The json[...] cast should be fixed.
    expect(content).toContain("json['id'] as int? ?? 0");
    // The non-json casts MUST remain untouched — this is the whole
    // point of the hole-#1 fix. If the regex started matching them,
    // it would silently change the semantics of business logic.
    expect(content).toContain("users.length as int;");
    expect(content).toContain("result as String,");
    expect(content).not.toContain("users.length as int? ??");
    expect(content).not.toContain("result as String? ??");
    // Sanity: at least one real fix was applied.
    expect(transformed.length).toBeGreaterThanOrEqual(1);
  });

  test("dart-005 skips insertion when setState is not inside a State<T> subclass", async () => {
    // The setState call here is on a misleading helper that isn't
    // inside a State<T>, so `mounted` wouldn't be defined. The fixer
    // must skip rather than produce uncompilable code.
    writeFileSync(
      join(tmp, "helper.dart"),
      `class NotAState {
  void doWork() async {
    await Future.delayed(Duration(seconds: 1));
    setState(() => print('oops'));
  }
  void setState(void Function() fn) => fn();
}
`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    const dart005 = fixes.filter((f) => f.pattern_id === "dart-005-setstate-after-dispose");
    // If the pattern fires, the fixer must NOT apply it to this file —
    // NotAState doesn't extend State<T>. Either no finding or all
    // findings for this pattern are skipped.
    for (const f of dart005) {
      expect(f.kind).toBe("skipped");
    }

    // Confirm the file was not touched by this pattern.
    const content = readFileSync(join(tmp, "helper.dart"), "utf-8");
    expect(content).not.toContain("if (!mounted) return;");
  });

  test("dart-005 recognizes a mounted guard added earlier in the same block", async () => {
    // The await and setState are 6+ lines apart. A valid mounted guard
    // sits right after the await — the old 3-line lookback missed this
    // and would insert a DUPLICATE guard. The full-span check should
    // recognize it and skip the insertion.
    writeFileSync(
      join(tmp, "state.dart"),
      `import 'package:flutter/widgets.dart';

class MyScreen extends StatefulWidget {
  @override
  State<MyScreen> createState() => _MyScreenState();
}

class _MyScreenState extends State<MyScreen> {
  bool _loaded = false;

  Future<void> _load() async {
    final data = await fetchData();
    if (!mounted) return;
    // Four spacer lines between the guard and setState to defeat a
    // short-window lookback.
    // spacer
    // spacer
    // spacer
    setState(() {
      _loaded = true;
    });
  }

  Future<List<int>> fetchData() async => [];

  @override
  Widget build(BuildContext context) => const SizedBox();
}
`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    const dart005 = fixes.filter((f) => f.pattern_id === "dart-005-setstate-after-dispose");
    // Either the pattern doesn't fire at all (regex doesn't match
    // because a guard is already there and no setState "after" an
    // unchecked await remains), or the fixer sees the guard and skips.
    // Both are acceptable; what's NOT acceptable is a "transformed"
    // result that inserts a duplicate guard.
    for (const f of dart005) {
      expect(f.kind).not.toBe("transformed");
    }

    const content = readFileSync(join(tmp, "state.dart"), "utf-8");
    // Count occurrences of `if (!mounted) return;` — must be exactly 1.
    const guardCount = (content.match(/if \(!mounted\) return;/g) ?? []).length;
    expect(guardCount).toBe(1);
  });

  test("applyRecipe does not insert duplicate annotations across repeated /fix runs", async () => {
    // dart-001-insecure-http uses the generic recipe (advisory only,
    // no bespoke fixer), so repeated /fix runs go through applyRecipe
    // each time. The file starts with one `http://` URL. After the
    // first /fix the annotation should be present exactly once, and
    // a second /fix must NOT append another identical annotation.
    writeFileSync(
      join(tmp, "api.dart"),
      `import 'package:http/http.dart' as http;

Future<void> fetch() async {
  final r = await http.get(Uri.parse('http://api.example.com/data'));
  print(r.body);
}
`,
    );

    // First /fix run — adds one annotation.
    const r1 = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
      skipVerification: true,
    });
    applyFixes(r1);
    const afterFirst = readFileSync(join(tmp, "api.dart"), "utf-8");
    const firstCount = (afterFirst.match(/audit-note:dart-001-insecure-http/g) ?? []).length;
    expect(firstCount).toBe(1);

    // Second /fix run against the same (stale) audit result. The
    // annotation is already in the file; the guard must catch it.
    applyFixes(r1);
    const afterSecond = readFileSync(join(tmp, "api.dart"), "utf-8");
    const secondCount = (afterSecond.match(/audit-note:dart-001-insecure-http/g) ?? []).length;
    expect(secondCount).toBe(1);

    // Third run with a re-scan (scanner now reports the line AFTER
    // the annotation shifted everything down by 1). The guard must
    // still catch it because the window check looks ±3 lines.
    const r3 = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
      skipVerification: true,
    });
    applyFixes(r3);
    const afterThird = readFileSync(join(tmp, "api.dart"), "utf-8");
    const thirdCount = (afterThird.match(/audit-note:dart-001-insecure-http/g) ?? []).length;
    expect(thirdCount).toBe(1);
  });

  // FIX.B (v2.10.381) — applyRecipe's idempotency check now matches
  // ALL tag-prefix variants any prior /fix run could have inserted.
  // Without this, a file with `audit-fix:` (bespoke form) or
  // `KCODE-FIX:` (legacy bespoke) tags would NOT be detected by the
  // recipe path's `audit-note:` regex, and a re-run in --annotate
  // mode would duplicate annotations.
  test("applyRecipe idempotency recognizes audit-fix: tags from prior bespoke /fix runs", async () => {
    // Seed a file that already has a bespoke-form `audit-fix:dart-001-insecure-http`
    // marker. Even though the marker is the BESPOKE form (not the
    // recipe form), a re-run via applyRecipe must skip insertion.
    writeFileSync(
      join(tmp, "api.dart"),
      `import 'package:http/http.dart' as http;

Future<void> fetch() async {
  // audit-fix:dart-001-insecure-http — prior /fix bespoke run
  final r = await http.get(Uri.parse('http://api.example.com/data'));
  print(r.body);
}
`,
    );
    const r = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
      skipVerification: true,
    });
    applyFixes(r, { annotateOnly: true });
    const after = readFileSync(join(tmp, "api.dart"), "utf-8");
    // Pre-existing audit-fix marker stays; no NEW audit-note marker is inserted.
    const fixCount = (after.match(/audit-fix:dart-001-insecure-http/g) ?? []).length;
    const noteCount = (after.match(/audit-note:dart-001-insecure-http/g) ?? []).length;
    expect(fixCount).toBe(1);
    expect(noteCount).toBe(0);
  });

  test("applyRecipe idempotency recognizes legacy KCODE-FIX: tags", async () => {
    writeFileSync(
      join(tmp, "api.dart"),
      `import 'package:http/http.dart' as http;

Future<void> fetch() async {
  // KCODE-FIX:dart-001-insecure-http — legacy /fix run pre-v2.10.300
  final r = await http.get(Uri.parse('http://api.example.com/data'));
  print(r.body);
}
`,
    );
    const r = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
      skipVerification: true,
    });
    applyFixes(r, { annotateOnly: true });
    const after = readFileSync(join(tmp, "api.dart"), "utf-8");
    expect((after.match(/audit-note:dart-001-insecure-http/g) ?? []).length).toBe(0);
    expect((after.match(/KCODE-FIX:dart-001-insecure-http/g) ?? []).length).toBe(1);
  });

  test("applyRecipe idempotency recognizes short-form ids (audit-fix:fsw-005)", async () => {
    // Bespoke fixers use the short-form pattern id (e.g. `fsw-005`
    // from the full `fsw-005-buffer-getdata-unchecked`). The recipe
    // path's idempotency check must recognize the short form too.
    // Seed a file where a bespoke run left `audit-fix:fsw-005` and
    // verify a follow-up recipe run doesn't insert
    // `audit-note:fsw-005-buffer-getdata-unchecked` on top of it.
    writeFileSync(
      join(tmp, "Test.cpp"),
      `void f(Fw::Buffer& fwBuffer) {
  // audit-fix:fsw-005 — prior bespoke /fix run
  U8* p = fwBuffer.getData() + 4;
  (void)p;
}
`,
    );
    const r = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
      skipVerification: true,
    });
    applyFixes(r, { annotateOnly: true });
    const after = readFileSync(join(tmp, "Test.cpp"), "utf-8");
    // Short-form `audit-fix:fsw-005` blocks the full-id recipe insertion.
    expect(
      (after.match(/audit-note:fsw-005-buffer-getdata-unchecked/g) ?? []).length,
    ).toBe(0);
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
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
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
    // And an audit-note marker comment was inserted above it.
    expect(content).toContain("audit-note:dart-001-insecure-http");
  });
});

// v2.10.351 P0 — applyFixes must respect review_state.
describe("applyFixes — review_state filtering", () => {
  test("skips findings tagged review_state='ignored'", () => {
    // Build a minimal AuditResult by hand — easier than driving a full
    // runAudit + /review session. We only need applyFixes to see one
    // finding and decide whether to touch the file.
    const tmpFile = `/tmp/kcode-applyfixes-ignored-${Date.now()}.cpp`;
    writeFileSync(
      tmpFile,
      `void f(const void *buf) {
    size_t n = 0;
    int s = sendto(0, (&buf)[n], 0, 0, NULL, 0);
}\n`,
    );
    const fakeResult = {
      project: "/tmp",
      timestamp: "2026-04-25",
      languages_detected: ["cpp"],
      files_scanned: 1,
      candidates_found: 1,
      confirmed_findings: 1,
      false_positives: 0,
      findings: [
        {
          pattern_id: "cpp-001-ptr-address-index",
          pattern_title: "Suspicious pointer arithmetic",
          severity: "high",
          file: tmpFile,
          line: 3,
          matched_text: "(&buf)[n]",
          context: "context",
          verification: { verdict: "confirmed", reasoning: "test" },
          review_state: "ignored",
        },
      ],
      false_positives_detail: [],
      needs_context: 0,
      needs_context_detail: [],
      coverage: {
        totalCandidateFiles: 1,
        scannedFiles: 1,
        skippedByLimit: 0,
        truncated: false,
        maxFiles: 1,
        capSource: "user" as const,
      },
      elapsed_ms: 0,
    };
    const fixes = applyFixes(fakeResult as unknown as Parameters<typeof applyFixes>[0]);
    expect(fixes.length).toBe(0); // ignored finding must not be touched
    // File must be unchanged.
    const content = readFileSync(tmpFile, "utf-8");
    expect(content).toContain("(&buf)[n]");
    expect(content).not.toContain("audit-note");
    expect(content).not.toContain("(const char*)buf");
  });

  test("skips findings tagged review_state='demoted_fp' (defensive)", () => {
    const tmpFile = `/tmp/kcode-applyfixes-demoted-${Date.now()}.cpp`;
    writeFileSync(tmpFile, `void f(const void *buf) { (&buf)[0]; }\n`);
    const fakeResult = {
      project: "/tmp",
      timestamp: "2026-04-25",
      languages_detected: ["cpp"],
      files_scanned: 1,
      candidates_found: 1,
      confirmed_findings: 1,
      false_positives: 0,
      findings: [
        {
          pattern_id: "cpp-001-ptr-address-index",
          pattern_title: "Suspicious pointer arithmetic",
          severity: "high",
          file: tmpFile,
          line: 1,
          matched_text: "(&buf)[0]",
          context: "context",
          verification: { verdict: "confirmed", reasoning: "test" },
          review_state: "demoted_fp",
        },
      ],
      false_positives_detail: [],
      needs_context: 0,
      needs_context_detail: [],
      coverage: {
        totalCandidateFiles: 1,
        scannedFiles: 1,
        skippedByLimit: 0,
        truncated: false,
        maxFiles: 1,
        capSource: "user" as const,
      },
      elapsed_ms: 0,
    };
    const fixes = applyFixes(fakeResult as unknown as Parameters<typeof applyFixes>[0]);
    expect(fixes.length).toBe(0);
  });

  test("DOES fix findings tagged review_state='promoted' (regression for P0.5)", () => {
    const tmpFile = `/tmp/kcode-applyfixes-promoted-${Date.now()}.cpp`;
    writeFileSync(
      tmpFile,
      `void f(const void *buf) {
    size_t n = 0;
    int s = sendto(0, (&buf)[n], 0, 0, NULL, 0);
}\n`,
    );
    const fakeResult = {
      project: "/tmp",
      timestamp: "2026-04-25",
      languages_detected: ["cpp"],
      files_scanned: 1,
      candidates_found: 1,
      confirmed_findings: 1,
      false_positives: 0,
      findings: [
        {
          pattern_id: "cpp-001-ptr-address-index",
          pattern_title: "Suspicious pointer arithmetic",
          severity: "high",
          file: tmpFile,
          line: 3,
          matched_text: "(&buf)[n]",
          context: "context",
          verification: { verdict: "confirmed", reasoning: "test" },
          review_state: "promoted",
        },
      ],
      false_positives_detail: [],
      needs_context: 0,
      needs_context_detail: [],
      coverage: {
        totalCandidateFiles: 1,
        scannedFiles: 1,
        skippedByLimit: 0,
        truncated: false,
        maxFiles: 1,
        capSource: "user" as const,
      },
      elapsed_ms: 0,
    };
    const fixes = applyFixes(fakeResult as unknown as Parameters<typeof applyFixes>[0]);
    expect(fixes.length).toBe(1);
    expect(fixes[0]!.applied).toBe(true);
  });
});
