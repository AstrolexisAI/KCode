import * as vscode from "vscode";
import { KCodeSidebarProvider } from "./sidebar";
import { openKCodeTerminal } from "./terminal";

let sidebarProvider: KCodeSidebarProvider;

export function activate(context: vscode.ExtensionContext) {
  // Register the sidebar webview provider
  sidebarProvider = new KCodeSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      KCodeSidebarProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Command: Send a prompt via input box
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.sendPrompt", async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: "Enter a prompt for KCode",
        placeHolder: "Ask KCode anything...",
      });
      if (prompt) {
        await sidebarProvider.sendPrompt(prompt);
      }
    })
  );

  // Command: New session
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.newSession", () => {
      sidebarProvider.newSession();
    })
  );

  // Command: Explain selection
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.explainSelection", async () => {
      const selection = getEditorSelection();
      if (!selection) {
        vscode.window.showWarningMessage("No text selected.");
        return;
      }
      const prompt = `Explain this code:\n\n\`\`\`\n${selection}\n\`\`\``;
      await sidebarProvider.sendPrompt(prompt);
    })
  );

  // Command: Fix selection
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.fixSelection", async () => {
      const selection = getEditorSelection();
      if (!selection) {
        vscode.window.showWarningMessage("No text selected.");
        return;
      }
      const prompt = `Fix bugs in this code:\n\n\`\`\`\n${selection}\n\`\`\``;
      await sidebarProvider.sendPrompt(prompt);
    })
  );

  // Command: Generate tests for selection
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.testSelection", async () => {
      const selection = getEditorSelection();
      if (!selection) {
        vscode.window.showWarningMessage("No text selected.");
        return;
      }
      const prompt = `Generate tests for this code:\n\n\`\`\`\n${selection}\n\`\`\``;
      await sidebarProvider.sendPrompt(prompt);
    })
  );

  // Command: Open KCode in terminal
  context.subscriptions.push(
    vscode.commands.registerCommand("kcode.openTerminal", () => {
      openKCodeTerminal();
    })
  );

  // Show activation message in output
  const outputChannel = vscode.window.createOutputChannel("KCode");
  outputChannel.appendLine("KCode extension activated.");
  context.subscriptions.push(outputChannel);
}

/**
 * Gets the currently selected text from the active editor.
 */
function getEditorSelection(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const selection = editor.selection;
  if (selection.isEmpty) {
    return undefined;
  }
  return editor.document.getText(selection);
}

export function deactivate() {
  // Cleanup handled by disposables
}
