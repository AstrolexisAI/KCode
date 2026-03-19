// KCode - MCP (Model Context Protocol) Client Manager
// Manages MCP server connections, tool discovery, and JSON-RPC communication

import { spawn, type Subprocess } from "bun";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDefinition, ToolResult } from "./types";
import { ToolRegistry } from "./tool-registry";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP/SSE transport: URL of the MCP server */
  url?: string;
  /** Transport type: "stdio" (default), "http", or "sse" */
  transport?: "stdio" | "http" | "sse";
  /** Optional API key for HTTP transport (Bearer token) */
  apiKey?: string;
  /** OAuth 2.0 configuration for servers requiring OAuth authentication */
  oauth?: {
    clientId: string;
    clientSecret?: string;
    authorizationUrl: string;
    tokenUrl: string;
    scopes?: string[];
  };
  /** Whether to auto-discover OAuth config from /.well-known/oauth-authorization-server */
  oauthAutoDiscover?: boolean;
  /** Request headers for HTTP transport */
  headers?: Record<string, string>;
  /** Allowlist of tool names this server is permitted to expose (glob patterns) */
  allowedTools?: string[];
  /** Blocklist of tool names this server must NOT expose (glob patterns) */
  blockedTools?: string[];
}

export interface McpServersConfig {
  [serverName: string]: McpServerConfig;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

// ─── Elicitation Types ──────────────────────────────────────────

export interface ElicitationRequest {
  id: string | number;
  method: "elicitation/create";
  params: {
    message: string;
    requestedSchema?: {
      type: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ElicitationResponse {
  action: "accept" | "deny" | "cancel";
  content?: Record<string, unknown>;
}

export type ElicitationCallback = (request: ElicitationRequest["params"]) => Promise<ElicitationResponse>;

// ─── MCP Server Connection ──────────────────────────────────────

class McpServerConnection {
  readonly name: string;
  private config: McpServerConfig;
  private process: Subprocess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private buffer = "";
  private initialized = false;
  private tools: McpToolSchema[] = [];
  private resources: McpResource[] = [];
  private restartCount = 0;
  private maxRestarts = 3;
  private elicitationCallback?: ElicitationCallback;

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
  }

  setElicitationCallback(cb: ElicitationCallback): void {
    this.elicitationCallback = cb;
  }

  async start(): Promise<void> {
    log.info("mcp", `Starting server "${this.name}": ${this.config.command} ${(this.config.args ?? []).join(" ")}`);
    const env = { ...process.env, ...(this.config.env ?? {}) };

    this.process = spawn({
      cmd: [this.config.command, ...(this.config.args ?? [])],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    // Read stdout in background
    this.readStdout();
    this.readStderr();

    // Initialize the MCP session
    await this.initialize();
    this.initialized = true;
  }

  private async readStdout(): Promise<void> {
    if (!this.process?.stdout) return;

    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch {
      // Process ended or stream closed
    }
  }

  private async readStderr(): Promise<void> {
    if (!this.process?.stderr) return;

    const reader = (this.process.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Log stderr for debugging but don't crash
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          // Silently capture - could add debug logging here
        }
      }
    } catch {
      // Process ended
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);

        // Check if this is a server-initiated request (has method field)
        if (parsed.method && parsed.id !== undefined) {
          this.handleServerRequest(parsed);
          continue;
        }

        const response = parsed as JsonRpcResponse;
        if (response.id !== undefined) {
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(response.id);
            pending.resolve(response);
          }
        }
        // Notifications (no id) are ignored for now
      } catch {
        // Not valid JSON, skip
      }
    }
  }

  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.process?.stdin) {
      throw new Error(`MCP server "${this.name}" is not running`);
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const message = JSON.stringify(request) + "\n";

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request "${method}" to "${this.name}" timed out after 30s`));
      }, 30_000);

      this.pendingRequests.set(id, {
        resolve: (resp: JsonRpcResponse) => {
          if (resp.error) {
            reject(new Error(`MCP error from "${this.name}": ${resp.error.message} (code: ${resp.error.code})`));
          } else {
            resolve(resp.result);
          }
        },
        reject,
        timer,
      });

      try {
        this.process!.stdin!.write(message);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`Failed to write to MCP server "${this.name}": ${err}`));
      }
    });
  }

  private async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        elicitation: {},
      },
      clientInfo: {
        name: "KCode",
        version: "1.0.0",
      },
    });

    // Send initialized notification (no id, but we still use sendRequest-like approach)
    if (this.process?.stdin) {
      const notification = JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }) + "\n";
      this.process.stdin.write(notification);
    }
  }

  async discoverTools(): Promise<McpToolSchema[]> {
    const result = await this.sendRequest("tools/list", {}) as { tools?: McpToolSchema[] };
    this.tools = result?.tools ?? [];
    log.info("mcp", `Server "${this.name}" discovered ${this.tools.length} tools`);
    return this.tools;
  }

  async discoverResources(): Promise<McpResource[]> {
    try {
      const result = await this.sendRequest("resources/list", {}) as { resources?: McpResource[] };
      this.resources = result?.resources ?? [];
    } catch {
      // Server may not support resources
      this.resources = [];
    }
    return this.resources;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.sendRequest("tools/call", {
      name: toolName,
      arguments: args,
    }) as { content?: Array<{ type: string; text?: string }> };

    if (!result?.content || result.content.length === 0) {
      return "";
    }

    return result.content
      .map((c) => c.text ?? JSON.stringify(c))
      .join("\n");
  }

  async readResource(uri: string): Promise<McpResourceContent[]> {
    const result = await this.sendRequest("resources/read", {
      uri,
    }) as { contents?: McpResourceContent[] };

    return result?.contents ?? [];
  }

  getTools(): McpToolSchema[] {
    return this.tools;
  }

  getResources(): McpResource[] {
    return this.resources;
  }

  isAlive(): boolean {
    if (!this.process) return false;
    // Check if process is still running by checking exitCode
    return this.process.exitCode === null;
  }

  async restart(): Promise<boolean> {
    if (this.restartCount >= this.maxRestarts) {
      log.warn("mcp", `Server "${this.name}" exceeded max restarts (${this.maxRestarts})`);
      return false;
    }
    this.restartCount++;
    log.info("mcp", `Restarting server "${this.name}" (attempt ${this.restartCount}/${this.maxRestarts})`);
    this.shutdown();
    await this.start();
    await this.discoverTools();
    await this.discoverResources();
    return true;
  }

  /**
   * Handle a server-initiated JSON-RPC request (e.g., elicitation/create).
   */
  private handleServerRequest(request: { id: string | number; method: string; params?: Record<string, unknown> }): void {
    if (request.method === "elicitation/create") {
      const params = request.params as ElicitationRequest["params"];
      const respond = (result: ElicitationResponse) => this.sendJsonRpcResponse(request.id, result);

      if (this.elicitationCallback) {
        this.elicitationCallback(params).then(respond).catch(() => {
          respond({ action: "deny" });
        });
      } else {
        respond({ action: "deny" });
      }
    }
  }

  /**
   * Send a JSON-RPC response back to the MCP server.
   */
  private sendJsonRpcResponse(id: string | number, result: unknown): void {
    if (!this.process?.stdin) return;
    const response = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
    try {
      this.process.stdin.write(response);
    } catch {
      // Process may have died
    }
  }

  shutdown(): void {
    log.info("mcp", `Shutting down server "${this.name}"`);
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP server "${this.name}" is shutting down`));
    }
    this.pendingRequests.clear();

    if (this.process) {
      try {
        // Send SIGTERM first for graceful shutdown
        this.process.kill("SIGTERM");
      } catch {
        // Already dead
      }
      // Schedule SIGKILL if still alive after 3 seconds
      const proc = this.process;
      setTimeout(() => {
        try {
          if (proc.exitCode === null) {
            log.warn("mcp", `Server "${this.name}" did not exit after SIGTERM, sending SIGKILL`);
            proc.kill("SIGKILL");
          }
        } catch {
          // Already dead
        }
      }, 3000);
      this.process = null;
    }
    this.initialized = false;
    this.buffer = "";
  }
}

// ─── MCP HTTP/SSE Connection ─────────────────────────────────────

class McpHttpConnection {
  readonly name: string;
  private config: McpServerConfig;
  private tools: McpToolSchema[] = [];
  private resources: McpResource[] = [];
  private sessionId: string | null = null;
  private requestId = 0;
  private accessToken: string | null = null;
  private sseAbortController: AbortController | null = null;
  private ssePendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private sseConnected = false;
  private elicitationCallback?: ElicitationCallback;

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
  }

  setElicitationCallback(cb: ElicitationCallback): void {
    this.elicitationCallback = cb;
  }

  async start(): Promise<void> {
    const transport = this.config.transport ?? "http";
    log.info("mcp", `Connecting to ${transport.toUpperCase()} server "${this.name}": ${this.config.url}`);

    // Resolve authentication
    await this.resolveAuth();

    // For SSE transport, start the SSE listener first
    if (transport === "sse") {
      await this.startSseListener();
    }

    await this.initialize();
  }

  /**
   * Resolve authentication: OAuth token, API key, or none.
   */
  private async resolveAuth(): Promise<void> {
    // Priority: OAuth > apiKey
    if (this.config.oauth) {
      const { McpOAuthClient } = await import("./mcp-oauth");
      const client = new McpOAuthClient(this.name, this.config.oauth);
      const tokens = await client.getStoredTokens();
      if (tokens) {
        this.accessToken = tokens.accessToken;
        log.info("mcp", `Using stored OAuth token for "${this.name}"`);
      } else {
        log.warn("mcp", `No OAuth token for "${this.name}" — run /mcp auth ${this.name} to authenticate`);
      }
    } else if (this.config.oauthAutoDiscover && this.config.url) {
      try {
        const { discoverOAuthConfig } = await import("./mcp-oauth");
        const discovered = await discoverOAuthConfig(this.config.url);
        if (discovered) {
          log.info("mcp", `Discovered OAuth config for "${this.name}" — requires /mcp auth to complete`);
        }
      } catch {
        // Auto-discovery is best-effort
      }
    }

    if (!this.accessToken && this.config.apiKey) {
      this.accessToken = this.config.apiKey;
    }
  }

  /**
   * Build request headers with auth, session, and custom headers.
   */
  private buildHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = contentType;
    if (this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    // Merge custom headers (user-configured headers override defaults)
    if (this.config.headers) {
      for (const [key, value] of Object.entries(this.config.headers)) {
        // Block header injection via newlines/control chars
        if (typeof value === "string" && !/[\r\n\0]/.test(value) && !/[\r\n\0]/.test(key)) {
          headers[key] = value;
        }
      }
    }
    return headers;
  }

  // ─── SSE Transport ──────────────────────────────────────────

  /**
   * Start an SSE listener that receives JSON-RPC responses from the server.
   * Used with transport: "sse" (MCP Streamable HTTP).
   */
  private async startSseListener(): Promise<void> {
    const url = this.config.url;
    if (!url) throw new Error(`No URL configured for SSE server "${this.name}"`);

    this.sseAbortController = new AbortController();
    const headers = this.buildHeaders();
    headers["Accept"] = "text/event-stream";

    // Start SSE connection in background
    this.sseConnected = true;
    this.connectSse(url, headers).catch((err) => {
      log.warn("mcp", `SSE connection error for "${this.name}": ${err instanceof Error ? err.message : String(err)}`);
      this.sseConnected = false; // Mark as disconnected on error
    });

    // Wait briefly for SSE to establish
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  private async connectSse(url: string, headers: Record<string, string>): Promise<void> {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: this.sseAbortController!.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("SSE response has no body");
      }

      // Capture session ID from response headers
      const sessionHeader = response.headers.get("mcp-session-id");
      if (sessionHeader) {
        this.sessionId = sessionHeader;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = this.parseSseEvents(buffer);
        buffer = events.remaining;

        for (const event of events.parsed) {
          this.handleSseEvent(event);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      throw err;
    }
  }

  private parseSseEvents(buffer: string): { parsed: Array<{ event?: string; data: string }>; remaining: string } {
    const parsed: Array<{ event?: string; data: string }> = [];
    const blocks = buffer.split("\n\n");
    let remaining = blocks.pop() ?? "";
    // Prevent unbounded buffer growth (1MB limit)
    if (remaining.length > 1_000_000) {
      log.warn("mcp", `SSE buffer exceeded 1MB for "${this.name}", truncating`);
      remaining = "";
    }

    for (const block of blocks) {
      if (!block.trim()) continue;
      let event: string | undefined;
      const dataLines: string[] = [];

      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }

      if (dataLines.length > 0) {
        parsed.push({ event, data: dataLines.join("\n") });
      }
    }

    return { parsed, remaining };
  }

  private handleSseEvent(event: { event?: string; data: string }): void {
    // Default event type is "message"
    const eventType = event.event ?? "message";

    if (eventType === "message" || eventType === "response") {
      try {
        const parsed = JSON.parse(event.data);

        // Check if this is a server-initiated request (has method field)
        if (parsed.method && parsed.id !== undefined) {
          this.handleServerRequest(parsed);
          return;
        }

        const response = parsed as JsonRpcResponse;
        if (response.id !== undefined) {
          const pending = this.ssePendingRequests.get(response.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.ssePendingRequests.delete(response.id);
            if (response.error) {
              pending.reject(new Error(`MCP error: ${response.error.message} (code: ${response.error.code})`));
            } else {
              pending.resolve(response.result);
            }
          }
        }
      } catch {
        // Not valid JSON, skip
      }
    }
    // Ignore "ping", "endpoint", and other event types
  }

  // ─── HTTP/SSE Request Sending ───────────────────────────────

  private async sendHttp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const url = this.config.url;
    if (!url) throw new Error(`No URL configured for HTTP server "${this.name}"`);

    const id = ++this.requestId;
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) body.params = params;

    const transport = this.config.transport ?? "http";

    // For SSE transport: POST the request and wait for response via SSE stream
    if (transport === "sse" && this.sseConnected) {
      return this.sendViaSse(id, url, body);
    }

    // Standard HTTP: POST and read response inline
    const headers = this.buildHeaders("application/json");
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    // Handle 401 Unauthorized — could indicate OAuth token expired
    if (response.status === 401 && this.config.oauth) {
      log.warn("mcp", `Got 401 from "${this.name}" — OAuth token may have expired`);
      // Try to refresh and retry once
      const refreshed = await this.tryRefreshToken();
      if (refreshed) {
        const retryHeaders = this.buildHeaders("application/json");
        const retryResponse = await fetch(url, {
          method: "POST",
          headers: retryHeaders,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        if (retryResponse.ok) {
          return this.parseHttpResponse(retryResponse);
        }
      }
      throw new Error(`HTTP 401: Unauthorized — run /mcp auth ${this.name} to re-authenticate`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check if response is SSE (some servers return SSE even for POST)
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return this.readSseResponse(response, id);
    }

    return this.parseHttpResponse(response);
  }

  private async parseHttpResponse(response: Response): Promise<unknown> {
    // Capture session ID from response
    const sessionHeader = response.headers.get("mcp-session-id");
    if (sessionHeader) {
      this.sessionId = sessionHeader;
    }

    const json = await response.json() as JsonRpcResponse;
    if (json.error) {
      throw new Error(`MCP error: ${json.error.message} (code: ${json.error.code})`);
    }
    return json.result;
  }

  /**
   * For SSE transport: POST the JSON-RPC request and wait for the response
   * to arrive via the SSE stream.
   */
  private sendViaSse(id: number, url: string, body: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.ssePendingRequests.delete(id);
        reject(new Error(`MCP SSE request timed out after 30s`));
      }, 30_000);

      this.ssePendingRequests.set(id, { resolve, reject, timer });

      try {
        const headers = this.buildHeaders("application/json");
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });

        // Capture session ID
        const sessionHeader = response.headers.get("mcp-session-id");
        if (sessionHeader) this.sessionId = sessionHeader;

        if (!response.ok) {
          clearTimeout(timer);
          this.ssePendingRequests.delete(id);
          reject(new Error(`HTTP ${response.status}: ${response.statusText}`));
          return;
        }

        // Some servers return the response inline even in SSE mode
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          clearTimeout(timer);
          this.ssePendingRequests.delete(id);
          const json = await response.json() as JsonRpcResponse;
          if (json.error) {
            reject(new Error(`MCP error: ${json.error.message}`));
          } else {
            resolve(json.result);
          }
          return;
        }

        // If response is SSE, parse it inline
        if (contentType.includes("text/event-stream")) {
          clearTimeout(timer);
          this.ssePendingRequests.delete(id);
          const result = await this.readSseResponse(response, id);
          resolve(result);
          return;
        }

        // Otherwise, the response comes via the main SSE stream (pending request stays active)
      } catch (err) {
        clearTimeout(timer);
        this.ssePendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Read an SSE response body (for POST responses that return text/event-stream).
   */
  private async readSseResponse(response: Response, expectedId: number): Promise<unknown> {
    if (!response.body) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = this.parseSseEvents(buffer);
        buffer = events.remaining;

        for (const event of events.parsed) {
          try {
            const json = JSON.parse(event.data) as JsonRpcResponse;
            if (json.id === expectedId) {
              if (json.error) {
                throw new Error(`MCP error: ${json.error.message}`);
              }
              return json.result;
            }
          } catch (e) {
            if (e instanceof Error && e.message.startsWith("MCP error:")) throw e;
            // Not the response we're looking for
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return null;
  }

  /**
   * Try to refresh the OAuth token after a 401.
   */
  private async tryRefreshToken(): Promise<boolean> {
    if (!this.config.oauth) return false;
    try {
      const { McpOAuthClient } = await import("./mcp-oauth");
      const client = new McpOAuthClient(this.name, this.config.oauth);
      // Clear stored tokens so getStoredTokens triggers refresh
      const tokens = await client.getStoredTokens();
      if (tokens) {
        this.accessToken = tokens.accessToken;
        return true;
      }
    } catch {
      // Refresh failed
    }
    return false;
  }

  // ─── Standard MCP Operations ────────────────────────────────

  private async initialize(): Promise<void> {
    const result = await this.sendHttp("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        elicitation: {},
      },
      clientInfo: { name: "KCode", version: "1.0.0" },
    });
    if (result && typeof result === "object" && "sessionId" in (result as Record<string, unknown>)) {
      this.sessionId = (result as Record<string, unknown>).sessionId as string;
    }
    // Send initialized notification
    await this.sendHttp("notifications/initialized", {}).catch(() => {});
  }

  async discoverTools(): Promise<McpToolSchema[]> {
    const result = await this.sendHttp("tools/list", {}) as { tools?: McpToolSchema[] };
    this.tools = result?.tools ?? [];
    log.info("mcp", `HTTP server "${this.name}" discovered ${this.tools.length} tools`);
    return this.tools;
  }

  async discoverResources(): Promise<McpResource[]> {
    try {
      const result = await this.sendHttp("resources/list", {}) as { resources?: McpResource[] };
      this.resources = result?.resources ?? [];
    } catch {
      this.resources = [];
    }
    return this.resources;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.sendHttp("tools/call", {
      name: toolName,
      arguments: args,
    }) as { content?: Array<{ type: string; text?: string }> };

    if (!result?.content || result.content.length === 0) return "";
    return result.content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
  }

  async readResource(uri: string): Promise<McpResourceContent[]> {
    const result = await this.sendHttp("resources/read", { uri }) as { contents?: McpResourceContent[] };
    return result?.contents ?? [];
  }

  getTools(): McpToolSchema[] { return this.tools; }
  getResources(): McpResource[] { return this.resources; }

  isAlive(): boolean {
    if (this.config.transport === "sse") {
      return this.sseConnected;
    }
    return true; // HTTP is stateless
  }

  async restart(): Promise<boolean> {
    try {
      if (this.config.transport === "sse") {
        this.shutdownSse();
        await this.startSseListener();
      }
      await this.resolveAuth();
      await this.initialize();
      await this.discoverTools();
      await this.discoverResources();
      return true;
    } catch { return false; }
  }

  private shutdownSse(): void {
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }
    for (const [id, pending] of this.ssePendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`SSE connection closed`));
    }
    this.ssePendingRequests.clear();
    this.sseConnected = false;
  }

  /**
   * Handle a server-initiated JSON-RPC request (e.g., elicitation/create).
   */
  private handleServerRequest(request: { id: string | number; method: string; params?: Record<string, unknown> }): void {
    if (request.method === "elicitation/create") {
      const params = request.params as ElicitationRequest["params"];
      const respond = (result: ElicitationResponse) => this.sendJsonRpcResponseHttp(request.id, result);

      if (this.elicitationCallback) {
        this.elicitationCallback(params).then(respond).catch(() => {
          respond({ action: "deny" });
        });
      } else {
        respond({ action: "deny" });
      }
    }
  }

  /**
   * Send a JSON-RPC response back to the MCP server via HTTP POST.
   */
  private sendJsonRpcResponseHttp(id: string | number, result: unknown): void {
    const url = this.config.url;
    if (!url) return;
    const headers = this.buildHeaders("application/json");
    const body = JSON.stringify({ jsonrpc: "2.0", id, result });
    fetch(url, { method: "POST", headers, body }).catch(() => {
      // Best-effort response
    });
  }

  shutdown(): void {
    this.shutdownSse();
    this.sessionId = null;
    this.accessToken = null;
  }
}

// ─── Connection Interface ──────────────────────────────────────

type McpConnection = McpServerConnection | McpHttpConnection;

// ─── MCP Manager ────────────────────────────────────────────────

/** Simple glob match for MCP tool filtering (supports * wildcard) */
function mcpToolGlobMatch(pattern: string, name: string): boolean {
  const regex = pattern.replace(/([.+^${}()|[\]\\])/g, "\\$1").replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`, "i").test(name);
}

/** Check if a tool name is allowed by a server's allowedTools/blockedTools config */
function isToolAllowedByConfig(toolName: string, config: McpServerConfig): boolean {
  // If blockedTools is defined, reject matching tools
  if (config.blockedTools && config.blockedTools.length > 0) {
    for (const pattern of config.blockedTools) {
      if (mcpToolGlobMatch(pattern, toolName)) return false;
    }
  }
  // If allowedTools is defined, only allow matching tools
  if (config.allowedTools && config.allowedTools.length > 0) {
    for (const pattern of config.allowedTools) {
      if (mcpToolGlobMatch(pattern, toolName)) return true;
    }
    return false; // Not in allowlist
  }
  return true; // No restrictions
}

export class McpManager {
  private servers = new Map<string, McpConnection>();
  private serverConfigs = new Map<string, McpServerConfig>();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private elicitationCallback?: ElicitationCallback;

  /**
   * Set a callback to handle elicitation requests from MCP servers.
   * The callback is propagated to all current and future server connections.
   */
  setElicitationCallback(cb: ElicitationCallback): void {
    this.elicitationCallback = cb;
    // Propagate to all existing connections
    for (const connection of this.servers.values()) {
      connection.setElicitationCallback(cb);
    }
  }

  /**
   * Load MCP server configs from settings files and start all servers.
   */
  async loadAndStart(cwd: string): Promise<void> {
    const configs = await this.loadConfigs(cwd);
    if (Object.keys(configs).length === 0) return;

    await this.startServers(configs);
    this.startHealthChecks();
  }

  /**
   * Load MCP server configs from a pre-parsed config object and start servers.
   * Used by --mcp-config CLI flag.
   */
  async loadFromConfigs(configs: McpServersConfig): Promise<void> {
    const validated: McpServersConfig = {};
    for (const [name, config] of Object.entries(configs)) {
      if (isValidServerConfig(config)) {
        validated[name] = config as McpServerConfig;
      }
    }
    if (Object.keys(validated).length === 0) return;

    await this.startServers(validated);
    this.startHealthChecks();
  }

  /**
   * Add a single MCP server at runtime and start it.
   */
  async addServer(name: string, config: McpServerConfig): Promise<void> {
    if (this.servers.has(name)) {
      throw new Error(`MCP server "${name}" already exists`);
    }
    await this.startServers({ [name]: config });
    this.startHealthChecks();
  }

  /**
   * Remove an MCP server and shut it down.
   */
  removeServer(name: string): boolean {
    const connection = this.servers.get(name);
    if (!connection) return false;
    connection.shutdown();
    this.servers.delete(name);
    return true;
  }

  /**
   * Get status info for all servers.
   */
  getServerStatus(): Array<{ name: string; alive: boolean; toolCount: number }> {
    const result: Array<{ name: string; alive: boolean; toolCount: number }> = [];
    for (const [name, connection] of this.servers) {
      result.push({
        name,
        alive: connection.isAlive(),
        toolCount: connection.getTools().length,
      });
    }
    return result;
  }

  /**
   * Load MCP server configs from .kcode/settings.json and ~/.kcode/settings.json.
   */
  private async loadConfigs(cwd: string): Promise<McpServersConfig> {
    const paths = [
      join(homedir(), ".kcode", "settings.json"),
      join(cwd, ".kcode", "settings.json"),
    ];

    const merged: McpServersConfig = {};

    for (const path of paths) {
      try {
        const file = Bun.file(path);
        if (await file.exists()) {
          const data = await file.json();
          if (data?.mcpServers && typeof data.mcpServers === "object") {
            for (const [name, config] of Object.entries(data.mcpServers)) {
              if (isValidServerConfig(config)) {
                merged[name] = config as McpServerConfig;
              }
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return merged;
  }

  /**
   * Start all configured MCP servers and discover their tools.
   */
  private async startServers(configs: McpServersConfig): Promise<void> {
    const startPromises = Object.entries(configs).map(async ([name, config]) => {
      // Choose transport based on config
      const isHttp = config.transport === "http" || config.transport === "sse" || (!config.command && config.url);
      const connection: McpConnection = isHttp
        ? new McpHttpConnection(name, config)
        : new McpServerConnection(name, config);

      // Propagate elicitation callback to new connections
      if (this.elicitationCallback) {
        connection.setElicitationCallback(this.elicitationCallback);
      }

      try {
        await connection.start();
        await connection.discoverTools();
        await connection.discoverResources();
        this.servers.set(name, connection);
        this.serverConfigs.set(name, config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[MCP] Failed to start server "${name}" (${isHttp ? "HTTP" : "stdio"}): ${msg}`);
        connection.shutdown();
      }
    });

    await Promise.allSettled(startPromises);
  }

  /**
   * Register all discovered MCP tools into a ToolRegistry.
   */
  registerTools(registry: ToolRegistry): void {
    for (const [serverName, connection] of this.servers) {
      const config = this.serverConfigs.get(serverName);
      for (const tool of connection.getTools()) {
        // Apply per-server tool filtering
        if (config && !isToolAllowedByConfig(tool.name, config)) {
          log.info("mcp", `Tool "${tool.name}" from server "${serverName}" blocked by allowedTools/blockedTools config`);
          continue;
        }

        const registeredName = `mcp__${serverName}__${tool.name}`;

        // Check for tool name collisions
        if (registry.has(registeredName)) {
          log.warn("mcp", `Tool name collision: "${registeredName}" already registered, skipping`);
          continue;
        }

        const definition: ToolDefinition = {
          name: registeredName,
          description: tool.description ?? `MCP tool "${tool.name}" from server "${serverName}"`,
          input_schema: tool.inputSchema ?? { type: "object", properties: {} },
        };

        const handler = async (input: Record<string, unknown>): Promise<ToolResult> => {
          try {
            // Check if server is alive, try restart if not
            if (!connection.isAlive()) {
              const restarted = await connection.restart();
              if (!restarted) {
                return {
                  tool_use_id: "",
                  content: `MCP server "${serverName}" is not running and could not be restarted`,
                  is_error: true,
                };
              }
            }

            const result = await connection.callTool(tool.name, input);
            return { tool_use_id: "", content: result };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { tool_use_id: "", content: `MCP tool error: ${msg}`, is_error: true };
          }
        };

        registry.register(registeredName, definition, handler);
      }
    }
  }

  /**
   * Get all resources from all connected MCP servers.
   */
  getAllResources(): Array<{ serverName: string; resource: McpResource }> {
    const results: Array<{ serverName: string; resource: McpResource }> = [];
    for (const [serverName, connection] of this.servers) {
      for (const resource of connection.getResources()) {
        results.push({ serverName, resource });
      }
    }
    return results;
  }

  /**
   * Read a resource from a specific server.
   */
  async readResource(serverName: string, uri: string): Promise<McpResourceContent[]> {
    const connection = this.servers.get(serverName);
    if (!connection) {
      throw new Error(`MCP server "${serverName}" not found`);
    }
    if (!connection.isAlive()) {
      const restarted = await connection.restart();
      if (!restarted) {
        throw new Error(`MCP server "${serverName}" is not running and could not be restarted`);
      }
    }
    return connection.readResource(uri);
  }

  /**
   * Call a tool on a specific MCP server.
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const connection = this.servers.get(serverName);
    if (!connection) {
      throw new Error(`MCP server "${serverName}" not found`);
    }
    if (!connection.isAlive()) {
      const restarted = await connection.restart();
      if (!restarted) {
        throw new Error(`MCP server "${serverName}" is not running and could not be restarted`);
      }
    }
    return connection.callTool(toolName, args);
  }

  /**
   * Discover all available tools across all connected MCP servers.
   * Returns ToolDefinition[] ready for use with the AI model.
   */
  discoverTools(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const [serverName, connection] of this.servers) {
      const config = this.serverConfigs.get(serverName);
      for (const tool of connection.getTools()) {
        // Apply per-server tool filtering
        if (config && !isToolAllowedByConfig(tool.name, config)) continue;
        definitions.push({
          name: `mcp__${serverName}__${tool.name}`,
          description: `[MCP: ${serverName}] ${tool.description ?? `Tool "${tool.name}" from server "${serverName}"`}`,
          input_schema: tool.inputSchema ?? { type: "object", properties: {} },
        });
      }
    }
    return definitions;
  }

  /**
   * Re-discover tools from all servers (e.g., after a server restart or schema change).
   * Calls tools/list on each connected server and updates cached tool lists.
   */
  async refreshTools(): Promise<ToolDefinition[]> {
    const refreshPromises = Array.from(this.servers.entries()).map(async ([name, connection]) => {
      try {
        if (!connection.isAlive()) {
          const restarted = await connection.restart();
          if (!restarted) {
            this.servers.delete(name);
            return;
          }
        }
        await connection.discoverTools();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[MCP] Failed to refresh tools from "${name}": ${msg}`);
      }
    });
    await Promise.allSettled(refreshPromises);
    return this.discoverTools();
  }

  /**
   * Get connected server names.
   */
  getServerNames(): string[] {
    return Array.from(this.servers.keys());
  }

  /**
   * Periodic health check: restart dead servers.
   */
  private startHealthChecks(): void {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(async () => {
      for (const [name, connection] of this.servers) {
        if (!connection.isAlive()) {
          log.warn("mcp", `Health check: server "${name}" is dead, attempting restart`);
          try {
            const restarted = await connection.restart();
            if (!restarted) {
              log.warn("mcp", `Health check: removing dead server "${name}" (restart failed)`);
              this.servers.delete(name);
            }
          } catch {
            log.warn("mcp", `Health check: removing dead server "${name}" (restart threw)`);
            this.servers.delete(name);
          }
        }
      }
    }, 30_000);
  }

  /**
   * Gracefully shut down all MCP servers.
   */
  shutdown(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    for (const [, connection] of this.servers) {
      connection.shutdown();
    }
    this.servers.clear();
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function isValidServerConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  // HTTP/SSE transport: must have url
  if (obj.transport === "http" || obj.transport === "sse" || obj.url) {
    if (typeof obj.url !== "string") return false;
    // Validate URL protocol
    try {
      const parsed = new URL(obj.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    } catch {
      return false;
    }
    // Validate oauth config if present
    if (obj.oauth !== undefined) {
      if (!obj.oauth || typeof obj.oauth !== "object") return false;
      const oauth = obj.oauth as Record<string, unknown>;
      if (typeof oauth.clientId !== "string") return false;
      if (typeof oauth.authorizationUrl !== "string") return false;
      if (typeof oauth.tokenUrl !== "string") return false;
    }
    // Validate allowedTools/blockedTools for HTTP transport too
    if (obj.allowedTools !== undefined) {
      if (!Array.isArray(obj.allowedTools) || !obj.allowedTools.every((t: unknown) => typeof t === "string")) return false;
    }
    if (obj.blockedTools !== undefined) {
      if (!Array.isArray(obj.blockedTools) || !obj.blockedTools.every((t: unknown) => typeof t === "string")) return false;
    }
    return true;
  }

  // Stdio transport (default): must have command
  if (typeof obj.command !== "string") return false;
  if (obj.args !== undefined && !Array.isArray(obj.args)) return false;
  if (obj.env !== undefined && typeof obj.env !== "object") return false;

  // Validate allowedTools/blockedTools if present
  if (obj.allowedTools !== undefined) {
    if (!Array.isArray(obj.allowedTools) || !obj.allowedTools.every((t: unknown) => typeof t === "string")) return false;
  }
  if (obj.blockedTools !== undefined) {
    if (!Array.isArray(obj.blockedTools) || !obj.blockedTools.every((t: unknown) => typeof t === "string")) return false;
  }

  return true;
}

// ─── Singleton ──────────────────────────────────────────────────

let globalMcpManager: McpManager | null = null;

export function getMcpManager(): McpManager {
  if (!globalMcpManager) {
    globalMcpManager = new McpManager();
  }
  return globalMcpManager;
}

export function shutdownMcpManager(): void {
  if (globalMcpManager) {
    globalMcpManager.shutdown();
    globalMcpManager = null;
  }
}
