---
name: db-migrate
description: Create and run database migrations with rollback support.
triggers:
  - "create migration"
  - "run migration"
  - "database migration"
---

# Database Migration

Create and manage database migrations.

## Usage

When asked to create or run migrations:

1. Generate a timestamped migration file with up/down SQL
2. Run pending migrations in order
3. Support rollback to a previous version

## Commands

- `create <name>`: Generate a new migration file
- `up`: Run all pending migrations
- `down`: Rollback the last migration
- `status`: Show migration status
