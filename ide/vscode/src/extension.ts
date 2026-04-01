// KCode VS Code Extension - Main Entry Point
// Activation, command registration, status bar, and sidebar

import * as vscode from "vscode";
import { KCodeClient } from "./api-client";
import { KCodeSidebarProvider } from "./sidebar";

let client: KCodeClient;
let statusBarItem: vscode.StatusBarItem;
let sidebarProvider: KCodeSidebarProvider;

// ── Activation ─────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("kcode");
  const serverUrl = config.get<string>("serverUrl", "http://localhost:10091");
  const apiKey = config.get<string>("apiKey", "");
  const autoConnect = config.get<boolean>("autoConnect", true);

  // Create the API client
  client = new KCodeClient(serverUrl, apiKey);

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "kcode.ask";
  updateStatusBar(false, "KCode");
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Create sidebar provider
  sidebarProvider = new KCodeSidebarProvider(context.extensionUri, client);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(KCodeSidebarProvider.viewType, sidebarProvider),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.ask", cmdAsk),
    vscode.commands.registerCommand("kcode.explain", cmdExplain),
    vscode.commands.registerCommand("kcode.commit", cmdCommit),
    vscode.commands.registerCommand("kcode.test", cmdTest),
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kcode")) {
        onConfigChanged();
      }
    }),
  );

  // Subscribe to server events for status bar updates
  context.subscriptions.push(
    client.onEvent((event) => {
      if (event.type === "connected") {
        updateStatusBar(true, event.model);
      } else if (event.type === "model.changed") {
        updateStatusBar(true, event.model);
      } else if (event.type === "session.stats") {
        updateStatusBar(true, event.model);
      } else if (event.type === "error" && !event.retryable) {
        updateStatusBar(false, "Error");
      }
    }),
  );

  // Auto-connect on startup
  if (autoConnect) {
    connectToServer();
  }
}

export function deactivate(): void {
  client?.dispose();
}

// ── Status Bar ─────────────────────────────────────────────────

function updateStatusBar(connected: boolean, model: string): void {
  const icon = connected ? "$(check)" : "$(circle-slash)";
  const shortModel = model.length > 20 ? model.slice(0, 17) + "..." : model;
  statusBarItem.text = `${icon} KCode: ${shortModel}`;
  statusBarItem.tooltip = connected
    ? `KCode connected - Model: ${model}\nClick to ask a question`
    : "KCode disconnected - Click to ask a question";
  statusBarItem.backgroundColor = connected
    ? undefined
    : new vscode.ThemeColor("statusBarItem.warningBackground");
}

// ── Server Connection ──────────────────────────────────────────

async function connectToServer(): Promise<void> {
  try {
    const health = await client.healthCheck();
    updateStatusBar(true, health.model);
    client.connectWebSocket();
    sidebarProvider.showStatus(true, health.model);
  } catch {
    updateStatusBar(false, "Offline");
    sidebarProvider.showStatus(false);
    // Retry after a delay
    setTimeout(connectToServer, 10_000);
  }
}

function onConfigChanged(): void {
  const config = vscode.workspace.getConfiguration("kcode");
  const serverUrl = config.get<string>("serverUrl", "http://localhost:10091");
  const apiKey = config.get<string>("apiKey", "");

  // Recreate client with new settings
  client.dispose();
  client = new KCodeClient(serverUrl, apiKey);
  sidebarProvider.setClient(client);
  connectToServer();
}

// ── Commands ───────────────────────────────────────────────────

async function cmdAsk(): Promise<void> {
  const input = await vscode.window.showInputBox({
    prompt: "Ask KCode",
    placeHolder: "What would you like to know?",
  });

  if (!input) return;

  if (!client.connected) {
    vscode.window.showWarningMessage("KCode is not connected. Start the KCode server first.");
    return;
  }

  // Send via WebSocket for streaming
  sidebarProvider.showMessage("user", input);
  client.wsSendMessage(input);

  // Reveal the sidebar
  vscode.commands.executeCommand("kcode.chat.focus");
}

async function cmdExplain(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor");
    return;
  }

  const selection = editor.document.getText(editor.selection);
  if (!selection) {
    vscode.window.showWarningMessage("No text selected");
    return;
  }

  if (!client.connected) {
    vscode.window.showWarningMessage("KCode is not connected. Start the KCode server first.");
    return;
  }

  const fileName = editor.document.fileName;
  const language = editor.document.languageId;
  const prompt = `Explain this ${language} code from ${fileName}:\n\n\`\`\`${language}\n${selection}\n\`\`\``;

  sidebarProvider.showMessage("user", `Explain selection from ${fileName}`);
  client.wsSendMessage(prompt);
  vscode.commands.executeCommand("kcode.chat.focus");
}

async function cmdCommit(): Promise<void> {
  if (!client.connected) {
    vscode.window.showWarningMessage("KCode is not connected. Start the KCode server first.");
    return;
  }

  const prompt = "Look at the current git diff and generate an appropriate commit message. Show me the suggested message.";
  sidebarProvider.showMessage("user", "Generate commit message");
  client.wsSendMessage(prompt);
  vscode.commands.executeCommand("kcode.chat.focus");
}

async function cmdTest(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor");
    return;
  }

  if (!client.connected) {
    vscode.window.showWarningMessage("KCode is not connected. Start the KCode server first.");
    return;
  }

  const selection = editor.document.getText(editor.selection);
  const fileName = editor.document.fileName;
  const language = editor.document.languageId;

  let prompt: string;
  if (selection) {
    prompt = `Generate tests for this ${language} code from ${fileName}:\n\n\`\`\`${language}\n${selection}\n\`\`\``;
  } else {
    prompt = `Generate tests for the file ${fileName}. Read the file first, then generate comprehensive tests.`;
  }

  sidebarProvider.showMessage("user", `Generate tests for ${fileName}`);
  client.wsSendMessage(prompt);
  vscode.commands.executeCommand("kcode.chat.focus");
}
