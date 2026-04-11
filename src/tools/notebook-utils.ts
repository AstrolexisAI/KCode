// KCode - Notebook Utilities
// Parsing, serialization, and cell lookup helpers for Jupyter .ipynb files.

export interface JupyterNotebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: {
    kernelspec?: { display_name: string; language: string; name: string };
    language_info?: { name: string; version: string };
    [key: string]: unknown;
  };
  cells: JupyterCell[];
}

export interface JupyterCell {
  cell_type: "code" | "markdown" | "raw";
  source: string[];
  metadata: Record<string, unknown>;
  outputs?: CellOutput[];
  execution_count?: number | null;
  id?: string;
}

export interface CellOutput {
  output_type: "stream" | "display_data" | "execute_result" | "error";
  text?: string[];
  data?: Record<string, unknown>;
  name?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

/** Parse .ipynb JSON content into a typed notebook structure */
export function parseNotebook(content: string): JupyterNotebook {
  // Catch malformed .ipynb JSON and re-raise with a useful diagnostic.
  // Raw SyntaxError from JSON.parse dumps its position offset but no
  // context about which file the caller was trying to read, so the
  // user sees "Unexpected token } in JSON at position 1234" instead of
  // "Invalid notebook JSON: ...".
  let nb: unknown;
  try {
    nb = JSON.parse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid notebook JSON: ${msg}`);
  }
  if (typeof nb !== "object" || nb === null) {
    throw new Error("Invalid notebook: root is not an object");
  }
  const root = nb as { nbformat?: unknown };
  if (root.nbformat !== 4) {
    throw new Error(`Only nbformat 4 is supported, found: ${String(root.nbformat)}`);
  }
  return nb as JupyterNotebook;
}

/** Serialize notebook back to JSON, preserving Jupyter's indent=1 convention */
export function serializeNotebook(nb: JupyterNotebook): string {
  return JSON.stringify(nb, null, 1) + "\n";
}

/** Find a cell by index or by content substring match */
export function findCell(
  nb: JupyterNotebook,
  query: { index?: number; contains?: string },
): number {
  if (query.index !== undefined) return query.index;
  if (query.contains) {
    return nb.cells.findIndex((c) => c.source.join("").includes(query.contains!));
  }
  return -1;
}

/** Split content string into Jupyter source line format */
export function contentToSource(content: string): string[] {
  return content.split("\n").map((line, i, arr) => (i < arr.length - 1 ? line + "\n" : line));
}

/** Join Jupyter source lines back to a string */
export function sourceToContent(source: string[]): string {
  return source.join("");
}

/** Create a new cell with proper defaults */
export function createCell(
  content: string,
  cellType: "code" | "markdown" | "raw" = "code",
): JupyterCell {
  const cell: JupyterCell = {
    cell_type: cellType,
    source: contentToSource(content),
    metadata: {},
  };
  if (cellType === "code") {
    cell.outputs = [];
    cell.execution_count = null;
  }
  return cell;
}

/** Get a human-readable summary of a notebook */
export function notebookSummary(nb: JupyterNotebook): string {
  const codeCells = nb.cells.filter((c) => c.cell_type === "code").length;
  const mdCells = nb.cells.filter((c) => c.cell_type === "markdown").length;
  const kernel = nb.metadata.kernelspec?.display_name ?? "unknown";
  return `${nb.cells.length} cells (${codeCells} code, ${mdCells} markdown), kernel: ${kernel}`;
}
