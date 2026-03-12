// KCode - Tool Registry
// Manages tool definitions and dispatches execution

import type { ToolDefinition, ToolResult, ToolHandler } from "./types";

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
      return await tool.handler(input);
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
}

interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}
