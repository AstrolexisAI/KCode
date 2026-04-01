// KCode VS Code Extension - Sidebar Chat Panel
// WebviewViewProvider for the KCode chat sidebar

import * as vscode from "vscode";
import type { KCodeClient, ServerEvent } from "./api-client";

export class KCodeSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "kcode.chat";

  private view?: vscode.WebviewView;
  private client: KCodeClient;
  private eventDisposable?: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    client: KCodeClient,
  ) {
    this.client = client;
  }

  /** Update the client reference (e.g., after reconnection) */
  setClient(client: KCodeClient): void {
    this.client = client;
    this.eventDisposable?.dispose();
    this.subscribeToEvents();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleWebviewMessage(message);
    });

    this.subscribeToEvents();
  }

  /** Post a message to the webview */
  postMessage(message: Record<string, unknown>): void {
    this.view?.webview.postMessage(message);
  }

  /** Append text to the current assistant response in the webview */
  appendDelta(text: string): void {
    this.postMessage({ type: "delta", text });
  }

  /** Display a complete assistant message */
  showMessage(role: "user" | "assistant", content: string): void {
    this.postMessage({ type: "message", role, content });
  }

  /** Show connection status */
  showStatus(connected: boolean, model?: string): void {
    this.postMessage({ type: "status", connected, model });
  }

  // ── Event Subscription ────────────────────────────────────

  private subscribeToEvents(): void {
    this.eventDisposable?.dispose();
    this.eventDisposable = this.client.onEvent((event: ServerEvent) => {
      this.handleServerEvent(event);
    });
  }

  private handleServerEvent(event: ServerEvent): void {
    switch (event.type) {
      case "message.new":
        this.postMessage({
          type: "message",
          role: event.role,
          content: event.content,
          id: event.id,
        });
        break;

      case "message.delta":
        this.postMessage({ type: "delta", text: event.delta, id: event.id });
        break;

      case "message.thinking":
        this.postMessage({ type: "thinking", text: event.thinking, id: event.id });
        break;

      case "tool.start":
        this.postMessage({
          type: "tool-start",
          name: event.name,
          id: event.id,
        });
        break;

      case "tool.result":
        this.postMessage({
          type: "tool-result",
          name: event.name,
          result: event.result,
          isError: event.isError,
          id: event.id,
        });
        break;

      case "permission.request":
        this.postMessage({
          type: "permission",
          id: event.id,
          tool: event.tool,
          description: event.description,
        });
        break;

      case "session.stats":
        this.postMessage({
          type: "stats",
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          costUsd: event.costUsd,
        });
        break;

      case "error":
        this.postMessage({ type: "error", message: event.message });
        break;

      case "connected":
        this.showStatus(true, event.model);
        break;

      case "model.changed":
        this.postMessage({ type: "model-changed", model: event.model });
        break;
    }
  }

  // ── Webview Message Handling ───────────────────────────────

  private handleWebviewMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case "send":
        if (typeof message.content === "string" && message.content.trim()) {
          this.client.wsSendMessage(message.content);
        }
        break;

      case "cancel":
        this.client.wsCancelMessage();
        break;

      case "permission-respond":
        if (typeof message.id === "string" && typeof message.action === "string") {
          this.client.wsRespondPermission(
            message.id,
            message.action as "allow" | "deny",
          );
        }
        break;
    }
  }

  // ── HTML Template ─────────────────────────────────────────

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    #status-bar {
      padding: 4px 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      display: inline-block;
      margin-right: 4px;
    }
    .status-dot.connected { background: #4caf50; }
    .status-dot.disconnected { background: #f44336; }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .message {
      margin-bottom: 12px;
      padding: 8px;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .message.user {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
    }
    .message.assistant {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }
    .message .role {
      font-weight: bold;
      font-size: 11px;
      margin-bottom: 4px;
      color: var(--vscode-descriptionForeground);
    }
    .tool-use {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 4px 8px;
      margin: 4px 0;
      border-left: 2px solid var(--vscode-activityBarBadge-background);
    }
    .error-msg {
      color: var(--vscode-errorForeground);
      padding: 4px 8px;
      margin: 4px 0;
    }
    .permission-request {
      padding: 8px;
      margin: 4px 0;
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      border-radius: 4px;
    }
    .permission-request button {
      margin: 4px 4px 0 0;
      padding: 2px 8px;
      cursor: pointer;
    }
    #input-area {
      padding: 8px;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 4px;
    }
    #input-area textarea {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 6px 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      resize: none;
      min-height: 36px;
      max-height: 120px;
    }
    #input-area textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    #input-area button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: var(--vscode-font-size);
    }
    #input-area button:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div id="status-bar">
    <span><span class="status-dot disconnected" id="status-dot"></span><span id="status-text">Disconnected</span></span>
    <span id="model-name">--</span>
  </div>
  <div id="messages"></div>
  <div id="input-area">
    <textarea id="input" rows="1" placeholder="Ask KCode..."></textarea>
    <button id="send-btn">Send</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('send-btn');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const modelName = document.getElementById('model-name');

    let currentAssistantEl = null;
    let currentAssistantContent = '';

    function addMessage(role, content, id) {
      const div = document.createElement('div');
      div.className = 'message ' + role;
      if (id) div.dataset.id = id;
      div.innerHTML = '<div class="role">' + (role === 'user' ? 'You' : 'KCode') + '</div>' +
        '<div class="content">' + escapeHtml(content) + '</div>';
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      if (role === 'assistant') {
        currentAssistantEl = div.querySelector('.content');
        currentAssistantContent = content;
      }
      return div;
    }

    function appendDelta(text, id) {
      if (id) {
        const existing = messagesEl.querySelector('[data-id="' + id + '"]');
        if (existing) {
          const contentEl = existing.querySelector('.content');
          if (contentEl) {
            currentAssistantContent += text;
            contentEl.textContent = currentAssistantContent;
            messagesEl.scrollTop = messagesEl.scrollHeight;
            return;
          }
        }
      }
      if (!currentAssistantEl) {
        addMessage('assistant', text, id);
      } else {
        currentAssistantContent += text;
        currentAssistantEl.textContent = currentAssistantContent;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function send() {
      const content = inputEl.value.trim();
      if (!content) return;
      vscode.postMessage({ type: 'send', content });
      inputEl.value = '';
      currentAssistantEl = null;
      currentAssistantContent = '';
    }

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    // Auto-resize textarea
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    // Handle messages from the extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'message':
          if (msg.role === 'assistant' && msg.content === '') {
            // Start of streaming - create empty assistant message
            addMessage('assistant', '', msg.id);
          } else {
            addMessage(msg.role, msg.content, msg.id);
          }
          break;
        case 'delta':
          appendDelta(msg.text, msg.id);
          break;
        case 'thinking':
          // Could show thinking indicator
          break;
        case 'tool-start':
          const toolDiv = document.createElement('div');
          toolDiv.className = 'tool-use';
          toolDiv.textContent = 'Running: ' + msg.name + '...';
          toolDiv.dataset.toolId = msg.id;
          messagesEl.appendChild(toolDiv);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        case 'tool-result':
          const existing = messagesEl.querySelector('[data-tool-id="' + msg.id + '"]');
          if (existing) {
            existing.textContent = (msg.isError ? 'Error: ' : 'Done: ') + msg.name;
          }
          break;
        case 'permission':
          const permDiv = document.createElement('div');
          permDiv.className = 'permission-request';
          permDiv.innerHTML = '<div>Permission: ' + escapeHtml(msg.description) + '</div>' +
            '<button onclick="respondPermission(\\''+msg.id+'\\', \\'allow\\')">Allow</button>' +
            '<button onclick="respondPermission(\\''+msg.id+'\\', \\'deny\\')">Deny</button>';
          messagesEl.appendChild(permDiv);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        case 'status':
          statusDot.className = 'status-dot ' + (msg.connected ? 'connected' : 'disconnected');
          statusText.textContent = msg.connected ? 'Connected' : 'Disconnected';
          if (msg.model) modelName.textContent = msg.model;
          break;
        case 'model-changed':
          modelName.textContent = msg.model;
          break;
        case 'stats':
          modelName.textContent = msg.model;
          break;
        case 'error':
          const errDiv = document.createElement('div');
          errDiv.className = 'error-msg';
          errDiv.textContent = 'Error: ' + msg.message;
          messagesEl.appendChild(errDiv);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
      }
    });

    function respondPermission(id, action) {
      vscode.postMessage({ type: 'permission-respond', id, action });
    }
  </script>
</body>
</html>`;
  }
}
