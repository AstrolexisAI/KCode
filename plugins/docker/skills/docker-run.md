---
name: docker-run
description: Run Docker containers with port mapping, volumes, and environment variables.
triggers:
  - "run docker container"
  - "start container"
  - "docker run"
---

# Docker Run

Run a Docker container from an image with configurable options.

## Usage

When asked to run a container:

1. Determine the image name and tag
2. Map ports, volumes, and environment variables as needed
3. Run the container and report its status

## Parameters

- `image`: Docker image to run (required)
- `ports`: Port mappings (e.g., "8080:80")
- `volumes`: Volume mounts (e.g., "./data:/app/data")
- `env`: Environment variables
- `detach`: Run in background (default: true)
- `name`: Container name

## Example

```bash
docker run -d --name myapp -p 8080:80 -v ./data:/app/data myapp:latest
```
