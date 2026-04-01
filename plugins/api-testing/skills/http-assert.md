---
name: http-assert
description: Assert HTTP response properties including status, headers, body, and timing.
triggers:
  - "assert response"
  - "check api response"
  - "validate response"
---

# HTTP Assert

Validate HTTP responses against expected values.

## Usage

When asked to validate an API response:

1. Send the HTTP request
2. Run assertions against the response
3. Report pass/fail for each assertion

## Assertion Types

- `status`: Check HTTP status code (e.g., 200, 201, 404)
- `header`: Check response header value
- `body.json`: Check JSON body using JSONPath expressions
- `body.contains`: Check body contains a string
- `time`: Check response time is under threshold
- `schema`: Validate response body against JSON Schema

## Example

```json
{
  "assertions": [
    { "type": "status", "expected": 200 },
    { "type": "body.json", "path": "$.data.id", "expected": 1 },
    { "type": "time", "maxMs": 500 }
  ]
}
```
