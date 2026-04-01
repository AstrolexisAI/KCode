---
name: kubectl-apply
description: Apply Kubernetes manifests with dry-run validation and diff preview.
triggers:
  - "kubectl apply"
  - "deploy to kubernetes"
  - "apply manifest"
---

# Kubectl Apply

Apply Kubernetes resource manifests with safety checks.

## Usage

When asked to apply Kubernetes resources:

1. Validate the manifest YAML/JSON
2. Show a diff of changes (dry-run)
3. Apply after user confirmation

## Parameters

- `file`: Path to manifest file or directory (required)
- `namespace`: Target namespace
- `dry-run`: Validate without applying (default: client-side dry-run first)
- `force`: Force apply (use with caution)

## Safety

- Always runs `--dry-run=client` first to validate
- Shows diff between current and desired state
- Requires user confirmation before applying
