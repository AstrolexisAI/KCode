---
name: ec2-status
description: Check EC2 instance status, start/stop instances, and view instance details.
triggers:
  - "ec2 status"
  - "list instances"
  - "check ec2"
---

# EC2 Status

Monitor and manage AWS EC2 instances.

## Usage

When asked about EC2 instances:

1. Query instance status via AWS CLI
2. Display instance ID, type, state, IP, and tags
3. Support start/stop/reboot actions with confirmation

## Parameters

- `instance-id`: Specific instance to check (optional)
- `region`: AWS region (default: from config)
- `state`: Filter by state (running, stopped, etc.)
- `action`: start, stop, or reboot (requires confirmation)
