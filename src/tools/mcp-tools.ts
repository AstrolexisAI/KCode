// KCode - MCP Tool Integration
// Factory functions for creating tool definitions from MCP server schemas,
// handlers for forwarding tool calls, and MCP resource operation tools

import type { ToolDefinition, ToolResult, ToolHandler } from "../core/types";
import { getMcpManager, type McpManager } from "../core/mcp";

// ─── MCP Tool Name Parsing ─────────────────────────────────────

const MCP_TOOL_PREFIX = "mcp__";

/** Check if a tool name is an MCP-proxied tool. */
export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** Extract serverName and toolName from an MCP-prefixed tool name. */
export function parseMcpToolName(name: string): { serverName: string; toolName: string } | null {
  if (!isMcpTool(name)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const separatorIndex = rest.indexOf("__");
  if (separatorIndex === -1) return null;
  return {
    serverName: rest.slice(0, separatorIndex),
    toolName: rest.slice(separatorIndex + 2),
  };
}

/** Build an MCP tool name from server and tool names. */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

// ─── MCP Tool Definition Factory ───────────────────────────────

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Create a KCode ToolDefinition from an MCP server's tool schema.
 * The tool name follows the convention: mcp__<serverName>__<toolName>
 */
export function mcpToolDefinition(
  serverName: string,
  tool: McpToolSchema,
): ToolDefinition {
  return {
    name: buildMcpToolName(serverName, tool.name),
    description: `[MCP: ${serverName}] ${tool.description ?? `Tool "${tool.name}" from MCP server "${serverName}"`}`,
    input_schema: tool.inputSchema ?? { type: "object", properties: {} },
  };
}

/**
 * Create a ToolHandler that forwards tool calls to the appropriate MCP server.
 * Handles server health checks and automatic restart on crash.
 */
export function executeMcpTool(
  serverName: string,
  toolName: string,
  mcpManager?: McpManager,
): ToolHandler {
  return async (input: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const manager = mcpManager ?? getMcpManager();
      const result = await manager.callTool(serverName, toolName, input);
      return { tool_use_id: "", content: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { tool_use_id: "", content: `MCP tool error: ${msg}`, is_error: true };
    }
  };
}

// ─── List MCP Resources ─────────────────────────────────────────

export const listMcpResourcesDefinition: ToolDefinition = {
  name: "ListMcpResources",
  description:
    "List all available resources from connected MCP servers. " +
    "Returns resource URIs, names, descriptions, and which server provides them.",
  input_schema: {
    type: "object",
    properties: {
      server_name: {
        type: "string",
        description: "Optional: filter resources by server name. If omitted, lists resources from all servers.",
      },
    },
    required: [],
  },
};

export async function executeListMcpResources(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const manager = getMcpManager();
    const serverFilter = input.server_name as string | undefined;
    const allResources = manager.getAllResources();

    const filtered = serverFilter
      ? allResources.filter((r) => r.serverName === serverFilter)
      : allResources;

    if (filtered.length === 0) {
      const servers = manager.getServerNames();
      if (servers.length === 0) {
        return {
          tool_use_id: "",
          content: "No MCP servers are connected. Configure servers in .kcode/settings.json under \"mcpServers\".",
        };
      }
      return {
        tool_use_id: "",
        content: serverFilter
          ? `No resources found from MCP server "${serverFilter}". Connected servers: ${servers.join(", ")}`
          : `No resources available from any connected MCP server. Connected servers: ${servers.join(", ")}`,
      };
    }

    const lines = filtered.map((r) => {
      const parts = [
        `  Server: ${r.serverName}`,
        `  URI: ${r.resource.uri}`,
        `  Name: ${r.resource.name}`,
      ];
      if (r.resource.description) parts.push(`  Description: ${r.resource.description}`);
      if (r.resource.mimeType) parts.push(`  MIME Type: ${r.resource.mimeType}`);
      return parts.join("\n");
    });

    return {
      tool_use_id: "",
      content: `Found ${filtered.length} MCP resource(s):\n\n${lines.join("\n\n")}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { tool_use_id: "", content: `Error listing MCP resources: ${msg}`, is_error: true };
  }
}

// ─── Read MCP Resource ──────────────────────────────────────────

export const readMcpResourceDefinition: ToolDefinition = {
  name: "ReadMcpResource",
  description:
    "Read the contents of a specific resource from an MCP server. " +
    "Use ListMcpResources first to discover available resource URIs.",
  input_schema: {
    type: "object",
    properties: {
      server_name: {
        type: "string",
        description: "The name of the MCP server that provides the resource.",
      },
      uri: {
        type: "string",
        description: "The URI of the resource to read.",
      },
    },
    required: ["server_name", "uri"],
  },
};

export async function executeReadMcpResource(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const serverName = input.server_name as string;
  const uri = input.uri as string;

  if (!serverName || !uri) {
    return {
      tool_use_id: "",
      content: "Both server_name and uri are required.",
      is_error: true,
    };
  }

  try {
    const manager = getMcpManager();
    const contents = await manager.readResource(serverName, uri);

    if (contents.length === 0) {
      return { tool_use_id: "", content: `Resource "${uri}" returned no content.` };
    }

    const parts = contents.map((c) => {
      if (c.text) return c.text;
      if (c.blob) return `[Binary content, ${c.blob.length} bytes base64, mime: ${c.mimeType ?? "unknown"}]`;
      return JSON.stringify(c);
    });

    return { tool_use_id: "", content: parts.join("\n") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { tool_use_id: "", content: `Error reading MCP resource: ${msg}`, is_error: true };
  }
}
