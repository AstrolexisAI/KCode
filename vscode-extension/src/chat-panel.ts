import * as vscode from "vscode";
import { KCodeApiClient, SSEEvent } from "./api-client";

/**
 * Webview panel provider for the KCode chat sidebar.
 * Communicates with the KCode HTTP API using SSE streaming.
 */
export class KCodeChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = "kcode.chat";

  private view?: vscode.WebviewView;
  private isStreaming = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly apiClient: KCodeApiClient
  ) {}

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
          this.cancelRequest();
          break;
        case "newSession":
          this.newSession();
          break;
        case "copyCode":
          await vscode.env.clipboard.writeText(message.code);
          vscode.window.showInformationMessage("Code copied to clipboard.");
          break;
      }
    });
  }

  /**
   * Send a prompt to the chat panel from an external command.
   */
  public async sendPrompt(prompt: string): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand("kcode.chat.focus");
      await new Promise((r) => setTimeout(r, 500));
    }
    // Show user message in the UI
    this.postMessage({ type: "addMessage", role: "user", content: prompt });
    await this.handlePrompt(prompt);
  }

  public newSession(): void {
    this.apiClient.clearSession();
    this.cancelRequest();
    this.postMessage({ type: "clearMessages" });
  }

  private cancelRequest(): void {
    if (this.isStreaming) {
      this.apiClient.cancelStreaming();
      this.isStreaming = false;
      this.postMessage({ type: "setLoading", loading: false });
    }
  }

  private async handlePrompt(text: string): Promise<void> {
    if (!text.trim() || this.isStreaming) {
      return;
    }

    this.isStreaming = true;
    this.postMessage({ type: "setLoading", loading: true });

    const config = vscode.workspace.getConfiguration("kcode");
    const model = config.get<string>("model", "") || undefined;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // Auto-attach current file context if enabled
    const autoAttach = config.get<boolean>("autoAttachFile", false);
    let prompt = text;
    if (autoAttach) {
      const editor = vscode.window.activeTextEditor;
      if (editor && !text.includes("```")) {
        const filePath = vscode.workspace.asRelativePath(editor.document.uri);
        const language = editor.document.languageId;
        const lineCount = editor.document.lineCount;
        if (lineCount <= 200) {
          const content = editor.document.getText();
          prompt = `[Current file: \`${filePath}\` (${language}, ${lineCount} lines)]\n\`\`\`${language}\n${content}\n\`\`\`\n\n${text}`;
        } else {
          prompt = `[Current file: \`${filePath}\` (${language}, ${lineCount} lines — too large to include)]\n\n${text}`;
        }
      }
    }

    try {
      // Start streaming assistant message container
      this.postMessage({ type: "startStream" });

      await this.apiClient.sendPromptStreaming(
        prompt,
        (event: SSEEvent) => {
          switch (event.type) {
            case "text":
              this.postMessage({ type: "streamChunk", content: event.text });
              break;
            case "tool_result":
              this.postMessage({
                type: "toolResult",
                name: event.name,
                result: event.result,
                isError: event.isError,
              });
              break;
            case "tool_progress":
              this.postMessage({
                type: "toolProgress",
                name: event.name,
                status: event.status,
              });
              break;
            case "done":
              this.postMessage({
                type: "streamDone",
                model: event.model,
                usage: event.usage,
              });
              break;
            case "error":
              this.postMessage({
                type: "streamError",
                error: event.error,
              });
              break;
          }
        },
        { model, cwd }
      );
    } catch (err: any) {
      if (err.name === "AbortError") {
        this.postMessage({ type: "streamAborted" });
      } else {
        const errorMsg = err.message || "Failed to connect to KCode server";
        this.postMessage({ type: "streamError", error: errorMsg });
        // Attempt reconnection
        this.apiClient.startAutoReconnect();
      }
    } finally {
      this.isStreaming = false;
      this.postMessage({ type: "setLoading", loading: false });
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
    * { margin: 0; padding: 0; box-sizing: border-box; }

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

    .header-actions { display: flex; gap: 4px; }

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
      position: relative;
    }

    .message-assistant code {
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', monospace);
      font-size: 12px;
    }

    .message-assistant p { margin: 4px 0; }

    .code-block-wrapper {
      position: relative;
      margin: 8px 0;
    }

    .copy-btn {
      position: absolute;
      top: 4px;
      right: 4px;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
      border: none;
      border-radius: 3px;
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s;
      z-index: 1;
    }
    .code-block-wrapper:hover .copy-btn { opacity: 1; }
    .copy-btn:hover {
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
    }

    .tool-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #ccc);
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      margin: 4px 0;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .tool-indicator.error {
      border-left: 3px solid var(--vscode-errorForeground, #f44);
    }
    .tool-indicator .tool-name { font-weight: 600; }

    .usage-info {
      font-size: 10px;
      opacity: 0.5;
      margin-top: 6px;
      text-align: right;
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
    @keyframes spin { to { transform: rotate(360deg); } }

    .loading-text {
      opacity: 0.6;
      font-size: 12px;
    }

    .input-area {
      padding: 12px;
      border-top: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
    }
    .input-row { display: flex; gap: 6px; }

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
    .welcome h2 { margin-bottom: 8px; font-size: 16px; }
    .welcome p { font-size: 12px; line-height: 1.6; }
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
      <button class="header-btn" onclick="cancelRequest()" title="Cancel">&#x2715;</button>
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
    let streamingRaw = '';

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
      addMessage('user', text);
      vscode.postMessage({ type: 'sendPrompt', text });
    }

    function newSession() {
      vscode.postMessage({ type: 'newSession' });
    }

    function cancelRequest() {
      vscode.postMessage({ type: 'cancel' });
    }

    function copyCode(btn) {
      const wrapper = btn.closest('.code-block-wrapper');
      const code = wrapper.querySelector('code');
      if (code) {
        vscode.postMessage({ type: 'copyCode', code: code.textContent });
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      }
    }

    function addMessage(role, content) {
      hideWelcome();
      const div = document.createElement('div');
      div.className = 'message message-' + role;
      if (role === 'assistant') {
        const rendered = formatMarkdown(content);
        if (typeof DOMPurify !== 'undefined') {
          div.innerHTML = DOMPurify.sanitize(rendered);
        } else {
          div.textContent = content;
        }
      } else {
        div.textContent = content;
      }
      messagesEl.appendChild(div);
      scrollToBottom();
    }

    function hideWelcome() {
      if (welcomeEl) welcomeEl.style.display = 'none';
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function formatMarkdown(text) {
      if (!text) return '';

      // Escape HTML first
      let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // Code blocks with copy button
      html = html.replace(/\`\`\`(\w*)\n([\s\S]*?)\`\`\`/g, function(match, lang, code) {
        var safeLang = lang.replace(/[^a-zA-Z0-9_-]/g, '');
        return '<div class="code-block-wrapper"><button class="copy-btn" onclick="copyCode(this)">Copy</button><pre><code class="language-' + safeLang + '">' + code + '</code></pre></div>';
      });

      // Inline code
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');

      // Bold
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

      // Italic
      html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

      // Line breaks
      html = html.replace(/\n\n/g, '</p><p>');
      html = html.replace(/\n/g, '<br>');

      if (!html.startsWith('<div') && !html.startsWith('<p>')) {
        html = '<p>' + html + '</p>';
      }

      return html;
    }

    // Handle messages from the extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'addMessage':
          addMessage(msg.role, msg.content);
          break;

        case 'startStream':
          hideWelcome();
          streamingRaw = '';
          streamingEl = document.createElement('div');
          streamingEl.className = 'message message-assistant';
          messagesEl.appendChild(streamingEl);
          scrollToBottom();
          break;

        case 'streamChunk':
          if (streamingEl) {
            streamingRaw += msg.content;
            streamingEl.innerHTML = formatMarkdown(streamingRaw);
            scrollToBottom();
          }
          break;

        case 'toolResult': {
          if (!streamingEl) {
            hideWelcome();
            streamingEl = document.createElement('div');
            streamingEl.className = 'message message-assistant';
            messagesEl.appendChild(streamingEl);
          }
          const toolDiv = document.createElement('div');
          toolDiv.className = 'tool-indicator' + (msg.isError ? ' error' : '');
          toolDiv.innerHTML = '<span class="tool-name">' + escapeHtml(msg.name) + '</span>';
          if (msg.result) {
            const resultText = typeof msg.result === 'string'
              ? msg.result.slice(0, 200)
              : JSON.stringify(msg.result).slice(0, 200);
            toolDiv.innerHTML += ' <span style="opacity:0.7">' + escapeHtml(resultText) + '</span>';
          }
          streamingEl.appendChild(toolDiv);
          scrollToBottom();
          break;
        }

        case 'toolProgress': {
          // Update loading text with tool progress
          const loadingText = document.querySelector('.loading-text');
          if (loadingText) {
            loadingText.textContent = msg.name + ': ' + msg.status;
          }
          break;
        }

        case 'streamDone': {
          if (streamingEl && msg.usage) {
            const usageDiv = document.createElement('div');
            usageDiv.className = 'usage-info';
            usageDiv.textContent = msg.model + ' | ' + msg.usage.inputTokens + ' in / ' + msg.usage.outputTokens + ' out';
            streamingEl.appendChild(usageDiv);
          }
          streamingEl = null;
          streamingRaw = '';
          const lt = document.querySelector('.loading-text');
          if (lt) lt.textContent = 'Thinking...';
          break;
        }

        case 'streamError': {
          if (!streamingEl) {
            hideWelcome();
            streamingEl = document.createElement('div');
            streamingEl.className = 'message message-assistant';
            messagesEl.appendChild(streamingEl);
          }
          const errP = document.createElement('p');
          errP.style.color = 'var(--vscode-errorForeground, #f44)';
          errP.textContent = 'Error: ' + msg.error;
          streamingEl.appendChild(errP);
          streamingEl = null;
          streamingRaw = '';
          scrollToBottom();
          break;
        }

        case 'streamAborted': {
          if (streamingEl) {
            const abortP = document.createElement('p');
            abortP.style.opacity = '0.5';
            abortP.style.fontStyle = 'italic';
            abortP.textContent = '(cancelled)';
            streamingEl.appendChild(abortP);
          }
          streamingEl = null;
          streamingRaw = '';
          break;
        }

        case 'setLoading':
          isLoading = msg.loading;
          loadingEl.className = msg.loading ? 'loading visible' : 'loading';
          sendBtn.disabled = msg.loading;
          break;

        case 'clearMessages':
          messagesEl.innerHTML = '';
          if (welcomeEl) {
            messagesEl.appendChild(welcomeEl);
            welcomeEl.style.display = '';
          }
          streamingEl = null;
          streamingRaw = '';
          break;
      }
    });

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    inputEl.focus();
  </script>
</body>
</html>`;
  }
}
