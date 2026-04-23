import { describe, expect, test } from "bun:test";
import { extractBashFileMutations } from "./audit-guards";

// Regression coverage for issue #102: `sed -i` (and related in-place
// mutation commands) were bypassing the audit-mode Edit guard because
// audit-guards.ts only looked at shell redirections.
describe("extractBashFileMutations — #102 sed/perl/awk bypass", () => {
  test("detects `sed -i PATH` inline mutation (the 2026-04-23 bypass)", () => {
    const targets = extractBashFileMutations(
      "sed -i 's/foo/bar/' /home/curly/proyectos/bitcoin-tui-dashboard/app.py",
    );
    expect(targets).toContain("/home/curly/proyectos/bitcoin-tui-dashboard/app.py");
  });

  test("detects `sed -i '' PATH` (BSD-sed empty suffix form)", () => {
    const targets = extractBashFileMutations("sed -i '' 's/old/new/' file.py");
    expect(targets).toContain("file.py");
  });

  test("detects `sed --in-place PATH`", () => {
    const targets = extractBashFileMutations("sed --in-place='.bak' 's/a/b/g' config.toml");
    expect(targets).toContain("config.toml");
  });

  test("detects multiple files in one sed -i", () => {
    const targets = extractBashFileMutations("sed -i 's/a/b/' a.py b.py c.py");
    expect(targets).toContain("a.py");
    expect(targets).toContain("b.py");
    expect(targets).toContain("c.py");
  });

  test("detects `perl -i -pe '…' PATH`", () => {
    const targets = extractBashFileMutations(
      "perl -i -pe 's/foo/bar/' /tmp/thing.py",
    );
    expect(targets).toContain("/tmp/thing.py");
  });

  test("detects `perl -i.bak -pe '…' PATH`", () => {
    const targets = extractBashFileMutations("perl -i.bak -pe 's/x/y/' src.rs");
    expect(targets).toContain("src.rs");
  });

  test("detects `awk -i inplace`", () => {
    const targets = extractBashFileMutations(
      "awk -i inplace '{print $1}' data.txt",
    );
    expect(targets).toContain("data.txt");
  });

  test("includes redirection targets (via extractRedirectionTargets)", () => {
    const targets = extractBashFileMutations("echo hello > /tmp/out.txt");
    expect(targets).toContain("/tmp/out.txt");
  });

  test("does NOT match `sed` WITHOUT -i (stdout-only)", () => {
    // sed without -i only writes to stdout — not a mutation.
    const targets = extractBashFileMutations("sed 's/foo/bar/' input.txt");
    expect(targets).not.toContain("input.txt");
  });

  test("does NOT match `grep`/`cat`/read-only commands", () => {
    expect(extractBashFileMutations("grep foo file.py")).toEqual([]);
    expect(extractBashFileMutations("cat /etc/hosts")).toEqual([]);
    expect(extractBashFileMutations("ls -la")).toEqual([]);
  });

  test("handles command chain with pipe correctly", () => {
    const targets = extractBashFileMutations(
      "cat file.txt | sed -i 's/a/b/' target.py",
    );
    expect(targets).toContain("target.py");
  });
});
