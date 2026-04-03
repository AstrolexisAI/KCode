// Keychain — Cross-platform secure credential storage.
// Linux: libsecret (GNOME Keyring / KDE Wallet)
// macOS: security (Keychain Access)
// Windows: cmdkey (Credential Manager)
// Fallback: encrypted file in ~/.kcode/credentials.enc

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVICE = "kcode";
const FALLBACK_DIR = join(homedir(), ".kcode");
const FALLBACK_FILE = join(FALLBACK_DIR, "credentials.enc");
const SALT_FILE = join(FALLBACK_DIR, "credentials.salt");

// ── Platform-specific implementations ──

async function darwinSet(account: string, secret: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["security", "add-generic-password", "-s", SERVICE, "-a", account, "-w", secret, "-U"],
    { stderr: "pipe" },
  );
  await proc.exited;
  return proc.exitCode === 0;
}

async function darwinGet(account: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode === 0 ? output.trim() || null : null;
  } catch {
    return null;
  }
}

async function darwinDelete(account: string): Promise<boolean> {
  const proc = Bun.spawn(["security", "delete-generic-password", "-s", SERVICE, "-a", account], {
    stderr: "pipe",
  });
  await proc.exited;
  return proc.exitCode === 0;
}

async function linuxSet(account: string, secret: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      [
        "secret-tool",
        "store",
        "--label",
        `KCode: ${account}`,
        "service",
        SERVICE,
        "account",
        account,
      ],
      { stdin: new TextEncoder().encode(secret), stderr: "pipe" },
    );
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function linuxGet(account: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["secret-tool", "lookup", "service", SERVICE, "account", account], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode === 0 ? output.trim() || null : null;
  } catch {
    return null;
  }
}

async function linuxDelete(account: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["secret-tool", "clear", "service", SERVICE, "account", account], {
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function win32Set(account: string, secret: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["cmdkey", `/add:${SERVICE}:${account}`, "/user:kcode", `/pass:${secret}`],
      { stderr: "pipe" },
    );
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function win32Get(account: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      [
        "powershell",
        "-NoProfile",
        "-Command",
        `(Get-StoredCredential -Target "${SERVICE}:${account}").GetNetworkCredential().Password`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode === 0 ? output.trim() || null : null;
  } catch {
    return null;
  }
}

async function win32Delete(account: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["cmdkey", `/delete:${SERVICE}:${account}`], { stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

// ── Fallback: encrypted file ──

/**
 * Get or create a random per-installation salt for key derivation.
 * On first use, generates 32 random bytes and saves to ~/.kcode/credentials.salt.
 * This avoids using predictable values like /etc/machine-id as salt.
 */
async function getOrCreateSalt(): Promise<Uint8Array> {
  try {
    const saltFile = Bun.file(SALT_FILE);
    if (await saltFile.exists()) {
      const existing = new Uint8Array(await saltFile.arrayBuffer());
      if (existing.length >= 32) return existing.slice(0, 32);
    }
  } catch {
    // Fall through to generate new salt
  }

  const salt = crypto.getRandomValues(new Uint8Array(32));
  try {
    mkdirSync(FALLBACK_DIR, { recursive: true });
    await Bun.write(SALT_FILE, salt);
  } catch {
    // If we can't persist, still use it for this session
  }
  return salt;
}

async function deriveKey(): Promise<CryptoKey> {
  const salt = await getOrCreateSalt();

  // Use machine-id as key material (not as salt) — provides machine binding
  let keyData: Uint8Array;
  try {
    const machineId = existsSync("/etc/machine-id")
      ? await Bun.file("/etc/machine-id").text()
      : `${homedir()}-${process.env.USER ?? "kcode"}`;
    keyData = new TextEncoder().encode(machineId.trim().slice(0, 64).padEnd(64, "0"));
  } catch {
    keyData = new TextEncoder().encode(homedir().padEnd(64, "0").slice(0, 64));
  }

  const keyMaterial = await crypto.subtle.importKey("raw", keyData, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function fallbackRead(): Promise<Record<string, string>> {
  try {
    const file = Bun.file(FALLBACK_FILE);
    if (!(await file.exists())) return {};
    const encrypted = await file.arrayBuffer();
    const key = await deriveKey();
    const iv = new Uint8Array(encrypted.slice(0, 12));
    const data = new Uint8Array(encrypted.slice(12));
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    return {};
  }
}

async function fallbackWrite(entries: Record<string, string>): Promise<void> {
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(entries));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const combined = new Uint8Array(iv.length + new Uint8Array(encrypted).length);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  await Bun.write(FALLBACK_FILE, combined);
}

async function fallbackSet(account: string, secret: string): Promise<boolean> {
  try {
    const entries = await fallbackRead();
    entries[account] = secret;
    await fallbackWrite(entries);
    return true;
  } catch {
    return false;
  }
}

async function fallbackGet(account: string): Promise<string | null> {
  const entries = await fallbackRead();
  return entries[account] ?? null;
}

async function fallbackDelete(account: string): Promise<boolean> {
  try {
    const entries = await fallbackRead();
    if (!(account in entries)) return false;
    delete entries[account];
    await fallbackWrite(entries);
    return true;
  } catch {
    return false;
  }
}

// ── Public API ──

/** Store a secret in the OS keychain (with fallback to encrypted file) */
export async function setSecret(account: string, secret: string): Promise<boolean> {
  const platform = process.platform;
  let success = false;

  if (platform === "darwin") success = await darwinSet(account, secret);
  else if (platform === "linux") success = await linuxSet(account, secret);
  else if (platform === "win32") success = await win32Set(account, secret);

  if (!success) success = await fallbackSet(account, secret);
  return success;
}

/** Retrieve a secret from the OS keychain (with fallback) */
export async function getSecret(account: string): Promise<string | null> {
  const platform = process.platform;
  let secret: string | null = null;

  if (platform === "darwin") secret = await darwinGet(account);
  else if (platform === "linux") secret = await linuxGet(account);
  else if (platform === "win32") secret = await win32Get(account);

  if (!secret) secret = await fallbackGet(account);
  return secret;
}

/** Delete a secret from the OS keychain (and fallback) */
export async function deleteSecret(account: string): Promise<boolean> {
  const platform = process.platform;
  let deleted = false;

  if (platform === "darwin") deleted = await darwinDelete(account);
  else if (platform === "linux") deleted = await linuxDelete(account);
  else if (platform === "win32") deleted = await win32Delete(account);

  // Also try fallback in case it was stored there
  const fallbackDeleted = await fallbackDelete(account);
  return deleted || fallbackDeleted;
}

/** Check if the native keychain backend is available */
export async function isKeychainAvailable(): Promise<boolean> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      const p = Bun.spawn(["security", "help"], { stderr: "pipe" });
      await p.exited;
      return true;
    }
    if (platform === "linux") {
      const p = Bun.spawn(["which", "secret-tool"], { stdout: "pipe" });
      await p.exited;
      return p.exitCode === 0;
    }
    if (platform === "win32") {
      const p = Bun.spawn(["where", "cmdkey"], { stdout: "pipe" });
      await p.exited;
      return p.exitCode === 0;
    }
  } catch {
    /* cleanup — ignore failures */
  }
  return false;
}

/** List accounts stored in the keychain (fallback only) */
export async function listAccounts(): Promise<string[]> {
  const entries = await fallbackRead();
  return Object.keys(entries);
}
