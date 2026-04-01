import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanupCrash, detectCrash, removePidFile, writePidFile } from "./crash-recovery";

const PID_FILE = join(homedir(), ".kcode", "kcode.pid");

describe("crash-recovery", () => {
  afterEach(async () => {
    // Clean up PID file after each test
    try {
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    } catch {}
  });

  describe("writePidFile", () => {
    test("creates PID file with current PID", async () => {
      await writePidFile();
      expect(existsSync(PID_FILE)).toBe(true);
      const content = await Bun.file(PID_FILE).text();
      expect(parseInt(content)).toBe(process.pid);
    });
  });

  describe("removePidFile", () => {
    test("removes PID file", async () => {
      await writePidFile();
      expect(existsSync(PID_FILE)).toBe(true);
      await removePidFile();
      expect(existsSync(PID_FILE)).toBe(false);
    });

    test("does not throw if file does not exist", async () => {
      await expect(removePidFile()).resolves.toBeUndefined();
    });
  });

  describe("detectCrash", () => {
    test("returns null when no PID file exists", async () => {
      const db = new Database(":memory:");
      const result = await detectCrash(db);
      expect(result).toBeNull();
      db.close();
    });

    test("returns null when PID file has current (alive) process", async () => {
      await writePidFile(); // Current process PID — is alive
      const db = new Database(":memory:");
      const result = await detectCrash(db);
      expect(result).toBeNull();
      db.close();
    });

    test("returns crash info for stale PID", async () => {
      // Write a PID that definitely doesn't exist
      await Bun.write(PID_FILE, "999999999");
      const db = new Database(":memory:");
      const result = await detectCrash(db);
      expect(result).not.toBeNull();
      expect(result!.pid).toBe(999999999);
      expect(result!.staleFile).toBe(PID_FILE);
      // No checkpoint since we haven't saved any
      expect(result!.checkpoint).toBeNull();
      db.close();
    });
  });

  describe("cleanupCrash", () => {
    test("removes stale PID file", async () => {
      await Bun.write(PID_FILE, "12345");
      await cleanupCrash();
      expect(existsSync(PID_FILE)).toBe(false);
    });

    test("does not throw when no PID file", async () => {
      await expect(cleanupCrash()).resolves.toBeUndefined();
    });
  });
});
