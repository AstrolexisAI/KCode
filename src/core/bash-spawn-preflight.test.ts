// Tests for bash-spawn-preflight (phase 2 of operator-mind).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkInotifyState,
  clearInotifyCache,
  findListeningPid,
  runSpawnPreflight,
} from "./bash-spawn-preflight";

describe("findListeningPid", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  test("returns a PID when the port is bound", () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("hi") });
    const pid = findListeningPid(server.port);
    // Bun's process always owns the listener — should match our PID
    // unless ss can't see it (insufficient privs → returns -1, also a hit).
    expect(pid).not.toBeNull();
  });

  test("returns null for a free port", () => {
    expect(findListeningPid(59123)).toBeNull();
  });
});

describe("checkInotifyState", () => {
  beforeEach(() => clearInotifyCache());

  test("returns numeric snapshot or null on non-Linux", () => {
    const s = checkInotifyState();
    if (s === null) return; // non-Linux
    expect(s.used).toBeGreaterThanOrEqual(0);
    expect(s.limit).toBeGreaterThan(0);
    expect(s.ratio).toBeGreaterThanOrEqual(0);
  });

  test("results are cached for the TTL window", () => {
    const a = checkInotifyState();
    const b = checkInotifyState();
    expect(a).toEqual(b);
  });
});

describe("runSpawnPreflight", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    server?.stop(true);
    server = null;
    clearInotifyCache();
  });

  test("returns null for one-shot commands", () => {
    expect(runSpawnPreflight("ls -la", process.cwd())).toBeNull();
    expect(runSpawnPreflight("git status", process.cwd())).toBeNull();
    expect(runSpawnPreflight("npm install", process.cwd())).toBeNull();
  });

  test("returns null for server spawn on a free port", () => {
    // Use python http.server so the inotify-saturation branch (which
    // only fires for watch-mode frameworks like next/vite/nodemon) is
    // skipped. Otherwise this test would fail on dev hosts whose
    // /proc/sys/fs/inotify/max_user_instances is already saturated —
    // the very condition the preflight is designed to catch.
    const r = runSpawnPreflight("python3 -m http.server 59124", process.cwd());
    expect(r).toBeNull();
  });

  test("refuses when the declared port is occupied", () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("hi") });
    const r = runSpawnPreflight(`PORT=${server.port} npm run dev`, process.cwd());
    expect(r).not.toBeNull();
    expect(r!.refused).toBe(true);
    expect(r!.report).toContain("already in use");
    expect(r!.report).toContain(String(server.port));
    expect(r!.report).toContain("Options:");
  });

  test("refusal report mentions kill and port-change options", () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("hi") });
    const r = runSpawnPreflight(`next dev --port ${server.port}`, process.cwd());
    expect(r!.report).toMatch(/kill/i);
    expect(r!.report).toMatch(/different port/i);
    expect(r!.report).toMatch(/reuse/i);
  });
});
