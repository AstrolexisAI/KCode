// KCode - LSP Tool
// Exposes language server queries (go-to-definition, find-references, hover, symbols)

import type { ToolDefinition, ToolResult } from "../core/types";

export const lspDefinition: ToolDefinition = {
  name: "LSP",
  description:
    "Query language servers for code intelligence. Actions: " +
    "'definition' (go to definition), 'references' (find all references), " +
    "'hover' (type/doc info), 'symbols' (list file symbols), 'diagnostics' (errors/warnings). " +
    "Requires a running language server (TypeScript, Python, Go, Rust).",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["definition", "references", "hover", "symbols", "diagnostics"],
        description: "LSP query to perform",
      },
      file_path: {
        type: "string",
        description: "Absolute path to the file",
      },
      line: {
        type: "number",
        description: "1-based line number (required for definition/references/hover)",
      },
      column: {
        type: "number",
        description: "1-based column number (required for definition/references/hover)",
      },
    },
    required: ["action", "file_path"],
  },
};

interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

interface LspSymbol {
  name: string;
  kind: number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  children?: LspSymbol[];
}

const SYMBOL_KINDS: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

function formatLocation(loc: LspLocation): string {
  const file = loc.uri.replace("file://", "");
  return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
}

function flattenSymbols(symbols: LspSymbol[], indent = 0): string[] {
  const lines: string[] = [];
  for (const sym of symbols) {
    const kind = SYMBOL_KINDS[sym.kind] ?? `kind:${sym.kind}`;
    const prefix = "  ".repeat(indent);
    lines.push(`${prefix}${kind} ${sym.name} (line ${sym.range.start.line + 1})`);
    if (sym.children) {
      lines.push(...flattenSymbols(sym.children, indent + 1));
    }
  }
  return lines;
}

export async function executeLsp(input: Record<string, unknown>): Promise<ToolResult> {
  const action = String(input.action ?? "").trim();
  const filePath = String(input.file_path ?? "").trim();
  const line = Number(input.line ?? 0);
  const column = Number(input.column ?? 0);

  if (!filePath) {
    return { tool_use_id: "", content: "Error: file_path is required.", is_error: true };
  }

  try {
    const { getLspManager } = await import("../core/lsp.js");
    const lsp = getLspManager();

    if (!lsp || !lsp.isActive()) {
      return {
        tool_use_id: "",
        content:
          "Error: No language servers are running. LSP requires a compatible language server (typescript-language-server, pyright, gopls, rust-analyzer) to be installed.",
        is_error: true,
      };
    }

    if (action === "diagnostics") {
      const diags = lsp.getDiagnostics(filePath);
      if (diags.length === 0) {
        return { tool_use_id: "", content: `No diagnostics for ${filePath}.` };
      }
      const lines = diags.map(
        (d) => `  L${d.line}:${d.column} [${d.severity}] ${d.message} (${d.source})`,
      );
      return {
        tool_use_id: "",
        content: `Diagnostics for ${filePath} (${diags.length}):\n${lines.join("\n")}`,
      };
    }

    if (action === "symbols") {
      const result = (await lsp.query(filePath, "textDocument/documentSymbol")) as
        | LspSymbol[]
        | null;
      if (!result || result.length === 0) {
        return { tool_use_id: "", content: `No symbols found in ${filePath}.` };
      }
      const lines = flattenSymbols(result);
      return {
        tool_use_id: "",
        content: `Symbols in ${filePath} (${lines.length}):\n${lines.join("\n")}`,
      };
    }

    // Position-based queries require line and column
    if (!line || !column) {
      return {
        tool_use_id: "",
        content: `Error: line and column are required for "${action}".`,
        is_error: true,
      };
    }

    // LSP uses 0-based positions
    const position = { line: line - 1, character: column - 1 };

    if (action === "definition") {
      const result = await lsp.query(filePath, "textDocument/definition", position);
      if (!result) {
        return {
          tool_use_id: "",
          content: `No definition found at ${filePath}:${line}:${column}.`,
        };
      }

      const locations = Array.isArray(result) ? (result as LspLocation[]) : [result as LspLocation];
      if (locations.length === 0) {
        return {
          tool_use_id: "",
          content: `No definition found at ${filePath}:${line}:${column}.`,
        };
      }

      const formatted = locations.map(formatLocation);
      return {
        tool_use_id: "",
        content: `Definition(s) for symbol at ${filePath}:${line}:${column}:\n${formatted.map((f) => `  ${f}`).join("\n")}`,
      };
    }

    if (action === "references") {
      const result = (await lsp.query(filePath, "textDocument/references", position)) as
        | LspLocation[]
        | null;
      if (!result || result.length === 0) {
        return {
          tool_use_id: "",
          content: `No references found at ${filePath}:${line}:${column}.`,
        };
      }

      const formatted = result.slice(0, 30).map(formatLocation);
      const extra = result.length > 30 ? `\n  ... +${result.length - 30} more` : "";
      return {
        tool_use_id: "",
        content: `References for symbol at ${filePath}:${line}:${column} (${result.length}):\n${formatted.map((f) => `  ${f}`).join("\n")}${extra}`,
      };
    }

    if (action === "hover") {
      const result = (await lsp.query(filePath, "textDocument/hover", position)) as {
        contents: string | { value: string } | Array<string | { value?: string }>;
      } | null;
      if (!result?.contents) {
        return { tool_use_id: "", content: `No hover info at ${filePath}:${line}:${column}.` };
      }

      let text: string;
      if (typeof result.contents === "string") {
        text = result.contents;
      } else if (result.contents.value) {
        text = result.contents.value;
      } else if (Array.isArray(result.contents)) {
        text = result.contents
          .map((c: string | { value?: string }) => (typeof c === "string" ? c : (c.value ?? "")))
          .join("\n");
      } else {
        text = JSON.stringify(result.contents);
      }

      return { tool_use_id: "", content: `Hover at ${filePath}:${line}:${column}:\n${text}` };
    }

    return { tool_use_id: "", content: `Error: Unknown action "${action}".`, is_error: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { tool_use_id: "", content: `LSP error: ${msg}`, is_error: true };
  }
}
