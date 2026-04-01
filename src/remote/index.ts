/**
 * Remote Mode for KCode.
 * Re-exports all public types and classes for remote session management.
 */

// File Sync
export {
  getLocalMtime,
  getRemoteMtime,
  initialSync,
  resolveConflict,
  startRemoteWatcher,
  startWatcher,
  syncChanges,
  syncFromRemote,
} from "./file-sync";
// Remote Permission
export {
  createAutoPrompt,
  PERMISSION_TIMEOUT_MS,
  type PermissionPromptFn,
  type PermissionRequest,
  type PermissionResult,
  RemotePermissionBridge,
} from "./remote-permission";
// Remote Session
export {
  RemoteSession,
  type RemoteSessionEvent,
  type RemoteSessionOptions,
  type SessionEventHandler,
} from "./remote-session";
// SSH Transport
export {
  checkConnectivity,
  checkKCodeInstalled,
  createTunnel,
  DEFAULT_RECONNECT,
  executeRemote,
  executeRemoteSync,
  installRemoteKCode,
  reconnect,
  startRemoteAgent,
} from "./ssh-transport";
// Types
export type {
  RemoteAgentInfo,
  RemoteConfig,
  RemoteMode,
  RemoteSessionInfo,
  SyncConflict,
  TunnelInfo,
} from "./types";
export { DEFAULT_REMOTE_CONFIG, DEFAULT_SYNC_EXCLUDES } from "./types";
