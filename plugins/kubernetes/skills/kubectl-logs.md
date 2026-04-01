---
name: kubectl-logs
description: View and stream Kubernetes pod logs with container and label filtering.
triggers:
  - "kubectl logs"
  - "pod logs"
  - "kubernetes logs"
---

# Kubectl Logs

View logs from Kubernetes pods and containers.

## Usage

When asked for pod logs:

1. Identify the pod by name or label selector
2. Stream or retrieve logs with filtering
3. Support multi-container pods with container selection

## Parameters

- `pod`: Pod name (required unless using selector)
- `namespace`: Kubernetes namespace
- `container`: Specific container in multi-container pod
- `selector`: Label selector (alternative to pod name)
- `tail`: Number of lines (default: 100)
- `since`: Duration (e.g., "1h", "30m")
- `follow`: Stream live logs

## Example

```bash
kubectl logs -n production -l app=myapp --tail=100 --since=1h
```
