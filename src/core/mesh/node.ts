// KCode - P2P Agent Mesh Node
// Individual mesh node that combines discovery, transport, scheduling, and security.
// This is the main entry point for the mesh subsystem.

import { log } from "../logger";
import { PeerDiscovery } from "./discovery";
import { generateNodeId, generateTeamToken } from "./security";
import { type LocalExecutor, TaskScheduler } from "./task-scheduler";
import { MeshTransport } from "./transport";
import type {
  DiscoveryMethod,
  MeshResult,
  MeshSettings,
  MeshTask,
  MeshTaskHandle,
  PeerCapabilities,
  PeerInfo,
  TransportConfig,
} from "./types";
import { DEFAULT_MESH_SETTINGS, DEFAULT_TRANSPORT_CONFIG } from "./types";

// ─── MeshNode ──────────────────────────────────────────────────

export type MeshNodeStatus = "stopped" | "starting" | "running" | "error";

export interface MeshNodeConfig {
  settings?: Partial<MeshSettings>;
  capabilities?: PeerCapabilities;
  localExecutor?: LocalExecutor;
}

export class MeshNode {
  readonly nodeId: string;
  readonly hostname: string;
  private settings: Required<MeshSettings>;
  private capabilities: PeerCapabilities;
  private _status: MeshNodeStatus = "stopped";
  private _error: string | null = null;

  readonly discovery: PeerDiscovery;
  readonly transport: MeshTransport;
  readonly scheduler: TaskScheduler;
  private localExecutor: LocalExecutor | null;

  // Task tracking
  private activeTasks: Map<string, MeshTask> = new Map();
  private taskResults: Map<string, MeshResult> = new Map();

  constructor(config: MeshNodeConfig = {}) {
    this.nodeId = generateNodeId();
    this.hostname = this.getHostname();

    // Merge settings with defaults
    this.settings = {
      ...DEFAULT_MESH_SETTINGS,
      ...config.settings,
    } as Required<MeshSettings>;

    // Default capabilities
    this.capabilities = config.capabilities ?? {
      models: [],
      gpuVram: 0,
      cpuCores: 1,
      maxConcurrent: this.settings.maxConcurrentTasks,
    };

    this.localExecutor = config.localExecutor ?? null;

    // Initialize subsystems
    this.discovery = new PeerDiscovery(this.nodeId);

    const transportConfig: Partial<TransportConfig> = {
      port: this.settings.port,
      teamToken: this.settings.teamToken ?? "",
      maxConnections: 10,
      messageMaxSize: DEFAULT_TRANSPORT_CONFIG.messageMaxSize,
    };

    this.transport = new MeshTransport(transportConfig, {
      onCapabilities: () => this.getLocalPeerInfo(),
      onTask: (task) => this.handleIncomingTask(task),
      onResult: async (result) => this.handleIncomingResult(result),
    });

    this.scheduler = new TaskScheduler(
      this.discovery,
      this.transport,
      this.localExecutor ?? undefined,
    );
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /**
   * Start the mesh node.
   * Initializes transport server and begins peer discovery.
   */
  async start(): Promise<void> {
    if (this._status === "running") return;

    this._status = "starting";
    this._error = null;

    try {
      // Ensure we have a team token
      if (!this.settings.teamToken) {
        this.settings.teamToken = generateTeamToken();
        log.debug("mesh-node", "Generated new team token (share with peers)");
      }

      // Update transport with the team token
      this.transport["config"].teamToken = this.settings.teamToken;

      // Start transport server
      await this.transport.start();

      // Start discovery based on configured method
      const localInfo = this.getLocalPeerInfo();
      await this.startDiscovery(this.settings.discovery, localInfo);

      this._status = "running";
      log.debug("mesh-node", `Mesh node ${this.nodeId} started on port ${this.settings.port}`);
    } catch (err) {
      this._status = "error";
      this._error = err instanceof Error ? err.message : String(err);
      log.error("mesh-node", `Failed to start: ${this._error}`);
      throw err;
    }
  }

  /**
   * Stop the mesh node gracefully.
   */
  async stop(): Promise<void> {
    this.discovery.stop();
    this.transport.stop();
    this.activeTasks.clear();
    this._status = "stopped";
    log.debug("mesh-node", `Mesh node ${this.nodeId} stopped`);
  }

  // ─── Discovery ────────────────────────────────────────────────

  private async startDiscovery(method: DiscoveryMethod, localInfo: PeerInfo): Promise<void> {
    switch (method) {
      case "mdns":
        await this.discovery.startMDNS(localInfo);
        break;
      case "manual":
        if (this.settings.peers.length > 0) {
          await this.discovery.loadManualPeers(this.settings.peers, this.settings.teamToken!);
        }
        break;
      case "shared-file":
        // Shared-file requires a directory path (not configured by default)
        log.debug(
          "mesh-node",
          "Shared-file discovery requires a directory path. Use manual discovery as fallback.",
        );
        break;
    }
  }

  // ─── Task Submission ──────────────────────────────────────────

  /**
   * Submit a task to the mesh.
   * Automatically selects the best peer or runs locally.
   */
  async submitTask(task: MeshTask): Promise<MeshResult> {
    // Check concurrent task limit
    if (this.activeTasks.size >= this.settings.maxConcurrentTasks) {
      throw new Error(`Concurrent task limit reached (${this.settings.maxConcurrentTasks})`);
    }

    this.activeTasks.set(task.id, task);

    try {
      // Try to find a peer
      const peers = this.discovery.getAvailablePeers();

      if (peers.length === 0) {
        // No peers — execute locally
        const result = await this.scheduler.executeLocal(task);
        this.taskResults.set(task.id, result);
        return result;
      }

      // Distribute if task has multiple files
      if (task.files && task.files.length > 1 && peers.length > 0) {
        const result = await this.scheduler.executeDistributed(task);
        this.taskResults.set(task.id, result);
        return result;
      }

      // Schedule to best peer
      const bestPeer = await this.scheduler.schedule(task);
      try {
        const handle = await this.transport.sendTask(bestPeer, task);
        const result: MeshResult = {
          taskId: handle.taskId,
          status: handle.status === "running" ? "completed" : handle.status,
          output: `Delegated to ${handle.assignedTo}`,
          durationMs: 0,
          fromNode: handle.assignedTo,
        };
        this.taskResults.set(task.id, result);
        return result;
      } catch (err) {
        // Peer failed — fallback to local
        log.debug("mesh-node", `Peer ${bestPeer.nodeId} failed, falling back to local: ${err}`);
        const result = await this.scheduler.executeLocal(task);
        this.taskResults.set(task.id, result);
        return result;
      }
    } finally {
      this.activeTasks.delete(task.id);
    }
  }

  // ─── Incoming Task/Result Handling ─────────────────────────────

  private async handleIncomingTask(task: MeshTask): Promise<MeshTaskHandle> {
    if (this.activeTasks.size >= this.settings.maxConcurrentTasks) {
      throw new Error("Node is at capacity");
    }

    this.activeTasks.set(task.id, task);

    // Execute asynchronously — return handle immediately
    const handle: MeshTaskHandle = {
      taskId: task.id,
      assignedTo: this.nodeId,
      status: "running",
      submittedAt: Date.now(),
    };

    // Fire and forget — result will be sent back when done
    this.scheduler.executeLocal(task).then(
      (result) => {
        this.taskResults.set(task.id, result);
        this.activeTasks.delete(task.id);
      },
      (err) => {
        const result: MeshResult = {
          taskId: task.id,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          durationMs: 0,
          fromNode: this.nodeId,
        };
        this.taskResults.set(task.id, result);
        this.activeTasks.delete(task.id);
      },
    );

    return handle;
  }

  private async handleIncomingResult(result: MeshResult): Promise<void> {
    this.taskResults.set(result.taskId, result);
    this.activeTasks.delete(result.taskId);
    log.debug(
      "mesh-node",
      `Received result for task ${result.taskId} from ${result.fromNode}: ${result.status}`,
    );
  }

  // ─── Status / Info ────────────────────────────────────────────

  get status(): MeshNodeStatus {
    return this._status;
  }

  get error(): string | null {
    return this._error;
  }

  get teamToken(): string | null {
    return this.settings.teamToken;
  }

  /**
   * Build the PeerInfo descriptor for the local node.
   */
  getLocalPeerInfo(): PeerInfo {
    return {
      nodeId: this.nodeId,
      hostname: this.hostname,
      ip: "127.0.0.1",
      port: this.settings.port,
      capabilities: { ...this.capabilities },
      status: this._status === "running" ? "online" : "offline",
      lastSeen: Date.now(),
    };
  }

  /**
   * Update this node's capabilities (e.g., after detecting new hardware).
   */
  updateCapabilities(caps: Partial<PeerCapabilities>): void {
    Object.assign(this.capabilities, caps);
  }

  /**
   * Get current active task count.
   */
  get activeTaskCount(): number {
    return this.activeTasks.size;
  }

  /**
   * Get result for a specific task.
   */
  getTaskResult(taskId: string): MeshResult | undefined {
    return this.taskResults.get(taskId);
  }

  /**
   * Get all known peers (from discovery).
   */
  getPeers(): PeerInfo[] {
    return this.discovery.getAllPeers();
  }

  /**
   * Get available (online) peers.
   */
  getAvailablePeers(): PeerInfo[] {
    return this.discovery.getAvailablePeers();
  }

  /**
   * Manually add a peer.
   */
  addPeer(info: PeerInfo): void {
    this.discovery.updatePeer(info);
  }

  /**
   * Join a team by setting the team token.
   */
  joinTeam(teamToken: string): void {
    this.settings.teamToken = teamToken;
    this.transport["config"].teamToken = teamToken;
  }

  /**
   * Generate a new team token and set it on this node.
   */
  initTeam(): string {
    const token = generateTeamToken();
    this.settings.teamToken = token;
    this.transport["config"].teamToken = token;
    return token;
  }

  private getHostname(): string {
    try {
      return require("node:os").hostname();
    } catch {
      return "unknown";
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────

let _meshNode: MeshNode | null = null;

/**
 * Get or create the global mesh node singleton.
 */
export function getMeshNode(config?: MeshNodeConfig): MeshNode {
  if (!_meshNode) {
    _meshNode = new MeshNode(config);
  }
  return _meshNode;
}

/**
 * Shut down the global mesh node.
 */
export async function shutdownMeshNode(): Promise<void> {
  if (_meshNode) {
    await _meshNode.stop();
    _meshNode = null;
  }
}

/** Reset the singleton (for tests). */
export function _resetMeshNode(): void {
  _meshNode = null;
}
