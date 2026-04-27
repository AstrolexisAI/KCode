// Tests for the persistent dev-server registry.
//
// Covers: read/write, register, unregister, isProcessAlive, and the
// cleanupStaleDevServers behavior that fixes the v2.10.81 forensic
// audit P0 finding (5 orphan `bun --watch` processes surviving for
// 29+ hours because no session had a record of what previous
// sessions had spawned).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupStaleDevServers,
  isProcessAlive,
  listDevServers,
  readRegistry,
  registerSpawnedServer,
  unregisterDevServer,
} from "./dev-server-registry";

// Isolate each test with its own KCODE_HOME so they can't see each
// other's registry state.
let originalKcodeHome: string | undefined;
let testHome: string;

beforeEach(() => {
  originalKcodeHome = process.env.KCODE_HOME;
  testHome = join(
    tmpdir(),
    `kcode-dev-registry-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(testHome, { recursive: true });
  process.env.KCODE_HOME = testHome;
});

afterEach(() => {
  if (originalKcodeHome === undefined) {
    delete process.env.KCODE_HOME;
  } else {
    process.env.KCODE_HOME = originalKcodeHome;
  }
  if (existsSync(testHome)) {
    rmSync(testHome, { recursive: true, force: true });
  }
});

describe("readRegistry", () => {
  test("returns empty array when file does not exist", () => {
    expect(readRegistry()).toEqual([]);
  });

  test("returns entries after registering one", () => {
    registerSpawnedServer({
      pid: 99999,
      cwd: "/tmp/proj",
      command: "bun run dev",
      port: 3000,
      name: "NEXT",
    });
    const entries = readRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.pid).toBe(99999);
    expect(entries[0]!.cwd).toBe("/tmp/proj");
    expect(entries[0]!.port).toBe(3000);
    expect(entries[0]!.name).toBe("NEXT");
    // startedAt and parentKcodePid are filled in by the registry
    expect(typeof entries[0]!.startedAt).toBe("number");
    expect(typeof entries[0]!.parentKcodePid).toBe("number");
  });
});

describe("registerSpawnedServer", () => {
  test("appends without clobbering existing entries", () => {
    registerSpawnedServer({ pid: 1, cwd: "/a", command: "x", port: 1 });
    registerSpawnedServer({ pid: 2, cwd: "/b", command: "y", port: 2 });
    registerSpawnedServer({ pid: 3, cwd: "/c", command: "z", port: 3 });
    const entries = readRegistry();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.pid)).toEqual([1, 2, 3]);
  });
});

describe("unregisterDevServer", () => {
  test("removes the entry matching the pid", () => {
    registerSpawnedServer({ pid: 101, cwd: "/a", command: "x", port: 1 });
    registerSpawnedServer({ pid: 102, cwd: "/b", command: "y", port: 2 });
    unregisterDevServer(101);
    const entries = readRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.pid).toBe(102);
  });

  test("is a no-op on unknown pid", () => {
    registerSpawnedServer({ pid: 1, cwd: "/a", command: "x", port: 1 });
    unregisterDevServer(999);
    expect(readRegistry()).toHaveLength(1);
  });
});

describe("isProcessAlive", () => {
  test("returns true for the test process itself", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("returns false for a clearly-dead pid", () => {
    // PID 0 is reserved and not a valid target. PIDs over 2^22 on
    // Linux are outside the default kernel pid range, so using
    // a very high value we know isn't allocated.
    expect(isProcessAlive(4194305)).toBe(false);
  });
});

describe("cleanupStaleDevServers", () => {
  test("returns zero counts when registry is empty", () => {
    const result = cleanupStaleDevServers("/tmp/proj");
    expect(result.removedDead).toBe(0);
    expect(result.killedStale).toBe(0);
    expect(result.remaining).toBe(0);
  });

  test("removes entries whose PID is dead", () => {
    // Register a dead PID (very high, not allocated)
    registerSpawnedServer({
      pid: 4194305,
      cwd: "/tmp/proj",
      command: "dev",
      port: 3000,
    });
    expect(readRegistry()).toHaveLength(1);

    const result = cleanupStaleDevServers("/tmp/proj");
    expect(result.removedDead).toBe(1);
    expect(result.killedStale).toBe(0);
    expect(result.remaining).toBe(0);
    // Registry should be empty on disk now
    expect(readRegistry()).toHaveLength(0);
  });

  test("keeps live entries in the same cwd if they are NOT stale", () => {
    // Register the test process itself (always alive) as if it were
    // a dev server — cleanup should not touch it.
    registerSpawnedServer({
      pid: process.pid,
      cwd: "/tmp/proj",
      command: "dev",
      port: 3000,
    });
    const result = cleanupStaleDevServers("/tmp/proj");
    expect(result.removedDead).toBe(0);
    expect(result.killedStale).toBe(0);
    expect(result.remaining).toBe(1);
  });

  test("leaves live entries in OTHER cwds alone even if stale", () => {
    // Dead entry in a different cwd gets reaped (dead), but a "stale"
    // live entry in a different cwd should NOT be killed — only
    // entries in the target cwd are candidates for stale-kill.
    registerSpawnedServer({
      pid: process.pid, // alive
      cwd: "/tmp/other-project",
      command: "dev",
      port: 4000,
    });

    // Manually tamper with the registry to make this entry look very
    // old. We do this by reading the current registry file and
    // rewriting it with an ancient startedAt.
    const entries = readRegistry();
    entries[0]!.startedAt = Date.now() - 24 * 3600 * 1000; // 24h old
    // Write via the internal writer by roundtripping registerSpawnedServer
    // on a fresh temp home won't work — instead, write the file directly
    // using the same format the module uses.
    const { writeFileSync } = require("node:fs");
    const { kcodePath } = require("./paths");
    writeFileSync(kcodePath("dev-servers.json"), JSON.stringify(entries, null, 2), "utf-8");

    // Run cleanup targeting a DIFFERENT cwd
    const result = cleanupStaleDevServers("/tmp/proj");

    // Nothing should have been killed — the stale live entry is in
    // a different cwd, so it's safe.
    expect(result.killedStale).toBe(0);
    expect(result.remaining).toBe(1);
    expect(readRegistry()).toHaveLength(1);
  });

  test("removes dead entries even in a different cwd", () => {
    // A dead PID in a different cwd should still be reaped as dead —
    // it's just garbage in the registry. Only the STALE LIVE kill is
    // scoped to the target cwd.
    registerSpawnedServer({
      pid: 4194305, // dead
      cwd: "/tmp/other-project",
      command: "dev",
      port: 4000,
    });

    const result = cleanupStaleDevServers("/tmp/proj");
    expect(result.removedDead).toBe(1);
    expect(result.remaining).toBe(0);
  });

  test("listDevServers returns the current entries", () => {
    registerSpawnedServer({ pid: 1, cwd: "/a", command: "x", port: 1 });
    registerSpawnedServer({ pid: 2, cwd: "/b", command: "y", port: 2 });
    const list = listDevServers();
    expect(list).toHaveLength(2);
    expect(list[0]!.cwd).toBe("/a");
    expect(list[1]!.cwd).toBe("/b");
  });
});

describe("registry corruption recovery", () => {
  test("corrupt JSON is reset to empty array without crashing", () => {
    // Write garbage directly to the registry file
    const { writeFileSync } = require("node:fs");
    const { kcodePath } = require("./paths");
    writeFileSync(kcodePath("dev-servers.json"), "{not valid json", "utf-8");

    // Reading should not throw; should return empty
    expect(readRegistry()).toEqual([]);

    // And registering on top should still work
    registerSpawnedServer({ pid: 1, cwd: "/a", command: "x", port: 1 });
    const entries = readRegistry();
    expect(entries).toHaveLength(1);
  });

  test("non-array JSON is reset to empty array", () => {
    const { writeFileSync } = require("node:fs");
    const { kcodePath } = require("./paths");
    writeFileSync(kcodePath("dev-servers.json"), JSON.stringify({ not: "an array" }), "utf-8");
    expect(readRegistry()).toEqual([]);
  });

  test("entries missing required fields are filtered out", () => {
    const { writeFileSync } = require("node:fs");
    const { kcodePath } = require("./paths");
    writeFileSync(
      kcodePath("dev-servers.json"),
      JSON.stringify([
        { pid: 1, cwd: "/a", command: "x", port: 1, startedAt: 1, parentKcodePid: 1 }, // valid
        { pid: "not-a-number", cwd: "/b", command: "y", port: 2 }, // invalid
        { notACompleteEntry: true }, // invalid
      ]),
      "utf-8",
    );
    const entries = readRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.pid).toBe(1);
  });
});
