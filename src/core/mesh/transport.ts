// KCode - P2P Agent Mesh Transport
// HTTP-based transport layer for mesh communication between nodes.
// Uses Bun.serve with team-token authentication.

import { log } from "../logger";
import { buildAuthHeaders, verifyPeerToken } from "./security";
import type { MeshResult, MeshTask, MeshTaskHandle, PeerInfo, TransportConfig } from "./types";
import { DEFAULT_TRANSPORT_CONFIG } from "./types";

// ─── Types ─────────────────────────────────────────────────────

export type RequestHandler = (req: Request) => Promise<Response> | Response;

export interface TransportEventHandlers {
  onTask?: (task: MeshTask) => Promise<MeshTaskHandle>;
  onResult?: (result: MeshResult) => Promise<void>;
  onCapabilities?: () => PeerInfo;
}

// ─── MeshTransport ─────────────────────────────────────────────

export class MeshTransport {
  private config: TransportConfig;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private handlers: TransportEventHandlers;
  private _running = false;

  constructor(config: Partial<TransportConfig> = {}, handlers: TransportEventHandlers = {}) {
    this.config = { ...DEFAULT_TRANSPORT_CONFIG, ...config };
    this.handlers = handlers;
  }

  // ─── Server Lifecycle ─────────────────────────────────────────

  /**
   * Start the mesh transport server.
   * Listens for incoming task requests from peers.
   */
  async start(): Promise<void> {
    if (this._running) return;
    if (!this.config.teamToken) {
      throw new Error("Cannot start mesh transport without a team token");
    }

    this.server = Bun.serve({
      port: this.config.port,
      fetch: async (req) => this.handleRequest(req),
    });

    this._running = true;
    log.debug("mesh-transport", `Transport server started on port ${this.config.port}`);
  }

  /**
   * Stop the transport server.
   */
  stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
    this._running = false;
    log.debug("mesh-transport", "Transport server stopped");
  }

  get running(): boolean {
    return this._running;
  }

  get port(): number {
    return this.config.port;
  }

  // ─── Request Routing ──────────────────────────────────────────

  /**
   * Route incoming requests to the appropriate handler.
   * All requests must carry a valid X-Team-Token header.
   */
  async handleRequest(req: Request): Promise<Response> {
    // Authentication check
    if (!verifyPeerToken(req.headers, this.config.teamToken)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Size check
    const contentLength = parseInt(req.headers.get("Content-Length") ?? "0", 10);
    if (contentLength > this.config.messageMaxSize) {
      return new Response(JSON.stringify({ error: "Payload too large" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);

    try {
      switch (url.pathname) {
        case "/api/v1/health":
          return this.handleHealth();
        case "/api/v1/capabilities":
          return this.handleCapabilities();
        case "/api/v1/task":
          return await this.handleTask(req);
        case "/api/v1/result":
          return await this.handleResult(req);
        default:
          return new Response(JSON.stringify({ error: "Not Found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
      }
    } catch (err) {
      log.error("mesh-transport", `Request handler error: ${err}`);
      return new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ─── Endpoint Handlers ────────────────────────────────────────

  private handleHealth(): Response {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private handleCapabilities(): Response {
    if (!this.handlers.onCapabilities) {
      return new Response(JSON.stringify({ error: "Capabilities not configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const info = this.handlers.onCapabilities();
    return new Response(JSON.stringify(info), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleTask(req: Request): Promise<Response> {
    if (!this.handlers.onTask) {
      return new Response(JSON.stringify({ error: "Task handling not configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const task = (await req.json()) as MeshTask;
    if (!task.id || !task.type) {
      return new Response(JSON.stringify({ error: "Invalid task: missing id or type" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const handle = await this.handlers.onTask(task);
    return new Response(JSON.stringify(handle), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleResult(req: Request): Promise<Response> {
    if (!this.handlers.onResult) {
      return new Response(JSON.stringify({ error: "Result handling not configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = (await req.json()) as MeshResult;
    await this.handlers.onResult(result);
    return new Response(JSON.stringify({ acknowledged: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ─── Client Methods (outgoing requests) ───────────────────────

  /**
   * Send a task to a remote peer.
   */
  async sendTask(peer: PeerInfo, task: MeshTask): Promise<MeshTaskHandle> {
    const url = `http://${peer.ip}:${peer.port}/api/v1/task`;
    const body = JSON.stringify(task);

    if (body.length > this.config.messageMaxSize) {
      throw new Error(`Task payload exceeds max size (${this.config.messageMaxSize} bytes)`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), task.timeout || 30_000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildAuthHeaders(this.config.teamToken),
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Peer ${peer.nodeId} rejected task: HTTP ${response.status}`);
      }

      return (await response.json()) as MeshTaskHandle;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  /**
   * Send a result back to the originating peer.
   */
  async sendResult(peer: PeerInfo, result: MeshResult): Promise<void> {
    const url = `http://${peer.ip}:${peer.port}/api/v1/result`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildAuthHeaders(this.config.teamToken),
        body: JSON.stringify(result),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Failed to send result to ${peer.nodeId}: HTTP ${response.status}`);
      }
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  /**
   * Check if a peer is reachable by hitting the health endpoint.
   * Returns latency in ms, or -1 if unreachable.
   */
  async ping(peer: PeerInfo): Promise<number> {
    const url = `http://${peer.ip}:${peer.port}/api/v1/health`;
    const start = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const response = await fetch(url, {
        headers: buildAuthHeaders(this.config.teamToken),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) return -1;
      return Date.now() - start;
    } catch {
      clearTimeout(timeout);
      return -1;
    }
  }
}
