// KCode - Extension API
// Main API class with routing, middleware pipeline, and SSE streaming

import { ExtensionEventEmitter } from "./events";
import { getCorsHeaders } from "./middleware";
import { generateOpenAPISchema } from "./schema";
import type {
  ExtensionApiConfig,
  ExtensionEvent,
  HealthResponse,
  InfoResponse,
  Middleware,
} from "./types";
import { DEFAULT_EXTENSION_API_CONFIG } from "./types";

// ─── Helpers ───────────────────────────────────────────────────

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'self'",
  "X-XSS-Protection": "0",
};

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
  });
}

function jsonWithHeaders(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...headers },
  });
}

const VERSION = "1.7.0";
const API_PREFIX = "/api/ext/v1";

// ─── Extension API ─────────────────────────────────────────────

/**
 * Main Extension API class.
 * Provides an HTTP API for IDE integrations, plugins, and external tooling
 * to interact with a running KCode session.
 */
export class ExtensionAPI {
  private config: ExtensionApiConfig;
  private middlewares: Middleware[] = [];
  private emitter: ExtensionEventEmitter;
  private startTime: number;

  constructor(config?: Partial<ExtensionApiConfig>) {
    this.config = { ...DEFAULT_EXTENSION_API_CONFIG, ...config };
    this.emitter = new ExtensionEventEmitter();
    this.startTime = Date.now();
  }

  /**
   * Add a middleware to the pipeline.
   * Middlewares run in order; first one to return a Response short-circuits.
   */
  use(mw: Middleware): void {
    this.middlewares.push(mw);
  }

  /**
   * Get the event emitter for subscribing to extension events.
   */
  getEventEmitter(): ExtensionEventEmitter {
    return this.emitter;
  }

  /**
   * Main request handler. Runs middleware pipeline, then routes to endpoint.
   */
  async handle(req: Request): Promise<Response> {
    // Run middleware pipeline
    for (const mw of this.middlewares) {
      const result = await mw(req);
      if (result !== null) {
        return result;
      }
    }

    // Parse URL and route
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Strip API prefix
    let route = path;
    if (path.startsWith(API_PREFIX)) {
      route = path.slice(API_PREFIX.length) || "/";
    } else {
      return json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }

    // CORS headers for all responses
    const corsHeaders = getCorsHeaders(this.config.corsOrigins, req.headers.get("Origin"));

    try {
      const response = await this.route(method, route, req);
      // Merge CORS headers into response
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
      }
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      return jsonWithHeaders({ error: message, code: "INTERNAL_ERROR" }, 500, corsHeaders);
    }
  }

  // ─── Router ────────────────────────────────────────────────

  private async route(method: string, path: string, req: Request): Promise<Response> {
    // Health
    if (method === "GET" && path === "/health") {
      return this.handleHealth();
    }

    // Info
    if (method === "GET" && path === "/info") {
      return this.handleInfo();
    }

    // OpenAPI schema
    if (method === "GET" && path === "/openapi.json") {
      return this.handleOpenAPI();
    }

    // Messages
    if (method === "GET" && path === "/messages") {
      return this.handleListMessages();
    }
    if (method === "POST" && path === "/messages") {
      return this.handleSendMessage(req);
    }

    // Cancel
    if (method === "POST" && path === "/cancel") {
      return this.handleCancel();
    }

    // SSE stream
    if (method === "GET" && path === "/stream") {
      return this.handleStream();
    }

    // Tools
    if (method === "GET" && path === "/tools") {
      return this.handleListTools();
    }
    if (method === "POST" && path.startsWith("/tools/")) {
      const toolName = decodeURIComponent(path.slice("/tools/".length));
      return this.handleExecuteTool(toolName, req);
    }

    // Memories
    if (method === "GET" && path === "/memories") {
      return this.handleListMemories();
    }
    if (method === "POST" && path === "/memories") {
      return this.handleCreateMemory(req);
    }
    if (method === "PUT" && path.startsWith("/memories/")) {
      const id = decodeURIComponent(path.slice("/memories/".length));
      return this.handleUpdateMemory(id, req);
    }
    if (method === "DELETE" && path.startsWith("/memories/")) {
      const id = decodeURIComponent(path.slice("/memories/".length));
      return this.handleDeleteMemory(id);
    }

    // Config
    if (method === "GET" && path === "/config") {
      return this.handleGetConfig();
    }
    if (method === "PATCH" && path === "/config") {
      return this.handleUpdateConfig(req);
    }

    // Sessions
    if (method === "GET" && path === "/sessions") {
      return this.handleListSessions();
    }
    if (method === "POST" && path === "/sessions") {
      return this.handleCreateSession(req);
    }
    if (method === "GET" && path.startsWith("/sessions/")) {
      const id = decodeURIComponent(path.slice("/sessions/".length));
      return this.handleGetSession(id);
    }

    return json({ error: "Not found", code: "NOT_FOUND" }, 404);
  }

  // ─── Endpoint Handlers ─────────────────────────────────────

  private handleHealth(): Response {
    const response: HealthResponse = {
      status: "ok",
      version: VERSION,
      uptime: Date.now() - this.startTime,
      model: "default",
      sessionId: null,
    };
    return json(response);
  }

  private handleInfo(): Response {
    const response: InfoResponse = {
      version: VERSION,
      tools: [
        "Read",
        "Write",
        "Edit",
        "MultiEdit",
        "Bash",
        "Glob",
        "Grep",
        "GrepReplace",
        "Rename",
        "DiffView",
        "LS",
        "GitStatus",
        "GitCommit",
        "GitLog",
        "TestRunner",
      ],
      models: [],
      features: [
        "streaming",
        "tool-execution",
        "memory",
        "sessions",
        "sse-events",
        "openapi-schema",
      ],
    };
    return json(response);
  }

  private handleOpenAPI(): Response {
    return json(generateOpenAPISchema());
  }

  private handleListMessages(): Response {
    // Placeholder: return mock messages
    return json([
      {
        id: "msg-1",
        role: "system",
        content: "Session initialized",
        timestamp: new Date().toISOString(),
      },
    ]);
  }

  private async handleSendMessage(req: Request): Promise<Response> {
    const body = (await req.json()) as { content?: string; model?: string; tools?: string[] };
    if (!body.content) {
      return json({ error: "Missing required field: content", code: "INVALID_INPUT" }, 400);
    }

    const messageId = `msg-${Date.now()}`;

    this.emitter.emit({
      type: "message.created",
      data: { id: messageId, role: "user", content: body.content },
    });

    // Placeholder response
    return json({
      id: messageId,
      role: "assistant",
      content: `Received: ${body.content}`,
      model: body.model || "default",
      timestamp: new Date().toISOString(),
    });
  }

  private handleCancel(): Response {
    return json({ ok: true, message: "Cancellation requested" });
  }

  private handleStream(): Response {
    const emitter = this.emitter;
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        const handler = (event: ExtensionEvent) => {
          const data = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            // Stream may be closed
            emitter.off("*", handler);
          }
        };

        emitter.on("*", handler);

        // Send initial keepalive
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private handleListTools(): Response {
    // Placeholder: return core tool list
    const tools = [
      { name: "Read", description: "Read a file from the filesystem" },
      { name: "Write", description: "Write content to a file" },
      { name: "Edit", description: "Edit a file with string replacements" },
      { name: "Bash", description: "Execute a bash command" },
      { name: "Glob", description: "Search for files matching a pattern" },
      { name: "Grep", description: "Search file contents with regex" },
    ];
    return json(tools);
  }

  private async handleExecuteTool(name: string, req: Request): Promise<Response> {
    const input = await req.json();

    this.emitter.emit({
      type: "tool.started",
      data: { id: `tool-${Date.now()}`, name },
    });

    const startTime = Date.now();

    // Placeholder: return mock tool result
    const result = {
      name,
      input,
      output: `Tool '${name}' executed (placeholder)`,
      success: true,
      durationMs: Date.now() - startTime,
    };

    this.emitter.emit({
      type: "tool.completed",
      data: { id: `tool-${Date.now()}`, name, success: true, durationMs: result.durationMs },
    });

    return json(result);
  }

  private handleListMemories(): Response {
    return json([]);
  }

  private async handleCreateMemory(req: Request): Promise<Response> {
    const body = (await req.json()) as { type?: string; title?: string; content?: string };
    if (!body.type || !body.title || !body.content) {
      return json(
        { error: "Missing required fields: type, title, content", code: "INVALID_INPUT" },
        400,
      );
    }

    const memory = {
      id: `mem-${Date.now()}`,
      type: body.type,
      title: body.title,
      content: body.content,
      createdAt: new Date().toISOString(),
    };

    this.emitter.emit({
      type: "memory.created",
      data: { type: body.type, title: body.title },
    });

    return json(memory, 201);
  }

  private async handleUpdateMemory(id: string, req: Request): Promise<Response> {
    const body = (await req.json()) as Record<string, unknown>;

    // Placeholder: return updated memory
    return json({
      id,
      ...body,
      updatedAt: new Date().toISOString(),
    });
  }

  private handleDeleteMemory(id: string): Response {
    return json({ ok: true, id });
  }

  private handleGetConfig(): Response {
    // Return sanitized config (no auth token)
    const { authToken: _, ...safeConfig } = this.config;
    return json(safeConfig);
  }

  private async handleUpdateConfig(req: Request): Promise<Response> {
    const patch = (await req.json()) as Partial<ExtensionApiConfig>;

    // Apply patch (excluding authToken for security)
    if (patch.port !== undefined) this.config.port = patch.port;
    if (patch.host !== undefined) this.config.host = patch.host;
    if (patch.rateLimit !== undefined) this.config.rateLimit = patch.rateLimit;
    if (patch.corsOrigins !== undefined) this.config.corsOrigins = patch.corsOrigins;

    const { authToken: _, ...safeConfig } = this.config;
    return json(safeConfig);
  }

  private handleListSessions(): Response {
    return json([]);
  }

  private async handleCreateSession(req: Request): Promise<Response> {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      // No body is fine for session creation
    }

    const session = {
      id: `session-${Date.now()}`,
      model: (body.model as string) || "default",
      startedAt: new Date().toISOString(),
    };

    this.emitter.emit({
      type: "session.started",
      data: { sessionId: session.id, model: session.model },
    });

    return json(session, 201);
  }

  private handleGetSession(id: string): Response {
    // Placeholder: return mock session
    return json({
      id,
      model: "default",
      startedAt: new Date().toISOString(),
      stats: {
        tokensUsed: 0,
        costUsd: 0,
        toolCalls: 0,
        durationMs: 0,
      },
    });
  }
}
