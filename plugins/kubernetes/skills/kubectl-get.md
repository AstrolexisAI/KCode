---
name: kubectl-get
description: List Kubernetes resources (pods, services, deployments, etc.) with filtering.
triggers:
  - "kubectl get"
  - "list pods"
  - "show deployments"
  - "kubernetes resources"
---

# Kubectl Get

List and inspect Kubernetes resources.

## Usage

When asked about Kubernetes resources:

1. Determine the resource type and namespace
2. Run kubectl get with appropriate flags
3. Format output as a readable table

## Parameters

- `resource`: Resource type -- pods, services, deployments, etc. (required)
- `namespace`: Kubernetes namespace (default: current context)
- `selector`: Label selector for filtering
- `output`: Output format -- wide, json, yaml (default: wide)
- `all-namespaces`: Search across all namespaces

## Example

```bash
kubectl get pods -n production -l app=myapp -o wide
```
