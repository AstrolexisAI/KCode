// KCode - Testing & build skills

import type { SkillDefinition } from "../builtin-skills";

export const testingSkills: SkillDefinition[] = [
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
    name: "test-for",
    description: "Generate tests",
    aliases: ["test-gen"],
    args: ["function or file"],
    template: `Generate comprehensive tests for: {{args}}. Include edge cases, error cases, and typical usage. Use the project's existing test framework and conventions.`,
  },
  {
    name: "auto-test",
    description: "Find and run tests for recently modified files",
    aliases: ["run-tests"],
    args: [],
    template: `__builtin_auto_test__`,
  },
  {
    name: "auto-fix",
    description: "Detect build/test errors and auto-generate fixes",
    aliases: ["fix-errors", "fixup"],
    args: ["build | test | <custom command>"],
    template: `__builtin_auto_fix__`,
  },
];
