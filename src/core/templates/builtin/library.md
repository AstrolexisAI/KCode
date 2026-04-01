---
name: library
description: TypeScript library with build and publish setup
tags: [typescript, library, npm, jsr]
parameters:
  - name: projectName
    description: Name of the library
    type: string
    required: true
  - name: runtime
    description: Target runtime
    type: choice
    choices: [bun, node]
    default: bun
  - name: publishTo
    description: Package registry
    type: choice
    choices: [npm, jsr, none]
    default: npm
---

Generate a complete TypeScript library project:
- Runtime: {{runtime}}
- Language: TypeScript (strict mode)
- Name: {{projectName}}
- Publish to: {{publishTo}}
- Structure: src/index.ts (exports), src/lib/ (implementation), tests/
- Testing: bun:test or vitest
- Build: tsup or Bun bundler for ESM + CJS output
- Include: README.md, .gitignore, tsconfig.json, package.json, LICENSE (MIT)

Generate ALL files with complete, working code. No placeholders.
