// KCode - Read Tool
// Reads file contents with line numbers, offset, and limit support
// Supports images (PNG, JPG, GIF, WEBP), PDFs, Office documents, and Jupyter notebooks

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../core/types";
import { getToolWorkspace } from "./workspace";

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_PDF_PAGES = 20;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const PDF_EXTENSION = ".pdf";
const NOTEBOOK_EXTENSION = ".ipynb";
const OFFICE_EXTENSIONS = new Set([
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".pptx",
  ".ppt",
  ".odt",
  ".ods",
  ".odp",
]);

export const readDefinition: ToolDefinition = {
  name: "Read",
  description:
    "Reads a file from the local filesystem. You can access any file directly by using this tool.\n" +
    "Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\n" +
    "Usage:\n" +
    "- The file_path parameter must be an absolute path, not a relative path\n" +
    "- By default, it reads up to 2000 lines starting from the beginning of the file\n" +
    "- When you already know which part of the file you need, only read that part. This can be important for larger files.\n" +
    "- Results are returned using cat -n format, with line numbers starting at 1\n" +
    "- This tool allows you to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually.\n" +
    "- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: \"1-5\"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.\n" +
    "- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.\n" +
    "- This tool can read Office documents (.docx, .xlsx, .pptx, .odt, .ods, .odp) and returns extracted text.\n" +
    "- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.\n" +
    "- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "The absolute path to the file to read" },
      offset: {
        type: "number",
        description:
          "The line number to start reading from. Only provide if the file is too large to read at once",
      },
      limit: {
        type: "number",
        description:
          "The number of lines to read. Only provide if the file is too large to read at once.",
      },
      pages: {
        type: "string",
        description:
          'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.',
      },
    },
    required: ["file_path"],
  },
};

// ─── Image Reading ──────────────────────────────────────────────

function readImage(filePath: string): ToolResult {
  const stat = statSync(filePath);
  const buffer = readFileSync(filePath);
  const base64 = buffer.toString("base64");
  const ext = extname(filePath).toLowerCase().replace(".", "");
  const mimeType = ext === "jpg" ? "jpeg" : ext;

  // Try to get image dimensions from binary header
  const dimensions = getImageDimensions(buffer, ext);
  const dimStr = dimensions ? `, ${dimensions.width}x${dimensions.height}` : "";

  return {
    tool_use_id: "",
    content:
      `[Image: ${filePath}${dimStr}, ${stat.size} bytes, ${mimeType}]\n` +
      `Note: For detailed image analysis (OCR, content description), the mnemo:scanner model at localhost:8092 can process this image.\n` +
      `data:image/${mimeType};base64,${base64}`,
  };
}

function getImageDimensions(buffer: Buffer, ext: string): { width: number; height: number } | null {
  try {
    if (ext === "png" && buffer.length >= 24) {
      // PNG: width at offset 16, height at offset 20 (big-endian uint32)
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }

    if ((ext === "jpg" || ext === "jpeg") && buffer.length >= 2) {
      // JPEG: scan for SOF0/SOF2 markers (0xFF 0xC0 or 0xFF 0xC2)
      let offset = 2;
      while (offset < buffer.length - 8) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        const segLen = buffer.readUInt16BE(offset + 2);
        offset += 2 + segLen;
      }
    }

    if (ext === "gif" && buffer.length >= 10) {
      // GIF: width at offset 6, height at offset 8 (little-endian uint16)
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      return { width, height };
    }

    if (ext === "webp" && buffer.length >= 30) {
      // WEBP: check for VP8 chunk
      const riff = buffer.toString("ascii", 0, 4);
      const webp = buffer.toString("ascii", 8, 12);
      if (riff === "RIFF" && webp === "WEBP") {
        const chunk = buffer.toString("ascii", 12, 16);
        if (chunk === "VP8 " && buffer.length >= 30) {
          // Lossy VP8
          const width = buffer.readUInt16LE(26) & 0x3fff;
          const height = buffer.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
        if (chunk === "VP8L" && buffer.length >= 25) {
          // Lossless VP8L
          const bits = buffer.readUInt32LE(21);
          const width = (bits & 0x3fff) + 1;
          const height = ((bits >> 14) & 0x3fff) + 1;
          return { width, height };
        }
      }
    }
  } catch {
    // If dimension parsing fails, just return null
  }
  return null;
}

// ─── PDF Reading ────────────────────────────────────────────────

function parsePagesParam(pages: string): { first: number; last: number } | null {
  const trimmed = pages.trim();

  // Single page: "3"
  const singleMatch = trimmed.match(/^(\d+)$/);
  if (singleMatch) {
    const page = parseInt(singleMatch[1]!, 10);
    return { first: page, last: page };
  }

  // Range: "1-5"
  const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const first = parseInt(rangeMatch[1]!, 10);
    const last = parseInt(rangeMatch[2]!, 10);
    if (first > last) return null;
    return { first, last };
  }

  return null;
}

function getPdfPageCount(filePath: string): number | null {
  try {
    const output = execFileSync("pdfinfo", [filePath], {
      encoding: "utf-8",
      timeout: 10000,
    });
    const pagesLine =
      output
        .split("\n")
        .find((l) => /^Pages:/i.test(l))
        ?.trim() ?? "";
    const match = pagesLine.match(/Pages:\s*(\d+)/i);
    return match ? parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

function readPdf(filePath: string, pages?: string): ToolResult {
  const stat = statSync(filePath);
  const pageCount = getPdfPageCount(filePath);

  // If large PDF (>10 pages) and no pages parameter, require it
  if (pageCount !== null && pageCount > 10 && !pages) {
    return {
      tool_use_id: "",
      content: `Error: PDF has ${pageCount} pages. For large PDFs (>10 pages), you must specify the "pages" parameter (e.g., "1-5"). Max ${MAX_PDF_PAGES} pages per request.`,
      is_error: true,
    };
  }

  // Parse pages parameter
  let pageRange: { first: number; last: number } | null = null;
  if (pages) {
    pageRange = parsePagesParam(pages);
    if (!pageRange) {
      return {
        tool_use_id: "",
        content: `Error: Invalid pages parameter "${pages}". Use format like "1-5", "3", or "10-20".`,
        is_error: true,
      };
    }

    // Enforce max pages limit
    const requestedPages = pageRange.last - pageRange.first + 1;
    if (requestedPages > MAX_PDF_PAGES) {
      return {
        tool_use_id: "",
        content: `Error: Requested ${requestedPages} pages, but maximum is ${MAX_PDF_PAGES} per request.`,
        is_error: true,
      };
    }
  }

  // Try pdftotext
  try {
    const args = ["-layout"];
    if (pageRange) {
      args.push("-f", String(pageRange.first), "-l", String(pageRange.last));
    }
    args.push(filePath, "-");

    const text = execFileSync("pdftotext", args, {
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const pageInfo = pageCount !== null ? ` (${pageCount} pages total)` : "";
    const rangeInfo = pageRange ? `, showing pages ${pageRange.first}-${pageRange.last}` : "";
    const header = `[PDF: ${filePath}, ${stat.size} bytes${pageInfo}${rangeInfo}]\n\n`;

    return {
      tool_use_id: "",
      content: header + text,
    };
  } catch {
    // pdftotext not available or failed, fall back to base64
    const buffer = readFileSync(filePath);
    const base64 = buffer.toString("base64");
    const pageInfo = pageCount !== null ? `, ${pageCount} pages` : "";

    return {
      tool_use_id: "",
      content: `[PDF: ${filePath}, ${stat.size} bytes${pageInfo}] (pdftotext not available, returning base64)\ndata:application/pdf;base64,${base64}`,
    };
  }
}

// ─── Notebook Reading ───────────────────────────────────────────

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

function formatNotebookOutput(output: Record<string, unknown>): string {
  const outputType = output.output_type as string;

  if (outputType === "stream") {
    const name = (output.name as string) || "stdout";
    const text = Array.isArray(output.text)
      ? (output.text as string[]).join("")
      : String(output.text);
    return `[${name}]\n${text}`;
  }

  if (outputType === "execute_result" || outputType === "display_data") {
    const data = output.data as Record<string, unknown> | undefined;
    if (!data) return "";

    const parts: string[] = [];

    // Prefer text/plain for readability
    if (data["text/plain"]) {
      const text = Array.isArray(data["text/plain"])
        ? (data["text/plain"] as string[]).join("")
        : String(data["text/plain"]);
      parts.push(text);
    }

    // Note image data presence
    if (data["image/png"]) {
      parts.push("[image/png output]");
    }
    if (data["image/jpeg"]) {
      parts.push("[image/jpeg output]");
    }
    if (data["text/html"] && !data["text/plain"]) {
      const html = Array.isArray(data["text/html"])
        ? (data["text/html"] as string[]).join("")
        : String(data["text/html"]);
      parts.push(`[HTML output, ${html.length} chars]`);
    }

    return parts.join("\n");
  }

  if (outputType === "error") {
    const ename = (output.ename as string) || "Error";
    const evalue = (output.evalue as string) || "";
    const traceback = output.traceback as string[] | undefined;
    let result = `[Error: ${ename}: ${evalue}]`;
    if (traceback && traceback.length > 0) {
      // Strip ANSI escape codes from traceback
      const cleanTb = traceback.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
      result += `\n${cleanTb.join("\n")}`;
    }
    return result;
  }

  return `[${outputType} output]`;
}

function readNotebook(filePath: string): ToolResult {
  const raw = readFileSync(filePath, "utf-8");
  const notebook = JSON.parse(raw) as Notebook;

  const kernelInfo = notebook.metadata?.kernelspec
    ? ` (${(notebook.metadata.kernelspec as Record<string, string>).display_name || "unknown kernel"})`
    : "";

  const parts: string[] = [
    `Notebook: ${filePath} — ${notebook.cells.length} cells, nbformat ${notebook.nbformat}.${notebook.nbformat_minor}${kernelInfo}`,
    "",
  ];

  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i]!;
    const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source);
    const typeLabel =
      cell.cell_type === "code"
        ? "Code"
        : cell.cell_type === "markdown"
          ? "Markdown"
          : cell.cell_type;
    const execCount =
      cell.cell_type === "code" && cell.execution_count != null ? ` [${cell.execution_count}]` : "";

    parts.push(`━━━ Cell ${i} [${typeLabel}]${execCount} ━━━`);
    parts.push(source);

    // Render outputs for code cells
    if (cell.cell_type === "code" && cell.outputs && cell.outputs.length > 0) {
      parts.push("");
      parts.push("── Output ──");
      for (const out of cell.outputs as Array<Record<string, unknown>>) {
        const formatted = formatNotebookOutput(out);
        if (formatted) {
          parts.push(formatted);
        }
      }
    }

    parts.push("");
  }

  return {
    tool_use_id: "",
    content: parts.join("\n"),
  };
}

// ─── Office Document Reading ────────────────────────────────────

const OFFICE_FORMAT_LABELS: Record<string, string> = {
  ".docx": "Word Document",
  ".doc": "Word Document (Legacy)",
  ".xlsx": "Excel Spreadsheet",
  ".xls": "Excel Spreadsheet (Legacy)",
  ".pptx": "PowerPoint Presentation",
  ".ppt": "PowerPoint Presentation (Legacy)",
  ".odt": "OpenDocument Text",
  ".ods": "OpenDocument Spreadsheet",
  ".odp": "OpenDocument Presentation",
};

function readOfficeDocument(filePath: string): ToolResult {
  const stat = statSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const label = OFFICE_FORMAT_LABELS[ext] ?? "Office Document";

  // Check if libreoffice is available
  try {
    execFileSync("which", ["libreoffice"], { timeout: 3000 });
  } catch {
    return {
      tool_use_id: "",
      content: `Error: LibreOffice is not installed. Install it to read ${label} files:\n  sudo dnf install libreoffice  # Fedora\n  sudo apt install libreoffice  # Ubuntu/Debian`,
      is_error: true,
    };
  }

  // Convert to plain text in a temp directory
  const tmpDir = mkdtempSync(join(tmpdir(), "kcode-office-"));

  try {
    // For spreadsheets, convert to CSV; for everything else, convert to txt
    const isSpreadsheet = [".xlsx", ".xls", ".ods"].includes(ext);
    const convertFormat = isSpreadsheet ? "csv:Text - txt - csv (StarCalc)" : "txt:Text";

    execSync(
      `libreoffice --headless --convert-to "${convertFormat}" --outdir "${tmpDir}" "${filePath}"`,
      { timeout: 30000, stdio: "pipe" },
    );

    // Find the output file (libreoffice names it based on input filename)
    const outputFiles = readdirSync(tmpDir);
    const outputFile = outputFiles.find((f) => f.endsWith(".txt") || f.endsWith(".csv"));

    if (!outputFile) {
      return {
        tool_use_id: "",
        content: `Error: LibreOffice conversion produced no output for "${filePath}".`,
        is_error: true,
      };
    }

    const text = readFileSync(join(tmpDir, outputFile), "utf-8").trim();

    if (!text) {
      return {
        tool_use_id: "",
        content: `[${label}: ${filePath}, ${stat.size} bytes]\n\n(Document is empty)`,
      };
    }

    const lines = text.split("\n");
    const lineCount = lines.length;

    // Format with line numbers like text files
    const maxLines = Math.min(lineCount, MAX_LINES);
    const formatted = lines
      .slice(0, maxLines)
      .map((line, i) => {
        const truncated =
          line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "..." : line;
        return `${String(i + 1).padStart(6)}\t${truncated}`;
      })
      .join("\n");

    const overflow =
      lineCount > MAX_LINES
        ? `\n\n[Showing ${MAX_LINES} of ${lineCount} lines. Use offset/limit to read more.]`
        : "";

    return {
      tool_use_id: "",
      content: `[${label}: ${filePath}, ${stat.size} bytes, ${lineCount} lines]\n\n${formatted}${overflow}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      tool_use_id: "",
      content: `Error converting "${filePath}" with LibreOffice: ${msg}`,
      is_error: true,
    };
  } finally {
    // Clean up temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* cleanup not critical */
    }
  }
}

// ─── Text File Reading (original) ───────────────────────────────

interface TextFileResult extends ToolResult {
  totalLines: number;
}

function readTextFile(filePath: string, offset?: number, limit?: number): TextFileResult {
  const raw = readFileSync(filePath, "utf-8");
  const allLines = raw.split("\n");
  const totalLines = allLines.length;

  const startLine = Math.max((offset ?? 1) - 1, 0);
  const lineCount = Math.min(limit ?? MAX_LINES, MAX_LINES);
  const lines = allLines.slice(startLine, startLine + lineCount);

  // Format with line numbers (cat -n style)
  const formatted = lines
    .map((line, i) => {
      const num = startLine + i + 1;
      const truncated =
        line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "..." : line;
      return `${String(num).padStart(6)}\t${truncated}`;
    })
    .join("\n");

  const header =
    totalLines > lineCount + startLine
      ? `[Showing lines ${startLine + 1}-${startLine + lines.length} of ${totalLines}]\n`
      : "";

  return {
    tool_use_id: "",
    content: header + formatted,
    totalLines,
  };
}

// ─── Sensitive Path Blocklist ───────────────────────────────────
// These paths contain secrets/credentials and must never be read,
// regardless of workspace location. This prevents data exfiltration
// even when the workspace is a subdirectory (not HOME).

const BLOCKED_READ_PATHS = [
  "/etc/shadow",
  "/etc/passwd",
  "/etc/sudoers",
  "/etc/master.passwd", // BSD equivalent
  "/proc/self/environ", // leaks env vars with secrets
];

const home = process.env.HOME ?? "";

const BLOCKED_READ_PREFIXES = [
  `${home}/.ssh/`,
  `${home}/.aws/`,
  `${home}/.gnupg/`,
  `${home}/.kube/`,
  "/etc/sudoers.d/",
];

const SENSITIVE_READ_PATTERNS = [
  /\.(env|env\.\w+)$/,
  /\.(pem|key|crt|cert)$/,
  /\.ssh\//,
  /credentials/i,
  /\.aws\//,
  /\.kube\/config/,
  /id_rsa/,
  /id_ed25519/,
  /\.gitconfig$/,
  /\.gnupg\//,
  /\/proc\/self\/environ$/,
];

function isSensitiveReadPath(filePath: string): boolean {
  const resolved = resolve(filePath);

  if (BLOCKED_READ_PATHS.includes(resolved)) return true;

  for (const prefix of BLOCKED_READ_PREFIXES) {
    if (prefix && resolved.startsWith(prefix)) return true;
  }

  if (SENSITIVE_READ_PATTERNS.some((p) => p.test(resolved))) return true;

  return false;
}

// ─── Main Entry Point ───────────────────────────────────────────

export async function executeRead(input: Record<string, unknown>): Promise<ToolResult> {
  const file_path = input.file_path as string;
  const offset = input.offset as number | undefined;
  const limit = input.limit as number | undefined;
  const pages = input.pages as string | undefined;

  // Block reads of sensitive system/credential files regardless of workspace
  if (isSensitiveReadPath(file_path)) {
    return {
      tool_use_id: "",
      content: `BLOCKED: Reading "${file_path}" is blocked because it matches a sensitive file pattern (credentials, keys, secrets, etc.). This protects against accidental exposure of secrets.`,
      is_error: true,
    };
  }

  // Workspace guard: when workspace is HOME, warn about broad reads
  const workspace = getToolWorkspace();
  const homeDir = process.env.HOME ?? "";
  const isHomeWorkspace = homeDir && resolve(workspace) === resolve(homeDir);

  if (isHomeWorkspace) {
    const resolved = resolve(file_path);
    const rel = relative(workspace, resolved);
    // Block paths outside HOME
    if (rel.startsWith("..") || resolved === "/") {
      return {
        tool_use_id: "",
        content: `Error: Path "${file_path}" is outside the workspace. Run KCode from a project directory.`,
        is_error: true,
      };
    }
    // If file doesn't exist and workspace is HOME, give a specific warning
    // instead of a generic ENOENT — the model likely invented this path
    try {
      statSync(file_path);
    } catch {
      return {
        tool_use_id: "",
        content: `Error: File "${file_path}" does not exist. Your workspace is your home directory (~) — this is too broad for code exploration. Run KCode from a project directory, or specify an existing file path.`,
        is_error: true,
      };
    }
  }

  try {
    const stat = statSync(file_path);
    if (stat.isDirectory()) {
      return {
        tool_use_id: "",
        content: `Error: "${file_path}" is a directory, not a file. Use Bash with 'ls' to list directory contents.`,
        is_error: true,
      };
    }

    // Record this file as Read in the session tracker (used by audit validation)
    try {
      const { recordRead } = await import("../core/session-tracker.js");
      recordRead(file_path);
    } catch {
      /* tracker is optional */
    }

    const ext = extname(file_path).toLowerCase();

    // Image files
    if (IMAGE_EXTENSIONS.has(ext)) {
      return readImage(file_path);
    }

    // PDF files - use pdftotext only (mnemo:scanner doesn't support PDFs)
    if (ext === PDF_EXTENSION) {
      return readPdf(file_path, pages);
    }

    // Jupyter notebooks
    if (ext === NOTEBOOK_EXTENSION) {
      return readNotebook(file_path);
    }

    // Office documents (Word, Excel, PowerPoint, OpenDocument)
    if (OFFICE_EXTENSIONS.has(ext)) {
      return readOfficeDocument(file_path);
    }

    // Default: text file — check cache first
    try {
      const { getToolCache } = await import("../core/tool-cache.js");
      const cache = getToolCache();
      const cacheKey = cache.makeKey("Read", file_path, `${offset ?? 0}:${limit ?? 0}`);
      const cached = cache.get(cacheKey, file_path);
      if (cached) {
        return { tool_use_id: "", content: cached };
      }
    } catch {
      /* cache not critical */
    }

    const result = readTextFile(file_path, offset, limit);

    // Hint: if file is large and no offset was specified, nudge the model to use offset/limit
    if (!offset && !limit && result.totalLines > 100) {
      result.content += `\n\n[HINT: This file has ${result.totalLines} lines. You are viewing the first ${Math.min(result.totalLines, MAX_LINES)} lines. To read a specific section, use the offset and limit parameters: offset=100, limit=50 to read lines 100-150.]`;
    }

    // Cache the result for text files
    try {
      const { getToolCache } = await import("../core/tool-cache.js");
      const cache = getToolCache();
      const cacheKey = cache.makeKey("Read", file_path, `${offset ?? 0}:${limit ?? 0}`);
      cache.set(cacheKey, file_path, result.content);
    } catch {
      /* cache not critical */
    }

    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      tool_use_id: "",
      content: `Error reading "${file_path}": ${msg}`,
      is_error: true,
    };
  }
}
