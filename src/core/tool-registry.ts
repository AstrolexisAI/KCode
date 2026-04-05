// KCode - Tool Registry
// Manages tool definitions and dispatches execution

import type { ToolDefinition, ToolHandler, ToolResult } from "./types";

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(name: string, definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(name, { definition, handler });
  }

  async execute(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        tool_use_id: "",
        content: `Error: Unknown tool "${name}"`,
        is_error: true,
      };
    }

    try {
      const result = await tool.handler(input);
      // Normalize: some tools return a plain string instead of ToolResult
      if (typeof result === "string") {
        return { tool_use_id: "", content: result, is_error: false };
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        tool_use_id: "",
        content: `Error executing ${name}: ${message}`,
        is_error: true,
      };
    }
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Create a new registry containing only the tools whose names are in the allowlist.
   * Used by HTTP server to restrict remote sessions to read-only tools.
   */
  filterTo(allowed: Set<string>): ToolRegistry {
    const filtered = new ToolRegistry();
    for (const [name, tool] of this.tools) {
      if (allowed.has(name)) {
        filtered.register(name, tool.definition, tool.handler);
      }
    }
    return filtered;
  }

  /** Read-only tools that are safe to execute in parallel. */
  static readonly PARALLEL_SAFE = new Set([
    "Read",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "TaskList",
    "TaskGet",
  ]);

  /**
   * Check if a tool is safe to run in parallel with other tools.
   */
  isParallelSafe(name: string): boolean {
    return ToolRegistry.PARALLEL_SAFE.has(name);
  }

  /**
   * Execute multiple tool calls in parallel (only for parallel-safe tools).
   * Returns results in the same order as the input calls.
   */
  async executeParallel(
    calls: Array<{ name: string; input: Record<string, unknown> }>,
  ): Promise<ToolResult[]> {
    return Promise.all(calls.map((c) => this.execute(c.name, c.input)));
  }
}

interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}
