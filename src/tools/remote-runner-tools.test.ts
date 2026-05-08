// KCode - Tests for BashOnRemote / ReadOnRemote tools
//
// Network round-trips are asserted in a single integration test that
// runs against 127.0.0.1 (loopback SSH must be set up — skipped in
// CI environments without sshd). The bulk of these tests cover input
// validation and the unknown-remote path, which don't need a live SSH.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { upsertRemote } from "../remote/remote-authorize";
import {
  executeBashOnRemote,
  executeReadOnRemote,
} from "./remote-runner-tools";

let tmpHome: string;
let prevKcodeHome: string | undefined;

beforeEach(() => {
  tmpHome = join("/tmp", `kcode-rrt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  prevKcodeHome = process.env.KCODE_HOME;
  process.env.KCODE_HOME = tmpHome;
});

afterEach(() => {
  if (prevKcodeHome === undefined) delete process.env.KCODE_HOME;
  else process.env.KCODE_HOME = prevKcodeHome;
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("BashOnRemote — validation", () => {
  test("rejects bad name", async () => {
    const r = await executeBashOnRemote({ name: "with spaces", command: "ls" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/name must match/);
  });

  test("rejects empty command", async () => {
    const r = await executeBashOnRemote({ name: "lap", command: "  " });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/command must not be empty/);
  });

  test("returns helpful error when remote not registered", async () => {
    const r = await executeBashOnRemote({ name: "nope", command: "echo ok" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/No remote named 'nope'/);
    expect(String(r.content)).toMatch(/RemoteAuthorize/);
  });
});

describe("ReadOnRemote — validation", () => {
  test("rejects bad name", async () => {
    const r = await executeReadOnRemote({ name: "bad name", path: "/etc/hostname" });
    expect(r.is_error).toBe(true);
  });

  test("rejects empty path", async () => {
    const r = await executeReadOnRemote({ name: "lap", path: "" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/path must not be empty/);
  });

  test("rejects path containing single quote", async () => {
    const r = await executeReadOnRemote({ name: "lap", path: "/tmp/foo's.txt" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/single quote/);
  });

  test("returns helpful error when remote not registered", async () => {
    const r = await executeReadOnRemote({ name: "nope", path: "/etc/hostname" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/No remote named 'nope'/);
  });
});

// Live integration test — requires the local box to accept SSH from
// itself (BatchMode=yes, key-based auth). We register a 'self' remote
// and run a simple command. Skipped if `ssh -o BatchMode=yes localhost
// echo` doesn't work (typical CI sandboxes don't allow this).
async function loopbackSshWorks(): Promise<boolean> {
  try {
    const { spawnSync } = require("node:child_process");
    const result = spawnSync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "StrictHostKeyChecking=accept-new", "127.0.0.1", "echo", "ok"],
      { encoding: "utf-8", timeout: 5_000 },
    );
    return result.status === 0 && result.stdout.includes("ok");
  } catch {
    return false;
  }
}

describe("BashOnRemote — live SSH (skipped if loopback SSH unavailable)", () => {
  test("runs echo via SSH and returns stdout + exit=0", async () => {
    if (!(await loopbackSshWorks())) {
      // Don't fail the suite in environments without loopback SSH;
      // this is exercised manually + via Curly's smoke test.
      return;
    }
    const user = process.env.USER ?? "user";
    upsertRemote({
      name: "self",
      target: `${user}@127.0.0.1`,
      addedAt: new Date().toISOString(),
      authorizedWithPubkey: "test",
    });
    const r = await executeBashOnRemote({ name: "self", command: "echo hello-from-remote" });
    expect(r.is_error).toBeFalsy();
    const out = String(r.content);
    expect(out).toMatch(/exit=0/);
    expect(out).toContain("hello-from-remote");
  }, 15_000);

  test("preserves non-zero exit codes", async () => {
    if (!(await loopbackSshWorks())) return;
    const user = process.env.USER ?? "user";
    upsertRemote({
      name: "self",
      target: `${user}@127.0.0.1`,
      addedAt: new Date().toISOString(),
      authorizedWithPubkey: "test",
    });
    const r = await executeBashOnRemote({ name: "self", command: "exit 7" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/exit=7/);
  }, 15_000);
});
