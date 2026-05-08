// KCode - Tests for remote-authorize bootstrap
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { kcodePath } from "../core/paths";
import {
  buildAuthorizeSnippet,
  ensurePubkey,
  findRemote,
  readRemotes,
  removeRemote,
  upsertRemote,
} from "./remote-authorize";

const TEST_PUBKEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGfdSDX/VI71nSatXLZS9++S8RBy8mCJOVgisI/1fRND test@host";

let tmpHome: string;
let prevKcodeHome: string | undefined;

beforeEach(() => {
  tmpHome = join("/tmp", `kcode-remote-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  prevKcodeHome = process.env.KCODE_HOME;
  process.env.KCODE_HOME = tmpHome;
});

afterEach(() => {
  if (prevKcodeHome === undefined) delete process.env.KCODE_HOME;
  else process.env.KCODE_HOME = prevKcodeHome;
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("buildAuthorizeSnippet", () => {
  test("renders a single-line && chain that creates ~/.ssh, appends the pubkey, and chmods it", () => {
    const snippet = buildAuthorizeSnippet(TEST_PUBKEY);
    expect(snippet).toContain("mkdir -p ~/.ssh");
    expect(snippet).toContain("chmod 700 ~/.ssh");
    expect(snippet).toContain(`echo '${TEST_PUBKEY}' >> ~/.ssh/authorized_keys`);
    expect(snippet).toContain("chmod 600 ~/.ssh/authorized_keys");
    // Single-quoted to prevent the pubkey being expanded by the shell.
    expect(snippet).not.toContain(`echo "${TEST_PUBKEY}"`);
  });

  test("refuses to render snippet if pubkey contains a single quote (sanity check)", () => {
    expect(() => buildAuthorizeSnippet("ssh-ed25519 evil'injection==")).toThrow(
      /single quote/,
    );
  });
});

describe("readRemotes / writeRemotes / upsertRemote / removeRemote", () => {
  test("returns empty list when no file exists", () => {
    expect(readRemotes()).toEqual({ version: 1, remotes: [] });
  });

  test("upsertRemote adds, then updates", () => {
    upsertRemote({
      name: "lap",
      target: "curly@192.168.1.58",
      addedAt: "2026-05-08T00:00:00Z",
      authorizedWithPubkey: TEST_PUBKEY,
    });
    expect(readRemotes().remotes).toHaveLength(1);

    upsertRemote({
      name: "lap",
      target: "curly@192.168.1.58",
      addedAt: "2026-05-08T00:00:00Z",
      lastSeen: "2026-05-08T01:00:00Z",
      authorizedWithPubkey: TEST_PUBKEY,
    });
    const after = readRemotes().remotes;
    expect(after).toHaveLength(1);
    expect(after[0]?.lastSeen).toBe("2026-05-08T01:00:00Z");
  });

  test("findRemote returns matching entry or undefined", () => {
    upsertRemote({
      name: "lap",
      target: "curly@192.168.1.58",
      addedAt: "2026-05-08T00:00:00Z",
      authorizedWithPubkey: TEST_PUBKEY,
    });
    expect(findRemote("lap")?.target).toBe("curly@192.168.1.58");
    expect(findRemote("nope")).toBeUndefined();
  });

  test("removeRemote returns true on hit, false on miss", () => {
    upsertRemote({
      name: "lap",
      target: "curly@192.168.1.58",
      addedAt: "2026-05-08T00:00:00Z",
      authorizedWithPubkey: TEST_PUBKEY,
    });
    expect(removeRemote("lap")).toBe(true);
    expect(removeRemote("lap")).toBe(false);
    expect(readRemotes().remotes).toHaveLength(0);
  });

  test("file is written with mode 600", async () => {
    upsertRemote({
      name: "x",
      target: "u@h",
      addedAt: "2026-05-08T00:00:00Z",
      authorizedWithPubkey: TEST_PUBKEY,
    });
    const path = kcodePath("remotes.json");
    const stat = await import("node:fs").then((fs) => fs.statSync(path));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("malformed JSON returns empty list (does not throw)", () => {
    mkdirSync(kcodePath(), { recursive: true });
    writeFileSync(kcodePath("remotes.json"), "{ not valid json", "utf-8");
    expect(readRemotes()).toEqual({ version: 1, remotes: [] });
  });

  test("future version is ignored gracefully", () => {
    mkdirSync(kcodePath(), { recursive: true });
    writeFileSync(kcodePath("remotes.json"), JSON.stringify({ version: 99, remotes: [] }), "utf-8");
    expect(readRemotes()).toEqual({ version: 1, remotes: [] });
  });
});

describe("ensurePubkey", () => {
  test("uses an existing id_ed25519.pub if present", () => {
    // Point HOME at a tmp dir so we don't clobber the real ~/.ssh
    const fakeHome = join(tmpHome, "fakehome");
    mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
    writeFileSync(join(fakeHome, ".ssh", "id_ed25519.pub"), `${TEST_PUBKEY}\n`);

    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const result = ensurePubkey();
      expect(result.path).toBe(join(fakeHome, ".ssh", "id_ed25519.pub"));
      expect(result.content).toBe(TEST_PUBKEY);
    } finally {
      if (prevHome) process.env.HOME = prevHome;
      else delete process.env.HOME;
    }
  });

  // Note: we don't test the keygen path here because ssh-keygen isn't always
  // available in CI sandboxes and writing real keys to disk is undesirable.
  // The real-machine smoke test covers it (Curly's ~/.ssh/id_ed25519 already
  // exists, so `kcode remote authorize` exercises the existing-key branch).

  test("returns the real user pubkey when one exists in the actual home dir", () => {
    // Skip this test if no key exists — it's a smoke test, not a unit test.
    const realPubPath = join(homedir(), ".ssh", "id_ed25519.pub");
    if (!existsSync(realPubPath)) return;
    const result = ensurePubkey();
    expect(result.content.startsWith("ssh-")).toBe(true);
  });
});
