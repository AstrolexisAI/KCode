---
name: cli-tool
description: Command-line tool with argument parsing and tests
tags: [typescript, cli, bun, commander]
parameters:
  - name: projectName
    description: Name of the CLI tool
    type: string
    required: true
  - name: description
    description: Short description of the tool
    type: string
    required: false
    default: A CLI tool built with Bun
  - name: testing
    description: Include test suite
    type: boolean
    default: true
postSetup:
  - bun install
---

Generate a complete CLI tool project:
- Runtime: Bun
- Language: TypeScript (strict mode)
- CLI framework: Commander.js
- Name: {{projectName}}
- Description: {{description}}
- Structure: src/index.ts (entry), src/commands/, src/utils/
{{#if testing}}- Testing: bun:test with tests for each command{{/if}}
- Include: README.md, .gitignore, tsconfig.json, package.json
- The CLI should have at least one example subcommand

Generate ALL files with complete, working code. No placeholders.
