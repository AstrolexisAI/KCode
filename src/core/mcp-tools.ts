// KCode - MCP Tool Discovery and Adaptation
// Tool filtering, registration, and conversion from MCP schemas to KCode ToolDefinitions

import type { ToolDefinition, ToolResult } from "./types";
import type { ToolRegistry } from "./tool-registry";
import type { McpServerConfig, McpConnection } from "./mcp-client";
import { log } from "./logger";

// ─── Tool Filtering ─────────────────────────────────────────────

/** Simple glob match for MCP tool filtering (supports * wildcard) */
export function mcpToolGlobMatch(pattern: string, name: string): boolean {
  const regex = pattern.replace(/([.+^${}()|[\]\\])/g, "\\$1").replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`, "i").test(name);
}

/** Check if a tool name is allowed by a server's allowedTools/blockedTools config */
export function isToolAllowedByConfig(toolName: string, config: McpServerConfig): boolean {
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

// ─── Tool Registration ──────────────────────────────────────────

/**
 * Register all discovered MCP tools from a set of servers into a ToolRegistry.
 */
export function registerMcpTools(
  servers: Map<string, McpConnection>,
  serverConfigs: Map<string, McpServerConfig>,
  registry: ToolRegistry,
): void {
  for (const [serverName, connection] of servers) {
    const config = serverConfigs.get(serverName);
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
 * Discover all available tools across all connected MCP servers.
 * Returns ToolDefinition[] ready for use with the AI model.
 */
export function discoverMcpTools(
  servers: Map<string, McpConnection>,
  serverConfigs: Map<string, McpServerConfig>,
): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  for (const [serverName, connection] of servers) {
    const config = serverConfigs.get(serverName);
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
