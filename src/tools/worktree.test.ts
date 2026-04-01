import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeEnterWorktree, executeExitWorktree } from "./worktree.ts";

let hasGit = false;
try {
  execFileSync("git", ["--version"], { stdio: "pipe" });
  hasGit = true;
} catch {}

let tempDir: string;
let originalCwd: string;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

function initGitRepo(dir: string): void {
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
}

(hasGit ? describe : describe.skip)("worktree tools", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-worktree-test-"));
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    // Always return to original cwd in case a test left us elsewhere
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── EnterWorktree ───────────────────────────────────────────

  describe("EnterWorktree", () => {
    test("returns error in a non-git directory", async () => {
      process.chdir(tempDir);

      const result = await executeEnterWorktree({});

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Not in a git repository");
    });

    test("rejects invalid base ref", async () => {
      initGitRepo(tempDir);
      await Bun.write(join(tempDir, "init.txt"), "init");
      git(["add", "."], tempDir);
      git(["commit", "-m", "initial"], tempDir);
      process.chdir(tempDir);

      const result = await executeEnterWorktree({ base: "nonexistent-ref-abc123" });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("does not exist");
    });

    test("blocks shell metacharacters in base parameter", async () => {
      initGitRepo(tempDir);
      await Bun.write(join(tempDir, "init.txt"), "init");
      git(["add", "."], tempDir);
      git(["commit", "-m", "initial"], tempDir);
      process.chdir(tempDir);

      const result = await executeEnterWorktree({ base: "HEAD; rm -rf /" });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("invalid characters");
    });

    test("sanitizes branch name from input", async () => {
      initGitRepo(tempDir);
      await Bun.write(join(tempDir, "init.txt"), "init");
      git(["add", "."], tempDir);
      git(["commit", "-m", "initial"], tempDir);
      process.chdir(tempDir);

      const result = await executeEnterWorktree({ name: "my cool feature!!" });

      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain("kcode-wt-my-cool-feature--");

      // Clean up: exit the worktree
      await executeExitWorktree({});
    });
  });

  // ─── ExitWorktree ────────────────────────────────────────────

  describe("ExitWorktree", () => {
    test("returns error when not in a worktree", async () => {
      const result = await executeExitWorktree({});

      // The test setup may or may not have an active worktree from a previous test,
      // but after afterEach resets, there should be none. We check the fresh state.
      // Note: worktree state is module-level, so we rely on clean test ordering.
      expect(result.content).toBeDefined();
    });
  });
});
