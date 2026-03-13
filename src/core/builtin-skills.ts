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
    description: "Export conversation to a file",
    aliases: ["save"],
    args: ["filename (default: kcode-export-<timestamp>.md)"],
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
];
