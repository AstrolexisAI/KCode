---
name: http-collection
description: Manage collections of HTTP requests for API testing workflows.
triggers:
  - "api collection"
  - "request collection"
  - "test suite"
---

# HTTP Collection

Manage and run collections of HTTP requests.

## Usage

When asked to manage API test collections:

1. Create or load a collection from .kcode/api-tests/
2. Run individual requests or the entire collection
3. Report results with pass/fail status

## Features

- Save requests to named collections
- Run collections sequentially with variable substitution
- Export collections as curl commands or OpenAPI spec
- Environment-based variable overrides (dev, staging, prod)

## Collection Format

Collections are stored as JSON in `.kcode/api-tests/<name>.json` with:
- `name`: Collection name
- `requests`: Array of request definitions
- `variables`: Shared variables across requests
