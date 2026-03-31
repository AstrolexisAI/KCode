/**
 * Remote Session manager for KCode Remote Mode.
 * Orchestrates the three remote operating modes:
 *   Mode 1 (execution): Full remote KCode agent via SSH tunnel + WebSocket
 *   Mode 2 (sync): Local KCode with remote Bash execution + file sync
 *   Mode 3 (viewer): Read-only subscriber to a remote session
 *
 * Handles session lifecycle, reconnection logic, and cleanup.
 */

import { randomUUID } from "node:crypto";
import type {
  RemoteConfig,
  RemoteMode,
  RemoteSessionInfo,
  RemoteAgentInfo,
  TunnelInfo,
} from "./types";
import {
  checkConnectivity,
  checkKCodeInstalled,
  startRemoteAgent,
  createTunnel,
  executeRemote,
  reconnect,
  DEFAULT_RECONNECT,
} from "./ssh-transport";
import {
  initialSync,
  syncChanges,
  startWatcher,
  startRemoteWatcher,
} from "./file-sync";
import {
  RemotePermissionBridge,
  type PermissionPromptFn,
} from "./remote-permission";

/** Events emitted by a remote session */
export type RemoteSessionEvent =
  | { type: "connecting" }
  | { type: "connected"; sessionId: string }
  | { type: "disconnected"; reason: string }
  | { type: "reconnecting"; attempt: number; maxAttempts: number }
  | { type: "reconnected" }
  | { type: "error"; error: string }
  | { type: "message"; data: unknown }
  | { type: "sync-started"; files: string[] }
  | { type: "sync-completed"; files: string[] }
  | { type: "sync-conflict"; path: string; resolution: string }
  | { type: "session-ended" };

/** Callback for session events */
export type SessionEventHandler = (event: RemoteSessionEvent) => void;

/** Options for creating a remote session */
export interface RemoteSessionOptions {
  config: RemoteConfig;
  mode: RemoteMode;
  localDir: string;
  sessionId?: string;
  onEvent?: SessionEventHandler;
  permissionPrompt?: PermissionPromptFn;
}

/** Internal state of the remote session */
interface SessionState {
  id: string;
  mode: RemoteMode;
  status: "connecting" | "connected" | "reconnecting" | "disconnected" | "terminated";
  agentInfo?: RemoteAgentInfo;
  tunnel?: TunnelInfo;
  ws?: WebSocket;
  localWatcher?: { stop: () => void };
  remoteWatcher?: { stop: () => void };
  permissionBridge?: RemotePermissionBridge;
}

/**
 * Remote Session class.
 * Main entry point for establishing and managing a remote KCode session.
 */
export class RemoteSession {
  private config: RemoteConfig;
  private localDir: string;
  private state: SessionState;
  private onEvent: SessionEventHandler;
  private permissionPrompt?: PermissionPromptFn;

  constructor(options: RemoteSessionOptions) {
    this.config = options.config;
    this.localDir = options.localDir;
    this.onEvent = options.onEvent ?? (() => {});
    this.permissionPrompt = options.permissionPrompt;

    this.state = {
      id: options.sessionId ?? randomUUID(),
      mode: options.mode,
      status: "disconnected",
    };
  }

  /** Get the session ID */
  get sessionId(): string {
    return this.state.id;
  }

  /** Get current session status */
  get status(): SessionState["status"] {
    return this.state.status;
  }

  /** Get session info */
  get info(): RemoteSessionInfo {
    return {
      id: this.state.id,
      host: this.config.host,
      dir: this.config.remoteDir,
      status: this.state.status === "connecting" || this.state.status === "reconnecting"
        ? "active"
        : this.state.status === "connected"
          ? "active"
          : this.state.status === "terminated"
            ? "terminated"
            : "disconnected",
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Start the remote session.
   * Dispatches to the appropriate mode handler.
   */
  async connect(): Promise<void> {
    this.state.status = "connecting";
    this.emit({ type: "connecting" });

    // Verify SSH connectivity
    if (!checkConnectivity(this.config.host)) {
      this.state.status = "disconnected";
      throw new Error(
        `Cannot connect to ${this.config.host}. Check SSH configuration, keys, and ssh-agent.`,
      );
    }

    switch (this.state.mode) {
      case "execution":
        await this.startExecutionMode();
        break;
      case "sync":
        await this.startSyncMode();
        break;
      case "viewer":
        await this.startViewerMode();
        break;
    }
  }

  /**
   * Mode 1: Remote Execution.
   * Start agent on remote -> create tunnel -> connect WebSocket.
   */
  private async startExecutionMode(): Promise<void> {
    // Check KCode is installed on remote
    const { installed } = checkKCodeInstalled(this.config.host);
    if (!installed) {
      throw new Error(
        `KCode is not installed on ${this.config.host}. ` +
        `Install with: kcode remote install ${this.config.host}`,
      );
    }

    // Start remote agent
    this.state.agentInfo = await startRemoteAgent(
      this.config.host,
      this.config.remoteDir,
    );

    // Create SSH tunnel
    this.state.tunnel = await createTunnel(
      this.config.host,
      this.state.agentInfo.port,
    );

    // Set up permission bridge
    if (this.permissionPrompt) {
      this.state.permissionBridge = new RemotePermissionBridge(this.permissionPrompt);
    }

    // Connect WebSocket
    await this.connectWebSocket(this.state.tunnel.localPort, this.state.agentInfo.token);

    this.state.status = "connected";
    this.emit({ type: "connected", sessionId: this.state.id });
  }

  /**
   * Mode 2: Local-Remote Hybrid (Sync).
   * Local KCode + file sync + remote Bash via SSH.
   */
  private async startSyncMode(): Promise<void> {
    // Perform initial sync
    this.emit({ type: "sync-started", files: ["*"] });
    const syncResult = await initialSync(
      this.localDir,
      this.config.host,
      this.config.remoteDir,
      this.config.syncExclude,
    );

    if (!syncResult.success) {
      throw new Error(`Initial sync failed: ${syncResult.error}`);
    }
    this.emit({ type: "sync-completed", files: ["*"] });

    // Start local file watcher for local->remote sync
    if (this.config.syncOnSave) {
      this.state.localWatcher = startWatcher(
        this.localDir,
        async (files) => {
          this.emit({ type: "sync-started", files });
          await syncChanges(files, this.localDir, this.config.host, this.config.remoteDir);
          this.emit({ type: "sync-completed", files });
        },
        500,
      );
    }

    // Start remote file watcher for remote->local sync
    this.state.remoteWatcher = startRemoteWatcher(
      this.config.host,
      this.config.remoteDir,
      async (files) => {
        this.emit({ type: "sync-started", files });
        // Import dynamically to avoid circular dependency
        const { syncFromRemote } = await import("./file-sync");
        await syncFromRemote(files, this.localDir, this.config.host, this.config.remoteDir);
        this.emit({ type: "sync-completed", files });
      },
    );

    // Set up permission bridge
    if (this.permissionPrompt) {
      this.state.permissionBridge = new RemotePermissionBridge(this.permissionPrompt);
    }

    this.state.status = "connected";
    this.emit({ type: "connected", sessionId: this.state.id });
  }

  /**
   * Mode 3: Viewer.
   * Subscribe to a remote session in read-only mode.
   */
  private async startViewerMode(): Promise<void> {
    // For viewer mode, we connect to an existing agent session
    // We need the agent info (port/token) from the remote
    const result = await executeRemote(
      this.config.host,
      ["kcode", "sessions", "--json"],
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list remote sessions: ${result.stderr}`);
    }

    let sessions: Array<{ id: string; port: number; token: string }>;
    try {
      sessions = JSON.parse(result.stdout);
    } catch {
      throw new Error("Failed to parse remote session list");
    }

    const target = sessions.find((s) => s.id === this.state.id);
    if (!target) {
      throw new Error(
        `Session ${this.state.id} not found on ${this.config.host}. ` +
        `Use 'kcode remote sessions ${this.config.host}' to list available sessions.`,
      );
    }

    // Create tunnel to the remote agent
    this.state.tunnel = await createTunnel(this.config.host, target.port);
    this.state.agentInfo = { port: target.port, token: target.token };

    // Connect WebSocket in viewer mode
    await this.connectWebSocket(this.state.tunnel.localPort, target.token, true);

    this.state.status = "connected";
    this.emit({ type: "connected", sessionId: this.state.id });
  }

  /**
   * Connect a WebSocket to the tunneled local port.
   */
  private async connectWebSocket(
    localPort: number,
    token: string,
    viewerMode: boolean = false,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = `ws://127.0.0.1:${localPort}`;
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      } as unknown as string[]);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket connection timed out"));
      }, 15_000);

      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        this.state.ws = ws;

        // If viewer mode, send subscription message
        if (viewerMode) {
          ws.send(JSON.stringify({
            type: "session.subscribe",
            sessionId: this.state.id,
            mode: "viewer",
          }));
        }

        resolve();
      });

      ws.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(String(event.data));
          this.handleRemoteMessage(data);
        } catch {
          // Non-JSON message, ignore
        }
      });

      ws.addEventListener("close", () => {
        clearTimeout(timeout);
        if (this.state.status === "connected") {
          this.handleDisconnection();
        }
      });

      ws.addEventListener("error", (event) => {
        clearTimeout(timeout);
        if (this.state.status === "connecting") {
          reject(new Error(`WebSocket error: ${event}`));
        }
      });
    });
  }

  /**
   * Handle a message from the remote agent.
   */
  private handleRemoteMessage(data: Record<string, unknown>): void {
    // Handle permission requests
    if (data.type === "permission.request" && this.state.permissionBridge) {
      this.state.permissionBridge
        .handleRequest(data as unknown as import("./remote-permission").PermissionRequest)
        .then((result) => {
          if (this.state.ws && this.state.ws.readyState === WebSocket.OPEN) {
            this.state.ws.send(JSON.stringify({
              type: "permission.response",
              ...result,
            }));
          }
        });
      return;
    }

    // Forward other messages as events
    this.emit({ type: "message", data });
  }

  /**
   * Handle a disconnection event.
   * Attempts reconnection with retry logic.
   */
  private async handleDisconnection(): Promise<void> {
    this.state.status = "reconnecting";
    this.emit({ type: "disconnected", reason: "Connection lost" });

    const success = await reconnect(
      this.config.host,
      DEFAULT_RECONNECT,
      (attempt, max) => {
        this.emit({ type: "reconnecting", attempt, maxAttempts: max });
      },
    );

    if (success) {
      try {
        // Re-establish tunnel and WebSocket
        if (this.state.agentInfo) {
          this.state.tunnel?.process.kill();
          this.state.tunnel = await createTunnel(
            this.config.host,
            this.state.agentInfo.port,
          );
          await this.connectWebSocket(
            this.state.tunnel.localPort,
            this.state.agentInfo.token,
            this.state.mode === "viewer",
          );
          this.state.status = "connected";
          this.emit({ type: "reconnected" });
        }
      } catch (err) {
        this.state.status = "disconnected";
        this.emit({
          type: "error",
          error: `Reconnection failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      this.state.status = "disconnected";
      this.emit({
        type: "error",
        error:
          `Could not reconnect after ${DEFAULT_RECONNECT.maxAttempts} attempts. ` +
          `The remote session may still be active. ` +
          `Reconnect with: kcode remote resume ${this.config.host} --session ${this.state.id}`,
      });
    }
  }

  /**
   * Send a message to the remote agent (execution and sync modes only).
   * Viewer mode does not allow sending.
   */
  send(message: unknown): void {
    if (this.state.mode === "viewer") {
      throw new Error("Cannot send messages in viewer mode");
    }
    if (!this.state.ws || this.state.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to remote agent");
    }
    this.state.ws.send(JSON.stringify(message));
  }

  /**
   * Execute a command on the remote host (for sync mode).
   * Returns the command output.
   */
  async executeRemoteCommand(command: string[]): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    if (this.state.mode !== "sync") {
      throw new Error("Remote command execution is only available in sync mode");
    }
    return executeRemote(this.config.host, command, this.config.remoteDir);
  }

  /**
   * List sessions on the remote host.
   */
  static async listSessions(host: string): Promise<RemoteSessionInfo[]> {
    const result = await executeRemote(host, ["kcode", "sessions", "--json"]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to list sessions: ${result.stderr}`);
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return [];
    }
  }

  /**
   * Disconnect and clean up the session.
   * Kills tunnel, watchers, and optionally the remote agent.
   *
   * @param killRemoteAgent Whether to terminate the remote agent too (default false)
   */
  async disconnect(killRemoteAgent: boolean = false): Promise<void> {
    this.state.status = "terminated";

    // Cancel pending permission requests
    this.state.permissionBridge?.cancelAll();

    // Close WebSocket
    if (this.state.ws) {
      try {
        if (this.state.ws.readyState === WebSocket.OPEN) {
          this.state.ws.send(JSON.stringify({ type: "session.cancel" }));
          this.state.ws.close();
        }
      } catch {
        // Best effort
      }
      this.state.ws = undefined;
    }

    // Kill SSH tunnel
    if (this.state.tunnel) {
      try {
        this.state.tunnel.process.kill();
      } catch {
        // Best effort
      }
      this.state.tunnel = undefined;
    }

    // Stop file watchers
    if (this.state.localWatcher) {
      this.state.localWatcher.stop();
      this.state.localWatcher = undefined;
    }
    if (this.state.remoteWatcher) {
      this.state.remoteWatcher.stop();
      this.state.remoteWatcher = undefined;
    }

    // Optionally kill remote agent
    if (killRemoteAgent && this.state.agentInfo) {
      try {
        await executeRemote(this.config.host, [
          "kcode", "serve", "--stop", "--port", String(this.state.agentInfo.port),
        ]);
      } catch {
        // Best effort
      }
    }

    this.emit({ type: "session-ended" });
  }

  /**
   * Emit a session event.
   */
  private emit(event: RemoteSessionEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Don't let event handler errors break the session
    }
  }
}
