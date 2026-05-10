import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { _resetShellRegistry, registerShell } from "../core/bg-shell-registry";
import { bashOutputDefinition, executeBashOutput } from "./bash-output";

beforeEach(() => {
  _resetShellRegistry();
});

afterEach(() => {
  _resetShellRegistry();
});

describe("bashOutputDefinition", () => {
  test("name is BashOutput", () => {
    expect(bashOutputDefinition.name).toBe("BashOutput");
  });

  test("schema accepts shellId + tailBytes, no required fields", () => {
    expect(bashOutputDefinition.input_schema.properties).toHaveProperty("shellId");
    expect(bashOutputDefinition.input_schema.properties).toHaveProperty("tailBytes");
    expect((bashOutputDefinition.input_schema as { required?: unknown }).required).toBeUndefined();
  });
});

describe("executeBashOutput — list mode", () => {
  test("with no shellId and no shells registered, says so", async () => {
    const r = await executeBashOutput({});
    expect(r.content).toContain("No background shells registered");
  });

  test("with no shellId and shells present, lists them", async () => {
    registerShell({
      shellId: "abc12345",
      pid: process.pid, // alive
      command: "sleep 60",
      startedAt: Date.now() - 5000,
      cwd: "/tmp",
    });
    registerShell({
      shellId: "def67890",
      pid: 999999, // dead
      command: "echo done",
      startedAt: Date.now() - 10000,
      cwd: "/tmp",
    });
    const r = await executeBashOutput({});
    expect(r.content).toContain("abc12345");
    expect(r.content).toContain("def67890");
    expect(r.content).toContain("RUNNING");
    expect(r.content).toContain("EXITED");
  });
});

describe("executeBashOutput — single shell mode", () => {
  test("returns header + content for a known shell", async () => {
    const id = "test1234";
    const rec = registerShell({
      shellId: id,
      pid: process.pid,
      command: "ls /",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    writeFileSync(rec.logPath, "drwxr-xr-x  bin\ndrwxr-xr-x  etc\n");
    const r = await executeBashOutput({ shellId: id });
    expect(r.content).toContain("[shellId: test1234]");
    expect(r.content).toContain("RUNNING");
    expect(r.content).toContain("drwxr-xr-x  bin");
  });

  test("returns error for unknown shellId", async () => {
    const r = await executeBashOutput({ shellId: "ghost" });
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("Unknown shellId");
  });

  test("respects tailBytes for large logs", async () => {
    const id = "bigshell";
    const rec = registerShell({
      shellId: id,
      pid: process.pid,
      command: "yes | head -c 5000",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    writeFileSync(rec.logPath, "x".repeat(10000) + "FINAL");
    const r = await executeBashOutput({ shellId: id, tailBytes: 200 });
    expect(r.content).toContain("FINAL");
    expect(r.content).toContain("showing last 200 bytes");
  });

  test("handles empty log gracefully (recently spawned, no output yet)", async () => {
    const id = "empty";
    registerShell({
      shellId: id,
      pid: process.pid,
      command: "sleep 10",
      startedAt: Date.now(),
      cwd: "/tmp",
    });
    const r = await executeBashOutput({ shellId: id });
    expect(r.content).toContain("(no output yet)");
  });
});
