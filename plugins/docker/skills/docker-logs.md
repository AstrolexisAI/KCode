---
name: docker-logs
description: View and follow Docker container logs with filtering.
triggers:
  - "docker logs"
  - "container logs"
  - "show logs"
---

# Docker Logs

View logs from running or stopped Docker containers.

## Usage

When asked to view container logs:

1. Identify the container by name or ID
2. Retrieve logs with optional tail and follow options
3. Optionally filter by timestamp or grep pattern

## Parameters

- `container`: Container name or ID (required)
- `tail`: Number of lines to show (default: 100)
- `follow`: Stream new log output (default: false)
- `since`: Show logs since timestamp (e.g., "1h", "2024-01-01")
- `grep`: Filter pattern

## Example

```bash
docker logs --tail 100 --since 1h myapp
```
