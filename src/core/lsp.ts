// KCode - LSP Integration
// Lightweight LSP client for diagnostics and code intelligence queries

import { type Subprocess, spawn } from "bun";
import { log } from "./logger";

interface LspDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}

interface LspServerConfig {
  name: string;
  command: string;
  args: string[];
  languages: string[]; // file extensions like ".ts", ".py"
  rootPatterns: string[]; // files that indicate project root: "tsconfig.json", "pyproject.toml"
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Well-known language servers
const KNOWN_SERVERS: LspServerConfig[] = [
  {
    name: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    languages: [".ts", ".tsx", ".js", ".jsx"],
    rootPatterns: ["tsconfig.json", "package.json"],
  },
  {
    name: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    languages: [".py"],
    rootPatterns: ["pyproject.toml", "setup.py", "requirements.txt"],
  },
  {
    name: "gopls",
    command: "gopls",
    args: ["serve"],
    languages: [".go"],
    rootPatterns: ["go.mod"],
  },
  {
    name: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    languages: [".rs"],
    rootPatterns: ["Cargo.toml"],
  },
];

interface ServerEntry {
  process: Subprocess;
  config: LspServerConfig;
  requestId: number;
  pendingRequests: Map<number, PendingRequest>;
}

export class LspManager {
  private servers = new Map<string, ServerEntry>();
  private diagnosticsCache = new Map<string, LspDiagnostic[]>();
  private cwd: string;
  private openedFiles = new Set<string>();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Auto-detect and start relevant language servers based on project files.
   */
  async autoStart(): Promise<void> {
    for (const config of KNOWN_SERVERS) {
      // Check if the server binary exists
      try {
        const which = Bun.spawnSync(["which", config.command]);
        if (which.exitCode !== 0) continue;
      } catch {
        continue;
      }

      // Check if project has relevant files
      const hasRootFile = config.rootPatterns.some((pattern) => {
        try {
          return Bun.file(`${this.cwd}/${pattern}`).size > 0;
        } catch {
          return false;
        }
      });

      if (!hasRootFile) continue;

      try {
        await this.startServer(config);
        log.info("lsp", `Started ${config.name} language server`);
      } catch (err) {
        log.warn("lsp", `Failed to start ${config.name}: ${err}`);
      }
    }
  }

  private async startServer(config: LspServerConfig): Promise<void> {
    const proc = spawn({
      cmd: [config.command, ...config.args],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.cwd,
    });

    const entry: ServerEntry = { process: proc, config, requestId: 0, pendingRequests: new Map() };
    this.servers.set(config.name, entry);

    // Read stdout for responses
    this.readResponses(config.name, proc, entry);

    // Send initialize request
    await this.sendRequest(config.name, "initialize", {
      processId: process.pid,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { contentFormat: ["plaintext", "markdown"] },
          documentSymbol: { dynamicRegistration: false },
        },
      },
      rootUri: `file://${this.cwd}`,
      workspaceFolders: [{ uri: `file://${this.cwd}`, name: "workspace" }],
    });

    // Send initialized notification
    this.sendNotification(config.name, "initialized", {});
  }

  private async readResponses(
    serverName: string,
    proc: Subprocess,
    entry: ServerEntry,
  ): Promise<void> {
    if (!proc.stdout || typeof proc.stdout === "number") return;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse LSP messages (Content-Length header + JSON body)
        while (true) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) break;

          const header = buffer.slice(0, headerEnd);
          const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
          if (!lengthMatch) {
            buffer = buffer.slice(headerEnd + 4);
            continue;
          }

          const contentLength = parseInt(lengthMatch[1]!, 10);
          const bodyStart = headerEnd + 4;
          if (buffer.length < bodyStart + contentLength) break;

          const body = buffer.slice(bodyStart, bodyStart + contentLength);
          buffer = buffer.slice(bodyStart + contentLength);

          try {
            const msg = JSON.parse(body);
            this.handleMessage(serverName, msg, entry);
          } catch {
            /* skip malformed */
          }
        }
      }
    } catch {
      /* stream closed */
    }
  }

  private handleMessage(serverName: string, msg: any, entry: ServerEntry): void {
    // Handle responses to our requests
    if (msg.id !== undefined && entry.pendingRequests.has(msg.id)) {
      const pending = entry.pendingRequests.get(msg.id)!;
      clearTimeout(pending.timer);
      entry.pendingRequests.delete(msg.id);

      if (msg.error) {
        pending.reject(new Error(`LSP error: ${msg.error.message} (code: ${msg.error.code})`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Handle publishDiagnostics notification
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params;
      const file = params.uri.replace("file://", "");
      const diagnostics: LspDiagnostic[] = (params.diagnostics ?? []).map((d: any) => ({
        file,
        line: (d.range?.start?.line ?? 0) + 1,
        column: (d.range?.start?.character ?? 0) + 1,
        severity: (["", "error", "warning", "info", "hint"] as const)[
          d.severity ?? 1
        ] as LspDiagnostic["severity"],
        message: d.message,
        source: d.source ?? serverName,
      }));
      this.diagnosticsCache.set(file, diagnostics);
    }
  }

  private sendRequest(serverName: string, method: string, params: any): Promise<unknown> {
    const entry = this.servers.get(serverName);
    if (!entry?.process.stdin) return Promise.reject(new Error(`Server ${serverName} not running`));

    entry.requestId++;
    const id = entry.requestId;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pendingRequests.delete(id);
        reject(new Error(`LSP request "${method}" timed out after 10s`));
      }, 10_000);

      entry.pendingRequests.set(id, { resolve, reject, timer });

      try {
        const stdin = entry.process.stdin;
        if (!stdin || typeof stdin === "number") throw new Error("stdin not available");
        (stdin as import("bun").FileSink).write(header + msg);
      } catch (err) {
        clearTimeout(timer);
        entry.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendNotification(serverName: string, method: string, params: any): void {
    const entry = this.servers.get(serverName);
    if (!entry?.process.stdin || typeof entry.process.stdin === "number") return;

    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;

    try {
      (entry.process.stdin as import("bun").FileSink).write(header + msg);
    } catch {
      /* ignore */
    }
  }

  /**
   * Ensure a file is opened in the language server before querying it.
   */
  private ensureFileOpen(serverName: string, filePath: string, content: string): void {
    const key = `${serverName}:${filePath}`;
    if (this.openedFiles.has(key)) {
      // Send didChange instead
      this.sendNotification(serverName, "textDocument/didChange", {
        textDocument: { uri: `file://${filePath}`, version: Date.now() },
        contentChanges: [{ text: content }],
      });
    } else {
      this.openedFiles.add(key);
      this.sendNotification(serverName, "textDocument/didOpen", {
        textDocument: {
          uri: `file://${filePath}`,
          languageId: this.getLanguageId(filePath.slice(filePath.lastIndexOf("."))),
          version: Date.now(),
          text: content,
        },
      });
    }
  }

  // ─── Public Query API (used by LSP tool) ────────────────────────

  /**
   * Send an LSP request for a given file. Auto-detects the right server.
   * Opens the file in the server if not already open.
   */
  async query(
    filePath: string,
    method: string,
    position?: { line: number; character: number },
  ): Promise<unknown> {
    const ext = filePath.slice(filePath.lastIndexOf("."));

    for (const [name, entry] of this.servers) {
      if (!entry.config.languages.includes(ext)) continue;

      // Ensure the file is open
      try {
        const { readFileSync } = await import("node:fs");
        const content = readFileSync(filePath, "utf-8");
        const key = `${name}:${filePath}`;
        const isNewFile = !this.openedFiles.has(key);
        this.ensureFileOpen(name, filePath, content);
        // Only delay on first open — server needs time to parse the file
        if (isNewFile) await new Promise((r) => setTimeout(r, 200));
      } catch {
        /* file might not exist */
      }

      const params: Record<string, unknown> = {
        textDocument: { uri: `file://${filePath}` },
      };
      if (position) {
        params.position = position;
      }

      return this.sendRequest(name, method, params);
    }

    throw new Error(
      `No language server available for ${filePath} (running: ${this.getServerNames().join(", ") || "none"})`,
    );
  }

  /**
   * Notify language server that a file was changed (after Write/Edit).
   */
  notifyFileChanged(filePath: string, content: string): void {
    const ext = filePath.slice(filePath.lastIndexOf("."));

    for (const [, entry] of this.servers) {
      if (!entry.config.languages.includes(ext)) continue;
      this.ensureFileOpen(entry.config.name, filePath, content);
    }
  }

  /**
   * Get diagnostics for a file (from cache).
   */
  getDiagnostics(filePath: string): LspDiagnostic[] {
    return this.diagnosticsCache.get(filePath) ?? [];
  }

  /**
   * Get all diagnostics with errors.
   */
  getAllErrors(): LspDiagnostic[] {
    const errors: LspDiagnostic[] = [];
    for (const diags of this.diagnosticsCache.values()) {
      errors.push(...diags.filter((d) => d.severity === "error"));
    }
    return errors;
  }

  /**
   * Format diagnostics for injection into conversation after a file edit.
   */
  formatDiagnosticsForFile(filePath: string): string | null {
    const diags = this.getDiagnostics(filePath);
    if (diags.length === 0) return null;

    const errors = diags.filter((d) => d.severity === "error");
    const warnings = diags.filter((d) => d.severity === "warning");

    if (errors.length === 0 && warnings.length === 0) return null;

    const lines: string[] = [];
    if (errors.length > 0) {
      lines.push(`LSP: ${errors.length} error(s) in ${filePath}:`);
      for (const e of errors.slice(0, 5)) {
        lines.push(`  L${e.line}:${e.column} [${e.source}] ${e.message}`);
      }
    }
    if (warnings.length > 0 && warnings.length <= 3) {
      lines.push(`  ${warnings.length} warning(s)`);
    }

    return lines.join("\n");
  }

  /**
   * Check if any servers are running.
   */
  isActive(): boolean {
    return this.servers.size > 0;
  }

  /**
   * Get names of running servers.
   */
  getServerNames(): string[] {
    return Array.from(this.servers.keys());
  }

  private getLanguageId(ext: string): string {
    const map: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".py": "python",
      ".go": "go",
      ".rs": "rust",
    };
    return map[ext] ?? "plaintext";
  }

  /**
   * Shut down all language servers.
   */
  shutdown(): void {
    for (const [name, entry] of this.servers) {
      // Reject all pending requests
      for (const [, pending] of entry.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`LSP server "${name}" shutting down`));
      }
      entry.pendingRequests.clear();

      // Send shutdown notification (not request — no response expected during teardown)
      try {
        this.sendNotification(name, "shutdown", null);
      } catch {
        /* best-effort shutdown notification */
      }
      // Kill after brief grace period
      const proc = entry.process;
      setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* process may have already exited */
        }
      }, 1000);
    }
    this.servers.clear();
    this.diagnosticsCache.clear();
    this.openedFiles.clear();
  }
}

let _lsp: LspManager | null = null;
export function getLspManager(cwd?: string): LspManager | null {
  if (!_lsp && cwd) _lsp = new LspManager(cwd);
  return _lsp;
}

export function shutdownLsp(): void {
  if (_lsp) {
    _lsp.shutdown();
    _lsp = null;
  }
}
