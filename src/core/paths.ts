// KCode - Centralized Path Resolution
// Single source of truth for all ~/.kcode paths.
// Override via KCODE_HOME env var for testing or custom installs.

import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the KCode home directory.
 * Reads KCODE_HOME at call time (not import time) so env var
 * overrides work in tests without module-load ordering issues.
 */
export function kcodeHome(): string {
  return process.env.KCODE_HOME ?? join(homedir(), ".kcode");
}

/**
 * Resolve a path relative to the KCode home directory.
 * @example kcodePath("awareness.db")       → ~/.kcode/awareness.db
 * @example kcodePath("plugins", "my-plug") → ~/.kcode/plugins/my-plug
 */
export function kcodePath(...segments: string[]): string {
  return join(kcodeHome(), ...segments);
}
