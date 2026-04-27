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
    const pid = findListeningPid(server.port!);
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
  });

  test("port refusal includes AUTHORIZED RECOVERY block (phase 6)", () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("hi") });
    // Phase 10: pass a fake cwd that does NOT match the test process's
    // real cwd, so the smart resolver picks the different-project
    // branch (which is the one with the "WITHOUT asking the user"
    // language and the ALTERNATIVE clause).
    const r = runSpawnPreflight(`next dev --port ${server.port}`, "/tmp/some-other-project-9f3e2");
    expect(r!.report).toContain("AUTHORIZED RECOVERY");
    expect(r!.report).toContain("WITHOUT asking the user");
    expect(r!.report).toMatch(/Step 1[\s\S]*kill/);
    expect(r!.report).toMatch(/Step \d[\s\S]*retry/);
    expect(r!.report).toContain("ALTERNATIVE");
  });
});
