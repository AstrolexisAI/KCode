// KCode Bridge/Daemon Mode - Public API
// Re-exports all bridge components for convenient importing.

export type { DaemonStatus } from "./daemon";
// Daemon
export {
  getActiveDaemon,
  getDaemonStatus,
  isDaemonRunning,
  listDaemonSessions,
  readPidFile,
  readPortFile,
  readTokenFile,
  startDaemon,
  stopDaemon,
  stopRemoteDaemon,
} from "./daemon";
// Permission Bridge
export { PermissionBridge } from "./permission-bridge";
// Protocol
export {
  createMessage,
  isClientMessageType,
  isServerMessageType,
  parseMessage,
  serializeMessage,
} from "./protocol";
export type { SessionEvent, SessionEventListener, SessionEventType } from "./session-manager";
// Session Manager
export { SessionManager } from "./session-manager";
// Types
export type {
  BridgeMessage,
  ClientMessage,
  PermissionRequestMessage,
  PermissionResponseMessage,
  PingMessage,
  PongMessage,
  ServerMessage,
  Session,
  SessionCancelMessage,
  SessionCreatedMessage,
  SessionCreateMessage,
  SessionDestroyMessage,
  SessionDoneMessage,
  SessionErrorMessage,
  SessionMessageMessage,
  SessionStatus,
  SessionTextMessage,
  SessionThinkingMessage,
  SessionToolUseMessage,
  ShutdownMessage,
  SpawnMode,
} from "./types";
// WebSocket Server
export { BridgeWebSocketServer } from "./websocket-server";
