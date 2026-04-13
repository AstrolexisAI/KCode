// KCode - Web UI Server
// HTTP + WebSocket server using Bun.serve for browser-based UI

import { timingSafeEqual } from "node:crypto";
import { extname, join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { log } from "../core/logger";

/**
 * Constant-time comparison of two auth tokens. Prevents timing
 * side-channel attacks that could recover a token character by
 * character. Both inputs are normalized to equal-length Buffers
 * before comparison, since timingSafeEqual throws on length mismatch.
 */
function timingSafeTokenEqual(supplied: string | null | undefined, expected: string): boolean {
  const a = Buffer.from(supplied ?? "");
  const b = Buffer.from(expected ?? "");
  if (a.length !== b.length) {
    // Still perform a fake comparison to equalize timing as much as possible.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
import { handleApiRequest } from "./api";
import type { ServerEvent, WebServerConfig } from "./types";
import { DEFAULT_WEB_CONFIG, MIME_TYPES } from "./types";
import { handleClientMessage, setSessionContext } from "./ws-handler";

// ─── Types ──────────────────────────────────────────────────────

interface WebSocketData {
  token: string;
  connectedAt: number;
}

// ─── Web Server ─────────────────────────────────────────────────

export class WebServer {
  private server: Server | null = null;
  private config: WebServerConfig;
  private connections = new Set<ServerWebSocket<WebSocketData>>();
  private staticDir: string;

  constructor(config?: Partial<WebServerConfig>) {
    this.config = { ...DEFAULT_WEB_CONFIG, ...config };
    if (config?.auth) {
      this.config.auth = { ...DEFAULT_WEB_CONFIG.auth, ...config.auth };
    }
    this.staticDir = join(import.meta.dir, "static");
  }

  /** Start the HTTP + WebSocket server */
  async start(): Promise<{ url: string; token: string }> {
    if (this.server) {
      throw new Error("Web server is already running");
    }

    const self = this;
    const config = this.config;

    this.server = Bun.serve<WebSocketData>({
      port: config.port,
      hostname: config.host,

      async fetch(req, server) {
        const url = new URL(req.url);
        const pathname = url.pathname;

        // CORS preflight
        if (req.method === "OPTIONS" && config.cors) {
          return new Response(null, {
            status: 204,
            headers: self.corsHeaders(),
          });
        }

        // WebSocket upgrade on /ws
        if (pathname === "/ws") {
          const token = url.searchParams.get("token") ?? req.headers.get("x-auth-token");
          if (config.auth.enabled && !timingSafeTokenEqual(token, config.auth.token)) {
            return new Response("Unauthorized", { status: 401 });
          }
          const upgraded = server.upgrade(req, {
            data: { token: token ?? "", connectedAt: Date.now() },
          });
          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 500 });
          }
          return undefined as unknown as Response;
        }

        // REST API routes
        if (pathname.startsWith("/api/v1/")) {
          // Auth check for API routes
          if (config.auth.enabled) {
            const authHeader = req.headers.get("authorization");
            const queryToken = url.searchParams.get("token");
            const validToken =
              authHeader === `Bearer ${config.auth.token}` || queryToken === config.auth.token;
            if (!validToken) {
              return Response.json({ error: "Unauthorized" }, { status: 401 });
            }
          }

          const response = await handleApiRequest(req, pathname);
          if (config.cors) {
            // Clone headers and add CORS
            const headers = new Headers(response.headers);
            for (const [k, v] of Object.entries(self.corsHeaders())) {
              headers.set(k, v);
            }
            return new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          }
          return response;
        }

        // Static file serving
        return self.serveStatic(pathname);
      },

      websocket: {
        open(ws) {
          self.connections.add(ws);
          log.info("web", `WebSocket connected (total: ${self.connections.size})`);

          // Send initial connected event
          const ctx = setSessionContext();
          const event: ServerEvent = {
            type: "connected",
            sessionId: ctx.sessionId,
            model: ctx.model,
          };
          ws.send(JSON.stringify(event));
        },

        message(ws, message) {
          const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
          handleClientMessage(ws, raw, (evt) => self.broadcast(evt));
        },

        close(ws) {
          self.connections.delete(ws);
          log.info("web", `WebSocket disconnected (total: ${self.connections.size})`);
        },

        drain(ws) {
          // Backpressure relief — no action needed
        },
      },
    });

    const baseUrl = `http://${config.host}:${config.port}`;
    const uiUrl = `${baseUrl}?token=${config.auth.token}`;

    log.info("web", `Web UI server started at ${baseUrl}`);
    log.info("web", `Auth token: ${config.auth.token}`);

    // Auto-open browser
    if (config.openBrowser) {
      this.openBrowser(uiUrl);
    }

    return { url: baseUrl, token: config.auth.token };
  }

  /** Stop the server */
  stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
      this.connections.clear();
      log.info("web", "Web UI server stopped");
    }
  }

  /** Broadcast a server event to all connected WebSocket clients */
  broadcast(event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const ws of this.connections) {
      try {
        ws.send(data);
      } catch {
        // Connection might be stale
        this.connections.delete(ws);
      }
    }
  }

  /** Get the number of active connections */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Whether the server is running */
  get isRunning(): boolean {
    return this.server !== null;
  }

  /** Get the current config */
  getConfig(): WebServerConfig {
    return { ...this.config };
  }

  // ─── Private ──────────────────────────────────────────────────

  /** Serve static files from the static/ directory */
  private async serveStatic(pathname: string): Promise<Response> {
    // Default to index.html
    if (pathname === "/" || pathname === "") {
      pathname = "/index.html";
    }

    // Prevent path traversal
    const normalized = pathname.replace(/\.\./g, "").replace(/\/+/g, "/");
    const filePath = join(this.staticDir, normalized);

    // Ensure resolved path is within static dir
    if (!filePath.startsWith(this.staticDir)) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) {
      // SPA fallback: serve index.html for unknown paths
      const indexFile = Bun.file(join(this.staticDir, "index.html"));
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    return new Response(file, {
      headers: {
        "content-type": contentType,
        "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      },
    });
  }

  /** Open browser on supported platforms */
  private openBrowser(url: string): void {
    try {
      const proc = Bun.spawn(
        process.platform === "darwin"
          ? ["open", url]
          : process.platform === "win32"
            ? ["cmd", "/c", "start", url]
            : ["xdg-open", url],
        { stdout: "ignore", stderr: "ignore" },
      );
      // Don't wait for the browser process
      proc.unref();
    } catch {
      log.debug("web", "Failed to auto-open browser");
    }
  }

  /** Generate CORS and security headers */
  private corsHeaders(req?: Request): Record<string, string> {
    let allowedOrigin = "*";
    if (req) {
      const origin = req.headers.get("Origin");
      if (
        origin &&
        /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(origin)
      ) {
        allowedOrigin = origin;
      } else if (origin) {
        allowedOrigin = "";
      }
    }
    return {
      ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Auth-Token",
      "Access-Control-Max-Age": "86400",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'",
      "X-XSS-Protection": "0",
    };
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let webServer: WebServer | null = null;

export function getWebServer(): WebServer | null {
  return webServer;
}

export async function startWebServer(
  config?: Partial<WebServerConfig>,
): Promise<{ url: string; token: string }> {
  if (webServer?.isRunning) {
    return {
      url: `http://${webServer.getConfig().host}:${webServer.getConfig().port}`,
      token: webServer.getConfig().auth.token,
    };
  }
  webServer = new WebServer(config);
  return webServer.start();
}

export function stopWebServer(): void {
  webServer?.stop();
  webServer = null;
}

export function broadcastEvent(event: ServerEvent): void {
  webServer?.broadcast(event);
}
