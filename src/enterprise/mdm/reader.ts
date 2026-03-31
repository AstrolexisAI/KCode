// KCode - MDM Reader
// Cross-platform MDM settings reader for macOS (plist), Windows (registry), and Linux (JSON files)

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../core/logger";
import type { MdmSettings } from "../types";
import {
  macosPlistPaths,
  WINDOWS_REGISTRY_PATHS,
  WINDOWS_REGISTRY_VALUE,
  LINUX_MANAGED_SETTINGS_PATH,
  LINUX_MANAGED_SETTINGS_DIR,
  SUBPROCESS_TIMEOUT_MS,
} from "./constants";

// ─── Session Cache ──────────────────────────────────────────────

let _mdmCache: MdmSettings | null | undefined = undefined; // undefined = not loaded yet

/**
 * Clear the MDM session cache (for testing or hot-reload).
 */
export function clearMdmCache(): void {
  _mdmCache = undefined;
}

// ─── Helpers ────────────────────────────────────────────────────

async function runSubprocess(cmd: string, args: string[], timeoutMs: number = SUBPROCESS_TIMEOUT_MS): Promise<string | null> {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Timeout handling
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
        resolve(null);
      }, timeoutMs);
    });

    const result = await Promise.race([
      proc.exited.then(async (code) => {
        if (code !== 0) return null;
        const stdout = await new Response(proc.stdout).text();
        return stdout.trim();
      }),
      timeoutPromise,
    ]);

    return result;
  } catch (err) {
    log.debug("config", `MDM subprocess failed (${cmd}): ${err}`);
    return null;
  }
}

function parseMdmSettings(raw: unknown): MdmSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const settings: MdmSettings = {};
  let hasAnyField = false;

  if (typeof obj.permissionMode === "string") { settings.permissionMode = obj.permissionMode; hasAnyField = true; }
  if (Array.isArray(obj.allowedTools)) { settings.allowedTools = obj.allowedTools.filter((t): t is string => typeof t === "string"); hasAnyField = true; }
  if (Array.isArray(obj.blockedTools)) { settings.blockedTools = obj.blockedTools.filter((t): t is string => typeof t === "string"); hasAnyField = true; }
  if (typeof obj.maxBudgetUsd === "number") { settings.maxBudgetUsd = obj.maxBudgetUsd; hasAnyField = true; }
  if (typeof obj.auditLogging === "boolean") { settings.auditLogging = obj.auditLogging; hasAnyField = true; }
  if (typeof obj.disableWebAccess === "boolean") { settings.disableWebAccess = obj.disableWebAccess; hasAnyField = true; }
  if (Array.isArray(obj.allowedModels)) { settings.allowedModels = obj.allowedModels.filter((m): m is string => typeof m === "string"); hasAnyField = true; }
  if (Array.isArray(obj.blockedModels)) { settings.blockedModels = obj.blockedModels.filter((m): m is string => typeof m === "string"); hasAnyField = true; }
  if (typeof obj.customSystemPrompt === "string") { settings.customSystemPrompt = obj.customSystemPrompt; hasAnyField = true; }
  if (typeof obj.forceModel === "string") { settings.forceModel = obj.forceModel; hasAnyField = true; }

  return hasAnyField ? settings : null;
}

// ─── macOS ──────────────────────────────────────────────────────

async function readMacOsMdm(): Promise<MdmSettings | null> {
  const username = process.env.USER ?? process.env.LOGNAME ?? "unknown";
  const paths = macosPlistPaths(username);

  for (const plistPath of paths) {
    // Fast-path: check existence before spawning subprocess
    if (!existsSync(plistPath)) continue;

    const jsonStr = await runSubprocess("plutil", ["-convert", "json", "-o", "-", "--", plistPath]);
    if (!jsonStr) continue;

    try {
      const parsed = JSON.parse(jsonStr);
      const settings = parseMdmSettings(parsed);
      if (settings) {
        log.debug("config", `MDM settings loaded from macOS plist: ${plistPath}`);
        return settings;
      }
    } catch (err) {
      log.debug("config", `Failed to parse macOS MDM plist ${plistPath}: ${err}`);
    }
  }

  return null;
}

// ─── Windows ────────────────────────────────────────────────────

async function readWindowsMdm(): Promise<MdmSettings | null> {
  for (const regPath of WINDOWS_REGISTRY_PATHS) {
    const output = await runSubprocess("reg", ["query", regPath, "/v", WINDOWS_REGISTRY_VALUE]);
    if (!output) continue;

    // Parse reg query output: look for REG_SZ value
    const match = output.match(/Settings\s+REG_SZ\s+(.*)/i);
    if (!match?.[1]) continue;

    try {
      const parsed = JSON.parse(match[1].trim());
      const settings = parseMdmSettings(parsed);
      if (settings) {
        log.debug("config", `MDM settings loaded from Windows registry: ${regPath}`);
        return settings;
      }
    } catch (err) {
      log.debug("config", `Failed to parse Windows MDM registry ${regPath}: ${err}`);
    }
  }

  return null;
}

// ─── Linux ──────────────────────────────────────────────────────

async function readLinuxMdm(): Promise<MdmSettings | null> {
  let base: Record<string, unknown> | null = null;

  // Read base file
  if (existsSync(LINUX_MANAGED_SETTINGS_PATH)) {
    try {
      const file = Bun.file(LINUX_MANAGED_SETTINGS_PATH);
      base = await file.json() as Record<string, unknown>;
    } catch (err) {
      log.debug("config", `Failed to read Linux MDM base settings: ${err}`);
    }
  }

  // Read drop-in directory
  const dropIns: Record<string, unknown>[] = [];
  if (existsSync(LINUX_MANAGED_SETTINGS_DIR)) {
    try {
      const entries = readdirSync(LINUX_MANAGED_SETTINGS_DIR)
        .filter(f => f.endsWith(".json"))
        .sort(); // Alphabetical order, last wins

      for (const entry of entries) {
        try {
          const file = Bun.file(join(LINUX_MANAGED_SETTINGS_DIR, entry));
          const data = await file.json() as Record<string, unknown>;
          if (data && typeof data === "object") {
            dropIns.push(data);
          }
        } catch (err) {
          log.debug("config", `Failed to read Linux MDM drop-in ${entry}: ${err}`);
        }
      }
    } catch (err) {
      log.debug("config", `Failed to read Linux MDM drop-in directory: ${err}`);
    }
  }

  if (!base && dropIns.length === 0) return null;

  // Merge: base has lowest priority, drop-ins in alphabetical order (last wins)
  const merged: Record<string, unknown> = {};
  if (base) Object.assign(merged, base);
  for (const dropIn of dropIns) {
    Object.assign(merged, dropIn);
  }

  const settings = parseMdmSettings(merged);
  if (settings) {
    log.debug("config", "MDM settings loaded from Linux managed settings");
  }
  return settings;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Load MDM settings from the platform-appropriate source.
 * Returns parsed settings or null if none found.
 * Results are cached for the session duration.
 */
export async function loadMdmSettings(): Promise<MdmSettings | null> {
  // Return cached result if available
  if (_mdmCache !== undefined) return _mdmCache;

  try {
    const platform = process.platform;
    let settings: MdmSettings | null = null;

    switch (platform) {
      case "darwin":
        settings = await readMacOsMdm();
        break;
      case "win32":
        settings = await readWindowsMdm();
        break;
      case "linux":
        settings = await readLinuxMdm();
        break;
      default:
        log.debug("config", `MDM not supported on platform: ${platform}`);
    }

    _mdmCache = settings;
    return settings;
  } catch (err) {
    log.debug("config", `MDM settings load failed: ${err}`);
    _mdmCache = null;
    return null;
  }
}

// Export for testing
export { parseMdmSettings as _parseMdmSettings };
