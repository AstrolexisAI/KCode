---
name: react-app
description: React application with routing and styling
tags: [typescript, react, vite, frontend]
parameters:
  - name: projectName
    description: Name of the project
    type: string
    required: true
  - name: styling
    description: Styling approach
    type: choice
    choices: [css, tailwind, styled-components]
    default: css
  - name: testing
    description: Include test setup
    type: boolean
    default: true
  - name: router
    description: Include React Router
    type: boolean
    default: true
---

Generate a complete React application:
- Build tool: Vite
- Language: TypeScript (strict mode)
- Name: {{projectName}}
- Styling: {{styling}}
{{#if router}}- Routing: React Router v6 with Home and About pages{{else}}- Routing: None (single page){{/if}}
{{#if testing}}- Testing: Vitest + React Testing Library{{/if}}
- Structure: src/components/, src/pages/, src/hooks/, src/styles/
- Include: README.md, .gitignore, tsconfig.json, package.json, vite.config.ts, index.html

Generate ALL files with complete, working code. No placeholders.
