// KCode - Web UI Types
// WebSocket event types for server↔client communication

// ─── Server → Client Events ────────────────────────────────────

export type ServerEvent =
  | { type: "message.new"; id: string; role: "user" | "assistant"; content: string; timestamp: number }
  | { type: "message.delta"; id: string; delta: string }
  | { type: "message.thinking"; id: string; thinking: string }
  | { type: "tool.start"; id: string; messageId: string; name: string; input: Record<string, unknown> }
  | { type: "tool.result"; id: string; messageId: string; name: string; result: string; isError: boolean; durationMs?: number }
  | { type: "permission.request"; id: string; tool: string; input: Record<string, unknown>; description: string }
  | { type: "permission.resolved"; id: string; allowed: boolean }
  | { type: "session.stats"; model: string; inputTokens: number; outputTokens: number; costUsd: number; messageCount: number }
  | { type: "model.changed"; model: string }
  | { type: "compact.start"; messageCount: number; tokensBefore: number }
  | { type: "compact.done"; tokensAfter: number; method: string }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "connected"; sessionId: string; model: string };

// ─── Client → Server Events ────────────────────────────────────

export type ClientEvent =
  | { type: "message.send"; content: string }
  | { type: "message.cancel" }
  | { type: "permission.respond"; id: string; action: "allow" | "deny" | "always_allow" }
  | { type: "model.switch"; model: string }
  | { type: "command.run"; command: string }
  | { type: "file.read"; path: string };

// ─── Config ────────────────────────────────────────────────────

export interface WebServerConfig {
  port: number;
  host: string;
  auth: {
    enabled: boolean;
    token: string;
  };
  cors: boolean;
  openBrowser: boolean;
}

export const DEFAULT_WEB_CONFIG: WebServerConfig = {
  port: 19300,
  host: "127.0.0.1",
  auth: {
    enabled: true,
    token: crypto.randomUUID(),
  },
  cors: false,
  openBrowser: true,
};

// ─── Internal Types ────────────────────────────────────────────

export interface WebSessionContext {
  sessionId: string;
  model: string;
  startTime: number;
  messageIdCounter: number;
}

export interface PendingPermission {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  resolve: (action: "allow" | "deny" | "always_allow") => void;
}

/** MIME type map for static file serving */
export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
