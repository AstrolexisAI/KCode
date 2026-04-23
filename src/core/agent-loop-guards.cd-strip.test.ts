// Tests for the `cd ... && X` strip in extractBashLoopPattern.
// Issue #111 v280: the loop detector treated every command run
// from the same project directory as "bash:cd" because the base
// command extractor didn't strip the cd prefix. After 5 distinct
// commands (mkdir, bun init, bun add, bun run, bun run rerun)
// the hard-stop fired and blocked the post-patch rerun.

import { describe, expect, test } from "bun:test";
import { extractBashLoopPattern } from "./agent-loop-guards";

describe("extractBashLoopPattern — cd prefix stripping", () => {
  test("cd abs && bun run → bash:bun (NOT bash:cd)", () => {
    expect(
      extractBashLoopPattern("cd /home/curly/proyectos/foo && bun run index.ts"),
    ).toBe("bash:bun");
  });

  test("cd rel && mkdir → bash:mkdir", () => {
    expect(extractBashLoopPattern("cd foo && mkdir -p src/components")).toBe(
      "bash:mkdir",
    );
  });

  test("cd && bun add → bash:bun", () => {
    expect(
      extractBashLoopPattern("cd /proj && bun add blessed bitcoin-core"),
    ).toBe("bash:bun");
  });

  test("cd && bun init → bash:bun", () => {
    expect(extractBashLoopPattern("cd /proj && bun init -y")).toBe("bash:bun");
  });

  test("cd && rerun same command → still bash:bun, not bash:cd", () => {
    // Even after the post-patch edit, the rerun should share the same
    // pattern as the original run so the loop counter advances correctly.
    expect(extractBashLoopPattern("cd /proj && bun run index.ts")).toBe("bash:bun");
  });

  test("cd && X ; Y — semicolon separator also strips", () => {
    // python specialization extracts the script basename; we just want
    // to confirm the cd prefix was stripped (pattern is NOT 'bash:cd').
    const p = extractBashLoopPattern("cd /proj ; python test.py");
    expect(p).not.toBe("bash:cd");
    expect(p).toBe("bash:test");
  });

  test("timeout N cd && X — cd still stripped (timeout is already a skip prefix)", () => {
    expect(extractBashLoopPattern("timeout 10 cd /proj && bun run index.ts")).toBe(
      "bash:bun",
    );
  });

  test("bare cd with no && → falls back on the directory argument", () => {
    // Bare `cd /proj` on its own is rare; we're not trying to block it,
    // just to make sure the result is NOT 'bash:cd' (the broken collapse).
    const p = extractBashLoopPattern("cd /proj");
    expect(p).not.toBe("bash:cd");
  });

  test("v280 EXACT sequence — 5 distinct Bash calls don't all collapse onto bash:cd", () => {
    const calls = [
      "cd /proj && mkdir -p src/components",
      "cd /proj && bun init -y",
      "cd /proj && bun add blessed bitcoin-core",
      "cd /proj && bun run index.ts",
      "cd /proj && bun run index.ts", // post-patch rerun
    ];
    const patterns = calls.map((c) => extractBashLoopPattern(c));
    expect(patterns).toEqual([
      "bash:mkdir",
      "bash:bun",
      "bash:bun",
      "bash:bun",
      "bash:bun",
    ]);
    // Only 4 bun calls → below the 5 hard-stop threshold.
    const bunCount = patterns.filter((p) => p === "bash:bun").length;
    expect(bunCount).toBe(4);
  });

  test("unrelated commands without cd prefix still work as before", () => {
    // python has a script-name specialization that returns bash:<script>.
    expect(extractBashLoopPattern("python test.py")).toBe("bash:test");
    expect(extractBashLoopPattern("bun run dev")).toBe("bash:bun");
    expect(extractBashLoopPattern("npm install")).toBe("bash:npm");
  });
});
