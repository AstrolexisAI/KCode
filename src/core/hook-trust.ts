// KCode - Workspace Trust System
// Manages workspace trust for project-level hook execution

import { resolve } from "node:path";

// ─── Workspace Trust ────────────────────────────────────────────

/**
 * Session-only set of workspace paths the user has approved for
 * running project-level hooks. Not persisted to disk.
 */
const trustedWorkspaces = new Set<string>();

/**
 * Optional callback for prompting the user to trust a workspace.
 * Set by the UI layer via setTrustPromptCallback().
 * Called with (workspacePath, hookCommand) and should return true to trust.
 */
let _trustPromptCallback: ((workspacePath: string, hookCommand: string) => Promise<boolean>) | null = null;

/** Register a callback that asks the user whether to trust a workspace. */
export function setTrustPromptCallback(
  cb: (workspacePath: string, hookCommand: string) => Promise<boolean>,
): void {
  _trustPromptCallback = cb;
}

/** Get the current trust prompt callback (used internally by HookManager). */
export function getTrustPromptCallback(): ((workspacePath: string, hookCommand: string) => Promise<boolean>) | null {
  return _trustPromptCallback;
}

/** Normalize a workspace path for consistent trust lookups. */
export function normalizePath(path: string): string {
  return resolve(path).replace(/\/+$/, "");
}

/** Explicitly trust a workspace path for the current session. */
export function trustWorkspace(path: string): void {
  trustedWorkspaces.add(normalizePath(path));
}

/** Check if a workspace path is currently trusted. */
export function isWorkspaceTrusted(path: string): boolean {
  return trustedWorkspaces.has(normalizePath(path));
}
