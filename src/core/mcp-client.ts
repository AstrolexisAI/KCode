// KCode - MCP Client Connections
// Low-level JSON-RPC client for stdio and HTTP/SSE MCP server transports

import { type Subprocess, spawn } from "bun";
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

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
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

export type ElicitationCallback = (
  request: ElicitationRequest["params"],
) => Promise<ElicitationResponse>;

// ─── Input Sanitization ─────────────────────────────────────────

/** Dangerous keys that could enable prototype pollution via JSON */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Maximum nesting depth for MCP tool arguments */
const MAX_INPUT_DEPTH = 20;

/** Maximum size of a single string field in MCP input (256 KB) */
const MAX_STRING_FIELD_SIZE = 256 * 1024;

/** Maximum number of keys in a single MCP input object */
const MAX_INPUT_KEYS = 100;

/** Maximum total number of array elements across all fields */
const MAX_ARRAY_ELEMENTS = 1000;

/**
 * Sanitize MCP tool input: strip prototype pollution keys,
 * reject excessively deep nesting, enforce field size limits.
 */
export function sanitizeMcpInput(obj: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > MAX_INPUT_DEPTH) {
    return { _error: "Input exceeds maximum nesting depth" };
  }
  const entries = Object.entries(obj);
  if (entries.length > MAX_INPUT_KEYS) {
    return { _error: `Input has too many keys (${entries.length}, max ${MAX_INPUT_KEYS})` };
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (typeof value === "string" && value.length > MAX_STRING_FIELD_SIZE) {
      result[key] =
        value.slice(0, MAX_STRING_FIELD_SIZE) + `\n[Truncated at ${MAX_STRING_FIELD_SIZE} bytes]`;
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = sanitizeMcpInput(value as Record<string, unknown>, depth + 1);
    } else if (Array.isArray(value)) {
      const capped = value.slice(0, MAX_ARRAY_ELEMENTS);
      result[key] = capped.map((item) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? sanitizeMcpInput(item as Record<string, unknown>, depth + 1)
          : item,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Stdio Command Allowlist ────────────────────────────────────

/** Commands that are allowed for stdio MCP transport by default */
const ALLOWED_STDIO_COMMANDS = new Set([
  "npx",
  "node",
  "bun",
  "bunx",
  "deno",
  "python",
  "python3",
  "pip",
  "pipx",
  "uvx",
  "docker",
  "podman",
  "mcp-server",
  "mcp-server-*",
]);

/**
 * Validate that a stdio MCP server command is safe to execute.
 * Blocks shell invocations and suspicious commands.
 */
export function validateStdioCommand(command: string): { ok: boolean; reason?: string } {
  // Block empty/whitespace-only commands
  if (!command.trim()) {
    return { ok: false, reason: "Empty command" };
  }

  // Block direct shell invocations
  const shell = command.split("/").pop() ?? command;
  const dangerousShells = new Set([
    "sh",
    "bash",
    "zsh",
    "fish",
    "csh",
    "tcsh",
    "dash",
    "ksh",
    "cmd",
    "powershell",
    "pwsh",
  ]);
  if (dangerousShells.has(shell)) {
    return { ok: false, reason: `Direct shell invocation blocked: "${command}"` };
  }

  // Block commands with shell metacharacters that suggest injection
  if (/[;|&$`\\]/.test(command)) {
    return { ok: false, reason: `Command contains shell metacharacters: "${command}"` };
  }

  // In safe mode, also check the allowlist
  if (process.env.KCODE_SAFE_PLUGINS === "1") {
    const basename = command.split("/").pop() ?? command;
    const matched =
      ALLOWED_STDIO_COMMANDS.has(basename) ||
      [...ALLOWED_STDIO_COMMANDS].some(
        (p) => p.endsWith("*") && basename.startsWith(p.slice(0, -1)),
      );
    if (!matched) {
      return { ok: false, reason: `Command "${basename}" not in safe-plugins allowlist` };
    }
  }

  return { ok: true };
}

// ─── MCP Server Connection (stdio) ──────────────────────────────

export class McpServerConnection {
  readonly name: string;
  private config: McpServerConfig;
  private process: Subprocess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
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
    // Validate the command before spawning
    const cmd = this.config.command ?? "";
    const validation = validateStdioCommand(cmd);
    if (!validation.ok) {
      throw new Error(`MCP server "${this.name}" blocked: ${validation.reason}`);
    }

    log.info("mcp", `Starting server "${this.name}": ${cmd} ${(this.config.args ?? []).join(" ")}`);
    const rawEnv = { ...process.env, ...(this.config.env ?? {}) };
    const env = Object.fromEntries(
      Object.entries(rawEnv).filter((e): e is [string, string] => e[1] !== undefined),
    );

    this.process = spawn({
      cmd: [this.config.command!, ...(this.config.args ?? [])],
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
    if (!this.process?.stdout || typeof this.process.stdout === "number") return;

    const reader = (this.process.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch (err) {
      log.debug("mcp", 'Stdout stream ended for server "' + this.name + '": ' + err);
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
    } catch (err) {
      log.debug("mcp", 'Stderr stream ended for server "' + this.name + '": ' + err);
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
      } catch (err) {
        log.debug("mcp", 'Failed to parse JSON-RPC message from "' + this.name + '": ' + err);
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
            reject(
              new Error(
                `MCP error from "${this.name}": ${resp.error.message} (code: ${resp.error.code})`,
              ),
            );
          } else {
            resolve(resp.result);
          }
        },
        reject,
        timer,
      });

      try {
        const stdin = this.process!.stdin;
        if (!stdin || typeof stdin === "number") throw new Error("stdin not available");
        (stdin as import("bun").FileSink).write(message);
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
    if (this.process?.stdin && typeof this.process.stdin !== "number") {
      const notification =
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n";
      (this.process.stdin as import("bun").FileSink).write(notification);
    }
  }

  async discoverTools(): Promise<McpToolSchema[]> {
    const result = (await this.sendRequest("tools/list", {})) as { tools?: McpToolSchema[] };
    this.tools = result?.tools ?? [];
    log.info("mcp", `Server "${this.name}" discovered ${this.tools.length} tools`);
    return this.tools;
  }

  async discoverResources(): Promise<McpResource[]> {
    try {
      const result = (await this.sendRequest("resources/list", {})) as {
        resources?: McpResource[];
      };
      this.resources = result?.resources ?? [];
    } catch (err) {
      log.debug("mcp", 'Server "' + this.name + '" does not support resources/list: ' + err);
      this.resources = [];
    }
    return this.resources;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    // Sanitize input: strip prototype pollution keys and limit depth
    const sanitizedArgs = sanitizeMcpInput(args);

    const result = (await this.sendRequest("tools/call", {
      name: toolName,
      arguments: sanitizedArgs,
    })) as { content?: unknown };

    // Validate response structure (prevent malicious MCP server injection)
    if (!result || typeof result !== "object") return "";
    if (!Array.isArray(result.content) || result.content.length === 0) return "";

    const MAX_RESPONSE_SIZE = 1024 * 1024; // 1MB limit per tool response
    let totalSize = 0;

    return result.content
      .filter((c: unknown): c is { type: string; text?: string } => {
        if (!c || typeof c !== "object") return false;
        const item = c as Record<string, unknown>;
        return typeof item.type === "string";
      })
      .map((c) => {
        const text = typeof c.text === "string" ? c.text : JSON.stringify(c);
        totalSize += text.length;
        if (totalSize > MAX_RESPONSE_SIZE) return "[truncated: MCP response too large]";
        return text;
      })
      .join("\n");
  }

  async readResource(uri: string): Promise<McpResourceContent[]> {
    const result = (await this.sendRequest("resources/read", {
      uri,
    })) as { contents?: McpResourceContent[] };

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
    log.info(
      "mcp",
      `Restarting server "${this.name}" (attempt ${this.restartCount}/${this.maxRestarts})`,
    );
    this.shutdown();
    this.buffer = ""; // Clear buffer to prevent old process data contaminating new connection
    await this.start();
    await this.discoverTools();
    await this.discoverResources();
    return true;
  }

  /**
   * Handle a server-initiated JSON-RPC request (e.g., elicitation/create).
   */
  private handleServerRequest(request: {
    id: string | number;
    method: string;
    params?: Record<string, unknown>;
  }): void {
    if (request.method === "elicitation/create") {
      const params = request.params as ElicitationRequest["params"];
      const respond = (result: ElicitationResponse) => this.sendJsonRpcResponse(request.id, result);

      if (this.elicitationCallback) {
        this.elicitationCallback(params)
          .then(respond)
          .catch(() => {
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
    if (!this.process?.stdin || typeof this.process.stdin === "number") return;
    const response = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
    try {
      (this.process.stdin as import("bun").FileSink).write(response);
    } catch (err) {
      log.warn("mcp", 'Failed to write to stdin of server "' + this.name + '": ' + err);
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
      } catch (err) {
        log.debug("mcp", 'Server "' + this.name + '" already dead on SIGTERM: ' + err);
      }
      // Schedule SIGKILL if still alive after 3 seconds
      const proc = this.process;
      setTimeout(() => {
        try {
          if (proc.exitCode === null) {
            log.warn("mcp", `Server "${this.name}" did not exit after SIGTERM, sending SIGKILL`);
            proc.kill("SIGKILL");
          }
        } catch (err) {
          log.debug("mcp", 'Server "' + this.name + '" already dead on SIGKILL: ' + err);
        }
      }, 3000);
      this.process = null;
    }
    this.initialized = false;
    this.buffer = "";
  }
}

// ─── MCP HTTP/SSE Connection ─────────────────────────────────────

export class McpHttpConnection {
  readonly name: string;
  private config: McpServerConfig;
  private tools: McpToolSchema[] = [];
  private resources: McpResource[] = [];
  private sessionId: string | null = null;
  private requestId = 0;
  private accessToken: string | null = null;
  private sseAbortController: AbortController | null = null;
  private ssePendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
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
    log.info(
      "mcp",
      `Connecting to ${transport.toUpperCase()} server "${this.name}": ${this.config.url}`,
    );

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
        log.warn(
          "mcp",
          `No OAuth token for "${this.name}" — run /mcp auth ${this.name} to authenticate`,
        );
      }
    } else if (this.config.oauthAutoDiscover && this.config.url) {
      try {
        const { discoverOAuthConfig } = await import("./mcp-oauth");
        const discovered = await discoverOAuthConfig(this.config.url);
        if (discovered) {
          log.info(
            "mcp",
            `Discovered OAuth config for "${this.name}" — requires /mcp auth to complete`,
          );
        }
      } catch (err) {
        log.debug("mcp", 'OAuth auto-discovery failed for "' + this.name + '": ' + err);
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
      log.warn(
        "mcp",
        `SSE connection error for "${this.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
      this.sseConnected = false; // Mark as disconnected on error
    });

    // Wait briefly for SSE to establish
    await new Promise((resolve) => setTimeout(resolve, 500));
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

  private parseSseEvents(buffer: string): {
    parsed: Array<{ event?: string; data: string }>;
    remaining: string;
  } {
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
              pending.reject(
                new Error(`MCP error: ${response.error.message} (code: ${response.error.code})`),
              );
            } else {
              pending.resolve(response.result);
            }
          }
        }
      } catch (err) {
        log.debug("mcp", 'Failed to parse SSE JSON-RPC message from "' + this.name + '": ' + err);
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

    const json = (await response.json()) as JsonRpcResponse;
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
          const json = (await response.json()) as JsonRpcResponse;
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
    } catch (err) {
      log.warn("mcp", 'OAuth token refresh failed for "' + this.name + '": ' + err);
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
    if (
      result &&
      typeof result === "object" &&
      "sessionId" in (result as Record<string, unknown>)
    ) {
      this.sessionId = (result as Record<string, unknown>).sessionId as string;
    }
    // Send initialized notification
    await this.sendHttp("notifications/initialized", {}).catch((e) => { log.debug("mcp", `Failed to send initialized notification to "${this.name}": ${e}`); });
  }

  async discoverTools(): Promise<McpToolSchema[]> {
    const result = (await this.sendHttp("tools/list", {})) as { tools?: McpToolSchema[] };
    this.tools = result?.tools ?? [];
    log.info("mcp", `HTTP server "${this.name}" discovered ${this.tools.length} tools`);
    return this.tools;
  }

  async discoverResources(): Promise<McpResource[]> {
    try {
      const result = (await this.sendHttp("resources/list", {})) as { resources?: McpResource[] };
      this.resources = result?.resources ?? [];
    } catch (err) {
      log.debug("mcp", 'HTTP server "' + this.name + '" does not support resources/list: ' + err);
      this.resources = [];
    }
    return this.resources;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    // Sanitize input: strip prototype pollution keys and limit depth
    const sanitizedArgs = sanitizeMcpInput(args);

    const result = (await this.sendHttp("tools/call", {
      name: toolName,
      arguments: sanitizedArgs,
    })) as { content?: Array<{ type: string; text?: string }> };

    if (!result?.content || !Array.isArray(result.content) || result.content.length === 0)
      return "";

    // Apply same 1MB response limit as stdio transport
    const MAX_RESPONSE_SIZE = 1024 * 1024;
    let totalSize = 0;
    const parts: string[] = [];
    for (const c of result.content) {
      if (!c || typeof c !== "object") continue;
      const text = typeof c.text === "string" ? c.text : JSON.stringify(c);
      totalSize += text.length;
      if (totalSize > MAX_RESPONSE_SIZE) {
        parts.push(`\n[Response truncated at 1MB limit]`);
        break;
      }
      parts.push(text);
    }
    return parts.join("\n");
  }

  async readResource(uri: string): Promise<McpResourceContent[]> {
    const result = (await this.sendHttp("resources/read", { uri })) as {
      contents?: McpResourceContent[];
    };
    return result?.contents ?? [];
  }

  getTools(): McpToolSchema[] {
    return this.tools;
  }
  getResources(): McpResource[] {
    return this.resources;
  }

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
    } catch (err) {
      log.warn("mcp", 'Failed to restart HTTP server "' + this.name + '": ' + err);
      return false;
    }
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
  private handleServerRequest(request: {
    id: string | number;
    method: string;
    params?: Record<string, unknown>;
  }): void {
    if (request.method === "elicitation/create") {
      const params = request.params as ElicitationRequest["params"];
      const respond = (result: ElicitationResponse) =>
        this.sendJsonRpcResponseHttp(request.id, result);

      if (this.elicitationCallback) {
        this.elicitationCallback(params)
          .then(respond)
          .catch(() => {
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

export type McpConnection = McpServerConnection | McpHttpConnection;
