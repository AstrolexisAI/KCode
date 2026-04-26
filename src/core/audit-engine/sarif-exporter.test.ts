// SARIF exporter tests — schema-conformance + KCode→SARIF mapping.
//
// These tests pin the contract that enterprise consumers depend on
// (GitHub code scanning, Azure DevOps, SonarQube). A regression here
// breaks external pipelines silently, so we assert the exact fields
// consumers query rather than just a rough shape.

import { describe, expect, test } from "bun:test";
import {
  buildSarif,
  fingerprintFinding,
  relativize,
  scoreFromSeverity,
  severityToSarif,
} from "./sarif-exporter";
import type { AuditResult, Finding } from "./types";

// ─── Fixtures ────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    pattern_id: "py-001-eval-exec",
    pattern_title: "eval()/exec() with potentially untrusted input",
    severity: "critical",
    file: "/home/user/proj/src/handler.py",
    line: 42,
    matched_text: "eval(user_input)",
    context: "40: def run(user_input):\n41:   # returns result\n42:   return eval(user_input)",
    verification: {
      verdict: "confirmed",
      reasoning: "user_input reaches eval directly with no sanitization.",
      suggested_fix: "Use ast.literal_eval or a proper expression parser.",
    },
    cwe: "CWE-94",
    ...overrides,
  };
}

function makeAudit(findings: Finding[]): AuditResult {
  return {
    project: "/home/user/proj",
    timestamp: "2026-04-17T12:00:00Z",
    languages_detected: ["python"],
    files_scanned: 42,
    candidates_found: 10,
    confirmed_findings: findings.length,
    false_positives: 7,
    findings,
  } as AuditResult;
}

// ─── Helpers ─────────────────────────────────────────────────────

describe("severityToSarif", () => {
  test("critical and high both become error (blocks merge)", () => {
    expect(severityToSarif("critical")).toBe("error");
    expect(severityToSarif("high")).toBe("error");
  });

  test("medium is warning, low is note", () => {
    expect(severityToSarif("medium")).toBe("warning");
    expect(severityToSarif("low")).toBe("note");
  });
});

describe("scoreFromSeverity", () => {
  test("produces CVSS-ish numbers that preserve ordering", () => {
    const c = parseFloat(scoreFromSeverity("critical"));
    const h = parseFloat(scoreFromSeverity("high"));
    const m = parseFloat(scoreFromSeverity("medium"));
    const l = parseFloat(scoreFromSeverity("low"));
    expect(c).toBeGreaterThan(h);
    expect(h).toBeGreaterThan(m);
    expect(m).toBeGreaterThan(l);
    expect(c).toBeLessThanOrEqual(10);
    expect(l).toBeGreaterThanOrEqual(0);
  });
});

describe("fingerprintFinding", () => {
  test("is deterministic for identical findings", () => {
    const a = makeFinding();
    const b = makeFinding();
    expect(fingerprintFinding(a)).toBe(fingerprintFinding(b));
  });

  test("changes when pattern_id changes", () => {
    const a = makeFinding();
    const b = makeFinding({ pattern_id: "py-003-pickle-deserialize" });
    expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
  });

  test("changes when file changes", () => {
    const a = makeFinding();
    const b = makeFinding({ file: "/home/user/proj/src/other.py" });
    expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
  });

  test("changes when line number changes", () => {
    const a = makeFinding();
    const b = makeFinding({ line: 43 });
    expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
  });

  test("is 32 hex chars (truncated sha256)", () => {
    expect(fingerprintFinding(makeFinding())).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("relativize", () => {
  test("strips project root prefix", () => {
    expect(relativize("/home/user/proj/src/a.ts", "/home/user/proj")).toBe(
      "src/a.ts",
    );
  });

  test("handles trailing slash on project root", () => {
    expect(relativize("/home/user/proj/src/a.ts", "/home/user/proj/")).toBe(
      "src/a.ts",
    );
  });

  test("falls back to basename when file is outside project root", () => {
    expect(relativize("/tmp/somewhere/else.ts", "/home/user/proj")).toBe(
      "else.ts",
    );
  });

  test("normalizes Windows backslashes to forward slashes", () => {
    expect(
      relativize("C:\\Users\\u\\proj\\src\\a.ts", "C:\\Users\\u\\proj"),
    ).toBe("src/a.ts");
  });
});

// ─── Full SARIF document ─────────────────────────────────────────

describe("buildSarif — top-level structure", () => {
  const audit = makeAudit([makeFinding()]);
  const doc = buildSarif(audit, {
    toolVersion: "2.10.119",
    projectRoot: "/home/user/proj",
  }) as Record<string, unknown>;

  test("has the required $schema and version", () => {
    expect(doc.$schema).toContain("sarif-schema-2.1.0");
    expect(doc.version).toBe("2.1.0");
  });

  test("has exactly one run", () => {
    expect(Array.isArray(doc.runs)).toBe(true);
    expect((doc.runs as unknown[]).length).toBe(1);
  });

  test("declares KCode as the tool driver", () => {
    const run = (doc.runs as Array<Record<string, unknown>>)[0]!;
    const tool = run.tool as { driver?: Record<string, unknown> };
    expect(tool.driver).toBeDefined();
    expect(tool.driver!.name).toBe("KCode");
    expect(tool.driver!.version).toBe("2.10.119");
    expect(tool.driver!.informationUri).toContain("github.com");
  });

  test("embeds a rule for every pattern referenced by a finding", () => {
    const run = (doc.runs as Array<Record<string, unknown>>)[0]!;
    const driver = (run.tool as { driver: Record<string, unknown> }).driver;
    const rules = driver.rules as Array<Record<string, unknown>>;
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(rules.find((r) => r.id === "py-001-eval-exec")).toBeDefined();
  });

  test("deduplicates rules when multiple findings share a pattern", () => {
    const sharedAudit = makeAudit([
      makeFinding({ line: 10 }),
      makeFinding({ line: 20 }),
      makeFinding({ line: 30 }),
    ]);
    const shared = buildSarif(sharedAudit, {
      toolVersion: "2.10.119",
      projectRoot: "/home/user/proj",
    }) as Record<string, unknown>;
    const rules = (shared.runs as Array<{ tool: { driver: { rules: unknown[] } } }>)[0]!
      .tool.driver.rules;
    // 3 findings → same rule → should only appear once
    expect(rules.length).toBe(1);
  });
});

describe("buildSarif — results", () => {
  const audit = makeAudit([
    makeFinding({ line: 10 }),
    makeFinding({ line: 20, severity: "low", pattern_id: "py-018-re-no-raw-string" }),
  ]);
  const doc = buildSarif(audit, {
    toolVersion: "2.10.119",
    projectRoot: "/home/user/proj",
  }) as Record<string, unknown>;
  const results = (doc.runs as Array<{ results: Array<Record<string, unknown>> }>)[0]!
    .results;

  test("emits one result per finding", () => {
    expect(results.length).toBe(2);
  });

  test("each result references its rule by id", () => {
    expect(results[0]!.ruleId).toBe("py-001-eval-exec");
    expect(results[1]!.ruleId).toBe("py-018-re-no-raw-string");
  });

  test("severity maps correctly per result", () => {
    expect(results[0]!.level).toBe("error"); // critical → error
    expect(results[1]!.level).toBe("note"); // low → note
  });

  test("location uses a project-relative URI", () => {
    const loc = (results[0]!.locations as Array<{
      physicalLocation: { artifactLocation: { uri: string } };
    }>)[0]!;
    expect(loc.physicalLocation.artifactLocation.uri).toBe("src/handler.py");
  });

  test("includes partialFingerprints for GitHub dedup", () => {
    const fp = results[0]!.partialFingerprints as Record<string, string>;
    expect(fp.primaryLocationLineHash).toMatch(/^[0-9a-f]{32}$/);
  });

  test("message.text includes the verifier reasoning", () => {
    const msg = results[0]!.message as { text: string };
    expect(msg.text).toContain("user_input reaches eval");
  });
});

describe("buildSarif — empty audit", () => {
  test("still produces a valid SARIF doc with zero results", () => {
    const doc = buildSarif(makeAudit([]), {
      toolVersion: "2.10.119",
      projectRoot: "/home/user/proj",
    }) as Record<string, unknown>;
    const run = (doc.runs as Array<{ results: unknown[]; tool: { driver: { rules: unknown[] } } }>)[0]!;
    expect(run.results).toEqual([]);
    expect(run.tool.driver.rules).toEqual([]);
  });
});

// v2.10.351 P0 — review_state filtering at the SARIF boundary.
describe("buildSarif — review_state filtering (v2.10.351 P0)", () => {
  test("excludes findings tagged 'ignored'", () => {
    const audit = makeAudit([
      makeFinding({ pattern_id: "py-001-eval-exec", review_state: "ignored" }),
      makeFinding({
        pattern_id: "py-002-yaml-load",
        line: 60,
        matched_text: "yaml.load(s)",
      }),
    ]);
    const doc = buildSarif(audit, {
      toolVersion: "2.10.351",
      projectRoot: "/home/user/proj",
    }) as Record<string, unknown>;
    const run = (doc.runs as Array<{
      results: Array<{ ruleId: string }>;
      tool: { driver: { rules: Array<{ id: string }> } };
    }>)[0]!;
    expect(run.results.length).toBe(1);
    expect(run.results[0]!.ruleId).toBe("py-002-yaml-load");
    // The rule registry must also drop the ignored pattern's rule
    // entry — SARIF consumers won't list a pattern with no findings.
    expect(run.tool.driver.rules.find((r) => r.id === "py-001-eval-exec")).toBeUndefined();
  });

  test("excludes 'demoted_fp' as a defensive guard", () => {
    const audit = makeAudit([
      makeFinding({ pattern_id: "p1", review_state: "demoted_fp" }),
    ]);
    const doc = buildSarif(audit, {
      toolVersion: "2.10.351",
      projectRoot: "/home/user/proj",
    }) as Record<string, unknown>;
    const run = (doc.runs as Array<{ results: unknown[] }>)[0]!;
    expect(run.results).toEqual([]);
  });

  test("includes 'promoted' findings (regression for P0.5+P0.7)", () => {
    const audit = makeAudit([
      makeFinding({ pattern_id: "p1", review_state: "promoted" }),
    ]);
    const doc = buildSarif(audit, {
      toolVersion: "2.10.351",
      projectRoot: "/home/user/proj",
    }) as Record<string, unknown>;
    const run = (doc.runs as Array<{ results: Array<{ ruleId: string }> }>)[0]!;
    expect(run.results.length).toBe(1);
    expect(run.results[0]!.ruleId).toBe("p1");
  });
});
