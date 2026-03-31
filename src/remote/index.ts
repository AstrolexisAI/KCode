/**
 * Remote Mode for KCode.
 * Re-exports all public types and classes for remote session management.
 */

// Types
export type {
  RemoteConfig,
  RemoteSessionInfo,
  SyncConflict,
  RemoteMode,
  RemoteAgentInfo,
  TunnelInfo,
} from "./types";
export { DEFAULT_SYNC_EXCLUDES, DEFAULT_REMOTE_CONFIG } from "./types";

// SSH Transport
export {
  checkConnectivity,
  checkKCodeInstalled,
  startRemoteAgent,
  createTunnel,
  executeRemote,
  executeRemoteSync,
  reconnect,
  installRemoteKCode,
  DEFAULT_RECONNECT,
} from "./ssh-transport";

// File Sync
export {
  initialSync,
  syncChanges,
  syncFromRemote,
  startWatcher,
  startRemoteWatcher,
  resolveConflict,
  getRemoteMtime,
  getLocalMtime,
} from "./file-sync";

// Remote Session
export {
  RemoteSession,
  type RemoteSessionEvent,
  type SessionEventHandler,
  type RemoteSessionOptions,
} from "./remote-session";

// Remote Permission
export {
  RemotePermissionBridge,
  createAutoPrompt,
  PERMISSION_TIMEOUT_MS,
  type PermissionRequest,
  type PermissionResult,
  type PermissionPromptFn,
} from "./remote-permission";
