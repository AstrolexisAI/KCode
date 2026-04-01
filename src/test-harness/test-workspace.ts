// KCode - Test Workspace Helper
// Creates isolated temporary workspaces with git repos and sample files for E2E testing

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────

export interface TestWorkspace {
  /** Absolute path to the temporary workspace directory. */
  dir: string;
  /** Create a file inside the workspace with the given relative path and content. */
  writeFile: (relativePath: string, content: string) => string;
  /** Remove the workspace and all its contents. */
  cleanup: () => void;
}

export interface TestWorkspaceOptions {
  /** Whether to initialize a git repo (default: true). */
  initGit?: boolean;
  /** Initial files to create: map of relative path to content. */
  files?: Record<string, string>;
}

// ─── Factory ─────────────────────────────────────────────────────

/**
 * Create an isolated test workspace in a temporary directory.
 *
 * By default:
 * - Initializes a git repository with an initial commit
 * - Creates sample files if provided
 *
 * Call `cleanup()` when done to remove the temp directory.
 */
export function createTestWorkspace(opts: TestWorkspaceOptions = {}): TestWorkspace {
  const dir = mkdtempSync(join(tmpdir(), "kcode-ws-"));

  // Initialize git repo
  if (opts.initGit !== false) {
    try {
      execSync("git init", { cwd: dir, stdio: "ignore" });
      execSync('git config user.email "test@kcode.dev"', { cwd: dir, stdio: "ignore" });
      execSync('git config user.name "KCode Test"', { cwd: dir, stdio: "ignore" });
      writeFileSync(join(dir, ".gitkeep"), "");
      execSync("git add -A && git commit -m 'init'", { cwd: dir, stdio: "ignore" });
    } catch {
      // Git not available — continue without
    }
  }

  // Write helper
  const writeFile = (relativePath: string, content: string): string => {
    const fullPath = join(dir, relativePath);
    const parentDir = join(fullPath, "..");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(fullPath, content);
    return fullPath;
  };

  // Create initial files
  if (opts.files) {
    for (const [relPath, content] of Object.entries(opts.files)) {
      writeFile(relPath, content);
    }
  }

  // Cleanup
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  return { dir, writeFile, cleanup };
}
