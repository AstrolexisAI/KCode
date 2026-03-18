import * as vscode from "vscode";
import { KCodeApiClient, ConnectionState } from "./api-client";

export class KCodeStatusBar {
  private statusBarItem: vscode.StatusBarItem;
  private modelName: string = "";
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly apiClient: KCodeApiClient) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = "kcode.startChat";
    this.statusBarItem.tooltip = "KCode - Click to open chat";

    // Listen for connection state changes
    this.disposables.push(
      apiClient.onStateChange((state) => this.updateDisplay(state))
    );

    this.updateDisplay("disconnected");
    this.statusBarItem.show();
  }

  public updateDisplay(state: ConnectionState): void {
    switch (state) {
      case "connected":
        this.statusBarItem.text = `$(check) KCode${this.modelName ? ": " + this.modelName : ""}`;
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.tooltip = `KCode connected${this.modelName ? " - Model: " + this.modelName : ""}\nClick to open chat`;
        break;
      case "connecting":
        this.statusBarItem.text = "$(sync~spin) KCode";
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.tooltip = "KCode - Connecting to server...";
        break;
      case "disconnected":
        this.statusBarItem.text = "$(circle-slash) KCode";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        this.statusBarItem.tooltip = "KCode - Disconnected\nClick to open chat, or run KCode: Start Server";
        break;
    }
  }

  public setModel(model: string): void {
    this.modelName = model;
    this.updateDisplay(this.apiClient.getState());
  }

  public dispose(): void {
    this.statusBarItem.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
