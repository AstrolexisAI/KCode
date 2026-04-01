# KCode IDE Integration Protocol

This document describes the HTTP API and WebSocket protocol that IDE plugins use to communicate with a running KCode server.

## Server Endpoints

KCode exposes two API surfaces:

1. **HTTP API server** (`kcode serve`) — Stateless REST API on port `10091` (default). Used by IDE plugins for direct integration.
2. **Web UI server** (`kcode web`) — Stateful REST + WebSocket API on port `19300` (default). Powers the web dashboard and real-time streaming.

IDE plugins should primarily target the HTTP API server (port 10091).

---

## HTTP API (Port 10091)

### Authentication

Requests may require an API key. Include it as a Bearer token:

```
Authorization: Bearer <api-key>
```

Session tracking uses the `X-Session-Id` header. The server returns a session ID which clients should include in subsequent requests to reuse the same conversation context.

### GET /api/health

Health check. Always returns 200 if the server is running.

**Response:**
```json
{
  "ok": true,
  "version": "1.8.0",
  "model": "mnemo:mark5-nano"
}
```

### GET /api/status

Server status with session and resource information.

**Response:**
```json
{
  "model": "mnemo:mark5-nano",
  "sessionId": "abc-123",
  "tokenCount": 15000,
  "toolUseCount": 5,
  "runningAgents": 1,
  "contextUsage": {
    "messageCount": 12,
    "tokenEstimate": 15000,
    "contextWindow": 32000,
    "usagePercent": 47
  },
  "uptime": 3600
}
```

### POST /api/prompt

Send a prompt and receive a response. Supports both streaming (SSE) and non-streaming modes.

**Request:**
```json
{
  "prompt": "Explain this function",
  "stream": false,
  "model": "optional-model-override",
  "cwd": "/path/to/workspace",
  "noTools": false
}
```

**Non-streaming response:**
```json
{
  "id": "uuid",
  "sessionId": "session-uuid",
  "response": "This function does...",
  "toolCalls": [
    {
      "name": "Read",
      "input": {},
      "result": "file contents...",
      "isError": false
    }
  ],
  "usage": { "inputTokens": 1000, "outputTokens": 500 },
  "model": "mnemo:mark5-nano"
}
```

**Streaming response (SSE):**

Set `"stream": true` to receive Server-Sent Events. Response has `Content-Type: text/event-stream`.

SSE event types:

| Event | Data | Description |
|-------|------|-------------|
| `session` | `{"sessionId": "..."}` | Session ID for this conversation |
| `text` | `{"text": "..."}` | Text delta (partial response) |
| `tool_result` | `{"name": "Read", "result": "...", "isError": false}` | Tool execution result |
| `tool_progress` | `{"name": "Grep", "status": "...", "index": 1, "total": 3}` | Tool progress update |
| `turn_start` | `{}` | New agent turn started |
| `compaction` | `{"tokensAfter": 8000}` | Context compaction occurred |
| `done` | `{"sessionId": "...", "usage": {...}, "model": "..."}` | Stream complete |
| `error` | `{"error": "..."}` | Error during processing |

### GET /api/tools

List all available tools.

**Response:**
```json
{
  "tools": [
    {
      "name": "Read",
      "description": "Read a file from the filesystem",
      "input_schema": { ... }
    }
  ]
}
```

### POST /api/tool

Execute a single tool directly. Only read-only tools are allowed via HTTP (security allowlist).

**Allowed tools:** Read, Glob, Grep, LS, DiffView, GitStatus, GitLog, ToolSearch

**Request:**
```json
{
  "name": "Grep",
  "input": { "pattern": "TODO", "path": "." },
  "cwd": "/path/to/workspace"
}
```

**Response:**
```json
{
  "name": "Grep",
  "content": "matching results...",
  "isError": false
}
```

### GET /api/sessions

List recent and active sessions.

**Query params:** `limit` (default 20, max 200)

**Response:**
```json
{
  "active": [
    {
      "sessionId": "uuid",
      "model": "mnemo:mark5-nano",
      "active": true,
      "createdAt": "2026-04-01T...",
      "lastActivity": "2026-04-01T...",
      "messageCount": 10,
      "toolUseCount": 3,
      "tokenCount": 8000
    }
  ],
  "recent": [
    {
      "filename": "session-2026-04-01.jsonl",
      "startedAt": "2026-04-01T...",
      "prompt": "first message",
      "messageCount": 25,
      "toolUseCount": 8,
      "duration": "15m"
    }
  ]
}
```

### GET /api/context

Get conversation context for a session.

**Query params:** `sessionId`, `lastN` (default 10, max 200)

---

## Web API (Port 19300)

These endpoints are available on the web UI server. IDE plugins can also use these if the web server is running.

### GET /api/v1/health

Simple health check. Returns `{"status": "ok", "timestamp": <ms>}`.

### GET /api/v1/session

Current session information (model, tokens, cost, message count).

### GET /api/v1/messages

Get conversation messages. Query params: `limit` (default 50), `offset` (default 0).

### POST /api/v1/messages

Enqueue a message for processing. The actual response comes via WebSocket.

**Request:** `{"content": "message text"}`
**Response:** `{"queued": true, "messageId": "msg-1"}`

### POST /api/v1/cancel

Cancel the current operation. Returns `{"cancelled": true}`.

### GET /api/v1/files

List files in the workspace. Query params: `pattern` (glob, default `**/*`), `limit` (default 200).

### GET /api/v1/files/:path

Read a file's contents (max 1MB). Path is URL-encoded relative to workspace root.

### GET /api/v1/tools

List available tools (name and description only).

### GET /api/v1/stats

Token usage and cost statistics.

### GET /api/v1/config

Current configuration (sensitive fields redacted).

### GET /api/v1/models

List available models. Returns `{models: [...], active: "model-id"}`.

### POST /api/v1/model

Switch the active model. Request: `{"model": "model-id"}`.

### GET /api/v1/plan

Get the current task plan (if any).

### POST /api/v1/permission/:id

Respond to a permission request. Request: `{"action": "allow" | "deny" | "always_allow"}`.

---

## WebSocket Protocol (Port 19300)

Connect to `ws://localhost:19300/ws` for real-time bidirectional communication.

### Authentication

The web server generates a random auth token on startup. Include it as a query parameter:

```
ws://localhost:19300/ws?token=<auth-token>
```

### Client to Server Events

#### message.send
Send a chat message.
```json
{"type": "message.send", "content": "Explain this code"}
```

#### message.cancel
Cancel the current operation.
```json
{"type": "message.cancel"}
```

#### permission.respond
Respond to a tool permission request.
```json
{"type": "permission.respond", "id": "perm-123", "action": "allow"}
```
Action must be `"allow"`, `"deny"`, or `"always_allow"`.

#### model.switch
Switch the active model.
```json
{"type": "model.switch", "model": "mnemo:mark5-large"}
```

#### command.run
Run a slash command.
```json
{"type": "command.run", "command": "/compact"}
```

#### file.read
Read a file and display in chat.
```json
{"type": "file.read", "path": "/absolute/path/to/file"}
```

### Server to Client Events

#### connected
Sent immediately after WebSocket connection.
```json
{"type": "connected", "sessionId": "web-123", "model": "mnemo:mark5-nano"}
```

#### message.new
New message (user or assistant).
```json
{"type": "message.new", "id": "msg-1", "role": "assistant", "content": "", "timestamp": 1711929600000}
```

#### message.delta
Streaming text fragment appended to the current assistant message.
```json
{"type": "message.delta", "id": "msg-1", "delta": "This function"}
```

#### message.thinking
Model thinking/reasoning text (for models that support it).
```json
{"type": "message.thinking", "id": "msg-1", "thinking": "Let me analyze..."}
```

#### tool.start
Tool execution started.
```json
{"type": "tool.start", "id": "tool-1", "messageId": "msg-1", "name": "Read", "input": {"file_path": "..."}}
```

#### tool.result
Tool execution completed.
```json
{"type": "tool.result", "id": "tool-1", "messageId": "msg-1", "name": "Read", "result": "file contents", "isError": false, "durationMs": 15}
```

#### permission.request
Server needs permission to run a tool.
```json
{"type": "permission.request", "id": "perm-1", "tool": "Bash", "input": {"command": "rm -rf /tmp/test"}, "description": "Run bash command: rm -rf /tmp/test"}
```

#### permission.resolved
Permission request was resolved.
```json
{"type": "permission.resolved", "id": "perm-1", "allowed": true}
```

#### session.stats
Updated session statistics (sent after each turn).
```json
{"type": "session.stats", "model": "mnemo:mark5-nano", "inputTokens": 5000, "outputTokens": 2000, "costUsd": 0.015, "messageCount": 8}
```

#### model.changed
Active model was switched.
```json
{"type": "model.changed", "model": "mnemo:mark5-large"}
```

#### compact.start / compact.done
Context compaction events.
```json
{"type": "compact.start", "messageCount": 50, "tokensBefore": 28000}
{"type": "compact.done", "tokensAfter": 8000, "method": "llm"}
```

#### error
Error occurred.
```json
{"type": "error", "message": "Rate limit exceeded", "retryable": true}
```

---

## Example Flows

### Simple Question (Non-Streaming)

```
POST /api/prompt
{"prompt": "What does the main function do?", "stream": false}

Response:
{"id": "...", "response": "The main function...", "toolCalls": [], "usage": {...}, "model": "..."}
```

### Streaming Conversation

```
POST /api/prompt
{"prompt": "Explain the architecture", "stream": true}

SSE stream:
event: session
data: {"sessionId": "abc-123"}

event: text
data: {"text": "The architecture"}

event: text
data: {"text": " consists of"}

event: tool_result
data: {"name": "Read", "result": "...", "isError": false}

event: text
data: {"text": " several modules..."}

event: done
data: {"sessionId": "abc-123", "usage": {"inputTokens": 1000, "outputTokens": 500}, "model": "..."}
```

### WebSocket Chat Session

```
→ {"type": "message.send", "content": "Fix the bug in utils.ts"}

← {"type": "message.new", "id": "msg-1", "role": "user", "content": "Fix the bug in utils.ts", "timestamp": ...}
← {"type": "message.new", "id": "msg-2", "role": "assistant", "content": "", "timestamp": ...}
← {"type": "message.delta", "id": "msg-2", "delta": "I'll look at"}
← {"type": "message.delta", "id": "msg-2", "delta": " the file..."}
← {"type": "tool.start", "id": "t-1", "messageId": "msg-2", "name": "Read", "input": {"file_path": "utils.ts"}}
← {"type": "tool.result", "id": "t-1", "messageId": "msg-2", "name": "Read", "result": "...", "isError": false}
← {"type": "permission.request", "id": "p-1", "tool": "Edit", "input": {...}, "description": "Edit utils.ts"}

→ {"type": "permission.respond", "id": "p-1", "action": "allow"}

← {"type": "permission.resolved", "id": "p-1", "allowed": true}
← {"type": "tool.result", "id": "t-2", "messageId": "msg-2", "name": "Edit", "result": "Applied", "isError": false}
← {"type": "message.delta", "id": "msg-2", "delta": "I've fixed the bug..."}
← {"type": "session.stats", "model": "...", "inputTokens": 5000, "outputTokens": 2000, "costUsd": 0.01, "messageCount": 2}
```

---

## Error Handling

All HTTP endpoints return error responses in this format:

```json
{
  "error": "Description of what went wrong",
  "code": 400
}
```

Common HTTP status codes:
- `400` — Invalid request (missing fields, bad JSON)
- `403` — Forbidden (blocked tool, path traversal)
- `404` — Not found (unknown endpoint, unknown tool)
- `413` — File too large (max 1MB for file reads)
- `500` — Internal server error
- `503` — No active session (server running but no KCode session)

WebSocket errors use the `error` event type with a `retryable` flag indicating whether the client should retry the operation.
