// KCode - Tool Registration
// Registers all built-in tools with the registry, plus MCP-discovered tools

import { ToolRegistry } from "../core/tool-registry";
import { getMcpManager, type McpManager } from "../core/mcp";
import { bashDefinition, executeBash } from "./bash";
import { readDefinition, executeRead } from "./read";
import { writeDefinition, executeWrite } from "./write";
import { editDefinition, executeEdit } from "./edit";
import { globDefinition, executeGlob } from "./glob";
import { grepDefinition, executeGrep } from "./grep";
import { agentDefinition, executeAgent } from "./agent";
import { webFetchDefinition, executeWebFetch } from "./web-fetch";
import { webSearchDefinition, executeWebSearch } from "./web-search";
import { notebookEditDefinition, executeNotebookEdit } from "./notebook";
import {
  taskCreateDefinition, executeTaskCreate,
  taskListDefinition, executeTaskList,
  taskGetDefinition, executeTaskGet,
  taskUpdateDefinition, executeTaskUpdate,
  taskStopDefinition, executeTaskStop,
} from "./tasks";
import {
  listMcpResourcesDefinition, executeListMcpResources,
  readMcpResourceDefinition, executeReadMcpResource,
} from "./mcp-tools";
import { learnDefinition, executeLearn } from "./learn";

/**
 * Register all built-in tools and optionally MCP-discovered tools.
 * If an McpManager is provided, its discovered tools are registered
 * dynamically after the built-in tools.
 */
export function registerBuiltinTools(mcpManager?: McpManager): ToolRegistry {
  const registry = new ToolRegistry();

  // Built-in tools
  registry.register("Bash", bashDefinition, executeBash);
  registry.register("Read", readDefinition, executeRead);
  registry.register("Write", writeDefinition, executeWrite);
  registry.register("Edit", editDefinition, executeEdit);
  registry.register("Glob", globDefinition, executeGlob);
  registry.register("Grep", grepDefinition, executeGrep);
  registry.register("Agent", agentDefinition, executeAgent);
  registry.register("WebFetch", webFetchDefinition, executeWebFetch);
  registry.register("WebSearch", webSearchDefinition, executeWebSearch);
  registry.register("NotebookEdit", notebookEditDefinition, executeNotebookEdit);
  registry.register("TaskCreate", taskCreateDefinition, executeTaskCreate);
  registry.register("TaskList", taskListDefinition, executeTaskList);
  registry.register("TaskGet", taskGetDefinition, executeTaskGet);
  registry.register("TaskUpdate", taskUpdateDefinition, executeTaskUpdate);
  registry.register("TaskStop", taskStopDefinition, executeTaskStop);

  // Learning / long-term memory
  registry.register("Learn", learnDefinition, executeLearn);

  // MCP resource tools (always available, gracefully handle no servers)
  registry.register("ListMcpResources", listMcpResourcesDefinition, executeListMcpResources);
  registry.register("ReadMcpResource", readMcpResourceDefinition, executeReadMcpResource);

  // MCP server-discovered tools (registered dynamically)
  if (mcpManager) {
    mcpManager.registerTools(registry);
  }

  return registry;
}

/**
 * Initialize MCP servers and register their tools into an existing registry.
 * Call this after registerBuiltinTools() once the working directory is known.
 * This is async because it spawns MCP server processes and waits for tool discovery.
 */
export async function registerMcpTools(registry: ToolRegistry, cwd: string): Promise<void> {
  const manager = getMcpManager();
  try {
    await manager.loadAndStart(cwd);
    manager.registerTools(registry);

    const serverNames = manager.getServerNames();
    if (serverNames.length > 0) {
      const toolCount = registry.getToolNames().filter((n) => n.startsWith("mcp__")).length;
      console.error(`[MCP] Connected to ${serverNames.length} server(s), registered ${toolCount} tool(s)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MCP] Failed to initialize MCP servers: ${msg}`);
  }
}
