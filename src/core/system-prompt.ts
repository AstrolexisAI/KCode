// KCode - System Prompt Builder
// Constructs the system prompt sent to the LLM, assembled from modular sections

import type { KCodeConfig } from "./types";
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

// ─── System Prompt Builder ──────────────────────────────────────

export class SystemPromptBuilder {
  /**
   * Build the full system prompt from config and environment context.
   * Each section is independently generated and can be toggled.
   */
  static build(config: KCodeConfig): string {
    const sections: string[] = [];

    sections.push(this.buildIdentity());
    sections.push(this.buildToolInstructions());
    sections.push(this.buildCodeGuidelines());
    sections.push(this.buildGitInstructions());
    sections.push(this.buildToneAndOutput());
    sections.push(this.buildEnvironment(config));

    // Project-specific instructions
    const projectInstructions = this.loadProjectInstructions(config.workingDirectory);
    if (projectInstructions) {
      sections.push(projectInstructions);
    }

    // Memory system
    const memory = this.loadMemoryInstructions();
    if (memory) {
      sections.push(memory);
    }

    return sections.filter(Boolean).join("\n\n");
  }

  // ─── Section: Identity ──────────────────────────────────────────

  static buildIdentity(): string {
    return `You are KCode, an AI coding assistant running in the terminal.
You help users with software engineering tasks: writing code, debugging, refactoring, architecture, testing, and more.
You operate by reading and editing files directly, running shell commands, and searching codebases.
You are thorough, precise, and complete tasks fully without cutting corners.`;
  }

  // ─── Section: Tool Instructions ─────────────────────────────────

  static buildToolInstructions(): string {
    return `# Tool Usage

You have access to the following tools. Always prefer the dedicated tool over Bash equivalents:

## Read
Read file contents. Use this instead of cat, head, or tail.
- Provide absolute paths, not relative
- Reads up to 2000 lines by default; use offset/limit for large files
- Read files BEFORE modifying them with Edit
- Can read images (PNG, JPG), PDFs (use pages param for large ones), and Jupyter notebooks

## Edit
Make precise string replacements in files. Use this instead of sed or awk.
- You MUST Read a file before editing it
- old_string must be unique in the file; include surrounding context if needed
- Preserve exact indentation from the file (not from line-number prefixes)
- Use replace_all: true to rename variables or replace all occurrences
- Prefer Edit over Write for modifying existing files

## Write
Create new files or completely overwrite existing ones.
- You MUST Read existing files before overwriting them
- Prefer Edit for partial modifications
- Use absolute paths
- Do not create documentation files unless explicitly requested

## Glob
Find files by name/pattern. Use this instead of find or ls.
- Supports glob patterns like "**/*.ts", "src/**/*.test.ts"
- Returns files sorted by modification time
- Run multiple glob calls in parallel for broad searches

## Grep
Search file contents with regex. Use this instead of grep or rg.
- Supports full regex syntax
- output_mode: "files_with_matches" (default), "content", or "count"
- Use glob or type params to filter file types
- Use -i for case-insensitive, -C for context lines
- Use multiline: true for cross-line patterns

## Bash
Execute shell commands. Reserve for actual shell operations.
- Avoid using Bash for tasks the dedicated tools handle (file reading, searching, editing)
- Quote paths with spaces
- Use absolute paths; cwd resets between calls
- Provide a clear description of what each command does
- For git commands: prefer new commits over amending; never skip hooks; never force-push without explicit request
- For long-running commands, use run_in_background: true

## Parallel Tool Calls
When multiple independent pieces of information are needed, make multiple tool calls in a single response. Do not serialize independent operations.`;
  }

  // ─── Section: Code Guidelines ───────────────────────────────────

  static buildCodeGuidelines(): string {
    return `# Code Guidelines

- Always Read files before modifying them to understand existing patterns and context
- Keep changes minimal and focused on what was requested; do not add unrequested features
- Do not over-engineer solutions; prefer simplicity and clarity
- Follow existing code style, naming conventions, and architecture patterns in the project
- Avoid introducing security vulnerabilities (injection, XSS, path traversal, hardcoded secrets, etc.)
- Do not commit or create files containing secrets (.env, credentials, API keys)
- When fixing bugs, verify the root cause before applying a fix
- When creating new files, follow the project's established directory structure
- Prefer editing existing files over creating new ones
- Do not create documentation files (README, .md) unless explicitly asked`;
  }

  // ─── Section: Git Instructions ──────────────────────────────────

  static buildGitInstructions(): string {
    return `# Git Instructions

## Commit Protocol
- Only create commits when the user explicitly asks
- Read recent commit messages (git log) to match the repository's style
- Use git diff to review all staged and unstaged changes before committing
- Write concise commit messages (1-2 sentences) focused on "why" not "what"
- Always pass commit messages via HEREDOC for proper formatting:
  git commit -m "$(cat <<'EOF'
  Commit message here.

  Co-Authored-By: KCode <noreply@astrolexis.dev>
  EOF
  )"
- Stage specific files by name; avoid "git add -A" or "git add ." which may include sensitive files
- After committing, run git status to verify success

## Git Safety
- NEVER modify git config
- NEVER run destructive commands (push --force, reset --hard, checkout ., clean -f, branch -D) unless the user explicitly requests them
- NEVER skip hooks (--no-verify) or bypass signing unless explicitly asked
- NEVER force push to main/master; warn the user if they request it
- Always create NEW commits rather than amending, unless explicitly asked to amend
- When a pre-commit hook fails, fix the issue, re-stage, and create a NEW commit (do not amend)

## Pull Request Protocol
- Use gh CLI for all GitHub operations
- Analyze ALL commits on the branch (not just the latest) before drafting PR description
- Keep PR title under 70 characters; use body for details
- Check if the branch needs to be pushed before creating the PR
- Use HEREDOC for the PR body to ensure correct formatting`;
  }

  // ─── Section: Tone and Output ───────────────────────────────────

  static buildToneAndOutput(): string {
    return `# Communication Style

- Be concise and direct; go straight to the point
- Lead with action, not reasoning; do first, explain briefly after
- Do not use emojis unless the user explicitly requests them
- Do not add filler phrases ("Sure!", "Great question!", "Let me help you with that!")
- Use absolute file paths in responses, never relative
- Include code snippets only when the exact text is meaningful (e.g., a bug found, a function signature asked for); do not recap code you merely read
- When reporting results, share only the essentials`;
  }

  // ─── Section: Environment ───────────────────────────────────────

  static buildEnvironment(config: KCodeConfig): string {
    const platform = process.platform;
    const shell = process.env.SHELL ?? "unknown";
    const osVersion = this.getOSVersion();
    const gitInfo = this.getGitInfo(config.workingDirectory);
    const today = new Date().toISOString().split("T")[0];

    const lines = [
      "# Environment",
      `- Working directory: ${config.workingDirectory}`,
      `- Platform: ${platform}`,
      `- Shell: ${shell}`,
    ];

    if (osVersion) {
      lines.push(`- OS: ${osVersion}`);
    }

    lines.push(`- Git repo: ${gitInfo.isRepo ? "Yes" : "No"}`);
    if (gitInfo.isRepo && gitInfo.branch) {
      lines.push(`- Git branch: ${gitInfo.branch}`);
    }
    if (gitInfo.isRepo && gitInfo.dirty !== undefined) {
      lines.push(`- Uncommitted changes: ${gitInfo.dirty ? "Yes" : "No"}`);
    }

    lines.push(`- Model: ${config.model}`);
    lines.push(`- Date: ${today}`);

    return lines.join("\n");
  }

  // ─── Section: Project Instructions ──────────────────────────────

  static loadProjectInstructions(cwd: string): string | null {
    const candidates = ["KCODE.md"];
    const loaded: string[] = [];

    for (const filename of candidates) {
      const filePath = join(cwd, filename);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, "utf-8").trim();
          if (content) {
            loaded.push(`# Project Instructions (${filename})\n\n${content}`);
          }
        } catch {
          // Skip unreadable files
        }
      }
    }

    // Also check parent directories up to 3 levels for inherited instructions
    let dir = cwd;
    for (let i = 0; i < 3; i++) {
      const parent = join(dir, "..");
      if (parent === dir) break; // reached root
      dir = parent;

      for (const filename of candidates) {
        const filePath = join(dir, filename);
        if (existsSync(filePath)) {
          try {
            const content = readFileSync(filePath, "utf-8").trim();
            if (content) {
              const rel = dir === cwd ? filename : `${basename(dir)}/${filename}`;
              loaded.push(`# Inherited Instructions (${rel})\n\n${content}`);
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    }

    return loaded.length > 0 ? loaded.join("\n\n") : null;
  }

  // ─── Section: Memory System ─────────────────────────────────────

  static loadMemoryInstructions(): string | null {
    const memoryPaths = [
      join(homedir(), ".kcode", "memory.md"),
      join(homedir(), ".kcode", "memory.md"),
    ];

    for (const memPath of memoryPaths) {
      if (existsSync(memPath)) {
        try {
          const content = readFileSync(memPath, "utf-8").trim();
          if (content) {
            return `# Memory\n\nThe following is persisted context from previous conversations:\n\n${content}`;
          }
        } catch {
          // Skip unreadable
        }
      }
    }

    return null;
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private static getGitInfo(cwd: string): GitInfo {
    try {
      // Check if directory is a git repo
      execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" });

      let branch: string | undefined;
      try {
        branch = execSync("git branch --show-current", { cwd, stdio: "pipe" })
          .toString()
          .trim();
        if (!branch) {
          // Detached HEAD - get short SHA
          branch = execSync("git rev-parse --short HEAD", { cwd, stdio: "pipe" })
            .toString()
            .trim();
          branch = `detached at ${branch}`;
        }
      } catch {
        branch = undefined;
      }

      let dirty: boolean | undefined;
      try {
        const status = execSync("git status --porcelain", { cwd, stdio: "pipe" })
          .toString()
          .trim();
        dirty = status.length > 0;
      } catch {
        dirty = undefined;
      }

      return { isRepo: true, branch, dirty };
    } catch {
      return { isRepo: false };
    }
  }

  private static getOSVersion(): string | null {
    try {
      if (process.platform === "linux") {
        return execSync("uname -sr", { stdio: "pipe" }).toString().trim();
      } else if (process.platform === "darwin") {
        const version = execSync("sw_vers -productVersion", { stdio: "pipe" })
          .toString()
          .trim();
        return `macOS ${version}`;
      }
    } catch {
      // Ignore
    }
    return null;
  }
}

// ─── Types ──────────────────────────────────────────────────────

interface GitInfo {
  isRepo: boolean;
  branch?: string;
  dirty?: boolean;
}
