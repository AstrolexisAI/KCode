// KCode - Tests for RemoteAuthorize tool
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { upsertRemote } from "../remote/remote-authorize";
import { executeRemoteAuthorize } from "./remote-authorize-tool";

let tmpHome: string;
let prevKcodeHome: string | undefined;
let fakeHome: string;
let prevHome: string | undefined;

const TEST_PUBKEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGfdSDX/VI71nSatXLZS9++S8RBy8mCJOVgisI/1fRND test@host";

beforeEach(() => {
  // Isolate KCODE_HOME so tool writes go to a tmp dir.
  tmpHome = join("/tmp", `kcode-remote-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  prevKcodeHome = process.env.KCODE_HOME;
  process.env.KCODE_HOME = tmpHome;

  // Isolate HOME so ensurePubkey reads our pre-staged fake key.
  fakeHome = join(tmpHome, "fakehome");
  mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
  require("node:fs").writeFileSync(
    join(fakeHome, ".ssh", "id_ed25519.pub"),
    `${TEST_PUBKEY}\n`,
  );
  prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (prevKcodeHome === undefined) delete process.env.KCODE_HOME;
  else process.env.KCODE_HOME = prevKcodeHome;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("RemoteAuthorize tool", () => {
  test("rejects malformed name", async () => {
    const result = await executeRemoteAuthorize({
      step: "issue",
      name: "bad name with spaces",
      target: "user@host",
    });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toMatch(/name must match/);
  });

  test("rejects malformed target", async () => {
    const result = await executeRemoteAuthorize({
      step: "issue",
      name: "lap",
      target: "not a target",
    });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toMatch(/target must look like/);
  });

  test("rejects unknown step", async () => {
    const result = await executeRemoteAuthorize({
      step: "fobar",
      name: "lap",
      target: "user@host",
    });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toMatch(/unknown step/);
  });

  test("step='issue' returns the snippet with the user's pubkey", async () => {
    const result = await executeRemoteAuthorize({
      step: "issue",
      name: "lap",
      target: "curly@192.168.1.58",
    });
    expect(result.is_error).toBeFalsy();
    const out = String(result.content);
    expect(out).toContain(TEST_PUBKEY);
    expect(out).toContain("authorized_keys");
    expect(out).toContain("curly@192.168.1.58");
    expect(out).toContain("step='verify'");
  });

  test("step='issue' refuses if remote already exists", async () => {
    upsertRemote({
      name: "lap",
      target: "curly@192.168.1.58",
      addedAt: "2026-05-08T00:00:00Z",
      authorizedWithPubkey: TEST_PUBKEY,
    });
    const result = await executeRemoteAuthorize({
      step: "issue",
      name: "lap",
      target: "curly@192.168.1.58",
    });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toMatch(/already exists/);
  });

  test(
    "step='verify' fails cleanly when SSH does not work (no remote registered)",
    async () => {
      // 192.0.2.1 is TEST-NET-1 RFC 5737 — guaranteed-unreachable.
      // SSH ConnectTimeout=8s, our wrapper times out at 15s.
      const result = await executeRemoteAuthorize({
        step: "verify",
        name: "deadhost",
        target: "nobody@192.0.2.1",
      });
      expect(result.is_error).toBe(true);
      expect(String(result.content)).toMatch(/SSH to .* still failed/);

      // Crucial: nothing should have been registered.
      const remotes = require("../remote/remote-authorize").readRemotes();
      expect(remotes.remotes).toHaveLength(0);
    },
    20_000,
  );

  test("accepts valid name and target shapes (regex sanity)", async () => {
    const validShapes: Array<[string, string]> = [
      ["lap", "user@host"],
      ["mac-office", "u@1.2.3.4"],
      ["server_42", "user@host:2222"],
      ["A1", "host"],
      ["a", "host:22"],
    ];
    for (const [name, target] of validShapes) {
      const result = await executeRemoteAuthorize({ step: "issue", name, target });
      const out = String(result.content);
      expect({ name, target, error: result.is_error, ok: out.includes(TEST_PUBKEY) }).toEqual({
        name,
        target,
        error: undefined,
        ok: true,
      });
    }
  });
});
