// KCode Bridge/Daemon Mode - WebSocket Server
// Bun-native WebSocket server for bidirectional daemon communication.

import type { Server, ServerWebSocket } from "bun";
import { log } from "../core/logger";
import type { PermissionBridge } from "./permission-bridge";
import { createMessage, isClientMessageType, parseMessage, serializeMessage } from "./protocol";
import type { SessionManager } from "./session-manager";
import type {
  BridgeMessage,
  PermissionRequestMessage,
  PermissionResponseMessage,
  PongMessage,
  SessionCancelMessage,
  SessionCreatedMessage,
  SessionCreateMessage,
  SessionDestroyMessage,
  SessionDoneMessage,
  SessionErrorMessage,
  SessionMessageMessage,
  ShutdownMessage,
} from "./types";

// ─── Constants ──────────────────────────────────────────────────

const MAX_CONNECTIONS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_MESSAGES = 100;

// ─── Client State ───────────────────────────────────────────────

interface ClientState {
  authenticated: boolean;
  subscribedSessions: Set<string>;
  messageTimestamps: number[];
  remoteAddress: string;
}

// ─── WebSocket Server ───────────────────────────────────────────

export class BridgeWebSocketServer {
  private server: Server | null = null;
  private clients = new Map<ServerWebSocket<ClientState>, ClientState>();
  private token: string;
  private sessionManager: SessionManager;
  private permissionBridge: PermissionBridge;
  private messageHandler:
    | ((ws: ServerWebSocket<ClientState>, msg: BridgeMessage) => Promise<void>)
    | null = null;

  constructor(opts: {
    token: string;
    sessionManager: SessionManager;
    permissionBridge: PermissionBridge;
  }) {
    this.token = opts.token;
    this.sessionManager = opts.sessionManager;
    this.permissionBridge = opts.permissionBridge;

    // Wire up permission bridge broadcast
    this.permissionBridge.setBroadcast((sessionId, msg) => {
      this.broadcastToSession(sessionId, msg);
    });
  }

  /**
   * Start the WebSocket server.
   */
  start(port: number, hostname: string = "127.0.0.1"): Server {
    const self = this;

    this.server = Bun.serve<ClientState>({
      port,
      hostname,

      fetch(req, server) {
        const url = new URL(req.url);

        // Health endpoint
        if (url.pathname === "/health") {
          return new Response(
            JSON.stringify({
              status: "ok",
              sessions: self.sessionManager.sessionCount,
              clients: self.clients.size,
              uptime: process.uptime(),
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }

        // WebSocket upgrade
        if (url.pathname === "/ws" || url.pathname === "/") {
          // Check connection limit
          if (self.clients.size >= MAX_CONNECTIONS) {
            return new Response("Too many connections", { status: 503 });
          }

          // Check auth token
          const authHeader = req.headers.get("authorization") ?? "";
          const token = authHeader.startsWith("Bearer ")
            ? authHeader.slice(7)
            : (url.searchParams.get("token") ?? "");

          if (token !== self.token) {
            return new Response("Unauthorized", { status: 401 });
          }

          const upgraded = server.upgrade(req, {
            data: {
              authenticated: true,
              subscribedSessions: new Set<string>(),
              messageTimestamps: [],
              remoteAddress: req.headers.get("x-forwarded-for") ?? "unknown",
            } satisfies ClientState,
          });

          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 400 });
          }
          return undefined;
        }

        return new Response("Not Found", { status: 404 });
      },

      websocket: {
        open(ws) {
          self.clients.set(ws, ws.data);
          log.info("ws-server", `Client connected (total: ${self.clients.size})`);
        },

        async message(ws, message) {
          const state = ws.data;
          if (!state.authenticated) {
            ws.close(4001, "Unauthorized");
            return;
          }

          // Rate limiting
          const now = Date.now();
          state.messageTimestamps = state.messageTimestamps.filter(
            (t) => now - t < RATE_LIMIT_WINDOW_MS,
          );
          if (state.messageTimestamps.length >= RATE_LIMIT_MAX_MESSAGES) {
            const errorMsg = createMessage<SessionErrorMessage>("session.error", {
              sessionId: "",
              error: "Rate limit exceeded (100 messages/minute)",
              fatal: false,
            });
            ws.send(serializeMessage(errorMsg));
            return;
          }
          state.messageTimestamps.push(now);

          // Parse message
          let parsed: BridgeMessage;
          try {
            const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
            parsed = parseMessage(raw);
          } catch (err) {
            const errorMsg = createMessage<SessionErrorMessage>("session.error", {
              sessionId: "",
              error: `Invalid message: ${err instanceof Error ? err.message : String(err)}`,
              fatal: false,
            });
            ws.send(serializeMessage(errorMsg));
            return;
          }

          // Route message
          try {
            await self.handleMessage(ws, parsed);
          } catch (err) {
            log.error("ws-server", `Error handling message: ${err}`);
            const errorMsg = createMessage<SessionErrorMessage>("session.error", {
              sessionId: parsed.sessionId ?? "",
              error: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
              fatal: false,
            });
            ws.send(serializeMessage(errorMsg));
          }
        },

        close(ws) {
          const state = ws.data;
          // Unsubscribe from all sessions
          for (const sessionId of state.subscribedSessions) {
            self.sessionManager.adjustClientCount(sessionId, -1);
          }
          self.clients.delete(ws);
          log.info("ws-server", `Client disconnected (total: ${self.clients.size})`);
        },
      },
    });

    log.info("ws-server", `WebSocket server listening on ${hostname}:${port}`);
    return this.server;
  }

  /**
   * Set an external message handler for extensibility.
   */
  onMessage(
    handler: (ws: ServerWebSocket<ClientState>, msg: BridgeMessage) => Promise<void>,
  ): void {
    this.messageHandler = handler;
  }

  /**
   * Handle a parsed message from a client.
   */
  private async handleMessage(ws: ServerWebSocket<ClientState>, msg: BridgeMessage): Promise<void> {
    const state = ws.data;

    switch (msg.type) {
      case "ping": {
        const pong = createMessage<PongMessage>("pong", {});
        ws.send(serializeMessage(pong));
        break;
      }

      case "session.create": {
        const createMsg = msg as SessionCreateMessage;
        try {
          const sessionId = this.sessionManager.createSession({
            dir: createMsg.dir,
            spawnMode: createMsg.spawnMode,
            model: createMsg.model,
          });

          // Auto-subscribe the creator to the session
          state.subscribedSessions.add(sessionId);
          this.sessionManager.adjustClientCount(sessionId, 1);

          const reply = createMessage<SessionCreatedMessage>("session.created", {
            sessionId,
            dir: createMsg.dir,
            model: createMsg.model ?? "default",
          });
          ws.send(serializeMessage(reply));
        } catch (err) {
          const errorMsg = createMessage<SessionErrorMessage>("session.error", {
            sessionId: "",
            error: err instanceof Error ? err.message : String(err),
            fatal: false,
          });
          ws.send(serializeMessage(errorMsg));
        }
        break;
      }

      case "session.message": {
        const sessionMsg = msg as SessionMessageMessage;
        if (!this.sessionManager.hasSession(sessionMsg.sessionId)) {
          const errorMsg = createMessage<SessionErrorMessage>("session.error", {
            sessionId: sessionMsg.sessionId,
            error: "Session not found",
            fatal: false,
          });
          ws.send(serializeMessage(errorMsg));
          break;
        }

        this.sessionManager.touchSession(sessionMsg.sessionId);
        this.sessionManager.setStatus(sessionMsg.sessionId, "responding");

        // Subscribe if not already
        if (!state.subscribedSessions.has(sessionMsg.sessionId)) {
          state.subscribedSessions.add(sessionMsg.sessionId);
          this.sessionManager.adjustClientCount(sessionMsg.sessionId, 1);
        }

        // Delegate to external handler if set
        if (this.messageHandler) {
          await this.messageHandler(ws, msg);
        }
        break;
      }

      case "session.cancel": {
        const cancelMsg = msg as SessionCancelMessage;
        if (this.sessionManager.hasSession(cancelMsg.sessionId)) {
          this.sessionManager.setStatus(cancelMsg.sessionId, "idle");
          if (this.messageHandler) {
            await this.messageHandler(ws, msg);
          }
        }
        break;
      }

      case "session.destroy": {
        const destroyMsg = msg as SessionDestroyMessage;
        // Unsubscribe all clients from this session
        for (const [client, clientState] of this.clients) {
          if (clientState.subscribedSessions.has(destroyMsg.sessionId)) {
            clientState.subscribedSessions.delete(destroyMsg.sessionId);
          }
        }
        await this.sessionManager.destroySession(destroyMsg.sessionId);

        const done = createMessage<SessionDoneMessage>("session.done", {
          sessionId: destroyMsg.sessionId,
          reason: "destroyed by client",
        });
        ws.send(serializeMessage(done));
        break;
      }

      case "permission.response": {
        const permMsg = msg as PermissionResponseMessage;
        this.permissionBridge.handleResponse(permMsg);
        break;
      }

      default: {
        if (this.messageHandler) {
          await this.messageHandler(ws, msg);
        } else {
          log.warn("ws-server", `Unhandled message type: ${msg.type}`);
        }
      }
    }
  }

  /**
   * Broadcast a message to all clients subscribed to a session.
   */
  broadcastToSession(sessionId: string, msg: BridgeMessage): void {
    const data = serializeMessage(msg);
    for (const [ws, state] of this.clients) {
      if (state.subscribedSessions.has(sessionId)) {
        try {
          ws.send(data);
        } catch (err) {
          log.error("ws-server", `Failed to send to client: ${err}`);
        }
      }
    }
  }

  /**
   * Broadcast a message to ALL connected clients (e.g., shutdown notice).
   */
  broadcastAll(msg: BridgeMessage): void {
    const data = serializeMessage(msg);
    for (const [ws] of this.clients) {
      try {
        ws.send(data);
      } catch (err) {
        log.error("ws-server", `Failed to broadcast to client: ${err}`);
      }
    }
  }

  /**
   * Get the current number of connected clients.
   */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Stop the WebSocket server.
   */
  stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
    this.clients.clear();
    log.info("ws-server", "WebSocket server stopped");
  }
}
