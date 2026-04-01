// KCode - Temporary Permission Grants
// Session-scoped temporary permissions that override policy evaluation.

// ─── Types ──────────────────────────────────────────────────────

interface GrantEntry {
  action: "allow" | "deny";
  expiresAt: number;
  reason?: string;
}

export interface GrantInfo {
  toolName: string;
  action: string;
  expiresAt: number;
  reason?: string;
}

export interface GrantCheckResult {
  action: "allow" | "deny";
  reason?: string;
}

// ─── TemporaryGrants Class ──────────────────────────────────────

export class TemporaryGrants {
  private grants: Map<string, GrantEntry> = new Map();

  /**
   * Adds a temporary permission grant.
   *
   * @param toolName - The tool name to grant permission for
   * @param action - Whether to allow or deny the tool
   * @param opts.duration - Duration in ms (default: Infinity = session lifetime)
   * @param opts.fieldMatch - Optional field value pattern to scope the grant (e.g. "git*")
   * @param opts.reason - Optional reason for the grant
   */
  grant(
    toolName: string,
    action: "allow" | "deny",
    opts?: {
      duration?: number;
      fieldMatch?: string;
      reason?: string;
    },
  ): void {
    const duration = opts?.duration ?? Infinity;
    const expiresAt = duration === Infinity ? Infinity : Date.now() + duration;

    const key = opts?.fieldMatch ? `${toolName}:${opts.fieldMatch}` : toolName;

    this.grants.set(key, {
      action,
      expiresAt,
      reason: opts?.reason,
    });
  }

  /**
   * Checks if a temporary grant exists for the given tool.
   *
   * Checks for both exact tool-level grants and field-level grants.
   * Field-level grants use glob matching against stringified input values.
   * Expired grants are automatically removed.
   *
   * Returns null if no matching grant is found.
   */
  check(toolName: string, input?: Record<string, unknown>): GrantCheckResult | null {
    const now = Date.now();

    // Check field-level grants first (more specific)
    if (input) {
      for (const [key, entry] of this.grants.entries()) {
        // Skip tool-level grants in this pass
        if (!key.includes(":")) continue;

        const [grantTool, fieldPattern] = splitKey(key);
        if (grantTool !== toolName) continue;

        // Check if expired
        if (entry.expiresAt !== Infinity && entry.expiresAt <= now) {
          this.grants.delete(key);
          continue;
        }

        // Check if any input value matches the field pattern
        if (inputMatchesPattern(input, fieldPattern)) {
          return { action: entry.action, reason: entry.reason };
        }
      }
    }

    // Check tool-level grant
    const toolGrant = this.grants.get(toolName);
    if (toolGrant) {
      if (toolGrant.expiresAt !== Infinity && toolGrant.expiresAt <= now) {
        this.grants.delete(toolName);
        return null;
      }
      return { action: toolGrant.action, reason: toolGrant.reason };
    }

    return null;
  }

  /**
   * Removes a specific grant for a tool.
   * Returns true if a grant was removed.
   */
  revoke(toolName: string): boolean {
    // Remove both tool-level and any field-level grants for this tool
    let removed = false;
    for (const key of [...this.grants.keys()]) {
      if (key === toolName || key.startsWith(`${toolName}:`)) {
        this.grants.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  /**
   * Removes all grants.
   */
  revokeAll(): void {
    this.grants.clear();
  }

  /**
   * Lists all active (non-expired) grants.
   */
  list(): GrantInfo[] {
    const now = Date.now();
    const result: GrantInfo[] = [];

    for (const [key, entry] of this.grants.entries()) {
      if (entry.expiresAt !== Infinity && entry.expiresAt <= now) continue;
      result.push({
        toolName: key,
        action: entry.action,
        expiresAt: entry.expiresAt,
        reason: entry.reason,
      });
    }

    return result;
  }

  /**
   * Removes all expired grants and returns the count of removed entries.
   */
  cleanup(): number {
    const now = Date.now();
    let count = 0;

    for (const [key, entry] of this.grants.entries()) {
      if (entry.expiresAt !== Infinity && entry.expiresAt <= now) {
        this.grants.delete(key);
        count++;
      }
    }

    return count;
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Splits a grant key into tool name and field pattern.
 * Key format: "toolName:fieldPattern"
 */
function splitKey(key: string): [string, string] {
  const colonIdx = key.indexOf(":");
  return [key.slice(0, colonIdx), key.slice(colonIdx + 1)];
}

/**
 * Checks if any value in the input matches the given glob pattern.
 * Uses simple glob matching (case-insensitive).
 */
function inputMatchesPattern(input: Record<string, unknown>, pattern: string): boolean {
  for (const value of Object.values(input)) {
    if (value === null || value === undefined) continue;
    const strValue = String(value);
    if (simpleGlobMatch(strValue, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Simple glob match for temporary grants.
 * Supports * wildcard only.
 */
function simpleGlobMatch(value: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${regexStr}$`, "i").test(value);
  } catch {
    return false;
  }
}
