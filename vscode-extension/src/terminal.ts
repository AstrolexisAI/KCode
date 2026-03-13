import * as vscode from "vscode";

const TERMINAL_NAME = "KCode";

/**
 * Opens (or reuses) a VS Code terminal running `kcode` interactively.
 * The terminal's cwd is set to the current workspace folder.
 */
export function openKCodeTerminal(): vscode.Terminal {
  // Reuse an existing KCode terminal if one is still open
  const existing = vscode.window.terminals.find(
    (t) => t.name === TERMINAL_NAME
  );
  if (existing) {
    existing.show(true);
    return existing;
  }

  const config = vscode.workspace.getConfiguration("kcode");
  const binaryPath = config.get<string>("binaryPath", "kcode");
  const model = config.get<string>("model", "");
  const permissionMode = config.get<string>("permissionMode", "acceptEdits");

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const args: string[] = [];
  if (model) {
    args.push("--model", model);
  }
  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }

  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd: workspaceFolder,
    shellPath: binaryPath,
    shellArgs: args,
  });

  terminal.show(true);
  return terminal;
}
