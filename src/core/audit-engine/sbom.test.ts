// P2.4 slice 1 (v2.10.392+) — SBOM tests.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchesRange,
  parsePackageJson,
  scanDependencies,
  type AdvisoryRecord,
} from "./sbom";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "kcode-sbom-"));
});
afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// ─── Range matcher ────────────────────────────────────────────

describe("matchesRange", () => {
  test("simple < range", () => {
    expect(matchesRange("1.2.3", "<2.0.0")).toBe(true);
    expect(matchesRange("2.0.0", "<2.0.0")).toBe(false);
    expect(matchesRange("2.5.0", "<2.0.0")).toBe(false);
  });
  test("anded >= < range", () => {
    expect(matchesRange("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(matchesRange("0.9.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(matchesRange("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
  });
  test("|| disjunct", () => {
    expect(matchesRange("0.7.29", ">=0.7.29 <0.7.30 || >=0.8.0 <0.8.1")).toBe(true);
    expect(matchesRange("0.8.0", ">=0.7.29 <0.7.30 || >=0.8.0 <0.8.1")).toBe(true);
    expect(matchesRange("0.9.0", ">=0.7.29 <0.7.30 || >=0.8.0 <0.8.1")).toBe(false);
  });
  test("strips ^ ~ = v prefixes from input version", () => {
    expect(matchesRange("^1.2.3", "<2.0.0")).toBe(true);
    expect(matchesRange("~1.2.3", "<2.0.0")).toBe(true);
    expect(matchesRange("v1.2.3", "<2.0.0")).toBe(true);
  });
  test("major-only comparison", () => {
    expect(matchesRange("3.0.0", "<2.0.0")).toBe(false);
    expect(matchesRange("1.99.99", "<2.0.0")).toBe(true);
  });
});

// ─── Manifest parsing ─────────────────────────────────────────

describe("parsePackageJson", () => {
  test("returns [] for missing manifest", () => {
    expect(parsePackageJson("/nonexistent/package.json")).toEqual([]);
  });

  test("returns [] for malformed JSON", () => {
    const path = join(TMP, "package.json");
    writeFileSync(path, "{ broken json");
    expect(parsePackageJson(path)).toEqual([]);
  });

  test("extracts deps + devDeps + peerDeps", () => {
    const path = join(TMP, "package.json");
    writeFileSync(path, JSON.stringify({
      name: "demo",
      dependencies: { "lodash": "^4.17.21", "react": "18.0.0" },
      devDependencies: { "vitest": "^1.0.0" },
      peerDependencies: { "react-dom": "^18.0.0" },
    }));
    const deps = parsePackageJson(path);
    expect(deps.length).toBe(4);
    expect(deps.find((d) => d.name === "lodash")?.source).toBe("dependencies");
    expect(deps.find((d) => d.name === "vitest")?.source).toBe("devDependencies");
    expect(deps.find((d) => d.name === "react-dom")?.source).toBe("peerDependencies");
    for (const d of deps) {
      expect(d.ecosystem).toBe("npm");
      expect(d.manifest).toBe(path);
    }
  });

  test("ignores non-string deps (yarn workspace style)", () => {
    const path = join(TMP, "package.json");
    writeFileSync(path, JSON.stringify({
      dependencies: { "valid-pkg": "1.0.0", "weird": { not: "string" } },
    }));
    const deps = parsePackageJson(path);
    expect(deps.length).toBe(1);
    expect(deps[0]?.name).toBe("valid-pkg");
  });
});

// ─── Full scan ────────────────────────────────────────────────

describe("scanDependencies", () => {
  test("flags event-stream@3.3.6 (the original incident)", () => {
    writeFileSync(join(TMP, "package.json"), JSON.stringify({
      dependencies: { "event-stream": "3.3.6" },
    }));
    const findings = scanDependencies(TMP);
    expect(findings.length).toBe(1);
    expect(findings[0]?.package).toBe("event-stream");
    expect(findings[0]?.severity).toBe("critical");
    expect(findings[0]?.pattern_id).toBe("sbom-GHSA-mh6f-8j2x-4483");
  });

  test("flags ua-parser-js across multiple disjuncts", () => {
    writeFileSync(join(TMP, "package.json"), JSON.stringify({
      dependencies: { "ua-parser-js": "0.7.29" },
    }));
    const findings = scanDependencies(TMP);
    expect(findings.length).toBe(1);
  });

  test("does NOT flag a clean version of a vulnerable package", () => {
    writeFileSync(join(TMP, "package.json"), JSON.stringify({
      dependencies: { "ua-parser-js": "1.0.40" },
    }));
    const findings = scanDependencies(TMP);
    expect(findings.length).toBe(0);
  });

  test("does NOT flag packages outside the advisory list", () => {
    writeFileSync(join(TMP, "package.json"), JSON.stringify({
      dependencies: { "lodash": "4.17.21", "react": "18.2.0" },
    }));
    const findings = scanDependencies(TMP);
    expect(findings.length).toBe(0);
  });

  test("walks subdirectories (monorepo with multiple package.json)", () => {
    mkdirSync(join(TMP, "packages", "a"), { recursive: true });
    mkdirSync(join(TMP, "packages", "b"), { recursive: true });
    writeFileSync(join(TMP, "packages", "a", "package.json"), JSON.stringify({
      dependencies: { "event-stream": "3.3.6" },
    }));
    writeFileSync(join(TMP, "packages", "b", "package.json"), JSON.stringify({
      dependencies: { "rc": "1.2.9" },
    }));
    const findings = scanDependencies(TMP);
    expect(findings.length).toBe(2);
    const pkgs = findings.map((f) => f.package).sort();
    expect(pkgs).toEqual(["event-stream", "rc"]);
  });

  test("skips node_modules even if a package.json inside is vulnerable", () => {
    mkdirSync(join(TMP, "node_modules", "anything"), { recursive: true });
    writeFileSync(join(TMP, "node_modules", "anything", "package.json"), JSON.stringify({
      dependencies: { "event-stream": "3.3.6" },
    }));
    const findings = scanDependencies(TMP);
    expect(findings.length).toBe(0);
  });

  test("supports custom advisories injection (for tests / live DB swap)", () => {
    writeFileSync(join(TMP, "package.json"), JSON.stringify({
      dependencies: { "test-pkg": "1.0.0" },
    }));
    const advisories: AdvisoryRecord[] = [
      {
        id: "TEST-001",
        ecosystem: "npm",
        package: "test-pkg",
        affected: ">=1.0.0 <2.0.0",
        severity: "high",
        summary: "test",
      },
    ];
    const findings = scanDependencies(TMP, { advisories });
    expect(findings.length).toBe(1);
    expect(findings[0]?.pattern_id).toBe("sbom-TEST-001");
  });
});
