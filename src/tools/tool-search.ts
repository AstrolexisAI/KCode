// KCode - ToolSearch
// Deferred tool loading — search for tools by keyword and retrieve their schemas

import type { ToolDefinition, ToolResult } from "../core/types";

// ─── Deferred Tool Registry ────────────────────────────────────

interface DeferredTool {
  name: string;
  description: string;
  definition: ToolDefinition;
}

const deferredTools: Map<string, DeferredTool> = new Map();

export function addDeferredTool(name: string, definition: ToolDefinition): void {
  deferredTools.set(name, {
    name,
    description: definition.description,
    definition,
  });
}

export function getDeferredToolCount(): number {
  return deferredTools.size;
}

export function getDeferredToolNames(): string[] {
  return Array.from(deferredTools.keys());
}

export function clearDeferredTools(): void {
  deferredTools.clear();
}

// ─── Tool Definition ───────────────────────────────────────────

export const toolSearchDefinition: ToolDefinition = {
  name: "ToolSearch",
  description:
    "Search for available tools by keyword or fetch specific tool schemas. " +
    "Use 'select:ToolA,ToolB' to fetch exact tools by name, or provide keywords " +
    "to search tool names and descriptions. Returns full JSON schema definitions " +
    "for matched tools so they can be invoked.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          'Search query. Use "select:Name1,Name2" for exact lookup, or keywords to search.',
      },
      max_results: {
        type: "number",
        description: "Maximum number of results to return (default: 5)",
      },
    },
    required: ["query"],
  },
};

// ─── Execution ─────────────────────────────────────────────────

export async function executeToolSearch(input: Record<string, unknown>): Promise<ToolResult> {
  const query = String(input.query ?? "").trim();
  const maxResults = Math.min(Math.max(Number(input.max_results) || 5, 1), 20);

  if (!query) {
    return { tool_use_id: "", content: "Error: query is required", is_error: true };
  }

  if (deferredTools.size === 0) {
    return {
      tool_use_id: "",
      content: "No deferred tools available. All tools are already loaded.",
    };
  }

  // Exact select mode: "select:ToolA,ToolB"
  if (query.startsWith("select:")) {
    const names = query
      .slice(7)
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    return { tool_use_id: "", content: selectByNames(names) };
  }

  // Keyword search
  return { tool_use_id: "", content: searchByKeywords(query, maxResults) };
}

function selectByNames(names: string[]): string {
  const results: string[] = [];
  const notFound: string[] = [];

  for (const name of names) {
    const tool = deferredTools.get(name);
    if (tool) {
      results.push(formatToolSchema(tool));
    } else {
      // Case-insensitive fallback
      const match = Array.from(deferredTools.values()).find(
        (t) => t.name.toLowerCase() === name.toLowerCase(),
      );
      if (match) {
        results.push(formatToolSchema(match));
      } else {
        notFound.push(name);
      }
    }
  }

  const parts: string[] = [];
  if (results.length > 0) {
    parts.push("<functions>");
    parts.push(...results);
    parts.push("</functions>");
  }
  if (notFound.length > 0) {
    parts.push(`\nNot found: ${notFound.join(", ")}`);
    parts.push(`Available deferred tools: ${getDeferredToolNames().join(", ")}`);
  }
  return parts.join("\n");
}

function searchByKeywords(query: string, maxResults: number): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored: Array<{ tool: DeferredTool; score: number }> = [];

  for (const tool of deferredTools.values()) {
    let score = 0;
    const nameLower = tool.name.toLowerCase();
    const descLower = tool.description.toLowerCase();

    for (const term of terms) {
      if (nameLower.includes(term)) {
        score += nameLower === term ? 10 : 5;
      }
      if (descLower.includes(term)) {
        score += 2;
      }
    }

    if (score > 0) {
      scored.push({ tool, score });
    }
  }

  if (scored.length === 0) {
    return `No tools matched "${query}". Available: ${getDeferredToolNames().join(", ")}`;
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxResults);

  const parts = ["<functions>"];
  for (const { tool } of top) {
    parts.push(formatToolSchema(tool));
  }
  parts.push("</functions>");

  if (scored.length > maxResults) {
    parts.push(`\n(${scored.length - maxResults} more results not shown)`);
  }

  return parts.join("\n");
}

function formatToolSchema(tool: DeferredTool): string {
  const schema = {
    description: tool.definition.description,
    name: tool.name,
    parameters: tool.definition.input_schema,
  };
  return `<function>${JSON.stringify(schema)}</function>`;
}
