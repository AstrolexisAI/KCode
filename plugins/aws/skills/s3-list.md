---
name: s3-list
description: List S3 buckets and objects with filtering and size information.
triggers:
  - "list s3"
  - "s3 buckets"
  - "show s3 objects"
---

# S3 List

List AWS S3 buckets and their contents.

## Usage

When asked about S3 resources:

1. Use AWS CLI or SDK to list buckets/objects
2. Display with size, last modified, and storage class
3. Support prefix filtering and recursive listing

## Parameters

- `bucket`: S3 bucket name (optional, lists all buckets if omitted)
- `prefix`: Object key prefix filter
- `recursive`: List recursively (default: false)
- `max-items`: Maximum items to display (default: 100)

## Example

```bash
aws s3 ls s3://my-bucket/data/ --recursive --human-readable
```
