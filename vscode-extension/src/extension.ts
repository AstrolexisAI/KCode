import * as vscode from "vscode";
import { KCodeApiClient } from "./api-client";
import { KCodeChatPanel } from "./chat-panel";
import { KCodeStatusBar } from "./status-bar";
import { KCodeCodeActionProvider } from "./code-actions";
import { KCodeSessionsProvider } from "./sessions-view";
import { KCodeMcpProvider } from "./mcp-view";

let apiClient: KCodeApiClient;
let chatPanel: KCodeChatPanel;
let statusBar: KCodeStatusBar;
let sessionsProvider: KCodeSessionsProvider;
let mcpProvider: KCodeMcpProvider;
let serverTerminal: vscode.Terminal | undefined;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("KCode");
  outputChannel.appendLine("KCode extension activating...");

  // Initialize the API client
  apiClient = new KCodeApiClient();
  context.subscriptions.push(new vscode.Disposable(() => apiClient.dispose()));

  // Initialize the status bar
  statusBar = new KCodeStatusBar(apiClient);
  context.subscriptions.push(statusBar);

  // Initialize the chat panel (sidebar webview)
  chatPanel = new KCodeChatPanel(context.extensionUri, apiClient);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      KCodeChatPanel.viewType,
      chatPanel,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Initialize tree view providers
  sessionsProvider = new KCodeSessionsProvider(apiClient);
  mcpProvider = new KCodeMcpProvider(apiClient);

  context.subscriptions.push(
    vscode.window.createTreeView("kcode.sessions", {
      treeDataProvider: sessionsProvider,
      showCollapseAll: true,
    })
  );

  context.subscriptions.push(
    vscode.window.createTreeView("kcode.mcp", {
      treeDataProvider: mcpProvider,
      showCollapseAll: true,
    })
  );

  // Register the code action provider for all languages
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new KCodeCodeActionProvider(),
      {
        providedCodeActionKinds: KCodeCodeActionProvider.providedCodeActionKinds,
      }
    )
  );

  // ── Register Commands ───────────────────────────────────────────

  // Open Chat
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.startChat", async () => {
      await vscode.commands.executeCommand("kcode.chat.focus");
    })
  );

  // Ask Question (via input box)
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.askQuestion", async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: "Ask KCode a question",
        placeHolder: "Ask anything about your code...",
      });
      if (prompt) {
        await vscode.commands.executeCommand("kcode.chat.focus");
        await chatPanel.sendPrompt(prompt);
      }
    })
  );

  // Explain Selection
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.explainCode", async () => {
      const { text, language, filePath } = getEditorContext();
      if (!text) {
        vscode.window.showWarningMessage("No text selected.");
        return;
      }
      const prompt = `Explain this ${language} code from \`${filePath}\`:\n\n\`\`\`${language}\n${text}\n\`\`\``;
      await vscode.commands.executeCommand("kcode.chat.focus");
      await chatPanel.sendPrompt(prompt);
    })
  );

  // Fix Selection
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.fixCode", async () => {
      const { text, language, filePath } = getEditorContext();
      if (!text) {
        vscode.window.showWarningMessage("No text selected.");
        return;
      }
      const prompt = `Fix any bugs or issues in this ${language} code from \`${filePath}\`:\n\n\`\`\`${language}\n${text}\n\`\`\`\n\nExplain what was wrong and show the corrected code.`;
      await vscode.commands.executeCommand("kcode.chat.focus");
      await chatPanel.sendPrompt(prompt);
    })
  );

  // Refactor Selection
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.refactorCode", async () => {
      const { text, language, filePath } = getEditorContext();
      if (!text) {
        vscode.window.showWarningMessage("No text selected.");
        return;
      }
      const prompt = `Refactor this ${language} code from \`${filePath}\` to improve readability, performance, or structure:\n\n\`\`\`${language}\n${text}\n\`\`\`\n\nExplain the changes you made and why.`;
      await vscode.commands.executeCommand("kcode.chat.focus");
      await chatPanel.sendPrompt(prompt);
    })
  );

  // Generate Tests
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.generateTests", async () => {
      const { text, language, filePath } = getEditorContext();
      if (!text) {
        vscode.window.showWarningMessage("No text selected.");
        return;
      }
      const prompt = `Generate comprehensive tests for this ${language} code from \`${filePath}\`:\n\n\`\`\`${language}\n${text}\n\`\`\`\n\nInclude edge cases and use the appropriate testing framework for this language.`;
      await vscode.commands.executeCommand("kcode.chat.focus");
      await chatPanel.sendPrompt(prompt);
    })
  );

  // Ask about current file
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.askAboutFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No file is open.");
        return;
      }

      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const language = editor.document.languageId;
      const lineCount = editor.document.lineCount;

      // Include file content (up to 500 lines) as context
      const maxLines = Math.min(lineCount, 500);
      const content = editor.document.getText(new vscode.Range(0, 0, maxLines, 0));

      const question = await vscode.window.showInputBox({
        prompt: `Ask about ${filePath}`,
        placeHolder: "What does this file do?",
      });

      if (question) {
        const prompt = `I have this ${language} file \`${filePath}\` (${lineCount} lines):\n\n\`\`\`${language}\n${content}\n\`\`\`\n\n${question}`;
        await vscode.commands.executeCommand("kcode.chat.focus");
        await chatPanel.sendPrompt(prompt);
      }
    })
  );

  // View Session (from tree view click)
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.viewSession", async (session: any) => {
      if (!session) { return; }

      if (session.type === "active" && session.sessionId) {
        // Switch to active session
        apiClient.setSessionId(session.sessionId);
        vscode.window.showInformationMessage(`Switched to session: ${session.label}`);
        await vscode.commands.executeCommand("kcode.chat.focus");
      } else if (session.type === "recent" && session.filename) {
        // View past session transcript
        try {
          const transcript = await apiClient.getSessionTranscript(session.filename);
          const doc = await vscode.workspace.openTextDocument({
            content: formatTranscript(transcript.messages),
            language: "markdown",
          });
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to load session: ${err.message}`);
        }
      }
    })
  );

  // Refresh Sessions
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.refreshSessions", () => {
      sessionsProvider.refresh();
    })
  );

  // Refresh MCP
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.refreshMcp", () => {
      mcpProvider.refresh();
    })
  );

  // Show Plan
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.showPlan", async () => {
      try {
        const data = await apiClient.getPlan();
        if (!data.plan) {
          vscode.window.showInformationMessage("No active plan in the current session.");
          return;
        }
        const doc = await vscode.workspace.openTextDocument({
          content: formatPlan(data.plan),
          language: "markdown",
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to get plan: ${err.message}`);
      }
    })
  );

  // Show Agents
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.showAgents", async () => {
      try {
        const data = await apiClient.getAgents();
        const lines: string[] = ["# Available Agents\n"];

        if (data.running.length > 0) {
          lines.push("## Running\n");
          for (const r of data.running) {
            lines.push(`- \`${r.id}\` (${Math.round(r.elapsed / 1000)}s)`);
          }
          lines.push("");
        }

        if (data.available.length > 0) {
          lines.push("## Defined\n");
          for (const a of data.available) {
            const flags: string[] = [];
            if (a.model) { flags.push(a.model); }
            if (a.effort) { flags.push(a.effort); }
            if (a.memory) { flags.push("memory"); }
            lines.push(`### ${a.name}\n`);
            lines.push(a.description);
            if (flags.length > 0) { lines.push(`\n*${flags.join(", ")}*`); }
            lines.push("");
          }
        } else {
          lines.push("No custom agents defined.\n\nCreate `.md` files in `~/.kcode/agents/` or `.kcode/agents/`.");
        }

        const doc = await vscode.workspace.openTextDocument({
          content: lines.join("\n"),
          language: "markdown",
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to get agents: ${err.message}`);
      }
    })
  );

  // Start Server
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.startServer", () => {
      startKCodeServer();
    })
  );

  // Stop Server
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.stopServer", () => {
      stopKCodeServer();
    })
  );

  // ── Listen for config changes ──────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kcode.serverUrl")) {
        apiClient.updateBaseUrl();
        apiClient.startAutoReconnect();
      }
    })
  );

  // ── Auto-start & connect ───────────────────────────────────────

  const config = vscode.workspace.getConfiguration("kcode");
  const autoStart = config.get<boolean>("autoStart", true);

  // Try connecting immediately; if that fails and autoStart is on, start the server
  apiClient.startAutoReconnect();

  apiClient.onStateChange(async (state) => {
    if (state === "connected") {
      try {
        const health = await apiClient.healthCheck();
        statusBar.setModel(health.model);
        outputChannel.appendLine(`Connected to KCode server (model: ${health.model}, version: ${health.version})`);

        // Refresh tree views on connection
        sessionsProvider.refresh();
        mcpProvider.refresh();
      } catch {
        // Ignore, status bar already updated by state change
      }
    }
  });

  // If auto-start is enabled and server is not reachable, start it
  if (autoStart) {
    setTimeout(async () => {
      if (apiClient.getState() === "disconnected") {
        outputChannel.appendLine("Auto-starting KCode server...");
        startKCodeServer();
      }
    }, 5000);
  }

  outputChannel.appendLine("KCode extension activated.");
  context.subscriptions.push(outputChannel);
}

// ── Helpers ────────────────────────────────────────────────────────

interface EditorContext {
  text: string | undefined;
  language: string;
  filePath: string;
}

function getEditorContext(): EditorContext {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return { text: undefined, language: "", filePath: "" };
  }
  const selection = editor.selection;
  const text = selection.isEmpty ? undefined : editor.document.getText(selection);
  const language = editor.document.languageId;
  const filePath = vscode.workspace.asRelativePath(editor.document.uri);
  return { text, language, filePath };
}

function formatTranscript(messages: Array<{ role: string; content: string }>): string {
  const lines: string[] = ["# Session Transcript\n"];
  for (const msg of messages) {
    const role = msg.role === "user" ? "User" : "Assistant";
    lines.push(`## ${role}\n`);
    lines.push(msg.content || "(empty)");
    lines.push("\n---\n");
  }
  return lines.join("\n");
}

function formatPlan(plan: unknown): string {
  if (!plan || typeof plan !== "object") {
    return "# Plan\n\nNo plan data available.";
  }

  const p = plan as Record<string, unknown>;
  const lines: string[] = ["# Task Plan\n"];

  if (p.title) { lines.push(`## ${p.title}\n`); }
  if (p.description) { lines.push(`${p.description}\n`); }

  if (Array.isArray(p.steps)) {
    lines.push("## Steps\n");
    for (let i = 0; i < p.steps.length; i++) {
      const step = p.steps[i] as Record<string, unknown>;
      const status = step.status === "completed" ? "[x]" : step.status === "in_progress" ? "[-]" : "[ ]";
      lines.push(`${i + 1}. ${status} ${step.title ?? step.description ?? "Step " + (i + 1)}`);
      if (step.details && typeof step.details === "string") {
        lines.push(`   ${step.details}`);
      }
    }
  }

  return lines.join("\n");
}

function startKCodeServer(): void {
  // Reuse existing terminal if one exists
  const existing = vscode.window.terminals.find((t) => t.name === "KCode Server");
  if (existing) {
    existing.show(false);
    return;
  }

  const config = vscode.workspace.getConfiguration("kcode");
  const serverUrl = config.get<string>("serverUrl", "http://localhost:10091");

  // Parse port from the URL
  let port = "10091";
  try {
    const url = new URL(serverUrl);
    port = url.port || "10091";
  } catch {
    // Default port
  }

  serverTerminal = vscode.window.createTerminal({
    name: "KCode Server",
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });

  serverTerminal.sendText(`kcode serve --port ${port}`);
  serverTerminal.show(false);

  outputChannel.appendLine(`Starting KCode server on port ${port}`);

  // Try reconnecting after a short delay to give the server time to start
  setTimeout(() => {
    apiClient.startAutoReconnect();
  }, 3000);
}

function stopKCodeServer(): void {
  const terminal = vscode.window.terminals.find((t) => t.name === "KCode Server");
  if (terminal) {
    terminal.sendText("\x03"); // Send Ctrl+C
    setTimeout(() => {
      terminal.dispose();
    }, 1000);
    serverTerminal = undefined;
    outputChannel.appendLine("KCode server stopped.");
  } else {
    vscode.window.showInformationMessage("No KCode server terminal found.");
  }
}

export function deactivate() {
  apiClient?.dispose();
}
