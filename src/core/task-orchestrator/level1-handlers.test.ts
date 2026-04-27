// Tests for tryLevel1 regex boundaries.
//
// tryLevel1 intercepts user prompts before they reach the LLM for a
// handful of deterministic commands (build, test, lint, status, start
// server, stop server, find). The regexes used to match those verbs
// have a long history of being too permissive — "Run git status" used
// to match the server-start verb and actually spawn a dev server. This
// file locks down the exact boundaries so we don't regress.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDevServer, tryLevel1 } from "./level1-handlers";

describe("tryLevel1 — start-verb boundaries", () => {
  let cwd: string;

  beforeEach(() => {
    // Empty temp dir → detectDevServer returns null → start verbs fall
    // through to "No dev server project detected" rather than actually
    // forking a real server process during tests.
    cwd = mkdtempSync(join(tmpdir(), "kcode-level1-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  // ── Should be handled (valid start commands) ──────────────────

  test.each([
    ["run"],
    ["run it"],
    ["start"],
    ["launch"],
    ["levantalo"],
    ["run the app"],
    ["start the server"],
    ["launch the project"],
    ["start it on port 3000"],
    ["levantalo en el puerto 8080"],
  ])("consumes %p as a start-server intent", (prompt) => {
    const r = tryLevel1(prompt, cwd);
    expect(r.handled).toBe(true);
  });

  // ── Should NOT be handled (unrelated prompts that happen to start
  //    with a start-verb word) ─────────────────────────────────────

  test.each([
    ["run git status"],
    ["run the linter"],
    ["run a quick audit"],
    ["start a new project"],
    ["launch a rocket"],
    ["start writing the README"],
    ["run the test suite"],
  ])("does NOT intercept %p", (prompt) => {
    const r = tryLevel1(prompt, cwd);
    expect(r.handled).toBe(false);
  });
});

describe("tryLevel1 — other verb anchors (regression guards)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kcode-level1-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("bare 'test' is intercepted (test runner handler)", () => {
    const r = tryLevel1("test", cwd);
    expect(r.handled).toBe(true);
  });

  test("'test the database' is NOT intercepted", () => {
    const r = tryLevel1("test the database", cwd);
    expect(r.handled).toBe(false);
  });

  test("'build' is intercepted (build handler)", () => {
    const r = tryLevel1("build", cwd);
    expect(r.handled).toBe(true);
  });

  test("'build a form component' is NOT intercepted", () => {
    const r = tryLevel1("build a form component", cwd);
    expect(r.handled).toBe(false);
  });

  test("'git status' is intercepted (status handler)", () => {
    const r = tryLevel1("git status", cwd);
    expect(r.handled).toBe(true);
  });

  test("'git status for the branch' is NOT intercepted", () => {
    const r = tryLevel1("git status for the branch", cwd);
    expect(r.handled).toBe(false);
  });
});

// ─── Phase 22 Bug #6 regression — single-HTML detection ─────────

describe("detectDevServer — static HTML files", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kcode-detect-html-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("detects orbital.html (single non-index .html at cwd root) — Bug #6 regression", () => {
    // Pre-fix: cwd with orbital.html but no index.html and no
    // package.json hit the early-return subdirectory-scan block
    // and returned null without reaching the static-HTML branch.
    const content =
      "<!DOCTYPE html><html><head><title>Orbital</title></head><body>" +
      "x".repeat(600) +
      "</body></html>";
    writeFileSync(join(cwd, "orbital.html"), content);
    const srv = detectDevServer(cwd);
    expect(srv).not.toBeNull();
    expect(srv!.name).toBe("Static");
    expect(srv!.htmlFile).toBe("orbital.html");
  });

  test("detects index.html at cwd root (existing behavior)", () => {
    const content = "<!DOCTYPE html><html><body>" + "x".repeat(600) + "</body></html>";
    writeFileSync(join(cwd, "index.html"), content);
    const srv = detectDevServer(cwd);
    expect(srv).not.toBeNull();
    expect(srv!.htmlFile).toBe("index.html");
  });

  test("returns null when cwd has multiple .html files (ambiguous)", () => {
    // Multiple HTML files without a clear entry point should be
    // ambiguous — we don't want to pick one at random.
    const content = "<!DOCTYPE html><html><body>" + "x".repeat(600) + "</body></html>";
    writeFileSync(join(cwd, "foo.html"), content);
    writeFileSync(join(cwd, "bar.html"), content);
    const srv = detectDevServer(cwd);
    expect(srv).toBeNull();
  });

  test("returns null when orbital.html is too small (< 500 bytes)", () => {
    writeFileSync(join(cwd, "orbital.html"), "<!DOCTYPE html>placeholder");
    expect(detectDevServer(cwd)).toBeNull();
  });

  test("returns null on empty cwd", () => {
    expect(detectDevServer(cwd)).toBeNull();
  });

  test("honors requestedPort argument", () => {
    const content = "<!DOCTYPE html><html><body>" + "x".repeat(600) + "</body></html>";
    writeFileSync(join(cwd, "orbital.html"), content);
    const srv = detectDevServer(cwd, 24564);
    expect(srv).not.toBeNull();
    expect(srv!.port).toBe(24564);
  });
});
