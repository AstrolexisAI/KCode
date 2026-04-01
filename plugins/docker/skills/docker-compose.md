---
name: docker-compose
description: Manage multi-container applications with Docker Compose.
triggers:
  - "docker compose"
  - "compose up"
  - "start services"
---

# Docker Compose

Manage multi-container Docker applications using docker-compose.yml.

## Usage

When asked to manage Docker Compose services:

1. Check for docker-compose.yml in the project
2. Execute the requested compose command (up, down, logs, ps)
3. Report service status

## Commands

- `up`: Start all services (`docker compose up -d`)
- `down`: Stop and remove containers (`docker compose down`)
- `ps`: List running services
- `logs`: Show service logs
- `build`: Build or rebuild services
