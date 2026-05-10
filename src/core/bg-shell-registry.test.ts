import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetShellRegistry,
  getShell,
  isShellAlive,
  killShell,
  listShells,
  logPathFor,
  newShellId,
  purgeShell,
  readShellOutput,
  registerShell,
} from "./bg-shell-registry";

let scratch: string;

beforeEach(() => {
  _resetShellRegistry();
  scratch = mkdtempSync(join(tmpdir(), "kcode-bg-test-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("newShellId", () => {
  test("returns 8 hex chars", () => {
    const id = newShellId();
    expect(id).toMatch(/^[0-9a-f]{1,8}$/);
  });

  test("returns unique IDs across calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(newShellId());
    // 100 random 8-hex-char ids → effectively no collisions
    expect(ids.size).toBe(100);
  });
});

describe("registerShell + getShell", () => {
  test("registers and retrieves a shell record", () => {
    const id = newShellId();
    const rec = registerShell({
      shellId: id,
      pid: 12345,
      command: "sleep 60",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    expect(rec.logPath).toBe(logPathFor(id));
    const back = getShell(id);
    expect(back?.pid).toBe(12345);
    expect(back?.command).toBe("sleep 60");
  });

  test("returns undefined for unknown shellId", () => {
    expect(getShell("nonexistent")).toBeUndefined();
  });
});

describe("listShells", () => {
  test("orders by startedAt descending (newest first)", () => {
    registerShell({
      shellId: "old",
      pid: 1,
      command: "a",
      startedAt: 100,
      cwd: "/tmp",
    });
    registerShell({
      shellId: "new",
      pid: 2,
      command: "b",
      startedAt: 200,
      cwd: "/tmp",
    });
    const list = listShells();
    expect(list[0]!.shellId).toBe("new");
    expect(list[1]!.shellId).toBe("old");
  });
});

describe("isShellAlive", () => {
  test("true for current process pid", () => {
    const rec = registerShell({
      shellId: "self",
      pid: process.pid,
      command: "self",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    expect(isShellAlive(rec)).toBe(true);
  });

  test("false for dead pid", () => {
    // PID 999999 is virtually never assigned on a normal system.
    const rec = registerShell({
      shellId: "dead",
      pid: 999999,
      command: "dead",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    expect(isShellAlive(rec)).toBe(false);
  });
});

describe("readShellOutput", () => {
  test("returns null for unknown shellId", () => {
    expect(readShellOutput("missing")).toBeNull();
  });

  test("returns empty content when log file does not exist yet", () => {
    const id = "no-log";
    registerShell({
      shellId: id,
      pid: 1,
      command: "x",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    const out = readShellOutput(id);
    expect(out?.content).toBe("");
    expect(out?.size).toBe(0);
  });

  test("returns full content for small log", () => {
    const id = "tiny";
    const rec = registerShell({
      shellId: id,
      pid: 1,
      command: "x",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    writeFileSync(rec.logPath, "hello world\nline 2\n");
    const out = readShellOutput(id);
    expect(out?.content).toBe("hello world\nline 2\n");
    expect(out?.truncated).toBe(false);
  });

  test("returns tail when tailBytes specified and log is large", () => {
    const id = "big";
    const rec = registerShell({
      shellId: id,
      pid: 1,
      command: "x",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    const big = "x".repeat(5000) + "TAIL_MARKER";
    writeFileSync(rec.logPath, big);
    const out = readShellOutput(id, { tailBytes: 100 });
    expect(out?.truncated).toBe(true);
    expect(out?.content.endsWith("TAIL_MARKER")).toBe(true);
    expect(out?.content.length).toBe(100);
  });
});

describe("killShell", () => {
  test("returns reason for unknown shellId", () => {
    const result = killShell("ghost");
    expect(result.killed).toBe(false);
    expect(result.reason).toMatch(/Unknown shellId/);
  });

  test("returns already-exited for dead pid + removes from registry", () => {
    const id = "zombie";
    registerShell({
      shellId: id,
      pid: 999999,
      command: "dead",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    const result = killShell(id);
    expect(result.killed).toBe(true);
    expect(result.reason).toBe("already-exited");
    expect(getShell(id)).toBeUndefined();
  });
});

describe("purgeShell", () => {
  test("removes registry entry + deletes log file", () => {
    const id = "purgeme";
    const rec = registerShell({
      shellId: id,
      pid: 1,
      command: "x",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    writeFileSync(rec.logPath, "log content");
    purgeShell(id);
    expect(getShell(id)).toBeUndefined();
    // Log file should be gone
    const { existsSync } = require("node:fs");
    expect(existsSync(rec.logPath)).toBe(false);
  });

  test("idempotent — purging unknown is a no-op", () => {
    expect(() => purgeShell("nonexistent")).not.toThrow();
  });
});
