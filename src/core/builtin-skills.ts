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
    name: "help",
    description: "Show available commands and tips",
    aliases: ["?", "commands"],
    template: `__builtin_help__`,
  },
];
