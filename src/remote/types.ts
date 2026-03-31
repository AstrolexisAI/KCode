/**
 * Remote Mode types for KCode.
 * Supports three modes: execution (full remote), sync (hybrid), viewer (read-only).
 */

/** Configuration for a remote connection, stored in .kcode/remote.json */
export interface RemoteConfig {
  /** SSH host string, e.g. "user@server" or "user@server:port" */
  host: string;
  /** Absolute path to the project directory on the remote machine */
  remoteDir: string;
  /** Glob patterns to exclude from file sync (e.g. ["node_modules/", ".git/objects/"]) */
  syncExclude: string[];
  /** Interval in ms between automatic syncs (default 2000) */
  syncInterval: number;
  /** Whether to sync immediately on file save (default true) */
  syncOnSave: boolean;
  /** Force remote to use only local models, no cloud APIs */
  localOnly: boolean;
}

/** Information about an active or recent remote session */
export interface RemoteSessionInfo {
  /** Unique session identifier */
  id: string;
  /** SSH host the session is running on */
  host: string;
  /** Working directory on the remote */
  dir: string;
  /** Current session status */
  status: "active" | "paused" | "disconnected" | "terminated";
  /** ISO timestamp of session creation */
  createdAt: string;
}

/** Describes a file sync conflict between local and remote */
export interface SyncConflict {
  /** Relative file path from project root */
  path: string;
  /** Local file modification time (epoch ms) */
  localMtime: number;
  /** Remote file modification time (epoch ms) */
  remoteMtime: number;
  /** How the conflict was resolved */
  resolution: "local-wins" | "remote-wins" | "manual";
}

/** Operating mode for a remote session */
export type RemoteMode = "execution" | "sync" | "viewer";

/** Result of starting a remote agent */
export interface RemoteAgentInfo {
  /** Port the headless agent is listening on (remote side) */
  port: number;
  /** Auth token for WebSocket connection */
  token: string;
}

/** Result of creating an SSH tunnel */
export interface TunnelInfo {
  /** Local port that forwards to the remote */
  localPort: number;
  /** The underlying process (for cleanup) */
  process: { kill: () => void };
}

/** Default sync exclude patterns */
export const DEFAULT_SYNC_EXCLUDES: string[] = [
  "node_modules/",
  ".git/objects/",
  "dist/",
  "*.pyc",
  ".kcode/",
  "__pycache__/",
];

/** Default remote config values */
export const DEFAULT_REMOTE_CONFIG: Omit<RemoteConfig, "host" | "remoteDir"> = {
  syncExclude: DEFAULT_SYNC_EXCLUDES,
  syncInterval: 2000,
  syncOnSave: true,
  localOnly: false,
};
