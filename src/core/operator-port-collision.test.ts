// Tests for phase 10 — smart port-collision resolution that distinguishes
// "occupant is your same project (hot-reload will pick up the edits)"
// from "occupant is a different project (kill or pick another port)".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cwdsAreSameProject, getProcessCwd, runSpawnPreflight } from "./bash-spawn-preflight";

describe("getProcessCwd", () => {
  test("returns the cwd of the current process", () => {
    const cwd = getProcessCwd(process.pid);
    expect(cwd).not.toBeNull();
    expect(typeof cwd).toBe("string");
    expect(cwd!.length).toBeGreaterThan(0);
  });

  test("returns null for a garbage PID", () => {
    expect(getProcessCwd(9999998)).toBeNull();
  });

  test("returns null for non-positive PIDs", () => {
    expect(getProcessCwd(0)).toBeNull();
    expect(getProcessCwd(-1)).toBeNull();
  });
});

describe("cwdsAreSameProject", () => {
  test("identical paths match", () => {
    expect(cwdsAreSameProject("/home/curly/projects/my-site", "/home/curly/projects/my-site")).toBe(
      true,
    );
  });

  test("subdirectory matches parent", () => {
    expect(
      cwdsAreSameProject("/home/curly/projects/my-site", "/home/curly/projects/my-site/src"),
    ).toBe(true);
  });

  test("parent matches subdirectory", () => {
    expect(
      cwdsAreSameProject("/home/curly/projects/my-site/src", "/home/curly/projects/my-site"),
    ).toBe(true);
  });

  test("siblings do NOT match", () => {
    expect(cwdsAreSameProject("/home/curly/projects/site-a", "/home/curly/projects/site-b")).toBe(
      false,
    );
  });

  test("unrelated paths do NOT match", () => {
    expect(cwdsAreSameProject("/home/curly/projects", "/tmp")).toBe(false);
  });

  test("null inputs return false", () => {
    expect(cwdsAreSameProject(null, "/x")).toBe(false);
    expect(cwdsAreSameProject("/x", null)).toBe(false);
    expect(cwdsAreSameProject(null, null)).toBe(false);
  });

  test("trailing-slash differences do not break the match", () => {
    expect(cwdsAreSameProject("/x/y/", "/x/y")).toBe(true);
    expect(cwdsAreSameProject("/x/y", "/x/y/z/")).toBe(true);
  });

  test("prefix-but-not-subdirectory does NOT match", () => {
    // /x/yz starts with "/x/y" textually but isn't a subdirectory.
    // The trailing-slash normalization in the implementation prevents this.
    expect(cwdsAreSameProject("/x/y", "/x/yz")).toBe(false);
  });
});

describe("runSpawnPreflight — port collision smart resolution (phase 10)", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  test("same-project occupant: refusal recommends treating as success", () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("hi") });
    // The bun process running this test has a cwd that should match
    // process.cwd() — so getProcessCwd(server.pid) === process.cwd().
    const r = runSpawnPreflight(`PORT=${server.port} npm run dev`, process.cwd());
    expect(r).not.toBeNull();
    expect(r!.refused).toBe(true);
    // Same-project banner
    expect(r!.report).toContain("inside YOUR current working directory");
    expect(r!.report).toContain("hot-reload");
    // Recommends success-path
    expect(r!.report).toContain("Treat this as a success");
    expect(r!.report).toContain("curling http://localhost:");
    // Still includes the AUTHORIZED RECOVERY for edge cases
    expect(r!.report).toContain("AUTHORIZED RECOVERY");
    expect(r!.report).toMatch(/only if hot-reload truly is not enough/i);
  });

  test("different-project occupant: refusal uses the kill-or-switch path", () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("hi") });
    // Pretend the spawn is happening from /tmp, which is NOT the cwd of
    // the test process (which lives in /home/curly/KCode). The occupant's
    // real cwd is the test process cwd, so cwds differ.
    const fakeCwd = "/tmp/some-other-project-9f3e2";
    const r = runSpawnPreflight(`PORT=${server.port} npm run dev`, fakeCwd);
    expect(r).not.toBeNull();
    expect(r!.refused).toBe(true);
    // Different-project warning
    expect(r!.report).toMatch(/OUTSIDE your current[\s\S]*working directory/);
    // Standard recovery block
    expect(r!.report).toContain("AUTHORIZED RECOVERY");
    expect(r!.report).toContain("WITHOUT asking the user");
    expect(r!.report).toMatch(/Step 1[\s\S]*kill/);
    expect(r!.report).toContain("ALTERNATIVE");
  });
});
