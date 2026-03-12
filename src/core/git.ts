// KCode - Git Context
// Provides git repository information for system prompt and tools

import { spawn } from "node:child_process";

const GIT_TIMEOUT = 30_000; // 30 seconds
const MAX_STATUS_CHARS = 40_000;

// ─── Git Command Runner ─────────────────────────────────────────

async function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const proc = spawn("git", ["--no-optional-locks", ...args], {
      cwd,
      timeout: GIT_TIMEOUT,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    proc.stdout.on("data", (data: Buffer) => chunks.push(data));
    proc.stderr.on("data", (data: Buffer) => errChunks.push(data));

    proc.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
        reject(new Error(stderr || `git exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf-8").trim());
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

// ─── Public API ─────────────────────────────────────────────────

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    return await runGit(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    return null;
  }
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  try {
    return await runGit(["branch", "--show-current"], cwd);
  } catch {
    return null;
  }
}

export async function getMainBranch(cwd: string): Promise<string> {
  // Try common main branch names
  for (const name of ["main", "master"]) {
    try {
      await runGit(["rev-parse", "--verify", `refs/heads/${name}`], cwd);
      return name;
    } catch {
      // try next
    }
  }

  // Fallback: check remote HEAD
  try {
    const result = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd);
    // result looks like "origin/main"
    return result.replace("origin/", "");
  } catch {
    return "main";
  }
}

export async function getGitStatus(cwd: string): Promise<string | null> {
  try {
    const result = await runGit(["status", "--short"], cwd);
    if (result.length > MAX_STATUS_CHARS) {
      return result.slice(0, MAX_STATUS_CHARS) + "\n... (truncated)";
    }
    return result || null;
  } catch {
    return null;
  }
}

export async function getRecentCommits(cwd: string, count: number = 5): Promise<string | null> {
  try {
    return await runGit(
      ["log", `--oneline`, `-n`, String(count), "--no-decorate"],
      cwd,
    );
  } catch {
    return null;
  }
}

// ─── Aggregate Context ──────────────────────────────────────────

export interface GitContext {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  mainBranch: string;
  status: string | null;
  recentCommits: string | null;
}

export async function getGitContext(cwd: string): Promise<GitContext> {
  const isRepo = await isGitRepo(cwd);
  if (!isRepo) {
    return {
      isRepo: false,
      root: null,
      branch: null,
      mainBranch: "main",
      status: null,
      recentCommits: null,
    };
  }

  const [root, branch, mainBranch, status, recentCommits] = await Promise.all([
    getGitRoot(cwd),
    getCurrentBranch(cwd),
    getMainBranch(cwd),
    getGitStatus(cwd),
    getRecentCommits(cwd),
  ]);

  return { isRepo, root, branch, mainBranch, status, recentCommits };
}
