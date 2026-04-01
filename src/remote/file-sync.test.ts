import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalMtime, resolveConflict, startWatcher } from "./file-sync";

let tempDir: string;
let backupDir: string;

describe("file-sync", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-file-sync-test-"));
    backupDir = join(tempDir, ".kcode", "sync-conflicts");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("resolveConflict", () => {
    test("local wins when local mtime is newer", async () => {
      const localFile = join(tempDir, "test.txt");
      await writeFile(localFile, "local content", "utf-8");

      const result = await resolveConflict(localFile, "test.txt", 2000, 1000, backupDir);

      expect(result.resolution).toBe("local-wins");
      expect(result.path).toBe("test.txt");
      expect(result.localMtime).toBe(2000);
      expect(result.remoteMtime).toBe(1000);
    });

    test("remote wins when remote mtime is newer", async () => {
      const localFile = join(tempDir, "test.txt");
      await writeFile(localFile, "local content", "utf-8");

      const result = await resolveConflict(localFile, "test.txt", 1000, 2000, backupDir);

      expect(result.resolution).toBe("remote-wins");
      expect(result.path).toBe("test.txt");
    });

    test("remote wins creates backup of local file", async () => {
      const localFile = join(tempDir, "src/main.ts");
      await mkdir(join(tempDir, "src"), { recursive: true });
      await writeFile(localFile, "local content to backup", "utf-8");

      await resolveConflict(localFile, "src/main.ts", 1000, 2000, backupDir);

      const backupFiles = await readdir(backupDir);
      expect(backupFiles.length).toBe(1);
      expect(backupFiles[0]).toContain("src_main.ts");
      expect(backupFiles[0]).toEndWith(".bak");

      const backupContent = await readFile(join(backupDir, backupFiles[0]), "utf-8");
      expect(backupContent).toBe("local content to backup");
    });

    test("local wins with equal timestamps", async () => {
      const localFile = join(tempDir, "equal.txt");
      await writeFile(localFile, "content", "utf-8");

      const result = await resolveConflict(localFile, "equal.txt", 1000, 1000, backupDir);

      expect(result.resolution).toBe("local-wins");
    });
  });

  describe("startWatcher", () => {
    test("stop() does not throw", () => {
      const watcher = startWatcher(tempDir, () => {}, 100);
      expect(() => watcher.stop()).not.toThrow();
    });

    test("returns object with stop method", () => {
      const watcher = startWatcher(tempDir, () => {}, 100);
      expect(typeof watcher.stop).toBe("function");
      watcher.stop();
    });
  });

  describe("getLocalMtime", () => {
    test("returns mtime for existing file", async () => {
      const filePath = join(tempDir, "mtime-test.txt");
      await writeFile(filePath, "content", "utf-8");

      const mtime = await getLocalMtime(filePath);
      expect(mtime).not.toBeNull();
      expect(typeof mtime).toBe("number");
      expect(mtime!).toBeGreaterThan(0);
    });

    test("returns null for non-existent file", async () => {
      const mtime = await getLocalMtime(join(tempDir, "nonexistent.txt"));
      expect(mtime).toBeNull();
    });
  });
});
