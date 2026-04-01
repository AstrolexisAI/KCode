# Contributing to KCode

Thanks for your interest in contributing to KCode! This guide covers everything you need to get started.

## Prerequisites

- **[Bun](https://bun.sh)** v1.2 or later (runtime and package manager)
- **Git** 2.30+
- **GPU with 8+ GB VRAM** recommended for local model testing (CPU works but is slow)
- A cloud API key (Anthropic, OpenAI, etc.) if you are not running a local model

## Getting Started

```bash
# Clone and install
git clone https://github.com/AstrolexisAI/KCode.git
cd KCode
bun install

# Run tests to verify your setup
bun test

# Run in development mode (auto-reloads on changes)
bun run dev

# Or run directly
bun run src/index.ts
```

## Architecture Overview

KCode is a terminal-based AI coding assistant built with Bun, TypeScript, and React/Ink. The codebase is organized as follows:

```
src/
  index.ts      # CLI entry point (Commander.js)
  core/         # Engine: conversation loop, config, permissions, models, memory,
                #   system prompt, pro gating, hooks, swarm, analytics, etc.
  tools/        # 46 built-in tools + MCP integration
  ui/           # Ink-based terminal UI (React 19 components) + print mode
  utils/        # Shared utilities
```

For the full architecture reference, see [CLAUDE.md](./CLAUDE.md) and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## How to Add a New Tool

1. Create a new file in `src/tools/` (e.g., `src/tools/my-tool.ts`).
2. Export a tool definition object with the required shape:

```typescript
import type { ToolDefinition } from "../core/types";

export const MyTool: ToolDefinition = {
  name: "MyTool",
  description: "One-line description of what this tool does.",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string", description: "What this parameter controls" },
    },
    required: ["input"],
  },
  async execute(params, context) {
    // Implementation here
    return { output: "result" };
  },
};
```

3. Register the tool in `src/tools/index.ts` by importing and adding it to the tools array.
4. Add tests in a corresponding test file (e.g., `src/tools/my-tool.test.ts`).

## How to Add a New Slash Command

Slash commands are defined as skill files. To add one:

1. Create a Markdown file in the appropriate skills directory:
   - Built-in: `src/core/builtin-skills.ts` (for commands shipped with KCode)
   - Global user: `~/.kcode/skills/my-command.md`
   - Project-level: `.kcode/skills/my-command.md`

2. Use YAML frontmatter to define metadata:

```markdown
---
name: my-command
description: What this command does
aliases:
  - mc
  - myc
args: "<required-arg> [optional-arg]"
---

Prompt template here. Use {{args}} for argument substitution.

{{#if args}}
The user provided: {{args}}
{{/if}}
```

3. The command will be automatically discovered at startup.

## How to Add Tests

KCode uses Bun's built-in test runner. Tests live alongside the code they test:

```bash
src/core/config.ts          # Source
src/core/config.test.ts     # Test
```

Write tests using `bun:test`:

```typescript
import { describe, test, expect } from "bun:test";

describe("MyFeature", () => {
  test("should do something", () => {
    expect(myFunction()).toBe(expectedValue);
  });
});
```

Run tests:

```bash
bun test                         # All tests
bun test src/core/config.test.ts # Single file
bun test --watch                 # Watch mode
```

## Code Style

- **Linter**: [Biome](https://biomejs.dev/) -- run `bun run lint` to check, `bun run lint:fix` to auto-fix.
- **Formatter**: Biome -- run `bun run format` to format all source files.
- **TypeScript**: Strict mode. Use `bun run typecheck` to verify.
- **Runtime**: Use Bun APIs (`Bun.file()`, `Bun.write()`) instead of Node.js `fs` equivalents. Bun auto-loads `.env` files.
- **Ports**: Ports below 10000 are reserved. Use 10000+ for any new defaults.
- **Imports**: Prefer relative imports within the project.

## Pull Request Checklist

Before submitting a PR, verify:

- [ ] All tests pass: `bun test`
- [ ] Linter is clean: `bun run lint`
- [ ] Type checking passes: `bun run typecheck`
- [ ] No secrets or credentials committed (`.env`, API keys, etc.)
- [ ] New features have corresponding tests
- [ ] Commit messages are clear and descriptive
- [ ] PR is focused on a single concern

## What We Accept

- Bug fixes with reproduction steps
- New tools with tests and documentation
- Performance improvements with benchmarks
- Test coverage improvements
- Documentation improvements

## What We Do Not Accept

- PRs modifying Pro-gated functionality (`src/core/pro.ts` and related guards) -- these are maintained exclusively by Astrolexis.
- Changes that remove or weaken the permission/security system.
- Dependencies on packages that duplicate Bun built-in functionality.

## Reporting Bugs

Open a [GitHub Issue](https://github.com/AstrolexisAI/KCode/issues) with:

- A clear, descriptive title
- Steps to reproduce the problem
- Expected vs. actual behavior
- Your OS, Bun version, GPU, and KCode version (`kcode doctor` output is helpful)

## Security Issues

Report security vulnerabilities to **contact@astrolexis.space** (see [SECURITY.md](./SECURITY.md)). Do not open public issues for security problems.

## License

KCode is licensed under **AGPL-3.0-only**. By submitting a contribution, you agree that your work is licensed under the same terms. See [LICENSE](./LICENSE) for details.

Copyright (c) 2026 Astrolexis.
