---
name: rest-api
description: REST API with database, auth, and tests
tags: [typescript, api, bun, sqlite]
parameters:
  - name: projectName
    description: Name of the project
    type: string
    required: true
  - name: database
    description: Database to use
    type: choice
    choices: [sqlite, postgres, mysql]
    default: sqlite
  - name: auth
    description: Include authentication
    type: boolean
    default: true
  - name: docker
    description: Include Dockerfile
    type: boolean
    default: true
postSetup:
  - bun install
---

Generate a complete REST API project with the following specs:
- Runtime: Bun
- Language: TypeScript (strict mode)
- Database: {{database}}
- Project name: {{projectName}}
{{#if auth}}- Auth: JWT-based authentication with register/login endpoints{{else}}- Auth: No authentication{{/if}}
- Testing: bun:test with at least one test per endpoint
- Structure: src/routes/, src/middleware/, src/models/, src/utils/
{{#if docker}}- Docker: Multi-stage Dockerfile with .dockerignore{{/if}}
- Include: README.md, .gitignore, tsconfig.json, package.json

Generate ALL files with complete, working code. No placeholders.
