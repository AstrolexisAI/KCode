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
    template: `Run \`git diff\` to show the current uncommitted changes. If there are staged changes, show both staged and unstaged. Summarize what changed.`,
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
];
