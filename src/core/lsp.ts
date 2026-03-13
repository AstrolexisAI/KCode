// KCode - LSP Integration
// Lightweight LSP client for diagnostics (type errors, lint warnings)

import { spawn, type Subprocess } from "bun";
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
  languages: string[];  // file extensions like ".ts", ".py"
  rootPatterns: string[]; // files that indicate project root: "tsconfig.json", "pyproject.toml"
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

export class LspManager {
  private servers = new Map<string, { process: Subprocess; config: LspServerConfig; requestId: number }>();
  private diagnosticsCache = new Map<string, LspDiagnostic[]>();
  private cwd: string;

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
      const hasRootFile = config.rootPatterns.some(pattern => {
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

    const entry = { process: proc, config, requestId: 0 };
    this.servers.set(config.name, entry);

    // Read stdout for responses
    this.readResponses(config.name, proc);

    // Send initialize request
    await this.sendRequest(config.name, "initialize", {
      processId: process.pid,
      capabilities: {},
      rootUri: `file://${this.cwd}`,
      workspaceFolders: [{ uri: `file://${this.cwd}`, name: "workspace" }],
    });

    // Send initialized notification
    this.sendNotification(config.name, "initialized", {});
  }

  private async readResponses(serverName: string, proc: Subprocess): Promise<void> {
    if (!proc.stdout) return;
    const reader = proc.stdout.getReader();
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

          const contentLength = parseInt(lengthMatch[1], 10);
          const bodyStart = headerEnd + 4;
          if (buffer.length < bodyStart + contentLength) break;

          const body = buffer.slice(bodyStart, bodyStart + contentLength);
          buffer = buffer.slice(bodyStart + contentLength);

          try {
            const msg = JSON.parse(body);
            this.handleMessage(serverName, msg);
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* stream closed */ }
  }

  private handleMessage(serverName: string, msg: any): void {
    // Handle publishDiagnostics notification
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params;
      const file = params.uri.replace("file://", "");
      const diagnostics: LspDiagnostic[] = (params.diagnostics ?? []).map((d: any) => ({
        file,
        line: (d.range?.start?.line ?? 0) + 1,
        column: (d.range?.start?.character ?? 0) + 1,
        severity: ["", "error", "warning", "info", "hint"][d.severity ?? 1] as any,
        message: d.message,
        source: d.source ?? serverName,
      }));
      this.diagnosticsCache.set(file, diagnostics);
    }
  }

  private sendRequest(serverName: string, method: string, params: any): Promise<void> {
    const entry = this.servers.get(serverName);
    if (!entry?.process.stdin) return Promise.resolve();

    entry.requestId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id: entry.requestId, method, params });
    const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;

    try {
      entry.process.stdin.write(header + msg);
    } catch { /* ignore write errors */ }

    return Promise.resolve();
  }

  private sendNotification(serverName: string, method: string, params: any): void {
    const entry = this.servers.get(serverName);
    if (!entry?.process.stdin) return;

    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;

    try {
      entry.process.stdin.write(header + msg);
    } catch { /* ignore */ }
  }

  /**
   * Notify language server that a file was changed (after Write/Edit).
   */
  notifyFileChanged(filePath: string, content: string): void {
    const ext = filePath.slice(filePath.lastIndexOf("."));

    for (const [, entry] of this.servers) {
      if (!entry.config.languages.includes(ext)) continue;

      const uri = `file://${filePath}`;

      // Send didOpen or didChange
      this.sendNotification(entry.config.name, "textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.getLanguageId(ext),
          version: Date.now(),
          text: content,
        },
      });
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
      errors.push(...diags.filter(d => d.severity === "error"));
    }
    return errors;
  }

  /**
   * Format diagnostics for injection into conversation after a file edit.
   */
  formatDiagnosticsForFile(filePath: string): string | null {
    const diags = this.getDiagnostics(filePath);
    if (diags.length === 0) return null;

    const errors = diags.filter(d => d.severity === "error");
    const warnings = diags.filter(d => d.severity === "warning");

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
      ".ts": "typescript", ".tsx": "typescriptreact",
      ".js": "javascript", ".jsx": "javascriptreact",
      ".py": "python", ".go": "go", ".rs": "rust",
    };
    return map[ext] ?? "plaintext";
  }

  /**
   * Shut down all language servers.
   */
  shutdown(): void {
    for (const [name, entry] of this.servers) {
      try {
        this.sendRequest(name, "shutdown", null);
        setTimeout(() => {
          try { entry.process.kill(); } catch {}
        }, 3000);
      } catch {}
    }
    this.servers.clear();
    this.diagnosticsCache.clear();
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
