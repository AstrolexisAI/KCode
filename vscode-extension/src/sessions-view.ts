import * as vscode from "vscode";
import { KCodeApiClient } from "./api-client";

interface SessionItem {
  type: "active" | "recent";
  label: string;
  sessionId?: string;
  filename?: string;
  messageCount: number;
  detail: string;
}

class SessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: SessionItem) {
    super(session.label, vscode.TreeItemCollapsibleState.None);
    this.description = session.detail;
    this.tooltip = `${session.label}\n${session.detail}\nMessages: ${session.messageCount}`;
    this.contextValue = session.type;

    if (session.type === "active") {
      this.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("terminal.ansiGreen"));
    } else {
      this.iconPath = new vscode.ThemeIcon("history");
    }

    this.command = {
      command: "kcode.viewSession",
      title: "View Session",
      arguments: [session],
    };
  }
}

class SectionHeader extends vscode.TreeItem {
  constructor(label: string, count: number) {
    super(`${label} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "section";
  }
}

export class KCodeSessionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private activeSessions: SessionItem[] = [];
  private recentSessions: SessionItem[] = [];

  constructor(private readonly apiClient: KCodeApiClient) {}

  refresh(): void {
    this.fetchSessions();
  }

  private async fetchSessions(): Promise<void> {
    try {
      const data = await this.apiClient.getSessions() as {
        active: Array<{ sessionId: string; model: string; messageCount: number; lastActivity: string }>;
        recent: Array<{ filename: string; prompt: string; messageCount: number; startedAt: string }>;
      };

      this.activeSessions = (data.active ?? []).map((s) => ({
        type: "active" as const,
        label: s.model || "Session",
        sessionId: s.sessionId,
        messageCount: s.messageCount,
        detail: `${s.messageCount} msgs`,
      }));

      this.recentSessions = (data.recent ?? []).slice(0, 20).map((s) => ({
        type: "recent" as const,
        label: s.prompt?.slice(0, 60) || s.filename,
        filename: s.filename,
        messageCount: s.messageCount,
        detail: s.startedAt?.slice(0, 16) ?? "",
      }));

      this._onDidChangeTreeData.fire();
    } catch {
      // Server not available
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      const items: vscode.TreeItem[] = [];
      if (this.activeSessions.length > 0) {
        items.push(new SectionHeader("Active", this.activeSessions.length));
      }
      if (this.recentSessions.length > 0) {
        items.push(new SectionHeader("Recent", this.recentSessions.length));
      }
      if (items.length === 0) {
        const empty = new vscode.TreeItem("No sessions");
        empty.description = "Start a chat to create a session";
        return [empty];
      }
      return items;
    }

    if (element instanceof SectionHeader) {
      if (element.label?.toString().startsWith("Active")) {
        return this.activeSessions.map((s) => new SessionTreeItem(s));
      }
      if (element.label?.toString().startsWith("Recent")) {
        return this.recentSessions.map((s) => new SessionTreeItem(s));
      }
    }

    return [];
  }
}
