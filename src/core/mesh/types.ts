// KCode - P2P Agent Mesh Types
// Shared type definitions for peer discovery, transport, task scheduling, and security.

// ─── Discovery ─────────────────────────────────────────────────

export type DiscoveryMethod = "mdns" | "manual" | "shared-file";

export type PeerStatus = "online" | "busy" | "offline";

export interface PeerCapabilities {
  models: string[];
  gpuVram: number;       // Total VRAM in GB
  cpuCores: number;
  maxConcurrent: number; // Max simultaneous tasks
}

export interface PeerInfo {
  nodeId: string;
  hostname: string;
  ip: string;
  port: number;
  capabilities: PeerCapabilities;
  status: PeerStatus;
  lastSeen: number;      // Epoch ms
}

// ─── Transport ─────────────────────────────────────────────────

export interface TransportConfig {
  port: number;             // default: 19200
  teamToken: string;        // Shared secret for the team
  tlsCert?: string;         // Path to TLS certificate (auto-generated)
  tlsKey?: string;          // Path to TLS private key
  maxConnections: number;   // default: 10
  messageMaxSize: number;   // default: 10 MB (bytes)
}

export const DEFAULT_TRANSPORT_CONFIG: TransportConfig = {
  port: 19200,
  teamToken: "",
  maxConnections: 10,
  messageMaxSize: 10 * 1024 * 1024,
};

// ─── Tasks ─────────────────────────────────────────────────────

export type TaskType = "query" | "embed" | "index" | "test" | "build";
export type TaskPriority = "low" | "normal" | "high";
export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface MeshTask {
  id: string;
  type: TaskType;
  prompt?: string;
  files?: string[];
  model?: string;
  priority: TaskPriority;
  timeout: number;         // ms
}

export interface MeshTaskHandle {
  taskId: string;
  assignedTo: string;      // nodeId of the peer handling it
  status: TaskStatus;
  submittedAt: number;     // Epoch ms
}

export interface MeshResult {
  taskId: string;
  status: TaskStatus;
  output?: string;
  error?: string;
  durationMs: number;
  fromNode: string;        // nodeId of the peer that executed it
}

// ─── Mesh Settings (stored in settings.json under "mesh") ──────

export interface MeshSettings {
  enabled?: boolean;
  port?: number;
  discovery?: DiscoveryMethod;
  teamToken?: string | null;
  autoStart?: boolean;
  maxConcurrentTasks?: number;
  sharableModels?: boolean;
  peers?: Array<{ host: string; port: number }>;
}

export const DEFAULT_MESH_SETTINGS: Required<MeshSettings> = {
  enabled: false,
  port: 19200,
  discovery: "mdns",
  teamToken: null,
  autoStart: false,
  maxConcurrentTasks: 2,
  sharableModels: true,
  peers: [],
};

// ─── Scored Peer (internal to scheduler) ───────────────────────

export interface ScoredPeer {
  peer: PeerInfo;
  score: number;
  latency: number;
}
