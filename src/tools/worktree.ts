// KCode - Worktree Tools
// EnterWorktree creates an isolated git worktree for safe experimentation
// ExitWorktree returns to the main working directory, optionally merging changes

import { execSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDefinition, ToolResult } from "../core/types";

// ─── Worktree State ────────────────────────────────────────────

interface WorktreeState {
  originalCwd: string;
  worktreePath: string;
  branchName: string;
  createdAt: number;
}

let _activeWorktree: WorktreeState | null = null;

export function getActiveWorktree(): WorktreeState | null {
  return _activeWorktree;
}

export function isInWorktree(): boolean {
  return _activeWorktree !== null;
}

// ─── EnterWorktree ─────────────────────────────────────────────

export const enterWorktreeDefinition: ToolDefinition = {
  name: "EnterWorktree",
  description:
    "Create and switch to an isolated git worktree. Changes made in the worktree are isolated from the main branch. " +
    "Use this for safe experimentation, prototyping, or parallel development. " +
    "Call ExitWorktree to return, optionally merging changes back.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name for the worktree branch (default: auto-generated)",
      },
      base: {
        type: "string",
        description: "Base branch or commit to create worktree from (default: HEAD)",
      },
    },
  },
};

export async function executeEnterWorktree(input: Record<string, unknown>): Promise<ToolResult> {
  if (_activeWorktree) {
    return {
      tool_use_id: "",
      content: `Already in worktree: ${_activeWorktree.worktreePath} (branch: ${_activeWorktree.branchName}). Use ExitWorktree first.`,
      is_error: true,
    };
  }

  const cwd = process.cwd();

  // Check if we're in a git repo
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe", timeout: 5000 });
  } catch {
    return {
      tool_use_id: "",
      content: "Error: Not in a git repository. Worktrees require git.",
      is_error: true,
    };
  }

  const id = randomUUID().slice(0, 8);
  const nameSlug = String(input.name ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 30) || "experiment";
  const branchName = `kcode-wt-${nameSlug}-${id}`;
  const base = String(input.base ?? "HEAD").trim();
  const worktreePath = join("/tmp", `kcode-worktree-${id}`);

  // Validate base parameter against injection
  if (!/^[a-zA-Z0-9_./@^~{}\-]+$/.test(base)) {
    return {
      tool_use_id: "",
      content: `Error: Base ref "${base}" contains invalid characters.`,
      is_error: true,
    };
  }

  // Validate base ref exists
  try {
    execFileSync("git", ["rev-parse", "--verify", base], { cwd, stdio: "pipe", timeout: 5000 });
  } catch {
    return {
      tool_use_id: "",
      content: `Error: Base ref "${base}" does not exist.`,
      is_error: true,
    };
  }

  try {
    execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath, base], {
      cwd,
      stdio: "pipe",
      timeout: 15000,
    });
  } catch (err) {
    return {
      tool_use_id: "",
      content: `Error creating worktree: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }

  _activeWorktree = {
    originalCwd: cwd,
    worktreePath,
    branchName,
    createdAt: Date.now(),
  };

  // Change process working directory to worktree
  try {
    process.chdir(worktreePath);
  } catch (err) {
    // Cleanup on chdir failure
    try { execFileSync("git", ["worktree", "remove", worktreePath, "--force"], { cwd, stdio: "pipe" }); } catch { /* best-effort worktree cleanup */ }
    _activeWorktree = null;
    return {
      tool_use_id: "",
      content: `Error switching to worktree: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }

  return {
    tool_use_id: "",
    content: [
      `Worktree created and activated:`,
      `  Branch: ${branchName}`,
      `  Path:   ${worktreePath}`,
      `  Base:   ${base}`,
      ``,
      `All file operations now target the worktree.`,
      `Use ExitWorktree to return to ${cwd}.`,
    ].join("\n"),
  };
}

// ─── ExitWorktree ──────────────────────────────────────────────

export const exitWorktreeDefinition: ToolDefinition = {
  name: "ExitWorktree",
  description:
    "Exit the current git worktree and return to the original working directory. " +
    "If changes were made, they remain on the worktree branch. " +
    "Use merge=true to merge the worktree branch back into the original branch.",
  input_schema: {
    type: "object",
    properties: {
      merge: {
        type: "boolean",
        description: "Merge the worktree branch changes back into the original branch (default: false)",
      },
      cleanup: {
        type: "boolean",
        description: "Delete the worktree and branch after exiting (default: true for no changes, false if changes exist)",
      },
    },
  },
};

export async function executeExitWorktree(input: Record<string, unknown>): Promise<ToolResult> {
  if (!_activeWorktree) {
    return {
      tool_use_id: "",
      content: "Not in a worktree. Use EnterWorktree to create one.",
      is_error: true,
    };
  }

  const { originalCwd, worktreePath, branchName, createdAt } = _activeWorktree;
  const doMerge = input.merge === true;
  const durationMs = Date.now() - createdAt;
  const lines: string[] = [];

  // Check if there are changes in the worktree
  let hasChanges = false;
  try {
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: worktreePath, stdio: "pipe", timeout: 5000 }).toString();
    hasChanges = status.trim().length > 0;

    if (hasChanges) {
      // Auto-commit changes in worktree before leaving
      execFileSync("git", ["add", "-A"], { cwd: worktreePath, stdio: "pipe", timeout: 5000 });
      execFileSync("git", ["commit", "-m", "KCode worktree changes (auto-commit)"], {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 10000,
      });
      lines.push("Changes auto-committed in worktree branch.");
    }
  } catch {
    // Status/commit may fail, continue with exit
  }

  // Check for commits on the worktree branch
  let commitCount = 0;
  try {
    const log = execFileSync("git", ["log", "--oneline", branchName, "--not", "HEAD"], {
      cwd: originalCwd,
      stdio: "pipe",
      timeout: 5000,
    }).toString();
    commitCount = log.trim().split("\n").filter((l) => l.length > 0).length;
  } catch {
    // May fail if branch diverged
  }

  // Return to original directory
  try {
    process.chdir(originalCwd);
  } catch (err) {
    return {
      tool_use_id: "",
      content: `Error returning to ${originalCwd}: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }

  // Merge if requested
  if (doMerge && commitCount > 0) {
    try {
      execFileSync("git", ["merge", branchName, "--no-ff", "-m", `Merge worktree ${branchName}`], {
        cwd: originalCwd,
        stdio: "pipe",
        timeout: 15000,
      });
      lines.push(`Merged ${commitCount} commit(s) from ${branchName} into current branch.`);
    } catch (err) {
      lines.push(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
      lines.push(`Branch ${branchName} is preserved. Merge manually with: git merge ${branchName}`);
    }
  }

  // Cleanup worktree
  const doCleanup = input.cleanup !== false && (commitCount === 0 || doMerge);
  if (doCleanup) {
    try {
      execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
        cwd: originalCwd,
        stdio: "pipe",
        timeout: 10000,
      });
      // Delete the branch too if merged or no changes
      if (commitCount === 0 || doMerge) {
        try {
          execFileSync("git", ["branch", "-D", branchName], {
            cwd: originalCwd,
            stdio: "pipe",
            timeout: 5000,
          });
        } catch { /* best-effort branch cleanup — branch may not exist */ }
      }
      lines.push("Worktree and branch cleaned up.");
    } catch {
      lines.push(`Worktree at ${worktreePath} could not be removed automatically.`);
    }
  } else if (commitCount > 0 && !doMerge) {
    lines.push(`Worktree branch preserved: ${branchName} (${commitCount} commit(s))`);
    lines.push(`To merge later: git merge ${branchName}`);
    lines.push(`To delete: git worktree remove ${worktreePath} --force && git branch -D ${branchName}`);
  }

  _activeWorktree = null;

  const durationStr = durationMs > 60000
    ? `${Math.round(durationMs / 60000)}m`
    : `${Math.round(durationMs / 1000)}s`;

  return {
    tool_use_id: "",
    content: [
      `Exited worktree (${durationStr}):`,
      `  Branch: ${branchName}`,
      `  Commits: ${commitCount}`,
      `  Returned to: ${originalCwd}`,
      ...lines.map((l) => `  ${l}`),
    ].join("\n"),
  };
}
