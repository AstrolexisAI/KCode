import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export class KCodeSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "kcode.chat";

  private view?: vscode.WebviewView;
  private messages: ChatMessage[] = [];
  private activeProcess: ChildProcess | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "sendPrompt":
          await this.handlePrompt(message.text);
          break;
        case "cancel":
          this.cancelActiveProcess();
          break;
        case "newSession":
          this.newSession();
          break;
      }
    });
  }

  /**
   * Send a prompt to the sidebar from an external command (e.g. context menu).
   */
  public async sendPrompt(prompt: string): Promise<void> {
    if (!this.view) {
      // If the sidebar isn't visible yet, reveal it
      await vscode.commands.executeCommand("kcode.chat.focus");
      // Small delay for the webview to initialize
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.handlePrompt(prompt);
  }

  public newSession(): void {
    this.messages = [];
    this.cancelActiveProcess();
    this.postMessage({ type: "clearMessages" });
  }

  private async handlePrompt(text: string): Promise<void> {
    if (!text.trim()) {
      return;
    }

    // Add user message
    this.messages.push({ role: "user", content: text });
    this.postMessage({ type: "addMessage", role: "user", content: text });
    this.postMessage({ type: "setLoading", loading: true });

    try {
      const response = await this.runKCode(text);
      this.messages.push({ role: "assistant", content: response });
      this.postMessage({
        type: "addMessage",
        role: "assistant",
        content: response,
      });
    } catch (err: any) {
      const errorMsg = `Error: ${err.message || "KCode process failed"}`;
      this.postMessage({
        type: "addMessage",
        role: "assistant",
        content: errorMsg,
      });
    } finally {
      this.postMessage({ type: "setLoading", loading: false });
    }
  }

  private runKCode(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const config = vscode.workspace.getConfiguration("kcode");
      const binaryPath = config.get<string>("binaryPath", "kcode");
      const model = config.get<string>("model", "");
      const permissionMode = config.get<string>(
        "permissionMode",
        "acceptEdits"
      );
      const workspaceFolder =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      const args = ["-p", "--print", prompt];
      if (model) {
        args.push("--model", model);
      }
      if (permissionMode) {
        args.push("--permission-mode", permissionMode);
      }

      const proc = spawn(binaryPath, args, {
        cwd: workspaceFolder,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.activeProcess = proc;

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;

        // Stream partial content to the webview for real-time updates
        this.postMessage({ type: "streamChunk", content: chunk });
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        this.activeProcess = null;
        if (code === 0 || stdout.length > 0) {
          resolve(stdout || "(no output)");
        } else {
          reject(new Error(stderr || `Process exited with code ${code}`));
        }
      });

      proc.on("error", (err) => {
        this.activeProcess = null;
        reject(err);
      });
    });
  }

  private cancelActiveProcess(): void {
    if (this.activeProcess) {
      this.activeProcess.kill("SIGTERM");
      this.activeProcess = null;
    }
  }

  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  private getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background, #1e1e1e);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
    }

    .header-title {
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
    }

    .header-actions {
      display: flex;
      gap: 4px;
    }

    .header-btn {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 12px;
      opacity: 0.7;
    }

    .header-btn:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground, #333);
    }

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .message {
      padding: 10px 14px;
      border-radius: 8px;
      max-width: 95%;
      line-height: 1.5;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    .message-user {
      align-self: flex-end;
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
      border-radius: 8px 8px 2px 8px;
    }

    .message-assistant {
      align-self: flex-start;
      background: var(--vscode-editor-background, #252526);
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 8px 8px 8px 2px;
    }

    .message-assistant pre {
      background: var(--vscode-textCodeBlock-background, #1a1a1a);
      padding: 10px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 8px 0;
      border: 1px solid var(--vscode-panel-border, #333);
    }

    .message-assistant code {
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', monospace);
      font-size: 12px;
    }

    .message-assistant p {
      margin: 4px 0;
    }

    .tool-indicator {
      display: inline-block;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #ccc);
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      margin: 2px 0;
    }

    .loading {
      display: none;
      align-self: flex-start;
      padding: 10px 14px;
    }

    .loading.visible {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      opacity: 0.6;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .loading-text {
      opacity: 0.6;
      font-size: 12px;
    }

    .input-area {
      padding: 12px;
      border-top: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
    }

    .input-row {
      display: flex;
      gap: 6px;
    }

    .input-area textarea {
      flex: 1;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
      padding: 8px 10px;
      font-family: inherit;
      font-size: 13px;
      resize: none;
      outline: none;
      min-height: 36px;
      max-height: 120px;
    }

    .input-area textarea:focus {
      border-color: var(--vscode-focusBorder, #0078d4);
    }

    .input-area textarea::placeholder {
      color: var(--vscode-input-placeholderForeground, #888);
    }

    .send-btn {
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      border-radius: 4px;
      padding: 0 14px;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
      flex-shrink: 0;
    }

    .send-btn:hover {
      background: var(--vscode-button-hoverBackground, #0066b8);
    }

    .send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .welcome {
      text-align: center;
      padding: 40px 20px;
      opacity: 0.6;
    }

    .welcome h2 {
      margin-bottom: 8px;
      font-size: 16px;
    }

    .welcome p {
      font-size: 12px;
      line-height: 1.6;
    }

    .welcome kbd {
      background: var(--vscode-keybindingLabel-background, #333);
      border: 1px solid var(--vscode-keybindingLabel-border, #555);
      border-radius: 3px;
      padding: 1px 5px;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="header-title">KCode Chat</span>
    <div class="header-actions">
      <button class="header-btn" onclick="newSession()" title="New Session">+</button>
      <button class="header-btn" onclick="cancelRequest()" title="Cancel">x</button>
    </div>
  </div>

  <div class="messages" id="messages">
    <div class="welcome" id="welcome">
      <h2>KCode</h2>
      <p>Local AI coding assistant.<br>
      Type a message or press <kbd>Ctrl+Shift+K</kbd> to start.<br>
      Right-click selected code for quick actions.</p>
    </div>
  </div>

  <div class="loading" id="loading">
    <div class="spinner"></div>
    <span class="loading-text">Thinking...</span>
  </div>

  <div class="input-area">
    <div class="input-row">
      <textarea
        id="input"
        placeholder="Ask KCode..."
        rows="1"
        autofocus
      ></textarea>
      <button class="send-btn" id="sendBtn" onclick="sendMessage()">&#9654;</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const welcomeEl = document.getElementById('welcome');
    const loadingEl = document.getElementById('loading');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('sendBtn');

    let isLoading = false;
    let streamingEl = null;

    // Auto-resize textarea
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    // Enter to send, Shift+Enter for newline
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    function sendMessage() {
      const text = inputEl.value.trim();
      if (!text || isLoading) return;

      inputEl.value = '';
      inputEl.style.height = 'auto';
      vscode.postMessage({ type: 'sendPrompt', text });
    }

    function newSession() {
      vscode.postMessage({ type: 'newSession' });
    }

    function cancelRequest() {
      vscode.postMessage({ type: 'cancel' });
    }

    function addMessage(role, content) {
      if (welcomeEl) welcomeEl.style.display = 'none';

      const div = document.createElement('div');
      div.className = 'message message-' + role;

      if (role === 'assistant') {
        div.innerHTML = formatContent(content);
      } else {
        div.textContent = content;
      }

      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      streamingEl = null;
    }

    function formatContent(text) {
      // Detect tool use indicators
      text = text.replace(/^(\\s*)([A-Z][a-zA-Z]+Tool|ReadFile|WriteFile|EditFile|Bash|Grep|Glob|WebSearch|WebFetch):/gm,
        '$1<span class="tool-indicator">&#9889; $2</span>:');

      // Convert code blocks
      text = text.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,
        '<pre><code class="language-$1">$2</code></pre>');

      // Convert inline code
      text = text.replace(/\`([^\`]+)\`/g, '<code>$1</code>');

      // Convert bold
      text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');

      // Convert italic
      text = text.replace(/\\*(.+?)\\*/g, '<em>$1</em>');

      // Convert line breaks to paragraphs (simple)
      text = text.replace(/\\n\\n/g, '</p><p>');
      text = text.replace(/\\n/g, '<br>');

      if (!text.startsWith('<pre>') && !text.startsWith('<p>')) {
        text = '<p>' + text + '</p>';
      }

      return text;
    }

    // Handle messages from the extension host
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'addMessage':
          addMessage(msg.role, msg.content);
          break;
        case 'streamChunk':
          // For real-time streaming, update the last assistant message
          if (!streamingEl) {
            if (welcomeEl) welcomeEl.style.display = 'none';
            streamingEl = document.createElement('div');
            streamingEl.className = 'message message-assistant';
            streamingEl.dataset.streaming = 'true';
            messagesEl.appendChild(streamingEl);
          }
          streamingEl.innerHTML = formatContent(
            (streamingEl.dataset.rawContent || '') + msg.content
          );
          streamingEl.dataset.rawContent =
            (streamingEl.dataset.rawContent || '') + msg.content;
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        case 'setLoading':
          isLoading = msg.loading;
          loadingEl.className = msg.loading ? 'loading visible' : 'loading';
          sendBtn.disabled = msg.loading;
          if (!msg.loading && streamingEl) {
            // Remove streaming el since addMessage will add the final version
            streamingEl.remove();
            streamingEl = null;
          }
          break;
        case 'clearMessages':
          messagesEl.innerHTML = '';
          if (welcomeEl) {
            messagesEl.appendChild(welcomeEl);
            welcomeEl.style.display = '';
          }
          streamingEl = null;
          break;
      }
    });

    // Focus input on load
    inputEl.focus();
  </script>
</body>
</html>`;
  }
}
