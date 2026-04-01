// KCode - Dev utility skills

import type { SkillDefinition } from "../builtin-skills";

export const devSkills: SkillDefinition[] = [
  {
    name: "batch",
    description: "Orchestrate parallel multi-file edits using subagents",
    aliases: ["mass-edit", "bulk"],
    args: ["description of the change"],
    template: `Orchestrate parallel multi-file edits using subagents for the following instruction:

{{args}}

Follow this exact workflow:

## Phase 1: Analysis
1. Use Glob and Grep to identify ALL files that need changes based on the instruction above.
2. Read a representative sample of matching files to understand the codebase patterns.
3. Determine the exact transformation needed for each file.

## Phase 2: Work Splitting
4. Split the identified files into independent chunks of 1-3 files each.
   - Files that depend on each other MUST go in the same chunk.
   - Aim for roughly equal work per chunk.
   - Maximum 5 chunks to run in parallel.
5. For each chunk, write a SPECIFIC prompt that includes:
   - The exact file paths to modify
   - The exact change to make (not vague instructions)
   - Any context from other files needed to make the change correctly

## Phase 3: Parallel Execution
6. Spawn one Agent per chunk using the Agent tool with these settings:
   - run_in_background: true
   - teamId: use a single team ID for all agents in this batch (e.g., "batch-<short-uuid>")
   - agentName: descriptive name like "edit-auth-files" or "update-api-endpoints"
   - shareResults: true
   - task: the specific prompt from Phase 2
7. Wait briefly, then poll each agent using resume with their agentId.
8. Continue polling until ALL agents have completed or failed.

## Phase 4: Verification & Summary
9. Read a sample of modified files to verify changes were applied correctly.
10. Run the project's test suite if one exists (bun test, npm test, pytest, etc.).
11. Present a summary table:
    - Agent name | Files modified | Status (success/failed) | Duration
    - Total files changed
    - Any errors or files that could not be modified
    - Test results if tests were run

IMPORTANT RULES:
- No two agents may modify the same file — deduplicate before spawning.
- Each agent receives the EXACT list of files it owns — no ambiguity.
- If fewer than 3 files need changes, use a single agent (no need for parallelism).
- If an agent fails, report which files were affected and what went wrong.
- Always verify at least one file from each agent's batch after completion.`,
  },
  {
    name: "loop",
    description: "Run a command or prompt repeatedly at an interval",
    aliases: ["repeat", "watch"],
    args: ["interval", "command or prompt"],
    template: `Run the following repeatedly until the user stops you (Ctrl+C / Escape).

Parse the arguments: {{args}}
- First argument should be an interval (e.g., "5s", "1m", "30s")
- Everything after is the command or prompt to run

For each iteration:
1. Run the command or process the prompt
2. Show the result
3. Wait for the specified interval using: Bash with command "sleep <seconds>"
4. Repeat

If the command fails 3 times in a row, stop and report the error.
Show iteration count and elapsed time with each run.`,
  },
  {
    name: "deps",
    description: "Check dependencies",
    aliases: ["dependencies"],
    template: `Analyze the project's dependencies. Check for outdated packages, security vulnerabilities, and unused dependencies. {{#if args}}Focus on: {{args}}{{/if}}`,
  },
  {
    name: "todo",
    description: "Find TODOs in code",
    aliases: ["todos"],
    args: ["scope"],
    template: `Search the codebase for TODO, FIXME, HACK, and XXX comments. {{#if args}}Focus on: {{args}}{{/if}} List them organized by file with context.`,
  },
  {
    name: "consensus",
    description: "Query multiple models and synthesize the best answer",
    aliases: ["agree", "vote"],
    args: ["prompt"],
    template: `__builtin_consensus__`,
  },
  {
    name: "search-chat",
    description: "Search through conversation messages",
    aliases: ["grep-chat", "find-msg"],
    args: ["query"],
    template: `__builtin_search_chat__`,
  },
  {
    name: "stashes",
    description: "List, show, apply, or drop git stashes",
    aliases: ["stash-list"],
    args: ["list | show <n> | apply <n> | pop | drop <n>"],
    template: `__builtin_stashes__`,
  },
  {
    name: "ratelimit",
    description: "Show rate limiter state and request stats",
    aliases: ["rl", "throttle"],
    args: [],
    template: `__builtin_ratelimit__`,
  },
  {
    name: "snippet",
    description: "Save, list, or paste reusable snippets",
    aliases: ["snip", "clip"],
    args: ["save <name> <content> | list | paste <name> | delete <name>"],
    template: `__builtin_snippet__`,
  },
  {
    name: "model-health",
    description: "Ping all registered models and show response times",
    aliases: ["ping", "mhealth"],
    args: [],
    template: `__builtin_model_health__`,
  },
  {
    name: "diff-session",
    description: "Show all codebase changes made during this session",
    aliases: ["session-diff", "sdiff"],
    args: [],
    template: `__builtin_diff_session__`,
  },
  {
    name: "retry",
    description: "Re-send the last user prompt, optionally modified",
    aliases: ["again", "redo"],
    args: ["replacement text (optional)"],
    template: `__builtin_retry__`,
  },
  {
    name: "env",
    description: "Show detected development environment and tool versions",
    aliases: ["environment", "versions"],
    args: [],
    template: `__builtin_env__`,
  },
  {
    name: "estimate",
    description: "Estimate token count for text or a file",
    aliases: ["tok-count", "tokens-for"],
    args: ["text or file path"],
    template: `__builtin_estimate__`,
  },
  {
    name: "budget",
    description: "Show projected token usage and context budget",
    aliases: ["ctx-budget"],
    args: [],
    template: `__builtin_budget__`,
  },
  {
    name: "suggest-files",
    description: "Suggest relevant files for the current task",
    aliases: ["relevant", "files-for"],
    args: ["description of what you're working on"],
    template: `__builtin_suggest_files__`,
  },
  {
    name: "fast",
    description: "Toggle between primary and fallback (faster/cheaper) model",
    aliases: ["quick"],
    args: [],
    template: `Toggle fast mode — switch between the primary model and the fallback (faster/cheaper) model.

1. Read the current config to determine the active model and the fallback model.
2. If currently using the primary model, switch to the fallback model.
3. If currently using the fallback model, switch back to the primary model.
4. Report which model is now active and confirm the switch.

This lets the user trade quality for speed on simpler tasks.`,
  },
  {
    name: "dry-run",
    description: "Preview changes without modifying files",
    aliases: ["simulate"],
    args: ["description of changes to preview"],
    template: `__builtin_dry_run__`,
  },
  {
    name: "btw",
    description: "Ask a side question without contaminating context",
    aliases: ["aside"],
    args: ["question"],
    template: `__builtin_btw__`,
  },
  {
    name: "sandbox",
    description: "Show sandbox status or toggle sandbox mode",
    aliases: ["bwrap", "isolate"],
    args: ["status | on | off"],
    template: `__builtin_sandbox__`,
  },
  {
    name: "swarm",
    description: "Run N agents in parallel on a task",
    aliases: ["multi-agent", "parallel-agents"],
    args: ["prompt [--agents N] [--files glob]"],
    template: `__builtin_swarm__`,
  },
  {
    name: "agents",
    description: "List available custom agent definitions",
    aliases: ["agent-list", "custom-agents"],
    args: [],
    template: `__builtin_agents__`,
  },
  {
    name: "gpu",
    description: "Show GPU status, VRAM usage, and temperature",
    aliases: ["vram", "nvidia"],
    args: [],
    template: `__builtin_gpu__`,
  },
  {
    name: "run-benchmark",
    description: "Run active benchmark on current model (speed + quality)",
    aliases: ["bench", "speed-test"],
    args: [],
    template: `__builtin_run_benchmark__`,
  },
  {
    name: "release-notes",
    description: "View recent changelog and version info",
    aliases: ["changelog", "whatsnew"],
    args: [],
    template: `Show the project's recent release notes and version.

1. Read the CHANGELOG.md file in the project root (if it exists).
2. Also read the "version" field from package.json.
3. Display the current version and the most recent changelog entries (last 2-3 releases).
4. If no CHANGELOG.md exists, show the version from package.json and suggest checking git tags with: git tag --sort=-version:refname | head -5`,
  },
  {
    name: "debug",
    description: "Toggle agent debug tracing (shows decision reasoning and state transitions)",
    aliases: ["trace", "debug-trace"],
    args: ["on | off | trace [category] | clear"],
    template: `__builtin_debug__`,
  },
];
