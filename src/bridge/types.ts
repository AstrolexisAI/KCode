// KCode Bridge/Daemon Mode - Type Definitions
// Defines the WebSocket protocol messages between IDE clients and the KCode daemon.

// ─── Spawn & Session ────────────────────────────────────────────

export type SpawnMode = "single-session" | "worktree" | "shared-dir";
export type SessionStatus = "active" | "idle" | "responding";

// ─── Base Message ───────────────────────────────────────────────

export interface BridgeMessage {
  type: string;
  id: string;
  sessionId?: string;
  timestamp: string; // ISO 8601
}

// ─── Client Messages ────────────────────────────────────────────

export interface SessionCreateMessage extends BridgeMessage {
  type: "session.create";
  dir: string;
  spawnMode: SpawnMode;
  model?: string;
  initialPrompt?: string;
}

export interface SessionMessageMessage extends BridgeMessage {
  type: "session.message";
  sessionId: string;
  content: string;
}

export interface SessionCancelMessage extends BridgeMessage {
  type: "session.cancel";
  sessionId: string;
}

export interface SessionDestroyMessage extends BridgeMessage {
  type: "session.destroy";
  sessionId: string;
}

export interface PermissionResponseMessage extends BridgeMessage {
  type: "permission.response";
  sessionId: string;
  requestId: string;
  allowed: boolean;
  remember: boolean;
}

export interface PingMessage extends BridgeMessage {
  type: "ping";
}

export type ClientMessage =
  | SessionCreateMessage
  | SessionMessageMessage
  | SessionCancelMessage
  | SessionDestroyMessage
  | PermissionResponseMessage
  | PingMessage;

// ─── Server Messages ────────────────────────────────────────────

export interface SessionCreatedMessage extends BridgeMessage {
  type: "session.created";
  sessionId: string;
  dir: string;
  model: string;
}

export interface SessionTextMessage extends BridgeMessage {
  type: "session.text";
  sessionId: string;
  content: string;
  role: "assistant";
  streaming: boolean;
}

export interface SessionToolUseMessage extends BridgeMessage {
  type: "session.tool_use";
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  status: "running" | "completed" | "error";
  result?: string;
}

export interface SessionThinkingMessage extends BridgeMessage {
  type: "session.thinking";
  sessionId: string;
  content: string;
}

export interface PermissionRequestMessage extends BridgeMessage {
  type: "permission.request";
  sessionId: string;
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  safetyAnalysis: { level: string; details: string };
}

export interface SessionDoneMessage extends BridgeMessage {
  type: "session.done";
  sessionId: string;
  tokensUsed?: { input: number; output: number };
  costUsd?: number;
  reason?: string;
}

export interface SessionErrorMessage extends BridgeMessage {
  type: "session.error";
  sessionId: string;
  error: string;
  fatal: boolean;
}

export interface PongMessage extends BridgeMessage {
  type: "pong";
}

export interface ShutdownMessage extends BridgeMessage {
  type: "shutdown";
  reason: string;
}

export type ServerMessage =
  | SessionCreatedMessage
  | SessionTextMessage
  | SessionToolUseMessage
  | SessionThinkingMessage
  | PermissionRequestMessage
  | SessionDoneMessage
  | SessionErrorMessage
  | PongMessage
  | ShutdownMessage;

// ─── Session ────────────────────────────────────────────────────

export interface Session {
  id: string;
  dir: string;
  spawnMode: SpawnMode;
  model: string;
  createdAt: Date;
  lastActivityAt: Date;
  status: SessionStatus;
  worktreePath?: string;
  clientCount: number;
}
