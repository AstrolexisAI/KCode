// Tests for Bash-as-Read and Bash-as-Grep pattern extraction.
// Closes the bypass where the model uses `cat foo.cpp` instead of the
// Read tool, escaping the session-read tracker.

import { describe, expect, test } from "bun:test";
import { extractBashGrepPattern, extractBashReadTargets } from "./audit-guards";

describe("extractBashReadTargets", () => {
  test("extracts cat target", () => {
    expect(extractBashReadTargets("cat foo.cpp")).toEqual(["foo.cpp"]);
  });

  test("extracts head with -n flag", () => {
    expect(extractBashReadTargets("head -n 50 src/bar.cpp")).toEqual(["src/bar.cpp"]);
  });

  test("extracts head with -NN flag", () => {
    expect(extractBashReadTargets("head -50 /path/to/file.h")).toEqual(["/path/to/file.h"]);
  });

  test("extracts tail target", () => {
    expect(extractBashReadTargets("tail -20 log.txt")).toEqual(["log.txt"]);
  });

  test("extracts multiple args", () => {
    expect(extractBashReadTargets("cat a.cpp b.cpp c.cpp")).toEqual(["a.cpp", "b.cpp", "c.cpp"]);
  });

  test("extracts quoted paths", () => {
    expect(extractBashReadTargets(`cat "path with spaces.cpp"`)).toEqual(["path with spaces.cpp"]);
  });

  test("ignores flags and numbers", () => {
    expect(extractBashReadTargets("head -n 100 --lines=50 foo.cpp")).toEqual(["foo.cpp"]);
  });

  test("handles chained commands (cd && cat)", () => {
    // The regex matches `cat` wherever it appears
    const targets = extractBashReadTargets("cd /project && cat README.md");
    expect(targets).toContain("README.md");
  });

  test("returns empty for non-read commands", () => {
    expect(extractBashReadTargets("ls -la")).toEqual([]);
    expect(extractBashReadTargets("mkdir foo")).toEqual([]);
    expect(extractBashReadTargets("find . -name '*.cpp'")).toEqual([]);
  });

  test("skips bare words that don't look like paths", () => {
    // "cat something" where "something" has no / or . — probably a category
    const targets = extractBashReadTargets("cat foo.txt && echo done");
    expect(targets).toContain("foo.txt");
    expect(targets).not.toContain("done");
  });

  test("stops at shell operators", () => {
    const targets = extractBashReadTargets("cat foo.cpp | grep bar");
    expect(targets).toContain("foo.cpp");
    expect(targets).not.toContain("bar");
  });
});

describe("extractBashGrepPattern", () => {
  test("extracts grep pattern", () => {
    expect(extractBashGrepPattern("grep data src/")).toBe("data");
  });

  test("extracts rg pattern", () => {
    expect(extractBashGrepPattern("rg 'data\\[' .")).toBe("data\\[");
  });

  test("extracts grep pattern with flags", () => {
    expect(extractBashGrepPattern("grep -rn --include='*.cpp' malloc .")).toBe("malloc");
  });

  test("extracts ag pattern", () => {
    expect(extractBashGrepPattern("ag recv src/")).toBe("recv");
  });

  test("returns null for non-grep commands", () => {
    expect(extractBashGrepPattern("ls -la")).toBeNull();
    expect(extractBashGrepPattern("cat foo.cpp")).toBeNull();
    expect(extractBashGrepPattern("find . -name '*.h'")).toBeNull();
  });

  test("extracts pattern after chained commands", () => {
    expect(extractBashGrepPattern("cd /project && grep -rn 'foo' .")).toBe("foo");
  });

  test("handles quoted patterns with spaces", () => {
    expect(extractBashGrepPattern(`grep "hello world" file.txt`)).toBe("hello world");
  });
});
