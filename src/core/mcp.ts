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
  command: string;
  args?: string[];
  env?: Record<string, string>;
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

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
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
        const response = JSON.parse(trimmed) as JsonRpcResponse;
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
      capabilities: {},
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

// ─── MCP Manager ────────────────────────────────────────────────

export class McpManager {
  private servers = new Map<string, McpServerConnection>();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

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
      const connection = new McpServerConnection(name, config);
      try {
        await connection.start();
        await connection.discoverTools();
        await connection.discoverResources();
        this.servers.set(name, connection);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[MCP] Failed to start server "${name}": ${msg}`);
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
      for (const tool of connection.getTools()) {
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
      for (const tool of connection.getTools()) {
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
  if (typeof obj.command !== "string") return false;
  if (obj.args !== undefined && !Array.isArray(obj.args)) return false;
  if (obj.env !== undefined && typeof obj.env !== "object") return false;
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
