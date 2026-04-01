---
name: docker-build
description: Build Docker images from a Dockerfile with optional build arguments and tags.
triggers:
  - "build docker image"
  - "docker build"
  - "create container image"
---

# Docker Build

Build a Docker image from a Dockerfile in the current directory or a specified path.

## Usage

When asked to build a Docker image:

1. Check for a Dockerfile in the project root or specified directory
2. Run `docker build -t <tag> .` with appropriate arguments
3. Report the build result including image size and layer count

## Parameters

- `context`: Build context directory (default: `.`)
- `tag`: Image tag (default: project name)
- `file`: Path to Dockerfile (default: `Dockerfile`)
- `build-args`: Key-value build arguments
- `no-cache`: Force rebuild without cache

## Example

```bash
docker build -t myapp:latest --build-arg NODE_ENV=production .
```
