import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync, existsSync } from "node:fs";
import { _resetShellRegistry, getShell, registerShell } from "../core/bg-shell-registry";
import { executeKillShell, killShellDefinition } from "./kill-shell";

beforeEach(() => {
  _resetShellRegistry();
});

afterEach(() => {
  _resetShellRegistry();
});

describe("killShellDefinition", () => {
  test("name is KillShell", () => {
    expect(killShellDefinition.name).toBe("KillShell");
  });

  test("requires shellId", () => {
    expect((killShellDefinition.input_schema as { required: string[] }).required).toEqual([
      "shellId",
    ]);
  });
});

describe("executeKillShell", () => {
  test("returns error if shellId missing", async () => {
    const r = await executeKillShell({});
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("shellId is required");
  });

  test("returns error for unknown shellId", async () => {
    const r = await executeKillShell({ shellId: "ghost" });
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("Unknown shellId");
  });

  test("removes already-exited shell from registry", async () => {
    const id = "deadshell";
    registerShell({
      shellId: id,
      pid: 999999, // dead
      command: "x",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    const r = await executeKillShell({ shellId: id });
    expect(r.is_error).toBeUndefined();
    expect(r.content).toContain("already exited");
    expect(getShell(id)).toBeUndefined();
  });

  test("purge=true deletes log file", async () => {
    const id = "purgable";
    const rec = registerShell({
      shellId: id,
      pid: 999999, // dead so killShell shortcuts to already-exited
      command: "x",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    writeFileSync(rec.logPath, "log to delete");
    expect(existsSync(rec.logPath)).toBe(true);
    const r = await executeKillShell({ shellId: id, purge: true });
    expect(r.is_error).toBeUndefined();
    expect(existsSync(rec.logPath)).toBe(false);
    expect(getShell(id)).toBeUndefined();
  });

  test("force=true mention in error message reflected", async () => {
    // We can't actually SIGKILL a real process safely in tests, but
    // we can verify that the API surface accepts force and that the
    // dead-shell shortcut still works.
    const id = "forceable";
    registerShell({
      shellId: id,
      pid: 999999,
      command: "x",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    const r = await executeKillShell({ shellId: id, force: true });
    // Dead pid is still detected as already-exited regardless of force flag
    expect(r.content).toContain("already exited");
  });
});
