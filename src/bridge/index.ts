// KCode Bridge/Daemon Mode - Public API
// Re-exports all bridge components for convenient importing.

// Types
export type {
  BridgeMessage,
  SpawnMode,
  SessionStatus,
  Session,
  ClientMessage,
  ServerMessage,
  SessionCreateMessage,
  SessionMessageMessage,
  SessionCancelMessage,
  SessionDestroyMessage,
  PermissionResponseMessage,
  PingMessage,
  SessionCreatedMessage,
  SessionTextMessage,
  SessionToolUseMessage,
  SessionThinkingMessage,
  PermissionRequestMessage,
  SessionDoneMessage,
  SessionErrorMessage,
  PongMessage,
  ShutdownMessage,
} from "./types";

// Protocol
export { parseMessage, serializeMessage, createMessage, isClientMessageType, isServerMessageType } from "./protocol";

// Session Manager
export { SessionManager } from "./session-manager";
export type { SessionEvent, SessionEventType, SessionEventListener } from "./session-manager";

// Permission Bridge
export { PermissionBridge } from "./permission-bridge";

// WebSocket Server
export { BridgeWebSocketServer } from "./websocket-server";

// Daemon
export {
  startDaemon,
  stopDaemon,
  stopRemoteDaemon,
  isDaemonRunning,
  getDaemonStatus,
  listDaemonSessions,
  readPidFile,
  readPortFile,
  readTokenFile,
  getActiveDaemon,
} from "./daemon";
export type { DaemonStatus } from "./daemon";
