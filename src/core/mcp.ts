// KCode - MCP (Model Context Protocol) Manager
// Orchestrates MCP server connections, tool discovery, and resource handling.
// Low-level client connections live in mcp-client.ts; tool adaptation in mcp-tools.ts (core).

import { join } from "node:path";
import type { ToolDefinition } from "./types";
import { kcodePath } from "./paths";
import type { ToolRegistry } from "./tool-registry";
import { log } from "./logger";

// Re-export all public types and classes from sub-modules so existing
// consumers that import from "./mcp" continue to work unchanged.
export type {
  McpServerConfig,
  McpServersConfig,
  McpToolSchema,
  McpResource,
  McpResourceContent,
  ElicitationRequest,
  ElicitationResponse,
  ElicitationCallback,
  McpConnection,
} from "./mcp-client";

export {
  McpServerConnection,
  McpHttpConnection,
} from "./mcp-client";

export { McpHealthMonitor, type ServerHealth, type CircuitBreakerConfig } from "./mcp-health";
export { addAlias, removeAlias, resolveAlias, listAliases, type ToolAlias } from "./mcp-aliases";

import {
  McpServerConnection,
  McpHttpConnection,
  type McpServerConfig,
  type McpServersConfig,
  type McpResourceContent,
  type McpResource,
  type McpConnection,
  type ElicitationCallback,
} from "./mcp-client";

import { registerMcpTools, discoverMcpTools } from "./mcp-tools";
import { McpHealthMonitor } from "./mcp-health";
import { resolveAlias } from "./mcp-aliases";
import { isWorkspaceTrusted } from "./hook-trust";

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
    } catch (err) {
      log.debug("mcp", "Invalid MCP server URL: " + err);
      return false;
    }
    // Validate oauth config if present
    if (obj.oauth !== undefined) {
      if (!obj.oauth || typeof obj.oauth !== "object") return false;
      const oauth = obj.oauth as Record<string, unknown>;
      if (typeof oauth.clientId !== "string") return false;
      if (typeof oauth.authorizationUrl !== "string") return false;
      if (typeof oauth.tokenUrl !== "string") return false;
      // Validate OAuth URLs use HTTPS (or http://localhost for dev). Block data:, javascript:, file: protocols.
      for (const urlField of ["authorizationUrl", "tokenUrl"] as const) {
        try {
          const parsed = new URL(oauth[urlField] as string);
          const isLocalhost = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1");
          if (parsed.protocol !== "https:" && !isLocalhost) return false;
        } catch {
          return false;
        }
      }
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

// ─── MCP Manager ────────────────────────────────────────────────

export class McpManager {
  private servers = new Map<string, McpConnection>();
  private serverConfigs = new Map<string, McpServerConfig>();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private elicitationCallback?: ElicitationCallback;
  readonly healthMonitor = new McpHealthMonitor();

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
   * Project-level configs require workspace trust.
   */
  private async loadConfigs(cwd: string): Promise<McpServersConfig> {
    const userPath = kcodePath("settings.json");
    const projectPath = join(cwd, ".kcode", "settings.json");

    const sources: Array<{ path: string; isProject: boolean }> = [
      { path: userPath, isProject: false },
      { path: projectPath, isProject: true },
    ];

    const merged: McpServersConfig = {};

    for (const { path, isProject } of sources) {
      // Skip project-level config if workspace is not trusted
      if (isProject && !isWorkspaceTrusted(cwd)) {
        try {
          const file = Bun.file(path);
          if (await file.exists()) {
            const data = await file.json();
            if (data?.mcpServers && typeof data.mcpServers === "object" && Object.keys(data.mcpServers).length > 0) {
              console.error(`[MCP] Skipping project .kcode/ MCP servers — workspace not trusted. Run \`kcode init --trust\` to trust this workspace.`);
            }
          }
        } catch { /* ignore */ }
        continue;
      }

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
      } catch (err) {
        log.debug("mcp", "Failed to read MCP config from " + path + ": " + err);
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
    registerMcpTools(this.servers, this.serverConfigs, registry, this.healthMonitor);
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
   * Checks circuit breaker before calling and records success/failure with latency.
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    // Check circuit breaker — block if circuit is open
    if (this.healthMonitor.isCircuitOpen(serverName)) {
      const health = this.healthMonitor.getHealth(serverName);
      throw new Error(
        `MCP server "${serverName}" circuit breaker is open (${health.consecutiveFailures} consecutive failures). ` +
        `Wait for automatic recovery or run /mcp reset ${serverName}.`
      );
    }

    const connection = this.servers.get(serverName);
    if (!connection) {
      throw new Error(`MCP server "${serverName}" not found`);
    }
    if (!connection.isAlive()) {
      const restarted = await connection.restart();
      if (!restarted) {
        this.healthMonitor.recordFailure(serverName, "Server not running and restart failed");
        throw new Error(`MCP server "${serverName}" is not running and could not be restarted`);
      }
    }

    const start = Date.now();
    try {
      const result = await connection.callTool(toolName, args);
      this.healthMonitor.recordSuccess(serverName, Date.now() - start);
      return result;
    } catch (err) {
      this.healthMonitor.recordFailure(serverName, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Resolve a tool alias to its full MCP tool name.
   */
  resolveAlias(name: string): string {
    return resolveAlias(name);
  }

  /**
   * Discover all available tools across all connected MCP servers.
   * Returns ToolDefinition[] ready for use with the AI model.
   */
  discoverTools(): ToolDefinition[] {
    return discoverMcpTools(this.servers, this.serverConfigs);
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

    const interval = setInterval(async () => {
      // Collect dead servers first, then act — avoids Map mutation during async iteration
      const deadServers: Array<[string, typeof this.servers extends Map<string, infer V> ? V : never]> = [];
      for (const [name, connection] of this.servers) {
        if (!connection.isAlive()) deadServers.push([name, connection]);
      }
      for (const [name, connection] of deadServers) {
        log.warn("mcp", `Health check: server "${name}" is dead, attempting restart`);
        try {
          const restarted = await connection.restart();
          if (!restarted) {
            log.warn("mcp", `Health check: removing dead server "${name}" (restart failed)`);
            this.servers.delete(name);
          }
        } catch (err) {
          log.warn("mcp", `Health check: removing dead server "${name}" (restart threw): ${err}`);
          this.servers.delete(name);
        }
      }
    }, 30_000);
    // Unref so the interval doesn't prevent process exit
    if (typeof interval.unref === "function") interval.unref();
    this.healthCheckInterval = interval;
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
