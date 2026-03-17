// KCode - Built-in skill definitions
// Default skills that ship with KCode

export interface SkillDefinition {
  name: string;
  description: string;
  aliases: string[];
  args?: string[];
  template: string;
}

export const builtinSkills: SkillDefinition[] = [
  {
    name: "commit",
    description: "Create a git commit with a message",
    aliases: ["ci"],
    args: ["-m message"],
    template: `Create a git commit following the project's commit conventions.

1. Run git status to see all untracked and modified files.
2. Run git diff and git diff --cached to review staged and unstaged changes.
3. Run git log --oneline -5 to see recent commit message style.
4. Draft a concise commit message that reflects the nature and purpose of the changes.
5. Stage relevant files (prefer specific files over git add -A).
6. Create the commit.
7. Run git status to verify success.

{{#if args}}User instructions: {{args}}{{/if}}`,
  },
  {
    name: "review-pr",
    description: "Review a pull request",
    aliases: ["pr", "review"],
    args: ["PR number or URL"],
    template: `Review the specified pull request thoroughly.

1. Fetch PR information using: gh pr view {{args}} --json title,body,baseRefName,headRefName,files,additions,deletions
2. Get the diff: gh pr diff {{args}}
3. Analyze the changes for:
   - Correctness and potential bugs
   - Code style and consistency
   - Performance concerns
   - Security issues
   - Missing tests or documentation
4. Provide a structured review with specific file/line references.

{{#if args}}PR to review: {{args}}{{/if}}`,
  },
  {
    name: "simplify",
    description: "Review changed code for quality and simplify",
    aliases: ["clean", "refactor"],
    template: `Review recently changed code for quality and simplification opportunities.

1. Run git diff to see current changes, or git diff HEAD~1 if nothing is staged.
2. For each changed file, analyze:
   - Can any logic be simplified?
   - Are there redundant checks or dead code?
   - Can functions be made shorter or more readable?
   - Are variable names clear?
   - Is there duplicated code that could be extracted?
3. Apply simplifications directly, keeping behavior identical.
4. Explain what was simplified and why.

{{#if args}}Focus area: {{args}}{{/if}}`,
  },
  {
    name: "diff",
    description: "Show git diff of current changes",
    aliases: [],
    args: ["file or path (optional)"],
    template: `Show current git changes with stats. Run these commands:

1. \`git diff --stat\` — overview of unstaged changes
2. \`git diff --cached --stat\` — overview of staged changes
3. \`git diff\` — full unstaged diff {{#if args}}filtered to: {{args}}{{/if}}
4. \`git diff --cached\` — full staged diff {{#if args}}filtered to: {{args}}{{/if}}

Summarize: how many files changed, lines added/removed, and a brief description of what changed. If a path was given, only show diffs for that path.`,
  },
  {
    name: "test",
    description: "Run project tests",
    aliases: ["tests"],
    args: ["test file or pattern"],
    template: `Run the project's test suite. {{#if args}}Focus on tests matching: {{args}}{{/if}} Use the appropriate test runner for this project (bun test, npm test, pytest, go test, etc). Report results concisely.`,
  },
  {
    name: "build",
    description: "Build the project",
    aliases: [],
    template: `Build this project using its configured build system. Report any errors. {{#if args}}Additional instructions: {{args}}{{/if}}`,
  },
  {
    name: "lint",
    description: "Lint and fix code",
    aliases: ["fix"],
    args: ["file or pattern"],
    template: `Run the project's linter. {{#if args}}Focus on: {{args}}{{/if}} Fix any auto-fixable issues. Report remaining issues.`,
  },
  {
    name: "branch",
    description: "Show or create git branch",
    aliases: ["br"],
    args: ["branch name"],
    template: `{{#if args}}Create and switch to a new git branch named '{{args}}'. Base it on the current branch.{{/if}}{{^if args}}Show the current git branch and list recent branches.{{/if}}`,
  },
  {
    name: "log",
    description: "Show git log",
    aliases: ["gl"],
    args: ["number of commits"],
    template: `Show the git log. {{#if args}}Show the last {{args}} commits.{{/if}}{{^if args}}Show the last 10 commits.{{/if}} Use a concise one-line format.`,
  },
  {
    name: "stash",
    description: "Stash or pop changes",
    aliases: [],
    args: ["pop or message"],
    template: `{{#if args}}{{args}}{{/if}}{{^if args}}Stash the current changes with git stash.{{/if}} If the argument is 'pop', pop the latest stash. If it's anything else, use it as the stash message.`,
  },
  {
    name: "explain",
    description: "Explain code or concept",
    aliases: ["what"],
    args: ["code or file to explain"],
    template: `Explain the following in clear, concise terms: {{args}}`,
  },
  {
    name: "find-bug",
    description: "Find bugs in code",
    aliases: ["bug", "debug"],
    args: ["file or description"],
    template: `Analyze the following for potential bugs, edge cases, and issues: {{args}}. Look for: null/undefined errors, off-by-one errors, race conditions, resource leaks, missing error handling, security issues.`,
  },
  {
    name: "security",
    description: "Security audit",
    aliases: ["audit"],
    args: ["file or scope"],
    template: `Perform a security audit. {{#if args}}Focus on: {{args}}{{/if}}{{^if args}}Scan the project for common security vulnerabilities.{{/if}} Check for: injection vulnerabilities, hardcoded secrets, insecure dependencies, missing input validation, authentication issues.`,
  },
  {
    name: "help",
    description: "Show available commands and tips",
    aliases: ["?", "commands"],
    template: `__builtin_help__`,
  },
  {
    name: "template",
    description: "Manage and use prompt templates",
    aliases: ["tpl", "tmpl"],
    args: ["list | use <name> [args...] | save <name>"],
    template: `__builtin_template__`,
  },
  {
    name: "batch",
    description: "Apply a change across multiple files in parallel using subagents",
    aliases: ["mass-edit", "bulk"],
    args: ["description of the change"],
    template: `Apply the following change across multiple files using parallel subagents.

1. First, use Glob and Grep to identify ALL files that need this change.
2. Group the files into batches of 3-5 files each.
3. For each batch, spawn an Agent with a clear prompt describing exactly what to change in those specific files.
4. Run all agents in parallel (background mode).
5. After all agents complete, verify the changes by reading a sample of modified files.
6. Report what was changed and any files that failed.

Change to apply: {{args}}

IMPORTANT:
- Use Agent tool with run_in_background=true for parallelism
- Each agent should receive the EXACT list of files it owns
- No two agents should modify the same file
- After all agents finish, run the project's test suite if one exists`,
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
    name: "security-review",
    description: "Scan code for security vulnerabilities",
    aliases: ["sec", "vuln"],
    args: ["file or directory path"],
    template: `Perform a thorough security review of the specified code.

Target: {{args}}

1. Read the target file(s) — if a directory, scan all source files.
2. Check for OWASP Top 10 vulnerabilities:
   - Injection (SQL, command, LDAP, XSS)
   - Broken authentication / session management
   - Sensitive data exposure (hardcoded secrets, API keys, passwords)
   - XXE (XML External Entities)
   - Broken access control
   - Security misconfiguration
   - Insecure deserialization
   - Using components with known vulnerabilities
   - Insufficient logging & monitoring
3. Check for language-specific issues:
   - TypeScript/JS: eval(), innerHTML, dangerouslySetInnerHTML, prototype pollution
   - Python: pickle, exec, shell=True, format string injection
   - Go: sql.Query with string concat, unsafe pointer use
4. Report findings with severity (CRITICAL/HIGH/MEDIUM/LOW), file:line, and fix recommendation.
5. If no issues found, confirm the code is clean.

Be thorough but avoid false positives. Only report real risks.`,
  },
  {
    name: "context",
    description: "Show context window usage",
    aliases: ["ctx", "tokens"],
    args: [],
    template: `__builtin_context__`,
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
    name: "test-for",
    description: "Generate tests",
    aliases: ["test-gen"],
    args: ["function or file"],
    template: `Generate comprehensive tests for: {{args}}. Include edge cases, error cases, and typical usage. Use the project's existing test framework and conventions.`,
  },
  {
    name: "doc",
    description: "Generate documentation",
    aliases: ["document"],
    args: ["file or function"],
    template: `Generate or update documentation for: {{args}}. Follow the project's existing documentation style. Include usage examples where appropriate.`,
  },
  {
    name: "type",
    description: "Add or fix types",
    aliases: ["types"],
    args: ["file or function"],
    template: `Review and improve TypeScript types for: {{args}}. Add missing type annotations, fix any type errors, and ensure type safety. Use strict types, avoid 'any'.`,
  },
  {
    name: "export",
    description: "Export conversation to file (md/json/html)",
    aliases: ["save"],
    args: ["filename or format (md/json/html, default: md)"],
    template: `__builtin_export__`,
  },
  {
    name: "stats",
    description: "Show usage statistics",
    aliases: [],
    template: `__builtin_stats__`,
  },
  {
    name: "doctor",
    description: "Check system health",
    aliases: ["health"],
    template: `__builtin_doctor__`,
  },
  {
    name: "models",
    description: "List registered models",
    aliases: ["model"],
    template: `__builtin_models__`,
  },
  {
    name: "clear",
    description: "Clear conversation",
    aliases: ["cls"],
    template: `__builtin_clear__`,
  },
  {
    name: "compact",
    description: "Compact conversation history",
    aliases: ["summarize"],
    template: `__builtin_compact__`,
  },
  {
    name: "rewind",
    description: "Undo recent file changes",
    aliases: ["rew"],
    args: ["number of actions to undo (default: 1)"],
    template: `__builtin_rewind__`,
  },
  {
    name: "plugins",
    description: "List installed plugins",
    aliases: ["plugin"],
    args: [],
    template: `__builtin_plugins__`,
  },
  {
    name: "theme",
    description: "List or switch color themes",
    aliases: ["skin"],
    args: ["theme name (optional)"],
    template: `__builtin_theme__`,
  },
  {
    name: "usage",
    description: "Show token usage and cost for this session",
    aliases: ["cost"],
    args: [],
    template: `__builtin_usage__`,
  },
  {
    name: "plan",
    description: "Show or manage the active plan",
    aliases: [],
    args: ["clear (optional)"],
    template: `__builtin_plan__`,
  },
  {
    name: "hooks",
    description: "Show configured hooks",
    aliases: ["hook"],
    args: [],
    template: `__builtin_hooks__`,
  },
  {
    name: "changes",
    description: "Show all files modified in this session",
    aliases: ["changed", "modified"],
    args: [],
    template: `__builtin_changes__`,
  },
  {
    name: "pin",
    description: "Pin a file to always be in context",
    aliases: [],
    args: ["file path"],
    template: `__builtin_pin__`,
  },
  {
    name: "unpin",
    description: "Unpin a file from context",
    aliases: [],
    args: ["file path (or 'all')"],
    template: `__builtin_unpin__`,
  },
  {
    name: "index",
    description: "Build or query the codebase index",
    aliases: ["idx"],
    args: ["query (optional, builds index if empty)"],
    template: `__builtin_index__`,
  },
  {
    name: "fork",
    description: "Fork the conversation at a specific point",
    aliases: ["split"],
    args: ["message number (optional, forks at current point if empty)"],
    template: `__builtin_fork__`,
  },
  {
    name: "memory",
    description: "List, search, or manage memories",
    aliases: ["mem", "remember"],
    args: ["list | search <query> | show <filename> | delete <filename>"],
    template: `__builtin_memory__`,
  },
  {
    name: "branches",
    description: "Show conversation fork history as a visual tree",
    aliases: ["tree", "forks"],
    args: [],
    template: `__builtin_branches__`,
  },
  {
    name: "compare",
    description: "Compare responses from two models side-by-side",
    aliases: ["ab", "versus"],
    args: ["model1 model2 prompt"],
    template: `__builtin_compare__`,
  },
  {
    name: "bookmark",
    description: "Set or list conversation bookmarks",
    aliases: ["bm", "mark"],
    args: ["label (set) | list | goto <label> | delete <label>"],
    template: `__builtin_bookmark__`,
  },
  {
    name: "analytics",
    description: "Show tool usage analytics for current session",
    aliases: ["metrics"],
    args: [],
    template: `__builtin_analytics__`,
  },
  {
    name: "consensus",
    description: "Query multiple models and synthesize the best answer",
    aliases: ["agree", "vote"],
    args: ["prompt"],
    template: `__builtin_consensus__`,
  },
  {
    name: "resolve",
    description: "Detect and resolve git merge conflicts",
    aliases: ["conflicts", "merge"],
    args: ["file path (optional)"],
    template: `Detect and resolve git merge conflicts.

1. Run \`git diff --name-only --diff-filter=U\` to find files with unresolved conflicts.
2. If no conflicts found, report that the working tree is clean.
3. For each conflicted file{{#if args}} (or just: {{args}}){{/if}}:
   a. Read the file to see the conflict markers (<<<<<<< / ======= / >>>>>>>)
   b. Analyze both sides of each conflict
   c. Determine the best resolution by understanding the intent of each change
   d. Apply the resolution using Edit tool — remove conflict markers and keep the correct code
   e. Explain what was resolved and why
4. After resolving, run \`git diff\` on the resolved files to confirm changes look correct.
5. Suggest: \`git add <files>\` to stage the resolutions.

IMPORTANT: Always prefer combining both changes when they don't conflict semantically. Only pick one side when they are truly incompatible.`,
  },
  {
    name: "search-chat",
    description: "Search through conversation messages",
    aliases: ["grep-chat", "find-msg"],
    args: ["query"],
    template: `__builtin_search_chat__`,
  },
  {
    name: "auto-test",
    description: "Find and run tests for recently modified files",
    aliases: ["run-tests"],
    args: [],
    template: `__builtin_auto_test__`,
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
    name: "config",
    description: "Show resolved configuration with source priority",
    aliases: ["settings", "cfg"],
    args: [],
    template: `__builtin_config__`,
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
    name: "budget",
    description: "Show projected token usage and context budget",
    aliases: ["ctx-budget"],
    args: [],
    template: `__builtin_budget__`,
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
    name: "note",
    description: "Add a timestamped annotation to the session",
    aliases: ["annotate"],
    args: ["note text"],
    template: `__builtin_note__`,
  },
  {
    name: "chain",
    description: "Run multiple slash commands in sequence",
    aliases: ["seq", "multi"],
    args: ["cmd1 ; cmd2 ; cmd3"],
    template: `__builtin_chain__`,
  },
  {
    name: "alias",
    description: "Create, list, or remove custom command aliases",
    aliases: ["shortcut"],
    args: ["set <shortcut> <expansion> | list | remove <shortcut>"],
    template: `__builtin_alias__`,
  },
  {
    name: "gallery",
    description: "Browse prompt templates by category with previews",
    aliases: ["templates-gallery", "tpl-browse"],
    args: [],
    template: `__builtin_gallery__`,
  },
  {
    name: "replay",
    description: "Replay the current session step by step with timestamps",
    aliases: ["playback"],
    args: [],
    template: `__builtin_replay__`,
  },
  {
    name: "depgraph",
    description: "Show import/export dependency tree for a file",
    aliases: ["deps-tree", "imports"],
    args: ["file path"],
    template: `__builtin_depgraph__`,
  },
  {
    name: "blame",
    description: "Show annotated git blame for a file",
    aliases: ["who"],
    args: ["file path"],
    template: `__builtin_blame__`,
  },
  {
    name: "project-cost",
    description: "Project estimated cost for N more messages",
    aliases: ["cost-forecast", "forecast"],
    args: ["number of messages"],
    template: `__builtin_project_cost__`,
  },
  {
    name: "workspace",
    description: "Switch working directory without restarting",
    aliases: ["cwd", "cd"],
    args: ["directory path"],
    template: `__builtin_workspace__`,
  },
  {
    name: "filesize",
    description: "Show files sorted by size with visual bars",
    aliases: ["sizes", "du"],
    args: ["glob pattern (default: **/*.*)"],
    template: `__builtin_filesize__`,
  },
  {
    name: "contributors",
    description: "Show git contributor stats",
    aliases: ["authors", "who-wrote"],
    args: [],
    template: `__builtin_contributors__`,
  },
  {
    name: "regex",
    description: "Test a regex against text or a file",
    aliases: ["rx", "regexp"],
    args: ["pattern text-or-file"],
    template: `__builtin_regex__`,
  },
  {
    name: "processes",
    description: "List project-related running processes",
    aliases: ["ps", "procs"],
    args: [],
    template: `__builtin_processes__`,
  },
  {
    name: "filediff",
    description: "Compare two files with unified diff",
    aliases: ["fdiff", "compare-files"],
    args: ["file1 file2"],
    template: `__builtin_filediff__`,
  },
  {
    name: "crons",
    description: "List user crontabs and systemd timers",
    aliases: ["schedules", "timers"],
    args: [],
    template: `__builtin_crons__`,
  },
  {
    name: "ports",
    description: "Show ports in use with associated processes",
    aliases: ["listening", "netstat"],
    args: [],
    template: `__builtin_ports__`,
  },
  {
    name: "tags",
    description: "List, create, or compare git tags",
    aliases: ["tag", "releases"],
    args: ["list | create <name> [message] | log <tag1>..<tag2>"],
    template: `__builtin_tags__`,
  },
  {
    name: "file-history",
    description: "Show commit history for a specific file",
    aliases: ["fhist", "file-log"],
    args: ["file path"],
    template: `__builtin_file_history__`,
  },
  {
    name: "copy",
    description: "Copy text or file content to system clipboard",
    aliases: ["clip-copy", "yank"],
    args: ["text or file path"],
    template: `__builtin_copy__`,
  },
  {
    name: "json",
    description: "Parse, validate, and inspect JSON files or text",
    aliases: ["json-inspect", "jq"],
    args: ["file path or JSON text"],
    template: `__builtin_json__`,
  },
  {
    name: "disk",
    description: "Show project disk usage by directory",
    aliases: ["disk-usage", "space"],
    args: [],
    template: `__builtin_disk__`,
  },
  {
    name: "http",
    description: "Make quick HTTP requests (GET/POST)",
    aliases: ["curl", "request"],
    args: ["[GET|POST|PUT|DELETE] <url> [body]"],
    template: `__builtin_http__`,
  },
  {
    name: "encode",
    description: "Encode/decode Base64, URL, or hex",
    aliases: ["decode", "base64"],
    args: ["base64|url|hex encode|decode <text>"],
    template: `__builtin_encode__`,
  },
  {
    name: "checksum",
    description: "Generate checksums for files or text",
    aliases: ["hash", "sha"],
    args: ["[md5|sha256|sha512] <file or text>"],
    template: `__builtin_checksum__`,
  },
  {
    name: "outline",
    description: "Show file structure (functions, classes, exports)",
    aliases: ["symbols", "structure"],
    args: ["file path"],
    template: `__builtin_outline__`,
  },
  {
    name: "weather",
    description: "Show current weather in terminal",
    aliases: ["wttr"],
    args: ["city (optional)"],
    template: `__builtin_weather__`,
  },
  {
    name: "lorem",
    description: "Generate placeholder text",
    aliases: ["placeholder", "filler"],
    args: ["words|sentences|paragraphs [count]"],
    template: `__builtin_lorem__`,
  },
  {
    name: "uuid",
    description: "Generate random UUIDs (v4)",
    aliases: ["guid", "id"],
    args: ["count (default: 1)"],
    template: `__builtin_uuid__`,
  },
  {
    name: "color",
    description: "Convert between color formats (hex/rgb/hsl)",
    aliases: ["hex-color", "rgb"],
    args: ["color value (#fff, rgb(…), hsl(…))"],
    template: `__builtin_color__`,
  },
  {
    name: "timestamp",
    description: "Convert between epoch and human-readable dates",
    aliases: ["epoch", "unixtime"],
    args: ["epoch seconds or date string (optional)"],
    template: `__builtin_timestamp__`,
  },
  {
    name: "csv",
    description: "Inspect CSV/TSV files with tabular preview",
    aliases: ["tsv", "table"],
    args: ["file path"],
    template: `__builtin_csv__`,
  },
  {
    name: "ip",
    description: "Show public IP, local IP, and network interfaces",
    aliases: ["myip", "network"],
    args: [],
    template: `__builtin_ip__`,
  },
  {
    name: "count",
    description: "Count lines, words, chars, and files by extension",
    aliases: ["wc", "lines"],
    args: ["file or directory (default: .)"],
    template: `__builtin_count__`,
  },
  {
    name: "random",
    description: "Generate random numbers, roll dice, or pick from list",
    aliases: ["rand", "dice"],
    args: ["[min-max | NdM | item1,item2,...]"],
    template: `__builtin_random__`,
  },
  {
    name: "diff-stats",
    description: "Show repository activity summary and stats",
    aliases: ["gitstats", "repo-stats"],
    args: [],
    template: `__builtin_diff_stats__`,
  },
  {
    name: "serve",
    description: "Serve current directory as static HTTP",
    aliases: ["preview", "static"],
    args: ["port (default: 10080)"],
    template: `__builtin_serve__`,
  },
  {
    name: "open",
    description: "Open file or URL in system application",
    aliases: ["browse", "xdg"],
    args: ["file path or URL"],
    template: `__builtin_open__`,
  },
  {
    name: "qr",
    description: "Generate QR code in terminal",
    aliases: ["qrcode"],
    args: ["text or URL"],
    template: `__builtin_qr__`,
  },
  {
    name: "calc",
    description: "Evaluate math expressions safely",
    aliases: ["math", "eval"],
    args: ["expression"],
    template: `__builtin_calc__`,
  },
  {
    name: "stopwatch",
    description: "Start a countdown timer",
    aliases: ["timer", "sw"],
    args: ["duration (e.g., 30s, 5m, 1h)"],
    template: `__builtin_stopwatch__`,
  },
  {
    name: "password",
    description: "Generate secure random passwords",
    aliases: ["passwd", "pwgen"],
    args: ["[length] [--no-symbols] [--count N]"],
    template: `__builtin_password__`,
  },
  {
    name: "diff-branch",
    description: "Compare current branch vs another branch",
    aliases: ["branch-diff", "bdiff"],
    args: ["target branch"],
    template: `__builtin_diff_branch__`,
  },
  {
    name: "mirrors",
    description: "Show and manage git remotes",
    aliases: ["remotes", "upstream"],
    args: ["list | add <name> <url> | remove <name>"],
    template: `__builtin_mirrors__`,
  },
  {
    name: "sort-lines",
    description: "Sort lines of a file",
    aliases: ["sort", "sortfile"],
    args: ["file [--reverse] [--numeric] [--unique]"],
    template: `__builtin_sort_lines__`,
  },
  {
    name: "montecarlo",
    description: "Run Monte Carlo simulations",
    aliases: ["simulate", "mc"],
    args: ["pi | coin [N] | dice NdM [N]"],
    template: `__builtin_montecarlo__`,
  },
  {
    name: "ascii",
    description: "Convert text to ASCII art",
    aliases: ["art", "figlet"],
    args: ["text"],
    template: `__builtin_ascii__`,
  },
  {
    name: "crontab",
    description: "Parse cron expressions and show next runs",
    aliases: ["cron-parse", "schedule"],
    args: ["cron expression (e.g., '*/5 * * * *')"],
    template: `__builtin_crontab__`,
  },
  {
    name: "diff-lines",
    description: "Compare two strings side by side",
    aliases: ["ldiff", "line-diff"],
    args: ["string1 | string2"],
    template: `__builtin_diff_lines__`,
  },
  {
    name: "sysinfo",
    description: "Show system hardware and OS info",
    aliases: ["hw", "machine"],
    args: [],
    template: `__builtin_sysinfo__`,
  },
  {
    name: "progress",
    description: "Generate visual progress bars",
    aliases: ["bar", "pbar"],
    args: ["value [max] [label]"],
    template: `__builtin_progress__`,
  },
  {
    name: "jwt",
    description: "Decode JWT tokens (header + payload)",
    aliases: ["token-decode", "jwt-decode"],
    args: ["JWT token string"],
    template: `__builtin_jwt__`,
  },
  {
    name: "dotenv",
    description: "Inspect and validate .env files",
    aliases: ["env-file", "secrets"],
    args: ["file path (default: .env)"],
    template: `__builtin_dotenv__`,
  },
  {
    name: "table-fmt",
    description: "Format data as aligned markdown table",
    aliases: ["markdown-table", "tbl"],
    args: ["header1,header2,... then rows via |"],
    template: `__builtin_table_fmt__`,
  },
  {
    name: "git-graph",
    description: "Show visual git history graph",
    aliases: ["graph", "history-graph"],
    args: ["[count] (default: 20)"],
    template: `__builtin_git_graph__`,
  },
  {
    name: "reverse",
    description: "Reverse text, lines, or words",
    aliases: ["rev", "flip"],
    args: ["text or --words or --lines"],
    template: `__builtin_reverse__`,
  },
  {
    name: "uptime-check",
    description: "Check if a URL is up (status, latency, TLS)",
    aliases: ["ping-url", "healthcheck"],
    args: ["URL"],
    template: `__builtin_uptime_check__`,
  },
  {
    name: "chmod-calc",
    description: "Convert between rwx and octal permissions",
    aliases: ["permissions", "octal"],
    args: ["octal (e.g., 755) or symbolic (e.g., rwxr-xr-x)"],
    template: `__builtin_chmod_calc__`,
  },
  {
    name: "semver",
    description: "Parse, compare, and bump semantic versions",
    aliases: ["version-bump", "ver"],
    args: ["version [bump major|minor|patch|prerelease]"],
    template: `__builtin_semver__`,
  },
  {
    name: "gitignore",
    description: "Inspect or add patterns to .gitignore",
    aliases: ["ignore", "gi"],
    args: ["[add <pattern>] or [check <file>] (default: inspect)"],
    template: `__builtin_gitignore__`,
  },
  {
    name: "wordfreq",
    description: "Analyze word frequency in text or a file",
    aliases: ["freq", "word-count"],
    args: ["text or file path [--top N]"],
    template: `__builtin_wordfreq__`,
  },
  {
    name: "network-ports",
    description: "Look up well-known network ports and services",
    aliases: ["common-ports", "port-lookup"],
    args: ["port number or service name"],
    template: `__builtin_network_ports__`,
  },
  {
    name: "wrap",
    description: "Word-wrap text to a specified column width",
    aliases: ["wordwrap", "rewrap"],
    args: ["[--width N] text (default: 80)"],
    template: `__builtin_wrap__`,
  },
  {
    name: "char-info",
    description: "Show Unicode info for characters",
    aliases: ["unicode", "charcode"],
    args: ["character(s) or U+XXXX codepoint"],
    template: `__builtin_char_info__`,
  },
  {
    name: "new-project",
    description: "Create a project from a template",
    aliases: ["scaffold", "init-project"],
    args: ["template-name project-name"],
    template: `__builtin_new_project__`,
  },
  {
    name: "cache",
    description: "Show or manage the response cache",
    aliases: ["response-cache", "llm-cache"],
    args: ["stats | clear"],
    template: `__builtin_cache__`,
  },
  {
    name: "effort",
    description: "Set reasoning effort level (low/medium/high)",
    aliases: ["reasoning", "depth"],
    args: ["low | medium | high"],
    template: `__builtin_effort__`,
  },
  {
    name: "agents",
    description: "List available custom agent definitions",
    aliases: ["agent-list", "custom-agents"],
    args: [],
    template: `__builtin_agents__`,
  },
  {
    name: "slug",
    description: "Convert text to URL-safe slug",
    aliases: ["slugify", "url-slug"],
    args: ["text"],
    template: `__builtin_slug__`,
  },
  {
    name: "diff-words",
    description: "Compare two texts highlighting word differences",
    aliases: ["wdiff", "word-diff"],
    args: ["text1 | text2"],
    template: `__builtin_diff_words__`,
  },
  {
    name: "headers",
    description: "Show HTTP response headers for a URL",
    aliases: ["http-headers", "resp-headers"],
    args: ["URL"],
    template: `__builtin_headers__`,
  },
  {
    name: "extract-urls",
    description: "Extract all URLs from text or a file",
    aliases: ["urls", "find-links"],
    args: ["text or file path"],
    template: `__builtin_extract_urls__`,
  },
  {
    name: "nato",
    description: "Convert text to NATO phonetic alphabet",
    aliases: ["phonetic", "spelling"],
    args: ["text"],
    template: `__builtin_nato__`,
  },
  {
    name: "markdown-toc",
    description: "Generate table of contents from a Markdown file",
    aliases: ["toc", "headings"],
    args: ["file path"],
    template: `__builtin_markdown_toc__`,
  },
];
