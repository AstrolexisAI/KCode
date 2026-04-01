// KCode - Changelog Generator Tests

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateChangelog, getLastTag, getCommitsSince } from "./generator";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, `__test_changelog_${process.pid}__`);

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  Bun.spawnSync(["git", "init"], { cwd: TEST_DIR });
  Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=t@t.com", "commit", "--allow-empty", "-m", "feat: initial commit"], { cwd: TEST_DIR });
  Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=t@t.com", "commit", "--allow-empty", "-m", "fix(auth): resolve login bug"], { cwd: TEST_DIR });
  Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=t@t.com", "commit", "--allow-empty", "-m", "docs: update README"], { cwd: TEST_DIR });
  Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=t@t.com", "commit", "--allow-empty", "-m", "Update some stuff"], { cwd: TEST_DIR });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("getLastTag", () => {
  test("returns empty string when no tags", async () => {
    const tag = await getLastTag(TEST_DIR);
    expect(tag).toBe("");
  });
});

describe("getCommitsSince", () => {
  test("returns all commits when since is empty", async () => {
    const commits = await getCommitsSince("", TEST_DIR);
    expect(commits.length).toBeGreaterThanOrEqual(4);
  });

  test("commit has correct structure", async () => {
    const commits = await getCommitsSince("", TEST_DIR);
    const first = commits[0]!;
    expect(first.hash).toBeDefined();
    expect(first.hash.length).toBeGreaterThanOrEqual(7);
    expect(first.message).toBeDefined();
    expect(first.author).toBe("test");
    expect(first.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("generateChangelog", () => {
  test("generates changelog with all sections", async () => {
    const changelog = await generateChangelog({ cwd: TEST_DIR });
    expect(changelog.entries.length).toBeGreaterThanOrEqual(4);
    expect(changelog.markdown).toBeDefined();
    expect(changelog.markdown.length).toBeGreaterThan(0);
  });

  test("categorizes conventional commits correctly", async () => {
    const changelog = await generateChangelog({ cwd: TEST_DIR });
    expect(changelog.features.length).toBeGreaterThanOrEqual(1);
    expect(changelog.fixes.length).toBeGreaterThanOrEqual(1);
  });

  test("includes version in markdown", async () => {
    const changelog = await generateChangelog({ cwd: TEST_DIR, version: "1.8.0" });
    expect(changelog.version).toBe("1.8.0");
    expect(changelog.markdown).toContain("## 1.8.0");
  });

  test("default version is Unreleased", async () => {
    const changelog = await generateChangelog({ cwd: TEST_DIR });
    expect(changelog.version).toBe("Unreleased");
    expect(changelog.markdown).toContain("Unreleased");
  });

  test("markdown has Features section", async () => {
    const changelog = await generateChangelog({ cwd: TEST_DIR });
    expect(changelog.markdown).toContain("### Features");
  });

  test("markdown has Bug Fixes section", async () => {
    const changelog = await generateChangelog({ cwd: TEST_DIR });
    expect(changelog.markdown).toContain("### Bug Fixes");
  });

  test("includes commit hashes in markdown", async () => {
    const changelog = await generateChangelog({ cwd: TEST_DIR });
    // Hashes are 7-char abbreviated
    expect(changelog.markdown).toMatch(/\([a-f0-9]{7}\)/);
  });

  test("fix with scope includes scope in markdown", async () => {
    const changelog = await generateChangelog({ cwd: TEST_DIR });
    expect(changelog.markdown).toContain("**auth:**");
  });

  test("classifies non-conventional commits", async () => {
    const changelog = await generateChangelog({ cwd: TEST_DIR });
    // "Update some stuff" should be classified as chore
    const choreEntry = changelog.other.find((e) => e.description.includes("Update some stuff"));
    expect(choreEntry).toBeDefined();
  });
});
