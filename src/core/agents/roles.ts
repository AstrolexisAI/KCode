// KCode — Agent role templates
//
// Each role is a specialization profile: an icon for the TUI, a
// display name, a system-prompt seed that frames the agent's
// mission, and a tool allowlist. The factory picks a role based on
// task keywords and project stack; the pool uses the role to build
// the per-agent request when spawning real LLM calls.

import type { AgentRole } from "./types";

export interface RoleTemplate {
  /** Role identifier — matches AgentRole union. */
  role: AgentRole;
  /** Emoji shown next to the agent name in the TUI. */
  icon: string;
  /** Human-readable label ("Security Auditor", "Code Fixer"). */
  displayName: string;
  /**
   * System-prompt fragment injected into the agent's LLM request.
   * Frames the agent's mission and constraints. Short and directive.
   */
  systemPromptSeed: string;
  /**
   * Tools this role is allowed to use. Subset of the full tool
   * registry. Empty list means all tools allowed.
   */
  allowedTools: string[];
  /**
   * Default max turns this agent can run before being forced to
   * wrap up. Keeps reasoning agents from burning budget.
   */
  defaultMaxTurns: number;
  /**
   * Short description shown in the /agents list and Kodi panel.
   */
  description: string;
}

/**
 * Registry of all available roles. Adding a new role means:
 *   1. Add the variant to AgentRole in types.ts
 *   2. Add a RoleTemplate here
 *   3. Optional: update factory.ts to pick the role from keywords
 */
export const ROLES: Record<AgentRole, RoleTemplate> = {
  auditor: {
    role: "auditor",
    icon: "🔍",
    displayName: "Auditor",
    description: "Scans code for security vulnerabilities and bugs",
    systemPromptSeed:
      "You are a security auditor. Scan the target path for known vulnerability patterns " +
      "(CWE Top 25, OWASP Top 10). For each finding, report file:line, severity, and a " +
      "one-sentence explanation. Read-only — do NOT modify files.",
    allowedTools: ["Read", "Grep", "Glob", "LS"],
    defaultMaxTurns: 30,
  },
  fixer: {
    role: "fixer",
    icon: "🔧",
    displayName: "Fixer",
    description: "Applies audit fixes and verifies they compile",
    systemPromptSeed:
      "You apply fixes to confirmed audit findings. Use the /fix bespoke recipes when " +
      "available. For each fix: read the file, apply the minimal change, verify the code " +
      "still compiles. Report what you changed and why. Never edit files outside the " +
      "finding's scope.",
    allowedTools: ["Read", "Edit", "Write", "Grep", "Bash"],
    defaultMaxTurns: 20,
  },
  tester: {
    role: "tester",
    icon: "🧪",
    displayName: "Tester",
    description: "Runs tests and analyzes failures",
    systemPromptSeed:
      "You run the project's test suite and analyze failures. Use the detected test " +
      "runner (bun test, jest, pytest, cargo test, go test). Report pass/fail counts, " +
      "group failures by root cause, and suggest fixes. Do not modify source code — " +
      "only run tests and interpret results.",
    allowedTools: ["Bash", "Read", "Grep", "TestRunner"],
    defaultMaxTurns: 15,
  },
  linter: {
    role: "linter",
    icon: "📏",
    displayName: "Linter",
    description: "Runs linters and formatters, reports style issues",
    systemPromptSeed:
      "You run the project's linter (eslint, clippy, ruff, mypy, etc.) and report " +
      "issues. Do not auto-fix unless explicitly asked — just classify and prioritize. " +
      "Focus on HIGH-severity style/correctness issues first.",
    allowedTools: ["Bash", "Read", "Grep"],
    defaultMaxTurns: 10,
  },
  reviewer: {
    role: "reviewer",
    icon: "👁",
    displayName: "Reviewer",
    description: "Reviews recent changes for quality and design",
    systemPromptSeed:
      "You review recent code changes (git diff HEAD~1 or staged) for quality. Flag: " +
      "unclear naming, missing error handling, duplicated logic, tests missing for " +
      "new code, and design smells. Do not modify files — just report with file:line " +
      "references.",
    allowedTools: ["Read", "Grep", "Bash"],
    defaultMaxTurns: 15,
  },
  architect: {
    role: "architect",
    icon: "🏛",
    displayName: "Architect",
    description: "Plans structure and sequencing for complex tasks",
    systemPromptSeed:
      "You design the overall approach for complex multi-file tasks BEFORE any code " +
      "is written. Output: a numbered plan with file paths, dependencies between " +
      "steps, and risk assessment. Do not edit files — your output is a plan that " +
      "other agents execute.",
    allowedTools: ["Read", "Grep", "Glob", "LS", "Plan"],
    defaultMaxTurns: 10,
  },
  security: {
    role: "security",
    icon: "🛡",
    displayName: "Security",
    description: "Deep security review focused on OWASP/CWE",
    systemPromptSeed:
      "You perform an adversarial security review. Walk the code path from untrusted " +
      "inputs (request bodies, file reads, env vars) to dangerous sinks (exec, SQL, " +
      "file writes). Report every data-flow that could be exploited, with a concrete " +
      "payload example. Read-only.",
    allowedTools: ["Read", "Grep", "Glob", "LS"],
    defaultMaxTurns: 25,
  },
  optimizer: {
    role: "optimizer",
    icon: "⚡",
    displayName: "Optimizer",
    description: "Finds performance hot spots and suggests improvements",
    systemPromptSeed:
      "You find performance issues: O(n²) loops, synchronous I/O in hot paths, " +
      "unbatched DB queries, memory leaks, missing indexes. Report concrete before/" +
      "after estimates when possible. Do not refactor — just report and recommend.",
    allowedTools: ["Read", "Grep", "Bash"],
    defaultMaxTurns: 15,
  },
  docs: {
    role: "docs",
    icon: "📝",
    displayName: "Docs",
    description: "Writes or updates docstrings, READMEs, and comments",
    systemPromptSeed:
      "You write technical documentation: JSDoc/TSDoc, Python docstrings, Rust doc " +
      "comments, and README updates. Match the project's existing style. Focus on " +
      "WHAT the code does and WHY it exists, not HOW (the code shows how).",
    allowedTools: ["Read", "Edit", "Write", "Grep"],
    defaultMaxTurns: 20,
  },
  migration: {
    role: "migration",
    icon: "🔀",
    displayName: "Migration",
    description: "Plans and executes dependency upgrades",
    systemPromptSeed:
      "You analyze outdated dependencies, read their migration guides, and report " +
      "the required code changes. Use WebFetch to read release notes. Produce a " +
      "migration plan: which files need changes, what the breaking changes are, " +
      "and an ordered sequence of edits.",
    allowedTools: ["Read", "Grep", "Glob", "WebFetch", "Bash"],
    defaultMaxTurns: 20,
  },
  explorer: {
    role: "explorer",
    icon: "🧭",
    displayName: "Explorer",
    description: "Navigates large codebases and answers questions",
    systemPromptSeed:
      "You explore a codebase to answer questions. Use Grep + Glob + Read to trace " +
      "definitions, call graphs, and data flow. Report findings with exact file:line " +
      "references. Read-only.",
    allowedTools: ["Read", "Grep", "Glob", "LS"],
    defaultMaxTurns: 20,
  },
  scribe: {
    role: "scribe",
    icon: "✍",
    displayName: "Scribe",
    description: "Writes commit messages, PR descriptions, changelogs",
    systemPromptSeed:
      "You write commit messages, PR descriptions, and changelog entries. Use the " +
      "project's existing conventions. Messages should explain the WHY, not just " +
      "the WHAT — include motivation and context.",
    allowedTools: ["Bash", "Read", "Grep"],
    defaultMaxTurns: 5,
  },
  worker: {
    role: "worker",
    icon: "⚙",
    displayName: "Worker",
    description: "Generic coding agent with full tool access",
    systemPromptSeed:
      "You are a general-purpose coding agent. Complete the assigned task using any " +
      "tool in your allowlist. Be concise and decisive.",
    allowedTools: [], // empty = all tools allowed
    defaultMaxTurns: 30,
  },
};

/** Pick the role that matches the task text best. Simple keyword-based heuristic. */
export function roleFromTask(task: string): AgentRole {
  const lower = task.toLowerCase();
  if (/\b(audit|scan|vulnerabilit|cwe|owasp)\b/.test(lower)) return "auditor";
  if (/\b(fix|repair|corregir|arreglar|patch)\b/.test(lower)) return "fixer";
  if (/\b(test|spec|pruebas|correr\s+test)\b/.test(lower)) return "tester";
  if (/\b(lint|format|style|formateo)\b/.test(lower)) return "linter";
  if (/\b(review|revisar|code review)\b/.test(lower)) return "reviewer";
  if (/\b(architect|plan|design|diseña|planifica)\b/.test(lower)) return "architect";
  if (/\b(security|seguridad|exploit|cve)\b/.test(lower)) return "security";
  if (/\b(optimize|perf|performance|slow|speed)\b/.test(lower)) return "optimizer";
  if (/\b(docs?|docstrings?|documenta|comments?|readme|jsdoc|tsdoc)\b/.test(lower)) return "docs";
  if (/\b(migrate|upgrade|bump|actualizar)\b/.test(lower)) return "migration";
  if (/\b(explore|find|buscar|navegar|where)\b/.test(lower)) return "explorer";
  if (/\b(commit|changelog|pr\s+description)\b/.test(lower)) return "scribe";
  return "worker";
}
