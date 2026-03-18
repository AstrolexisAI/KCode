import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeGitStatus, executeGitCommit, executeGitLog } from "./git-tools.ts";

let hasGit = false;
try { execFileSync("git", ["--version"], { stdio: "pipe" }); hasGit = true; } catch {}

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

(hasGit ? describe : describe.skip)("git-tools", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-git-tools-test-"));
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── GitStatus ────────────────────────────────────────────────

  describe("GitStatus", () => {
    test("returns error in a non-git directory", async () => {
      process.chdir(tempDir);

      const result = await executeGitStatus({});

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Not in a git repository");
    });

    test("shows structured output with branch and clean state", async () => {
      initGitRepo(tempDir);
      await Bun.write(join(tempDir, "init.txt"), "init");
      git(["add", "."], tempDir);
      git(["commit", "-m", "initial"], tempDir);
      process.chdir(tempDir);

      const result = await executeGitStatus({});

      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain("Branch:");
      expect(result.content).toContain("Clean working tree");
    });

    test("shows staged, unstaged, and untracked files", async () => {
      initGitRepo(tempDir);
      await Bun.write(join(tempDir, "tracked.txt"), "original");
      git(["add", "."], tempDir);
      git(["commit", "-m", "initial"], tempDir);

      // Create staged, unstaged, and untracked changes
      await Bun.write(join(tempDir, "staged.txt"), "new staged");
      git(["add", "staged.txt"], tempDir);
      await Bun.write(join(tempDir, "tracked.txt"), "modified");
      await Bun.write(join(tempDir, "untracked.txt"), "untracked");
      process.chdir(tempDir);

      const result = await executeGitStatus({});

      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain("Staged");
      expect(result.content).toContain("Unstaged");
      expect(result.content).toContain("Untracked");
    });
  });

  // ─── GitCommit ────────────────────────────────────────────────

  describe("GitCommit", () => {
    test("blocks sensitive files (.env)", async () => {
      initGitRepo(tempDir);
      await Bun.write(join(tempDir, "app.ts"), "code");
      git(["add", "."], tempDir);
      git(["commit", "-m", "initial"], tempDir);

      await Bun.write(join(tempDir, ".env"), "SECRET=abc");
      process.chdir(tempDir);

      const result = await executeGitCommit({
        message: "add env",
        files: [".env"],
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Sensitive files");
      expect(result.content).toContain(".env");
    });

    test("commits successfully with valid files", async () => {
      initGitRepo(tempDir);
      await Bun.write(join(tempDir, "hello.ts"), "console.log('hi');");
      process.chdir(tempDir);

      const result = await executeGitCommit({
        message: "add hello",
        files: ["hello.ts"],
      });

      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain("Committed:");
      expect(result.content).toContain("add hello");
      expect(result.content).toContain("hello.ts");
    });

    test("error when nothing is staged", async () => {
      initGitRepo(tempDir);
      await Bun.write(join(tempDir, "init.txt"), "init");
      git(["add", "."], tempDir);
      git(["commit", "-m", "initial"], tempDir);
      process.chdir(tempDir);

      const result = await executeGitCommit({ message: "empty commit" });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Nothing staged");
    });
  });

  // ─── GitLog ───────────────────────────────────────────────────

  describe("GitLog", () => {
    test("returns error in a non-git directory", async () => {
      process.chdir(tempDir);

      const result = await executeGitLog({});

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Not in a git repository");
    });

    test("shows commit history", async () => {
      initGitRepo(tempDir);
      await Bun.write(join(tempDir, "a.txt"), "first");
      git(["add", "."], tempDir);
      git(["commit", "-m", "first commit"], tempDir);
      await Bun.write(join(tempDir, "b.txt"), "second");
      git(["add", "."], tempDir);
      git(["commit", "-m", "second commit"], tempDir);
      process.chdir(tempDir);

      const result = await executeGitLog({});

      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain("first commit");
      expect(result.content).toContain("second commit");
    });

    test("oneline format returns compact output", async () => {
      initGitRepo(tempDir);
      await Bun.write(join(tempDir, "a.txt"), "content");
      git(["add", "."], tempDir);
      git(["commit", "-m", "test oneline"], tempDir);
      process.chdir(tempDir);

      const result = await executeGitLog({ oneline: true });

      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain("test oneline");
      // Oneline format should not contain "by" author lines
      expect(result.content).not.toContain("  by ");
    });
  });
});
