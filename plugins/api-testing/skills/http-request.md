---
name: http-request
description: Send HTTP requests with configurable method, headers, body, and authentication.
triggers:
  - "send http request"
  - "curl"
  - "api request"
  - "fetch url"
---

# HTTP Request

Send HTTP requests and inspect responses.

## Usage

When asked to make an HTTP request:

1. Build the request with method, URL, headers, and body
2. Send the request and capture the response
3. Display status, headers, body, and timing

## Parameters

- `url`: Request URL (required)
- `method`: HTTP method -- GET, POST, PUT, DELETE, PATCH (default: GET)
- `headers`: Key-value headers
- `body`: Request body (JSON, form data, or raw)
- `auth`: Authentication -- bearer token, basic auth, or API key
- `timeout`: Request timeout in seconds (default: 30)

## Example

```bash
curl -X POST https://api.example.com/users \
  -H "Content-Type: application/json" \
  -d '{"name": "John", "email": "john@example.com"}'
```
