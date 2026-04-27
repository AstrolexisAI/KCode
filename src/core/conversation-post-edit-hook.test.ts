import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildErrorRecoveryMessage,
  detectProjectType,
  extractEditedFiles,
  findRelatedTests,
  hasCompileErrors,
  hasTestFailures,
  runPostEditFeedback,
} from "./conversation-post-edit-hook";
import type { ToolUseBlock } from "./types";

// ─── Helpers ─────────────────────────────────────────────────────

function fakeTool(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id: "test-id", name, input };
}

async function makeTempDir(): Promise<string> {
  const dir = await import("node:fs/promises").then(() =>
    import("node:os").then((os) => os.tmpdir()),
  );
  const path = join(dir, `kcode-hook-test-${Date.now()}`);
  await mkdir(path, { recursive: true });
  return path;
}

// ─── extractEditedFiles ───────────────────────────────────────

describe("extractEditedFiles", () => {
  test("extracts file_path from Write call", () => {
    const calls = [fakeTool("Write", { file_path: "/tmp/foo.ts", content: "x" })];
    expect(extractEditedFiles(calls)).toEqual(["/tmp/foo.ts"]);
  });

  test("extracts file_path from Edit call", () => {
    const calls = [
      fakeTool("Edit", { file_path: "/tmp/bar.ts", old_string: "a", new_string: "b" }),
    ];
    expect(extractEditedFiles(calls)).toEqual(["/tmp/bar.ts"]);
  });

  test("extracts file_path from MultiEdit call", () => {
    const calls = [
      fakeTool("MultiEdit", {
        file_path: "/tmp/baz.ts",
        edits: [{ old_string: "x", new_string: "y" }],
      }),
    ];
    expect(extractEditedFiles(calls)).toEqual(["/tmp/baz.ts"]);
  });

  test("deduplicates files modified in multiple calls", () => {
    const calls = [
      fakeTool("Edit", { file_path: "/tmp/foo.ts", old_string: "a", new_string: "b" }),
      fakeTool("Edit", { file_path: "/tmp/foo.ts", old_string: "c", new_string: "d" }),
    ];
    expect(extractEditedFiles(calls)).toEqual(["/tmp/foo.ts"]);
  });

  test("returns empty array when no edit tools", () => {
    const calls = [fakeTool("Read", { file_path: "/tmp/foo.ts" })];
    expect(extractEditedFiles(calls)).toEqual([]);
  });

  test("ignores non-edit tool calls in mixed batch", () => {
    const calls = [
      fakeTool("Read", { file_path: "/tmp/read.ts" }),
      fakeTool("Write", { file_path: "/tmp/write.ts", content: "x" }),
      fakeTool("Bash", { command: "ls" }),
    ];
    expect(extractEditedFiles(calls)).toEqual(["/tmp/write.ts"]);
  });
});

// ─── detectProjectType ────────────────────────────────────────

describe("detectProjectType", () => {
  test("detects typescript-bun when tsconfig.json + bunfig.toml exist", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "tsconfig.json"), "{}");
    await writeFile(join(dir, "bunfig.toml"), "");
    expect(detectProjectType(dir)).toBe("typescript-bun");
    await rm(dir, { recursive: true });
  });

  test("detects typescript-npm when tsconfig.json exists without bun files", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "tsconfig.json"), "{}");
    expect(detectProjectType(dir)).toBe("typescript-npm");
    await rm(dir, { recursive: true });
  });

  test("detects rust when Cargo.toml exists", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "Cargo.toml"), "");
    expect(detectProjectType(dir)).toBe("rust");
    await rm(dir, { recursive: true });
  });

  test("detects go when go.mod exists", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "");
    expect(detectProjectType(dir)).toBe("go");
    await rm(dir, { recursive: true });
  });

  test("returns unknown for empty directory", async () => {
    const dir = await makeTempDir();
    expect(detectProjectType(dir)).toBe("unknown");
    await rm(dir, { recursive: true });
  });
});

// ─── findRelatedTests ─────────────────────────────────────────

describe("findRelatedTests", () => {
  test("finds .test.ts sibling for a .ts source file", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "foo.ts"), "export const x = 1;");
    await writeFile(join(dir, "foo.test.ts"), "test('x', () => {});");
    const tests = findRelatedTests([join(dir, "foo.ts")], dir);
    expect(tests).toContain(join(dir, "foo.test.ts"));
    await rm(dir, { recursive: true });
  });

  test("returns empty array when no test file exists", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "bar.ts"), "export const y = 2;");
    const tests = findRelatedTests([join(dir, "bar.ts")], dir);
    expect(tests).toEqual([]);
    await rm(dir, { recursive: true });
  });

  test("skips .skip test files", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "baz.ts"), "");
    await writeFile(join(dir, "baz.test.ts.skip"), "");
    const tests = findRelatedTests([join(dir, "baz.ts")], dir);
    expect(tests).toEqual([]);
    await rm(dir, { recursive: true });
  });
});

// ─── hasCompileErrors ─────────────────────────────────────────

describe("hasCompileErrors", () => {
  test("detects TypeScript error TS2345", () => {
    expect(hasCompileErrors("error TS2345: Argument of type 'string' is not assignable")).toBe(
      true,
    );
  });

  test("detects tsc summary '3 errors'", () => {
    expect(hasCompileErrors("Found 3 errors in 2 files.\n")).toBe(true);
  });

  test("detects Rust error[E0308]", () => {
    expect(hasCompileErrors("error[E0308]: mismatched types\n --> src/main.rs:10:5")).toBe(true);
  });

  test("detects Go build error", () => {
    expect(hasCompileErrors("# main\nerror: undefined: Foo")).toBe(true);
  });

  test("returns false for clean output", () => {
    expect(hasCompileErrors("Build succeeded.\n1 warning generated.")).toBe(false);
  });
});

// ─── hasTestFailures ──────────────────────────────────────────

describe("hasTestFailures", () => {
  test("detects '2 fail' pattern", () => {
    expect(hasTestFailures("2 pass\n2 fail")).toBe(true);
  });

  test("detects FAILED keyword", () => {
    expect(hasTestFailures("FAILED src/core/foo.test.ts > my test")).toBe(true);
  });

  test("returns false for all-pass output", () => {
    expect(hasTestFailures("28 pass\n0 fail")).toBe(false);
  });
});

// ─── buildErrorRecoveryMessage ────────────────────────────────

describe("buildErrorRecoveryMessage", () => {
  test("returns null when no errors in tool results", () => {
    expect(buildErrorRecoveryMessage(["28 pass\n0 fail", "ok"])).toBeNull();
  });

  test("returns recovery directive on compile error", () => {
    const msg = buildErrorRecoveryMessage(["error TS2304: Cannot find name 'foo'"]);
    expect(msg).not.toBeNull();
    expect(msg).toContain("COMPILATION ERROR");
    expect(msg).toContain("FIX IT NOW");
  });

  test("returns recovery directive on test failure", () => {
    const msg = buildErrorRecoveryMessage(["1 pass\n3 fail"]);
    expect(msg).not.toBeNull();
    expect(msg).toContain("TEST FAILURE");
  });

  test("includes error summary in message", () => {
    const errText = "error TS2304: Cannot find name 'missingThing'";
    const msg = buildErrorRecoveryMessage([errText]);
    expect(msg).toContain("missingThing");
  });

  test("returns null for empty input", () => {
    expect(buildErrorRecoveryMessage([])).toBeNull();
    expect(buildErrorRecoveryMessage([""])).toBeNull();
  });
});

// ─── runPostEditFeedback ───────────────────────────────────────

describe("runPostEditFeedback", () => {
  test("returns null when no edit tool calls", async () => {
    const result = await runPostEditFeedback([fakeTool("Bash", { command: "ls" })], process.cwd());
    expect(result).toBeNull();
  });

  test("returns null when project type is unknown", async () => {
    const dir = await makeTempDir();
    const result = await runPostEditFeedback(
      [fakeTool("Write", { file_path: join(dir, "foo.txt"), content: "x" })],
      dir,
    );
    expect(result).toBeNull();
    await rm(dir, { recursive: true });
  });

  test("returns null when related tests pass", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "tsconfig.json"), "{}");
    // Create a passing test file
    await writeFile(join(dir, "util.ts"), "export const x = 1;");
    await writeFile(
      join(dir, "util.test.ts"),
      `import { expect, test } from "bun:test";\ntest("pass", () => expect(1).toBe(1));`,
    );
    const result = await runPostEditFeedback(
      [fakeTool("Write", { file_path: join(dir, "util.ts"), content: "export const x = 1;" })],
      dir,
      { runTests: true, runBuild: false },
    );
    expect(result).toBeNull();
    await rm(dir, { recursive: true });
  });

  test("returns feedback message when related tests fail", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "tsconfig.json"), "{}");
    await writeFile(join(dir, "broken.ts"), "export const x = 1;");
    await writeFile(
      join(dir, "broken.test.ts"),
      `import { expect, test } from "bun:test";\ntest("fail", () => expect(1).toBe(2));`,
    );
    const result = await runPostEditFeedback(
      [fakeTool("Write", { file_path: join(dir, "broken.ts"), content: "export const x = 1;" })],
      dir,
      { runTests: true, runBuild: false },
    );
    expect(result).not.toBeNull();
    expect(result).toContain("TESTS FAILED");
    expect(result).toContain("Fix all errors");
    await rm(dir, { recursive: true });
  });
});
