// KCode - System Prompt Context Functions
// Environment/dynamic context methods and system introspection helpers
// (extracted from SystemPromptBuilder)

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { log } from "./logger";
import { kcodePath } from "./paths";
import type { KCodeConfig } from "./types";

// ─── Types ──────────────────────────────────────────────────────

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  dirty?: boolean;
  mainBranch?: string;
  recentCommits?: string;
  changedFiles?: string;
}

// ─── Section: Environment ───────────────────────────────────────

export function buildEnvironment(config: KCodeConfig): string {
  const platform = process.platform;
  const shell = process.env.SHELL ?? "unknown";
  const osVersion = getOSVersion();
  const gitInfo = getGitInfo(config.workingDirectory);
  const today = new Date().toISOString().split("T")[0];

  const lines = ["# Environment", `- Working directory: ${config.workingDirectory}`];

  if (config.additionalDirs && config.additionalDirs.length > 0) {
    lines.push(`- Additional directories: ${config.additionalDirs.join(", ")}`);
  }

  lines.push(`- Platform: ${platform}`);
  lines.push(`- Shell: ${shell}`);

  if (osVersion) {
    lines.push(`- OS: ${osVersion}`);
  }

  lines.push(`- Git repo: ${gitInfo.isRepo ? "Yes" : "No"}`);
  if (gitInfo.isRepo && gitInfo.branch) {
    lines.push(`- Git branch: ${gitInfo.branch}`);
  }
  if (gitInfo.isRepo && gitInfo.mainBranch) {
    lines.push(`- Main branch: ${gitInfo.mainBranch}`);
  }
  if (gitInfo.isRepo && gitInfo.dirty !== undefined) {
    lines.push(`- Uncommitted changes: ${gitInfo.dirty ? "Yes" : "No"}`);
  }
  if (gitInfo.isRepo && gitInfo.recentCommits) {
    lines.push("- Recent commits:");
    for (const line of gitInfo.recentCommits.split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  if (gitInfo.isRepo && gitInfo.changedFiles) {
    lines.push("- Changed files:");
    for (const line of gitInfo.changedFiles.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  // Cap total git context to avoid bloating the system prompt
  // "- Model:" is added after this block, so end is always lines.length
  const gitStartIdx = lines.findIndex((l) => l.startsWith("- Git repo:"));
  if (gitStartIdx >= 0) {
    const gitSection = lines.slice(gitStartIdx).join("\n");
    if (gitSection.length > 2000) {
      const truncated = gitSection.slice(0, 1950) + "\n  ... (git context truncated)";
      const truncatedLines = truncated.split("\n");
      lines.splice(gitStartIdx, lines.length - gitStartIdx, ...truncatedLines);
    }
  }

  lines.push(`- Model: ${config.model}`);
  lines.push(`- Date: ${today}`);

  return lines.join("\n");
}

// ─── Section: Situational Awareness ────────────────────────────

export function buildSituationalAwareness(config: KCodeConfig): string {
  const lines = [
    "# Situational Awareness",
    "",
    "You are aware of your operating context at all times:",
  ];

  // Context window awareness
  const ctxSize = config.contextWindowSize ?? 0;
  if (ctxSize > 0) {
    lines.push(
      `- Your context window is ${ctxSize.toLocaleString()} tokens. As the conversation grows, older messages will be pruned. Be mindful of this — if a task requires many steps, summarize progress periodically.`,
    );
  }

  // Project scan — quick overview of what's in the working directory
  const projectInfo = scanProject(config.workingDirectory);
  if (projectInfo) {
    lines.push(`- Project scan of ${config.workingDirectory}:`);
    lines.push(projectInfo);
  }

  // Running services — what ports are in use locally
  const ports = detectListeningPorts();
  if (ports) {
    lines.push(`- Services detected on local ports: ${ports}`);
    lines.push("  Be aware of port conflicts when launching new services.");
  }

  // Disk space awareness
  const diskInfo = getDiskUsage(config.workingDirectory);
  if (diskInfo) {
    lines.push(`- Disk: ${diskInfo}`);
  }

  // System load
  const loadInfo = getSystemLoad();
  if (loadInfo) {
    lines.push(`- System: ${loadInfo}`);
  }

  // Time awareness
  const now = new Date();
  const hour = now.getHours();
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  lines.push(`- Current time: ${timeStr}`);
  if (hour >= 22 || hour < 6) {
    lines.push(
      "  (Late hours — the user may be tired. Be extra careful with destructive operations.)",
    );
  }

  return lines.join("\n");
}

// ─── Section: Project Instructions ──────────────────────────────

export function loadProjectInstructions(cwd: string): string | null {
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
      } catch (err) {
        log.debug("prompt", "Failed to read project instructions file " + filename + ": " + err);
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
        } catch (err) {
          log.debug(
            "prompt",
            "Failed to read inherited instructions file " + filename + ": " + err,
          );
        }
      }
    }
  }

  return loaded.length > 0 ? loaded.join("\n\n") : null;
}

// ─── Section: Memory System ─────────────────────────────────────

export function loadMemoryInstructions(): string | null {
  const memoryPaths = [kcodePath("memory.md")];

  for (const memPath of memoryPaths) {
    if (existsSync(memPath)) {
      try {
        const content = readFileSync(memPath, "utf-8").trim();
        if (content) {
          return `# Memory\n\nThe following is persisted context from previous conversations:\n\n${content}`;
        }
      } catch (err) {
        log.debug("memory", "Failed to read memory file: " + err);
      }
    }
  }

  return null;
}

// ─── Extensible Consciousness ──────────────────────────────────

/**
 * Load user-defined identity extensions from ~/.kcode/identity.md
 * This file can add personality traits, preferences, context about the user, etc.
 */
export function loadExtensibleIdentity(): string | null {
  const identityPath = kcodePath("identity.md");
  try {
    if (!existsSync(identityPath)) return null;
    const content = readFileSync(identityPath, "utf-8").trim();
    if (!content) return null;
    return `# Extended Identity\n\n${content}`;
  } catch (err) {
    log.debug("identity", "Failed to read identity.md: " + err);
    return null;
  }
}

/**
 * Load awareness modules from a directory of .md files.
 * Each file becomes an independent awareness module injected into the system prompt.
 *
 * Global: ~/.kcode/awareness/*.md
 * Project: <cwd>/.kcode/awareness/*.md
 *
 * Files are sorted alphabetically. Filenames become section titles:
 *   01-ports.md      → "Awareness: ports"
 *   security.md      → "Awareness: security"
 */
export function loadAwarenessModules(projectDir?: string): string[] {
  const dir = projectDir ? join(projectDir, ".kcode", "awareness") : kcodePath("awareness");

  const modules: string[] = [];

  try {
    if (!existsSync(dir)) return modules;
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      try {
        const content = readFileSync(join(dir, entry.name), "utf-8").trim();
        if (!content) continue;

        // Derive a title from the filename: "01-security-rules.md" → "security rules"
        const title = entry.name.replace(/\.md$/, "").replace(/^\d+-/, "").replace(/[-_]/g, " ");

        const scope = projectDir ? "Project" : "Global";
        modules.push(`# ${scope} Awareness: ${title}\n\n${content}`);
      } catch (err) {
        log.debug("awareness", "Failed to read awareness module " + entry.name + ": " + err);
      }
    }
  } catch (err) {
    log.debug("awareness", "Failed to read awareness directory: " + err);
  }

  return modules;
}

// ─── Selective Attention ─────────────────────────────────────────

/**
 * Extract context keywords from the project scan for selective attention.
 * Uses stack indicators (TypeScript, React, etc.) and directory names
 * to score and filter learnings by relevance.
 */
export function extractContextKeywords(config: KCodeConfig): string[] {
  const keywords: string[] = [];

  try {
    const entries = readdirSync(config.workingDirectory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;
      if (entry.isDirectory()) {
        if (
          !["node_modules", "dist", "build", ".next", "__pycache__", "venv", ".git"].includes(
            entry.name,
          )
        ) {
          keywords.push(entry.name);
        }
      } else {
        files.push(entry.name);
      }
    }

    // Stack indicators from marker files
    if (files.includes("package.json")) keywords.push("node", "npm", "javascript");
    if (files.includes("tsconfig.json")) keywords.push("typescript");
    if (
      files.includes("next.config.ts") ||
      files.includes("next.config.js") ||
      files.includes("next.config.mjs")
    )
      keywords.push("next", "react");
    if (files.includes("Cargo.toml")) keywords.push("rust", "cargo");
    if (files.includes("go.mod")) keywords.push("go", "golang");
    if (
      files.includes("requirements.txt") ||
      files.includes("pyproject.toml") ||
      files.includes("setup.py")
    )
      keywords.push("python", "pip");
    if (files.includes("Gemfile")) keywords.push("ruby", "rails");
    if (files.includes("pom.xml") || files.includes("build.gradle"))
      keywords.push("java", "maven", "gradle");
    if (files.includes("Package.swift")) keywords.push("swift", "ios", "xcode");
    if (files.includes("docker-compose.yml") || files.includes("Dockerfile"))
      keywords.push("docker", "container");
    if (files.includes("Makefile")) keywords.push("make");
    if (files.includes("bun.lockb") || files.includes("bunfig.toml")) keywords.push("bun");
    if (files.includes("vite.config.ts") || files.includes("vite.config.js"))
      keywords.push("vite");
    if (files.includes("tailwind.config.ts") || files.includes("tailwind.config.js"))
      keywords.push("tailwind");
    if (
      files.includes(".eslintrc.js") ||
      files.includes("eslint.config.js") ||
      files.includes(".eslintrc.json")
    )
      keywords.push("eslint");
  } catch (err) {
    log.debug("prompt", "Failed to detect project keywords: " + err);
  }

  return keywords;
}

// ─── Awareness Helpers ─────────────────────────────────────────

export function scanProject(cwd: string): string | null {
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    const dirs: string[] = [];
    const files: string[] = [];
    const indicators: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;
      if (entry.isDirectory()) {
        if (
          !["node_modules", "dist", "build", ".next", "__pycache__", "venv", ".git"].includes(
            entry.name,
          )
        ) {
          dirs.push(entry.name + "/");
        }
      } else {
        files.push(entry.name);
      }
    }

    // Detect project type from marker files
    if (files.includes("package.json")) indicators.push("Node.js");
    if (files.includes("tsconfig.json")) indicators.push("TypeScript");
    if (
      files.includes("next.config.ts") ||
      files.includes("next.config.js") ||
      files.includes("next.config.mjs")
    )
      indicators.push("Next.js");
    if (files.includes("Cargo.toml")) indicators.push("Rust");
    if (files.includes("go.mod")) indicators.push("Go");
    if (
      files.includes("requirements.txt") ||
      files.includes("pyproject.toml") ||
      files.includes("setup.py")
    )
      indicators.push("Python");
    if (files.includes("Gemfile")) indicators.push("Ruby");
    if (files.includes("pom.xml") || files.includes("build.gradle")) indicators.push("Java");
    if (files.includes("Package.swift")) indicators.push("Swift");
    if (files.includes("docker-compose.yml") || files.includes("Dockerfile"))
      indicators.push("Docker");
    if (files.includes("Makefile")) indicators.push("Make");

    const parts: string[] = [];
    if (indicators.length > 0) parts.push(`  Stack: ${indicators.join(", ")}`);
    if (dirs.length > 0)
      parts.push(
        `  Directories: ${dirs.slice(0, 15).join(", ")}${dirs.length > 15 ? ` (+${dirs.length - 15} more)` : ""}`,
      );
    if (files.length > 0)
      parts.push(
        `  Root files: ${files.slice(0, 10).join(", ")}${files.length > 10 ? ` (+${files.length - 10} more)` : ""}`,
      );

    return parts.length > 0 ? parts.join("\n") : null;
  } catch (err) {
    log.debug("prompt", "Failed to scan project directory: " + err);
    return null;
  }
}

export function detectListeningPorts(): string | null {
  try {
    const output = execSync(
      "ss -tlnp 2>/dev/null | grep LISTEN | awk '{print $4}' | grep -oP '\\d+$' | sort -n | uniq",
      {
        stdio: "pipe",
        timeout: 2000,
      },
    )
      .toString()
      .trim();

    if (!output) return null;
    const ports = output.split("\n").filter((p) => {
      const n = parseInt(p);
      return n >= 1024 && n <= 65535; // Only user ports
    });
    return ports.length > 0 ? ports.join(", ") : null;
  } catch (err) {
    log.debug("prompt", "Failed to detect listening ports: " + err);
    return null;
  }
}

export function getDiskUsage(cwd: string): string | null {
  try {
    const output = execSync(
      `df -h "${cwd}" 2>/dev/null | tail -1 | awk '{print $4 " available (" $5 " used)"}'`,
      {
        stdio: "pipe",
        timeout: 2000,
      },
    )
      .toString()
      .trim();
    return output || null;
  } catch (err) {
    log.debug("prompt", "Failed to get disk usage: " + err);
    return null;
  }
}

export function getSystemLoad(): string | null {
  try {
    const load = execSync("cat /proc/loadavg 2>/dev/null | awk '{print $1, $2, $3}'", {
      stdio: "pipe",
      timeout: 1000,
    })
      .toString()
      .trim();
    const mem = execSync("free -h 2>/dev/null | awk '/^Mem:/{print $3 \"/\" $2}'", {
      stdio: "pipe",
      timeout: 1000,
    })
      .toString()
      .trim();
    const parts: string[] = [];
    if (load) parts.push(`load ${load}`);
    if (mem) parts.push(`RAM ${mem}`);
    return parts.length > 0 ? parts.join(", ") : null;
  } catch (err) {
    log.debug("prompt", "Failed to get system load: " + err);
    return null;
  }
}

export function getGitInfo(cwd: string): GitInfo {
  try {
    // Check if directory is a git repo
    execSync("git rev-parse --git-dir", { cwd, stdio: "pipe", timeout: 3000 });

    let branch: string | undefined;
    try {
      branch = execSync("git branch --show-current", { cwd, stdio: "pipe", timeout: 3000 })
        .toString()
        .trim();
      if (!branch) {
        // Detached HEAD - get short SHA
        branch = execSync("git rev-parse --short HEAD", { cwd, stdio: "pipe", timeout: 3000 })
          .toString()
          .trim();
        branch = `detached at ${branch}`;
      }
    } catch (err) {
      log.debug("git", "Failed to detect git branch: " + err);
      branch = undefined;
    }

    // Main branch detection
    let mainBranch: string | undefined;
    try {
      for (const name of ["main", "master"]) {
        try {
          execSync(`git rev-parse --verify refs/heads/${name}`, {
            cwd,
            stdio: "pipe",
            timeout: 3000,
          });
          mainBranch = name;
          break;
        } catch (err) {
          log.debug("git", "Branch " + name + " not found: " + err);
        }
      }
      if (!mainBranch) {
        try {
          const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD --short", {
            cwd,
            stdio: "pipe",
            timeout: 3000,
          })
            .toString()
            .trim();
          mainBranch = ref.replace("origin/", "");
        } catch (err) {
          log.debug("git", "Failed to detect remote HEAD, defaulting to main: " + err);
          mainBranch = "main";
        }
      }
    } catch (err) {
      log.debug("git", "Failed to detect main branch: " + err);
      mainBranch = undefined;
    }

    // Recent commits (last 5)
    let recentCommits: string | undefined;
    try {
      const commits = execSync("git log --oneline -n 5 --no-decorate", {
        cwd,
        stdio: "pipe",
        timeout: 3000,
      })
        .toString()
        .trim();
      if (commits) recentCommits = commits;
    } catch (err) {
      log.debug("git", "Failed to load recent commits: " + err);
      recentCommits = undefined;
    }

    // Changed files + dirty state (single git status call)
    let dirty: boolean | undefined;
    let changedFiles: string | undefined;
    try {
      const statusOutput = execSync("git status --short", { cwd, stdio: "pipe", timeout: 3000 })
        .toString()
        .trim();
      dirty = statusOutput.length > 0;
      if (statusOutput) {
        const statusLines = statusOutput.split("\n");
        if (statusLines.length > 20) {
          changedFiles =
            statusLines.slice(0, 20).join("\n") + `\n  ... (+${statusLines.length - 20} more)`;
        } else {
          changedFiles = statusOutput;
        }
      }
    } catch (err) {
      log.debug("git", "Failed to get git status: " + err);
      dirty = undefined;
      changedFiles = undefined;
    }

    return { isRepo: true, branch, dirty, mainBranch, recentCommits, changedFiles };
  } catch (err) {
    log.debug("git", "Directory is not a git repo: " + err);
    return { isRepo: false };
  }
}

export function getOSVersion(): string | null {
  try {
    if (process.platform === "linux") {
      return execSync("uname -sr", { stdio: "pipe" }).toString().trim();
    } else if (process.platform === "darwin") {
      const version = execSync("sw_vers -productVersion", { stdio: "pipe" }).toString().trim();
      return `macOS ${version}`;
    }
  } catch (err) {
    log.debug("prompt", "Failed to detect OS version: " + err);
  }
  return null;
}
