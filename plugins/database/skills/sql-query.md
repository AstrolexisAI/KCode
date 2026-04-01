---
name: sql-query
description: Execute SQL queries against PostgreSQL, MySQL, or SQLite databases.
triggers:
  - "run sql"
  - "query database"
  - "execute query"
---

# SQL Query

Execute SQL queries against a connected database.

## Usage

When asked to run a SQL query:

1. Determine the target database from connection config
2. Validate the query for safety (block DROP/TRUNCATE unless confirmed)
3. Execute and format results as a table

## Parameters

- `query`: SQL query string (required)
- `database`: Connection name from config (default: "default")
- `limit`: Max rows to return (default: 100)
- `format`: Output format -- table, csv, or json (default: table)

## Safety

- SELECT queries run without confirmation
- INSERT/UPDATE/DELETE require user confirmation
- DROP/TRUNCATE/ALTER require explicit approval
