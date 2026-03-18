// KCode - Git Tools
// Structured git operations: status, commit, log
// Safer than raw Bash — returns parsed output and enforces guardrails

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../core/types";

const GIT_TIMEOUT = 30_000;

// ─── Helpers ──────────────────────────────────────────────────

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd,
    stdio: "pipe",
    timeout: GIT_TIMEOUT,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).toString().trim();
}

function isGitRepo(cwd: string): boolean {
  try {
    runGit(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

// ─── GitStatus ──────────────────────────────────────────────

export const gitStatusDefinition: ToolDefinition = {
  name: "GitStatus",
  description:
    "Show the current git status: branch, staged/unstaged changes, untracked files. " +
    "Returns structured output. Safer and more informative than 'git status' via Bash.",
  input_schema: {
    type: "object",
    properties: {
      verbose: {
        type: "boolean",
        description: "Include diff stats for changed files (default: false)",
      },
    },
  },
};

export async function executeGitStatus(input: Record<string, unknown>): Promise<ToolResult> {
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) {
    return { tool_use_id: "", content: "Error: Not in a git repository.", is_error: true };
  }

  try {
    const branch = runGit(["branch", "--show-current"], cwd) || "(detached HEAD)";
    const status = runGit(["status", "--porcelain", "-u"], cwd);

    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const line of status.split("\n").filter(Boolean)) {
      const x = line[0]; // staging area
      const y = line[1]; // working tree
      const file = line.slice(3);

      if (x === "?" && y === "?") {
        untracked.push(file);
      } else {
        if (x !== " " && x !== "?") staged.push(`${x} ${file}`);
        if (y !== " " && y !== "?") unstaged.push(`${y} ${file}`);
      }
    }

    const lines: string[] = [
      `Branch: ${branch}`,
    ];

    // Ahead/behind remote
    try {
      const tracking = runGit(["rev-list", "--left-right", "--count", `@{upstream}...HEAD`], cwd);
      const [behind, ahead] = tracking.split("\t").map(Number);
      if (ahead > 0 || behind > 0) {
        const parts: string[] = [];
        if (ahead > 0) parts.push(`${ahead} ahead`);
        if (behind > 0) parts.push(`${behind} behind`);
        lines.push(`Remote: ${parts.join(", ")}`);
      }
    } catch { /* no upstream */ }

    lines.push("");

    if (staged.length > 0) {
      lines.push(`Staged (${staged.length}):`);
      for (const f of staged.slice(0, 50)) lines.push(`  ${f}`);
      if (staged.length > 50) lines.push(`  ... +${staged.length - 50} more`);
    }

    if (unstaged.length > 0) {
      lines.push(`Unstaged (${unstaged.length}):`);
      for (const f of unstaged.slice(0, 50)) lines.push(`  ${f}`);
      if (unstaged.length > 50) lines.push(`  ... +${unstaged.length - 50} more`);
    }

    if (untracked.length > 0) {
      lines.push(`Untracked (${untracked.length}):`);
      for (const f of untracked.slice(0, 30)) lines.push(`  ${f}`);
      if (untracked.length > 30) lines.push(`  ... +${untracked.length - 30} more`);
    }

    if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
      lines.push("Clean working tree.");
    }

    // Verbose: add diff stats
    if (input.verbose === true && (staged.length > 0 || unstaged.length > 0)) {
      lines.push("");
      try {
        const diffStat = runGit(["diff", "--stat"], cwd);
        if (diffStat) {
          lines.push("Diff stats (unstaged):");
          lines.push(diffStat);
        }
      } catch { /* ignore */ }
    }

    return { tool_use_id: "", content: lines.join("\n") };
  } catch (err) {
    return { tool_use_id: "", content: `Error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
  }
}

// ─── GitCommit ──────────────────────────────────────────────

// Files that should never be committed
const SENSITIVE_PATTERNS = [
  ".env", ".env.local", ".env.production",
  "credentials.json", "secrets.json", "service-account.json",
  ".pem", ".key", ".p12", ".pfx",
  "id_rsa", "id_ed25519", "id_ecdsa",
];

export const gitCommitDefinition: ToolDefinition = {
  name: "GitCommit",
  description:
    "Create a git commit. Stages specified files (or all changes if files not specified), " +
    "validates no sensitive files are staged, and commits with the given message. " +
    "Returns the commit hash and summary.",
  input_schema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Commit message (required)",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Specific files to stage and commit (if omitted, commits currently staged files)",
      },
      all: {
        type: "boolean",
        description: "Stage all modified and deleted files before committing (like git add -A, default: false)",
      },
    },
    required: ["message"],
  },
};

export async function executeGitCommit(input: Record<string, unknown>): Promise<ToolResult> {
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) {
    return { tool_use_id: "", content: "Error: Not in a git repository.", is_error: true };
  }

  const message = String(input.message ?? "").trim();
  if (!message) {
    return { tool_use_id: "", content: "Error: commit message is required.", is_error: true };
  }

  try {
    // Stage files if specified
    if (input.all === true) {
      runGit(["add", "-A"], cwd);
    } else if (Array.isArray(input.files) && input.files.length > 0) {
      const files = input.files.map(String);
      // Validate files exist
      for (const f of files) {
        if (!existsSync(join(cwd, f))) {
          return { tool_use_id: "", content: `Error: File not found: ${f}`, is_error: true };
        }
      }
      runGit(["add", "--", ...files], cwd);
    }

    // Check what's staged
    const staged = runGit(["diff", "--cached", "--name-only"], cwd);
    if (!staged) {
      return { tool_use_id: "", content: "Error: Nothing staged to commit. Use files=[...] or all=true to stage changes.", is_error: true };
    }

    // Check for sensitive files
    const stagedFiles = staged.split("\n").filter(Boolean);
    const sensitiveFound: string[] = [];
    for (const file of stagedFiles) {
      const lower = file.toLowerCase();
      for (const pattern of SENSITIVE_PATTERNS) {
        if (lower.includes(pattern.toLowerCase())) {
          sensitiveFound.push(file);
          break;
        }
      }
    }

    if (sensitiveFound.length > 0) {
      // Unstage sensitive files
      for (const f of sensitiveFound) {
        try { runGit(["reset", "HEAD", "--", f], cwd); } catch { /* ignore */ }
      }
      return {
        tool_use_id: "",
        content: `Error: Sensitive files detected and unstaged:\n${sensitiveFound.map((f) => `  ${f}`).join("\n")}\n\nRemove these files from staging before committing.`,
        is_error: true,
      };
    }

    // Commit — use execFileSync (array args, no shell) to prevent injection
    const commitOutput = execFileSync("git", ["commit", "-m", message], {
      cwd,
      stdio: "pipe",
      timeout: GIT_TIMEOUT,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).toString().trim();

    // Get the commit hash
    const hash = runGit(["rev-parse", "--short", "HEAD"], cwd);

    return {
      tool_use_id: "",
      content: [
        `Committed: ${hash}`,
        `Message: ${message}`,
        `Files (${stagedFiles.length}):`,
        ...stagedFiles.slice(0, 20).map((f) => `  ${f}`),
        stagedFiles.length > 20 ? `  ... +${stagedFiles.length - 20} more` : "",
      ].filter(Boolean).join("\n"),
    };
  } catch (err) {
    return { tool_use_id: "", content: `Error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
  }
}

// ─── GitLog ────────────────────────────────────────────────

export const gitLogDefinition: ToolDefinition = {
  name: "GitLog",
  description:
    "Show recent git commit history. Returns structured commit info: hash, author, date, message. " +
    "Use file= to show history for a specific file.",
  input_schema: {
    type: "object",
    properties: {
      count: {
        type: "number",
        description: "Number of commits to show (default: 10, max: 50)",
      },
      file: {
        type: "string",
        description: "Show history for a specific file (optional)",
      },
      oneline: {
        type: "boolean",
        description: "Compact one-line format (default: false)",
      },
    },
  },
};

export async function executeGitLog(input: Record<string, unknown>): Promise<ToolResult> {
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) {
    return { tool_use_id: "", content: "Error: Not in a git repository.", is_error: true };
  }

  const count = Math.max(1, Math.min(50, Number(input.count ?? 10)));
  const file = input.file ? String(input.file).trim() : "";
  const oneline = input.oneline === true;

  // Reject shell metacharacters in file path
  if (file && /[;|&`$(){}[\]<>!\n\r]/.test(file)) {
    return { tool_use_id: "", content: "Error: file path contains invalid characters.", is_error: true };
  }

  try {
    const format = oneline
      ? "--format=%h %s (%cr)"
      : "--format=%h|%an|%cr|%s";

    const args = ["log", format, `-${count}`];
    if (file) args.push("--", file);

    const output = runGit(args, cwd);
    if (!output) {
      return { tool_use_id: "", content: "No commits found." };
    }

    if (oneline) {
      return { tool_use_id: "", content: output };
    }

    // Parse structured output
    const lines: string[] = [];
    for (const line of output.split("\n").filter(Boolean)) {
      const [hash, author, date, ...msgParts] = line.split("|");
      const msg = msgParts.join("|");
      lines.push(`${hash} ${msg}`);
      lines.push(`  by ${author}, ${date}`);
      lines.push("");
    }

    return { tool_use_id: "", content: lines.join("\n").trim() };
  } catch (err) {
    return { tool_use_id: "", content: `Error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
  }
}
