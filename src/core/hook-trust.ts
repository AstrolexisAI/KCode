// KCode - Workspace Trust System
// Manages workspace trust for project-level hook, plugin, and MCP execution.
// Trust is persisted to ~/.kcode/trusted-workspaces.json so users only need
// to approve a workspace once.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "./logger";
import { kcodeHome, kcodePath } from "./paths";

// ─── Trust Store Path ──────────────────────────────────────────

const TRUST_STORE_PATH = kcodePath("trusted-workspaces.json");

// ─── Workspace Trust ────────────────────────────────────────────

/**
 * Session-only set of workspace paths the user has approved for
 * running project-level hooks. Supplements the persistent store.
 */
const sessionTrustedWorkspaces = new Set<string>();

/**
 * Cached persistent trust store. Loaded lazily on first access.
 * null means not yet loaded.
 */
let _persistentTrustCache: Set<string> | null = null;

/**
 * Optional callback for prompting the user to trust a workspace.
 * Set by the UI layer via setTrustPromptCallback().
 * Called with (workspacePath, hookCommand) and should return true to trust.
 */
let _trustPromptCallback:
  | ((workspacePath: string, hookCommand: string) => Promise<boolean>)
  | null = null;

/** Register a callback that asks the user whether to trust a workspace. */
export function setTrustPromptCallback(
  cb: (workspacePath: string, hookCommand: string) => Promise<boolean>,
): void {
  _trustPromptCallback = cb;
}

/** Get the current trust prompt callback (used internally by HookManager). */
export function getTrustPromptCallback():
  | ((workspacePath: string, hookCommand: string) => Promise<boolean>)
  | null {
  return _trustPromptCallback;
}

/** Normalize a workspace path for consistent trust lookups. */
export function normalizePath(path: string): string {
  return resolve(path).replace(/\/+$/, "");
}

// ─── Persistent Trust Store ─────────────────────────────────────

/** Load the persistent trust store from disk. */
function loadPersistentTrustStore(): Set<string> {
  if (_persistentTrustCache) return _persistentTrustCache;

  _persistentTrustCache = new Set<string>();
  try {
    if (existsSync(TRUST_STORE_PATH)) {
      const raw = readFileSync(TRUST_STORE_PATH, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        for (const entry of data) {
          if (typeof entry === "string") {
            _persistentTrustCache.add(normalizePath(entry));
          }
        }
      }
    }
  } catch (err) {
    log.debug("trust", `Failed to load trusted-workspaces.json: ${err}`);
  }
  return _persistentTrustCache;
}

/** Save the persistent trust store to disk. */
function savePersistentTrustStore(store: Set<string>): void {
  try {
    const dir = kcodeHome();
    mkdirSync(dir, { recursive: true });
    const sorted = [...store].sort();
    writeFileSync(TRUST_STORE_PATH, JSON.stringify(sorted, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (err) {
    log.debug("trust", `Failed to save trusted-workspaces.json: ${err}`);
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Explicitly trust a workspace path. Persists to ~/.kcode/trusted-workspaces.json
 * and also marks it trusted for the current session.
 */
export function trustWorkspace(path: string): void {
  const normalized = normalizePath(path);
  sessionTrustedWorkspaces.add(normalized);

  const store = loadPersistentTrustStore();
  if (!store.has(normalized)) {
    store.add(normalized);
    savePersistentTrustStore(store);
  }
}

/**
 * Check if a workspace path is currently trusted (either session or persistent).
 */
export function isWorkspaceTrusted(path: string): boolean {
  const normalized = normalizePath(path);
  if (sessionTrustedWorkspaces.has(normalized)) return true;

  const store = loadPersistentTrustStore();
  return store.has(normalized);
}

/**
 * Remove trust for a workspace path (both session and persistent).
 */
export function untrustWorkspace(path: string): void {
  const normalized = normalizePath(path);
  sessionTrustedWorkspaces.delete(normalized);

  const store = loadPersistentTrustStore();
  if (store.has(normalized)) {
    store.delete(normalized);
    savePersistentTrustStore(store);
  }
}

/**
 * Reset the in-memory trust caches (useful for testing).
 */
export function _resetTrustCache(): void {
  sessionTrustedWorkspaces.clear();
  _persistentTrustCache = null;
}
