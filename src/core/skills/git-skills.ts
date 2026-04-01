// KCode - Git & VCS skills

import type { SkillDefinition } from "../builtin-skills";

export const gitSkills: SkillDefinition[] = [
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
    name: "blame",
    description: "Show annotated git blame for a file",
    aliases: ["who"],
    args: ["file path"],
    template: `__builtin_blame__`,
  },
  {
    name: "diff-branch",
    description: "Compare current branch vs another branch",
    aliases: ["branch-diff", "bdiff"],
    args: ["target branch"],
    template: `__builtin_diff_branch__`,
  },
  {
    name: "git-graph",
    description: "Show visual git history graph",
    aliases: ["graph", "history-graph"],
    args: ["[count] (default: 20)"],
    template: `__builtin_git_graph__`,
  },
];
