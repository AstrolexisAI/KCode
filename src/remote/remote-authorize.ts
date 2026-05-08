// KCode - Remote authorization bootstrap
//
// Bridges the gap between "no SSH access" and the rest of the
// remote/* infrastructure (which assumes BatchMode SSH already works).
//
// Flow:
//   1. Locate or generate the user's SSH keypair (~/.ssh/id_ed25519).
//   2. Show the user the exact snippet to run on the target host so it
//      appends our pubkey to the target's authorized_keys.
//   3. Wait for the user to confirm they ran it.
//   4. Test connectivity. If green, register the remote in
//      ~/.kcode/remotes.json so other commands can refer to it by name.
//
// Security: pubkeys are public; nothing secret leaves this machine.
// The snippet uses single-quoted echo so the pubkey can't be evaluated
// as a shell command on the target. We refuse to operate on private
// keys — only the .pub side.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { kcodePath } from "../core/paths";

export interface RemoteEntry {
  /** Friendly name (e.g. "laptop-mac"). */
  name: string;
  /** SSH target string: user@host or host. */
  target: string;
  /** SHA256 fingerprint of the host key seen at registration. */
  hostFingerprint?: string;
  /** ISO timestamp of registration. */
  addedAt: string;
  /** Last successful connection (ISO). */
  lastSeen?: string;
  /** Pubkey used to authorize this remote (so we can show it back). */
  authorizedWithPubkey: string;
}

interface RemotesFile {
  version: 1;
  remotes: RemoteEntry[];
}

const REMOTES_FILE_VERSION = 1;

function remotesPath(): string {
  return kcodePath("remotes.json");
}

export function readRemotes(): RemotesFile {
  const path = remotesPath();
  if (!existsSync(path)) {
    return { version: REMOTES_FILE_VERSION, remotes: [] };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RemotesFile>;
    if (parsed.version !== REMOTES_FILE_VERSION) {
      // Forward-compat: keep the file, return empty so we don't corrupt it.
      return { version: REMOTES_FILE_VERSION, remotes: [] };
    }
    return { version: REMOTES_FILE_VERSION, remotes: parsed.remotes ?? [] };
  } catch {
    return { version: REMOTES_FILE_VERSION, remotes: [] };
  }
}

export function writeRemotes(file: RemotesFile): void {
  const path = remotesPath();
  const dir = kcodePath();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
}

export function findRemote(name: string): RemoteEntry | undefined {
  return readRemotes().remotes.find((r) => r.name === name);
}

export function upsertRemote(entry: RemoteEntry): void {
  const file = readRemotes();
  const idx = file.remotes.findIndex((r) => r.name === entry.name);
  if (idx >= 0) {
    file.remotes[idx] = entry;
  } else {
    file.remotes.push(entry);
  }
  writeRemotes(file);
}

export function removeRemote(name: string): boolean {
  const file = readRemotes();
  const before = file.remotes.length;
  file.remotes = file.remotes.filter((r) => r.name !== name);
  if (file.remotes.length === before) return false;
  writeRemotes(file);
  return true;
}

/** Locate the user's preferred SSH pubkey. Generates an ed25519 pair if none exists. */
export function ensurePubkey(): { path: string; content: string } {
  // Read HOME at call time so test env overrides work; fall back to homedir().
  const home = process.env.HOME ?? homedir();
  const sshDir = join(home, ".ssh");
  const candidates = ["id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub"];
  for (const name of candidates) {
    const p = join(sshDir, name);
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8").trim();
      if (content.length > 0) return { path: p, content };
    }
  }

  // Generate a new ed25519 key.
  if (!existsSync(sshDir)) {
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }
  const keyPath = join(sshDir, "id_ed25519");
  const comment = `kcode-remote@${process.env.USER ?? "user"}`;
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath], {
    stdio: "pipe",
  });
  const pubPath = `${keyPath}.pub`;
  return { path: pubPath, content: readFileSync(pubPath, "utf-8").trim() };
}

/**
 * Render the snippet the user must run on the target host. We single-quote
 * the pubkey so even if it contained shell metacharacters (it shouldn't —
 * pubkeys are base64), it can't be re-evaluated.
 */
export function buildAuthorizeSnippet(pubkey: string): string {
  // Hard-fail on stray single quotes — sanity check, not realistic input.
  if (pubkey.includes("'")) {
    throw new Error("pubkey contains a single quote; refusing to render snippet");
  }
  return [
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
    `echo '${pubkey}' >> ~/.ssh/authorized_keys`,
    "chmod 600 ~/.ssh/authorized_keys",
  ].join(" && ");
}

/**
 * Test SSH connectivity using the same options as the rest of remote/*:
 * BatchMode=yes (so we don't hang on a password prompt) + a short timeout.
 * Returns true if the remote echoed back our probe.
 */
export function testConnectivity(target: string): boolean {
  const result = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "StrictHostKeyChecking=accept-new",
      target,
      "echo",
      "kcode-ok",
    ],
    { encoding: "utf-8", timeout: 15_000 },
  );
  return result.status === 0 && result.stdout.includes("kcode-ok");
}

/** Best-effort host key fingerprint for the audit/registry. */
export function fetchHostFingerprint(host: string): string | undefined {
  try {
    const hostOnly = host.includes("@") ? host.split("@")[1]! : host;
    // ssh-keyscan exits 0 even when no keys are returned, so check stdout.
    const scan = spawnSync("ssh-keyscan", ["-T", "5", "-t", "ed25519,rsa", hostOnly], {
      encoding: "utf-8",
      timeout: 8_000,
    });
    if (!scan.stdout) return undefined;
    // Pipe the scanned keys to ssh-keygen -lf - to compute fingerprint.
    const fp = spawnSync("ssh-keygen", ["-lf", "-"], {
      input: scan.stdout,
      encoding: "utf-8",
      timeout: 5_000,
    });
    if (fp.status !== 0) return undefined;
    return fp.stdout.split("\n")[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}
