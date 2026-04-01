// KCode - NotebookEdit Tool
// Read and edit Jupyter .ipynb notebook files

import { readFileSync, writeFileSync } from "node:fs";
import type { ToolDefinition, ToolResult } from "../core/types";

export interface NotebookEditInput {
  file_path: string;
  operation: "read" | "replace" | "insert" | "delete" | "move" | "clear_outputs";
  cell_index?: number;
  cell_type?: "code" | "markdown";
  content?: string;
  /** Find cell by content match (alternative to cell_index) */
  cell_contains?: string;
  /** Target index for move operation */
  target_index?: number;
}

interface NotebookCell {
  cell_type: string;
  source: string[];
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

export const notebookEditDefinition: ToolDefinition = {
  name: "NotebookEdit",
  description:
    "Read or edit Jupyter .ipynb notebook files. Supports replace, insert, and delete operations on cells.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the .ipynb file" },
      operation: {
        type: "string",
        enum: ["read", "replace", "insert", "delete", "move", "clear_outputs"],
        description: "Operation to perform on the notebook",
      },
      cell_index: {
        type: "number",
        description:
          "Zero-based index of the cell to operate on (required for replace/delete, insertion point for insert)",
      },
      cell_contains: {
        type: "string",
        description: "Find cell by content match (alternative to cell_index)",
      },
      cell_type: {
        type: "string",
        enum: ["code", "markdown"],
        description: "Cell type for insert/replace operations (default: code)",
      },
      content: {
        type: "string",
        description: "Cell content for insert/replace operations",
      },
      target_index: {
        type: "number",
        description: "Target position for move operation",
      },
    },
    required: ["file_path", "operation"],
  },
};

function readNotebook(filePath: string): Notebook {
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as Notebook;
}

function writeNotebook(filePath: string, notebook: Notebook): void {
  writeFileSync(filePath, JSON.stringify(notebook, null, 1) + "\n", "utf-8");
}

function formatCellForDisplay(cell: NotebookCell, index: number): string {
  const source = cell.source.join("");
  const typeLabel = cell.cell_type === "code" ? "Code" : "Markdown";
  let display = `--- Cell ${index} [${typeLabel}] ---\n${source}`;

  if (cell.cell_type === "code" && cell.outputs && cell.outputs.length > 0) {
    const outputTexts: string[] = [];
    for (const out of cell.outputs as Array<Record<string, unknown>>) {
      if (out.text) {
        outputTexts.push((out.text as string[]).join(""));
      } else if (out.data && typeof out.data === "object") {
        const data = out.data as Record<string, string[]>;
        if (data["text/plain"]) {
          outputTexts.push(data["text/plain"].join(""));
        }
      }
    }
    if (outputTexts.length > 0) {
      display += `\n[Output]\n${outputTexts.join("\n")}`;
    }
  }

  return display;
}

/** Resolve cell index from explicit index or content search */
function resolveCell(
  notebook: Notebook,
  cellIndex: number | undefined,
  cellContains: string | undefined,
): number | null {
  if (cellIndex !== undefined) return cellIndex;
  if (cellContains) {
    const idx = notebook.cells.findIndex((c) => c.source.join("").includes(cellContains));
    return idx >= 0 ? idx : null;
  }
  return null;
}

function makeCell(content: string, cellType: string): NotebookCell {
  // Split content into lines preserving newlines
  const lines = content
    .split("\n")
    .map((line, i, arr) => (i < arr.length - 1 ? line + "\n" : line));

  const cell: NotebookCell = {
    cell_type: cellType,
    source: lines,
    metadata: {},
  };

  if (cellType === "code") {
    cell.outputs = [];
    cell.execution_count = null;
  }

  return cell;
}

export async function executeNotebookEdit(input: Record<string, unknown>): Promise<ToolResult> {
  const opts = input as unknown as NotebookEditInput;
  const { file_path, operation, cell_index, cell_type, content, cell_contains, target_index } =
    opts;

  try {
    if (operation === "read") {
      const notebook = readNotebook(file_path);
      const display = notebook.cells.map((cell, i) => formatCellForDisplay(cell, i)).join("\n\n");
      return {
        tool_use_id: "",
        content: `Notebook: ${file_path} (${notebook.cells.length} cells)\n\n${display}`,
      };
    }

    if (operation === "replace") {
      if (content === undefined) {
        return {
          tool_use_id: "",
          content: "Error: content is required for replace",
          is_error: true,
        };
      }

      const notebook = readNotebook(file_path);
      const idx = resolveCell(notebook, cell_index, cell_contains);
      if (idx === null || idx < 0 || idx >= notebook.cells.length) {
        return { tool_use_id: "", content: "Error: cell not found", is_error: true };
      }

      const type = cell_type ?? notebook.cells[idx]!.cell_type;
      notebook.cells[idx] = makeCell(content, type);
      writeNotebook(file_path, notebook);

      return {
        tool_use_id: "",
        content: `Replaced cell ${idx} in ${file_path}`,
      };
    }

    if (operation === "insert") {
      if (content === undefined) {
        return {
          tool_use_id: "",
          content: "Error: content is required for insert",
          is_error: true,
        };
      }

      const notebook = readNotebook(file_path);
      const insertAt = cell_index ?? notebook.cells.length;

      if (insertAt < 0 || insertAt > notebook.cells.length) {
        return {
          tool_use_id: "",
          content: `Error: cell_index ${insertAt} out of range (0-${notebook.cells.length})`,
          is_error: true,
        };
      }

      const type = cell_type ?? "code";
      const newCell = makeCell(content, type);
      notebook.cells.splice(insertAt, 0, newCell);
      writeNotebook(file_path, notebook);

      return {
        tool_use_id: "",
        content: `Inserted ${type} cell at index ${insertAt} in ${file_path} (now ${notebook.cells.length} cells)`,
      };
    }

    if (operation === "delete") {
      const notebook = readNotebook(file_path);
      const idx = resolveCell(notebook, cell_index, cell_contains);
      if (idx === null || idx < 0 || idx >= notebook.cells.length) {
        return { tool_use_id: "", content: "Error: cell not found", is_error: true };
      }

      notebook.cells.splice(idx, 1);
      writeNotebook(file_path, notebook);

      return {
        tool_use_id: "",
        content: `Deleted cell ${idx} from ${file_path} (now ${notebook.cells.length} cells)`,
      };
    }

    if (operation === "move") {
      const notebook = readNotebook(file_path);
      const idx = resolveCell(notebook, cell_index, cell_contains);
      if (idx === null || idx < 0 || idx >= notebook.cells.length) {
        return { tool_use_id: "", content: "Error: source cell not found", is_error: true };
      }
      const targetIdx = target_index ?? 0;
      if (targetIdx < 0 || targetIdx >= notebook.cells.length) {
        return {
          tool_use_id: "",
          content: `Error: target_index ${targetIdx} out of range`,
          is_error: true,
        };
      }

      const [cell] = notebook.cells.splice(idx, 1);
      notebook.cells.splice(targetIdx, 0, cell!);
      writeNotebook(file_path, notebook);

      return {
        tool_use_id: "",
        content: `Moved cell from ${idx} to ${targetIdx} in ${file_path}`,
      };
    }

    if (operation === "clear_outputs") {
      const notebook = readNotebook(file_path);

      if (cell_index !== undefined || cell_contains !== undefined) {
        const idx = resolveCell(notebook, cell_index, cell_contains);
        if (idx === null || idx < 0 || idx >= notebook.cells.length) {
          return { tool_use_id: "", content: "Error: cell not found", is_error: true };
        }
        const cell = notebook.cells[idx]!;
        if (cell.cell_type === "code") {
          cell.outputs = [];
          cell.execution_count = null;
        }
        writeNotebook(file_path, notebook);
        return { tool_use_id: "", content: `Cleared outputs of cell ${idx} in ${file_path}` };
      }

      // Clear all outputs
      let cleared = 0;
      for (const cell of notebook.cells) {
        if (cell.cell_type === "code") {
          cell.outputs = [];
          cell.execution_count = null;
          cleared++;
        }
      }
      writeNotebook(file_path, notebook);
      return {
        tool_use_id: "",
        content: `Cleared outputs of ${cleared} code cells in ${file_path}`,
      };
    }

    return {
      tool_use_id: "",
      content: `Error: Unknown operation "${operation}". Use: read, replace, insert, delete, move, clear_outputs`,
      is_error: true,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      tool_use_id: "",
      content: `Error: ${msg}`,
      is_error: true,
    };
  }
}
