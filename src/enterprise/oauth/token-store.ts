// KCode - OAuth Token Store
// Secure token storage with platform-specific backends.
// macOS: Keychain, Linux: secret-tool (fallback: file), Windows: file fallback

import { join } from "node:path";
import { log } from "../../core/logger";
import { kcodeHome } from "../../core/paths";
import type { OAuthTokens } from "../types";

// ─── Constants ──────────────────────────────────────────────────

const KEYCHAIN_ACCOUNT = "kcode";
const KEYCHAIN_SERVICE = "kcode-oauth";
const SECRET_TOOL_LABEL = "KCode OAuth";
const FALLBACK_PATH = () => join(kcodeHome(), "tokens.json");
const SUBPROCESS_TIMEOUT_MS = 5_000;

// ─── Issuer Normalization ───────────────────────────────────────

/**
 * Normalize an OAuth issuer URL for consistent cache lookups.
 * - Lowercases the host
 * - Removes trailing slashes
 * - Ensures https:// prefix
 */
export function normalizeIssuer(issuer: string): string {
  try {
    const url = new URL(issuer.includes("://") ? issuer : `https://${issuer}`);
    // Lowercase host, remove trailing slash, preserve path
    const path = url.pathname.replace(/\/+$/, "") || "";
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    // If URL parsing fails, just normalize basic patterns
    return issuer.toLowerCase().replace(/\/+$/, "");
  }
}

// ─── Helpers ────────────────────────────────────────────────────

async function runCommand(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin ? "pipe" : undefined,
    });

    if (stdin && proc.stdin) {
      proc.stdin.write(new TextEncoder().encode(stdin));
      proc.stdin.end();
    }

    const timeoutPromise = new Promise<{ ok: false; stdout: "" }>((resolve) => {
      setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        resolve({ ok: false, stdout: "" });
      }, SUBPROCESS_TIMEOUT_MS);
    });

    const resultPromise = proc.exited.then(async (code) => {
      const stdout = await new Response(proc.stdout).text();
      return { ok: code === 0, stdout: stdout.trim() };
    });

    return await Promise.race([resultPromise, timeoutPromise]);
  } catch (err) {
    log.debug("config", `Token store command failed (${cmd}): ${err}`);
    return { ok: false, stdout: "" };
  }
}

// ─── macOS Keychain ─────────────────────────────────────────────

async function saveMacOS(tokens: OAuthTokens): Promise<boolean> {
  const json = JSON.stringify(tokens);
  const result = await runCommand("security", [
    "add-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
    json,
    "-U", // Update if exists
  ]);
  return result.ok;
}

async function loadMacOS(): Promise<OAuthTokens | null> {
  const result = await runCommand("security", [
    "find-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (!result.ok || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout) as OAuthTokens;
  } catch {
    return null;
  }
}

async function clearMacOS(): Promise<boolean> {
  const result = await runCommand("security", [
    "delete-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
  ]);
  return result.ok;
}

// ─── Linux secret-tool ──────────────────────────────────────────

async function saveLinuxSecretTool(tokens: OAuthTokens): Promise<boolean> {
  const json = JSON.stringify(tokens);
  const result = await runCommand(
    "secret-tool",
    ["store", "--label=" + SECRET_TOOL_LABEL, "service", "kcode", "type", "oauth"],
    json,
  );
  return result.ok;
}

async function loadLinuxSecretTool(): Promise<OAuthTokens | null> {
  const result = await runCommand("secret-tool", ["lookup", "service", "kcode", "type", "oauth"]);
  if (!result.ok || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout) as OAuthTokens;
  } catch {
    return null;
  }
}

async function clearLinuxSecretTool(): Promise<boolean> {
  const result = await runCommand("secret-tool", ["clear", "service", "kcode", "type", "oauth"]);
  return result.ok;
}

// ─── File Fallback ──────────────────────────────────────────────

async function saveToFile(tokens: OAuthTokens): Promise<boolean> {
  try {
    const path = FALLBACK_PATH();
    await Bun.write(path, JSON.stringify(tokens, null, 2));
    try {
      const { chmodSync } = require("node:fs") as typeof import("node:fs");
      chmodSync(path, 0o600);
    } catch {
      /* best effort */
    }
    return true;
  } catch (err) {
    log.debug("config", `Failed to save tokens to file: ${err}`);
    return false;
  }
}

async function loadFromFile(): Promise<OAuthTokens | null> {
  try {
    const file = Bun.file(FALLBACK_PATH());
    if (!(await file.exists())) return null;
    const data = await file.json();
    if (data && typeof data === "object" && data.access_token) {
      return data as OAuthTokens;
    }
    return null;
  } catch (err) {
    log.debug("config", `Failed to load tokens from file: ${err}`);
    return null;
  }
}

async function clearFile(): Promise<boolean> {
  try {
    const { unlinkSync } = require("node:fs") as typeof import("node:fs");
    unlinkSync(FALLBACK_PATH());
    return true;
  } catch {
    return false;
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Save OAuth tokens using the best available secure storage.
 */
export async function saveTokens(tokens: OAuthTokens): Promise<void> {
  const platform = process.platform;

  if (platform === "darwin") {
    if (await saveMacOS(tokens)) return;
    log.debug("config", "macOS Keychain save failed, falling back to file");
  }

  if (platform === "linux") {
    if (await saveLinuxSecretTool(tokens)) return;
    log.debug("config", "Linux secret-tool save failed, falling back to file");
  }

  // Windows and all fallbacks use file storage
  const saved = await saveToFile(tokens);
  if (saved && platform !== "win32") {
    log.warn(
      "config",
      "Tokens saved to file (~/.kcode/tokens.json) — less secure than system keychain",
    );
  }
}

/**
 * Load OAuth tokens from secure storage.
 */
export async function loadTokens(): Promise<OAuthTokens | null> {
  const platform = process.platform;

  if (platform === "darwin") {
    const tokens = await loadMacOS();
    if (tokens) return tokens;
  }

  if (platform === "linux") {
    const tokens = await loadLinuxSecretTool();
    if (tokens) return tokens;
  }

  // Try file fallback
  return loadFromFile();
}

/**
 * Clear all stored OAuth tokens.
 */
export async function clearTokens(): Promise<void> {
  const platform = process.platform;

  if (platform === "darwin") {
    await clearMacOS();
  }

  if (platform === "linux") {
    await clearLinuxSecretTool();
  }

  // Always try to clear file fallback too
  await clearFile();
}
