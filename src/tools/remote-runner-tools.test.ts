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
  executeEditOnRemote,
  executeGlobOnRemote,
  executeGrepOnRemote,
  executeReadOnRemote,
  executeWriteOnRemote,
} from "./remote-runner-tools";

const TEST_PUBKEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGfdSDX/VI71nSatXLZS9++S8RBy8mCJOVgisI/1fRND test@host";

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

describe("WriteOnRemote — validation", () => {
  test("rejects empty path", async () => {
    const r = await executeWriteOnRemote({ name: "lap", path: "", content: "x" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/path must not be empty/);
  });

  test("rejects path with single quote", async () => {
    const r = await executeWriteOnRemote({ name: "lap", path: "/tmp/x's.txt", content: "x" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/single quote/);
  });

  test("returns helpful error when remote not registered", async () => {
    const r = await executeWriteOnRemote({ name: "nope", path: "/tmp/x", content: "" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/No remote named 'nope'/);
  });
});

describe("EditOnRemote — validation", () => {
  test("rejects empty old_string", async () => {
    const r = await executeEditOnRemote({
      name: "lap",
      path: "/tmp/x",
      old_string: "",
      new_string: "y",
    });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/old_string must not be empty/);
  });

  test("rejects identical old_string and new_string", async () => {
    const r = await executeEditOnRemote({
      name: "lap",
      path: "/tmp/x",
      old_string: "same",
      new_string: "same",
    });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/identical/);
  });

  test("returns helpful error when remote not registered", async () => {
    const r = await executeEditOnRemote({
      name: "nope",
      path: "/tmp/x",
      old_string: "a",
      new_string: "b",
    });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/No remote named 'nope'/);
  });
});

describe("GlobOnRemote / GrepOnRemote — validation", () => {
  test("Glob rejects empty pattern", async () => {
    const r = await executeGlobOnRemote({ name: "lap", pattern: " " });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/pattern must not be empty/);
  });
  test("Glob rejects pattern with single quote", async () => {
    upsertRemote({
      name: "lap",
      target: "u@h",
      addedAt: new Date().toISOString(),
      authorizedWithPubkey: TEST_PUBKEY,
    });
    const r = await executeGlobOnRemote({ name: "lap", pattern: "x'.txt" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/single quote/);
  });
  test("Glob errors when remote not registered", async () => {
    const r = await executeGlobOnRemote({ name: "nope", pattern: "*.ts" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/No remote named 'nope'/);
  });
  test("Grep rejects empty pattern", async () => {
    const r = await executeGrepOnRemote({ name: "lap", pattern: "" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/pattern must not be empty/);
  });
  test("Grep rejects pattern with single quote", async () => {
    upsertRemote({
      name: "lap",
      target: "u@h",
      addedAt: new Date().toISOString(),
      authorizedWithPubkey: TEST_PUBKEY,
    });
    const r = await executeGrepOnRemote({ name: "lap", pattern: "foo'bar" });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/single quote/);
  });
});

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

describe("WriteOnRemote / EditOnRemote — live SSH round-trip", () => {
  test("writes a file then reads it back, then edits it, then reads again", async () => {
    if (!(await loopbackSshWorks())) return;
    const user = process.env.USER ?? "user";
    upsertRemote({
      name: "self",
      target: `${user}@127.0.0.1`,
      addedAt: new Date().toISOString(),
      authorizedWithPubkey: "test",
    });

    const tmpPath = `/tmp/kcode-rrt-roundtrip-${Date.now()}.txt`;
    const initial = "alpha\nbeta\ngamma\n";

    // Write
    const w = await executeWriteOnRemote({ name: "self", path: tmpPath, content: initial });
    expect(w.is_error).toBeFalsy();
    expect(String(w.content)).toMatch(/Wrote \d+ bytes/);

    // Read back
    const r1 = await executeReadOnRemote({ name: "self", path: tmpPath });
    expect(r1.is_error).toBeFalsy();
    expect(String(r1.content)).toContain(initial);

    // Edit
    const e = await executeEditOnRemote({
      name: "self",
      path: tmpPath,
      old_string: "beta",
      new_string: "BETA",
    });
    expect(e.is_error).toBeFalsy();
    expect(String(e.content)).toMatch(/1 replacement/);

    // Read after edit
    const r2 = await executeReadOnRemote({ name: "self", path: tmpPath });
    expect(r2.is_error).toBeFalsy();
    expect(String(r2.content)).toContain("BETA");
    expect(String(r2.content)).not.toContain("\nbeta\n");

    // Cleanup
    await executeBashOnRemote({ name: "self", command: `rm -f '${tmpPath}'` });
  }, 30_000);

  test("GlobOnRemote finds files by name pattern", async () => {
    if (!(await loopbackSshWorks())) return;
    const user = process.env.USER ?? "user";
    upsertRemote({
      name: "self",
      target: `${user}@127.0.0.1`,
      addedAt: new Date().toISOString(),
      authorizedWithPubkey: "test",
    });
    // Stage 3 files in /tmp
    const stamp = `${Date.now()}`;
    const dir = `/tmp/kcode-glob-test-${stamp}`;
    await executeBashOnRemote({
      name: "self",
      command: `mkdir -p '${dir}' && touch '${dir}/a.txt' '${dir}/b.txt' '${dir}/skip.md'`,
    });
    const r = await executeGlobOnRemote({ name: "self", pattern: "*.txt", path: dir });
    expect(r.is_error).toBeFalsy();
    const out = String(r.content);
    expect(out).toContain("a.txt");
    expect(out).toContain("b.txt");
    expect(out).not.toContain("skip.md");
    await executeBashOnRemote({ name: "self", command: `rm -rf '${dir}'` });
  }, 30_000);

  test("GrepOnRemote finds matching lines", async () => {
    if (!(await loopbackSshWorks())) return;
    const user = process.env.USER ?? "user";
    upsertRemote({
      name: "self",
      target: `${user}@127.0.0.1`,
      addedAt: new Date().toISOString(),
      authorizedWithPubkey: "test",
    });
    const stamp = `${Date.now()}`;
    const dir = `/tmp/kcode-grep-test-${stamp}`;
    await executeBashOnRemote({
      name: "self",
      command: `mkdir -p '${dir}' && printf 'hello\\nNEEDLE here\\nnope\\n' > '${dir}/a.txt' && printf 'no match\\n' > '${dir}/b.txt'`,
    });
    const r = await executeGrepOnRemote({ name: "self", pattern: "NEEDLE", path: dir });
    expect(r.is_error).toBeFalsy();
    const out = String(r.content);
    expect(out).toContain("a.txt:2:NEEDLE here");
    expect(out).not.toContain("b.txt");
    await executeBashOnRemote({ name: "self", command: `rm -rf '${dir}'` });
  }, 30_000);

  test("EditOnRemote refuses ambiguous match without replace_all", async () => {
    if (!(await loopbackSshWorks())) return;
    const user = process.env.USER ?? "user";
    upsertRemote({
      name: "self",
      target: `${user}@127.0.0.1`,
      addedAt: new Date().toISOString(),
      authorizedWithPubkey: "test",
    });
    const tmpPath = `/tmp/kcode-edit-ambig-${Date.now()}.txt`;
    await executeWriteOnRemote({ name: "self", path: tmpPath, content: "x x x\n" });
    const e = await executeEditOnRemote({
      name: "self",
      path: tmpPath,
      old_string: "x",
      new_string: "y",
    });
    expect(e.is_error).toBe(true);
    expect(String(e.content)).toMatch(/matches 3 times/);
    await executeBashOnRemote({ name: "self", command: `rm -f '${tmpPath}'` });
  }, 30_000);
});
