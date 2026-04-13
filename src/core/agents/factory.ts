// KCode — Agent factory
//
// Turns user intent + project stack into a set of AgentSpecs that
// the pool can execute in parallel. Two entry points:
//
//   dispatch(opts)           — create specs from a high-level goal
//   dispatchFromInstruction  — parse natural language like
//                              "liberemos 3 agentes para auditar backend/"
//
// The factory is deliberately conservative: it generates fewer
// agents when the task is simple, more when it's complex, and never
// exceeds the pool's maxConcurrent.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AgentPool, getAgentPool } from "./pool";
import { roleFromTask, ROLES } from "./roles";
import type { Agent, AgentExecutor, AgentRole, AgentSpec } from "./types";

/** Detected project characteristics used to pick roles. */
export interface StackInfo {
  languages: Set<string>;
  frameworks: string[];
  hasTests: boolean;
  hasLinter: boolean;
  hasGit: boolean;
  hasDocs: boolean;
  sourceDirs: string[];
  topLevelDirs: string[];
  fileCount: number;
}

/**
 * Detect the project stack for a directory. Reads package.json,
 * pyproject.toml, Cargo.toml, and scans for source directories.
 * Never throws — returns an empty StackInfo on any error.
 */
export function detectStack(cwd: string): StackInfo {
  const info: StackInfo = {
    languages: new Set(),
    frameworks: [],
    hasTests: false,
    hasLinter: false,
    hasGit: existsSync(join(cwd, ".git")),
    hasDocs: existsSync(join(cwd, "docs")) || existsSync(join(cwd, "README.md")),
    sourceDirs: [],
    topLevelDirs: [],
    fileCount: 0,
  };

  // Node / TS / JS
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    info.languages.add("typescript");
    info.languages.add("javascript");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      for (const dep of Object.keys(allDeps)) {
        if (dep === "next" || dep === "react") info.frameworks.push(dep);
        if (dep === "vue" || dep === "svelte") info.frameworks.push(dep);
        if (dep === "express" || dep === "fastify") info.frameworks.push(dep);
        if (dep === "vite") info.frameworks.push("vite");
      }
      if (pkg.scripts?.test) info.hasTests = true;
      if (pkg.scripts?.lint || allDeps.eslint) info.hasLinter = true;
    } catch {
      // bad JSON — don't crash
    }
  }

  // Python
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "requirements.txt"))) {
    info.languages.add("python");
    if (existsSync(join(cwd, "manage.py"))) info.frameworks.push("django");
    try {
      const toml = existsSync(join(cwd, "pyproject.toml"))
        ? readFileSync(join(cwd, "pyproject.toml"), "utf-8")
        : "";
      if (toml.includes("fastapi")) info.frameworks.push("fastapi");
      if (toml.includes("flask")) info.frameworks.push("flask");
      if (toml.includes("pytest")) info.hasTests = true;
      if (toml.includes("ruff") || toml.includes("mypy") || toml.includes("flake8")) {
        info.hasLinter = true;
      }
    } catch {
      /* ignore */
    }
  }

  // Rust
  if (existsSync(join(cwd, "Cargo.toml"))) {
    info.languages.add("rust");
    // Cargo has built-in test and clippy
    info.hasTests = true;
    info.hasLinter = true;
  }

  // Go
  if (existsSync(join(cwd, "go.mod"))) {
    info.languages.add("go");
    info.hasTests = true;
  }

  // Enumerate top-level directories (for work division)
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        info.topLevelDirs.push(entry.name);
        // Common source dirs
        if (["src", "lib", "app", "core", "backend", "frontend", "api"].includes(entry.name)) {
          info.sourceDirs.push(entry.name);
        }
      }
    }
  } catch {
    /* ignore */
  }

  // Rough file count (for sizing decisions)
  try {
    const countFiles = (dir: string, depth = 0): number => {
      if (depth > 3) return 0;
      let n = 0;
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const full = join(dir, e.name);
          if (e.isFile()) n++;
          else if (e.isDirectory()) n += countFiles(full, depth + 1);
        }
      } catch {
        /* ignore */
      }
      return n;
    };
    info.fileCount = countFiles(cwd);
  } catch {
    /* ignore */
  }

  return info;
}

/** Options for the factory's high-level dispatch. */
export interface DispatchOptions {
  /** Project root — used for stack detection and work division. */
  cwd: string;
  /** User's goal in natural language. */
  task: string;
  /** Hard cap on agent count. Pool enforces its own limit separately. */
  maxAgents?: number;
  /** Optional group name — if set, all spawned agents join this group. */
  groupName?: string;
  /** Optional mission statement for the group. */
  groupMission?: string;
  /** Executor to run each agent with. */
  executor?: AgentExecutor;
  /** Override the pool singleton (for tests). */
  pool?: AgentPool;
}

/**
 * High-level dispatch: given a task and a cwd, decide which roles
 * and how many agents to spawn, then launch them through the pool.
 *
 * Heuristics:
 *   - Audit / security tasks: 1 auditor + 1 fixer + 1 tester
 *   - Feature work: 1 architect → 1 worker + 1 tester + 1 reviewer
 *   - Refactor: 1 explorer + 1 worker + 1 tester
 *   - Exploration: 1 explorer
 *   - Docs: 1 docs
 *
 * Returns the spawned Agent objects (which may still be in
 * "spawning" state if the pool queued them).
 */
export function dispatch(opts: DispatchOptions): Agent[] {
  const pool = opts.pool ?? getAgentPool();
  const info = detectStack(opts.cwd);
  const maxAgents = Math.min(opts.maxAgents ?? pool.maxConcurrent, pool.maxConcurrent);

  const primaryRole = roleFromTask(opts.task);
  const specs: AgentSpec[] = [];

  const baseSpec = (role: AgentRole, task: string, targetPath?: string): AgentSpec => ({
    role,
    task,
    targetPath,
    groupName: opts.groupName,
  });

  // Build the spec list based on the primary role. These are
  // intentionally conservative — the model can always spawn more
  // manually via the Agent tool.
  switch (primaryRole) {
    case "auditor":
    case "security":
      specs.push(baseSpec("auditor", `Audit ${opts.cwd} for security vulnerabilities`));
      if (info.sourceDirs.length > 1) {
        for (const dir of info.sourceDirs.slice(0, 3)) {
          specs.push(baseSpec("auditor", `Deep audit of ${dir}/`, dir));
        }
      }
      specs.push(baseSpec("fixer", "Apply audit findings"));
      break;

    case "fixer":
      specs.push(baseSpec("fixer", opts.task));
      if (info.hasTests) specs.push(baseSpec("tester", "Verify fixes via test run"));
      break;

    case "tester":
      specs.push(baseSpec("tester", opts.task));
      break;

    case "linter":
      specs.push(baseSpec("linter", opts.task));
      break;

    case "reviewer":
      specs.push(baseSpec("reviewer", opts.task));
      break;

    case "architect":
      specs.push(baseSpec("architect", opts.task));
      break;

    case "optimizer":
      specs.push(baseSpec("optimizer", opts.task));
      break;

    case "docs":
      specs.push(baseSpec("docs", opts.task));
      break;

    case "migration":
      specs.push(baseSpec("architect", "Plan the migration sequence"));
      specs.push(baseSpec("migration", opts.task));
      if (info.hasTests) specs.push(baseSpec("tester", "Regression-test after migration"));
      break;

    case "explorer":
      specs.push(baseSpec("explorer", opts.task));
      break;

    case "scribe":
      specs.push(baseSpec("scribe", opts.task));
      break;

    default:
      // Generic worker — split by source directory if available.
      if (info.sourceDirs.length >= 2) {
        for (const dir of info.sourceDirs.slice(0, 3)) {
          specs.push(baseSpec("worker", `${opts.task} (${dir})`, dir));
        }
      } else {
        specs.push(baseSpec("worker", opts.task));
      }
  }

  // Enforce the maxAgents cap BEFORE spawning.
  const capped = specs.slice(0, maxAgents);

  // Create the group if the caller asked for one.
  if (opts.groupName) {
    pool.createGroup(opts.groupName, opts.groupMission ?? opts.task, []);
  }

  // Spawn each spec and collect the live Agent objects.
  const spawned: Agent[] = [];
  for (const spec of capped) {
    spawned.push(pool.spawn(spec, opts.executor));
  }
  return spawned;
}

/**
 * Parse natural language instructions like "liberemos 3 agentes
 * para auditar el backend" or "formemos 2 grupos: Alfa para
 * security, Beta para performance". Returns the spawned agents.
 *
 * This is deliberately lightweight pattern matching — the model
 * is expected to handle complex work division itself by calling
 * dispatch() directly with structured specs. This function covers
 * the quick path where the user speaks naturally.
 */
export function dispatchFromInstruction(
  instruction: string,
  opts: Omit<DispatchOptions, "task">,
): Agent[] {
  // "N agentes" → pick N
  const countMatch = instruction.match(
    /(\d+)\s+(?:agente|agent|worker|bot)/i,
  );
  const requestedCount = countMatch ? parseInt(countMatch[1]!, 10) : undefined;

  // "grupo X" / "group X" → assign group name
  const groupMatch = instruction.match(/grupo\s+(\w+)|group\s+(\w+)/i);
  const groupName = groupMatch ? groupMatch[1] ?? groupMatch[2] : undefined;

  // Strip the "N agentes para" prefix so we have a cleaner task description
  const task = instruction
    .replace(/^.*?(?:\d+\s+(?:agente|agent|worker)s?)\s+(?:para|to|for)\s+/i, "")
    .replace(/grupo\s+\w+\s*[:,]?\s*/gi, "")
    .trim();

  return dispatch({
    ...opts,
    task: task.length > 0 ? task : instruction,
    maxAgents: requestedCount,
    groupName,
  });
}
