import * as vscode from "vscode";
import { KCodeApiClient } from "./api-client";

interface McpServer {
  name: string;
  alive: boolean;
  toolCount: number;
}

interface McpTool {
  name: string;
  description: string;
}

class McpServerItem extends vscode.TreeItem {
  constructor(public readonly server: McpServer) {
    super(server.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${server.toolCount} tools`;
    this.tooltip = `${server.name} — ${server.alive ? "connected" : "disconnected"} (${server.toolCount} tools)`;
    this.iconPath = new vscode.ThemeIcon(
      server.alive ? "plug" : "debug-disconnect",
      new vscode.ThemeColor(server.alive ? "terminal.ansiGreen" : "terminal.ansiRed")
    );
    this.contextValue = "mcpServer";
  }
}

class McpToolItem extends vscode.TreeItem {
  constructor(public readonly tool: McpTool) {
    super(tool.name, vscode.TreeItemCollapsibleState.None);
    this.description = tool.description?.slice(0, 60);
    this.tooltip = tool.description;
    this.iconPath = new vscode.ThemeIcon("wrench");
    this.contextValue = "mcpTool";
  }
}

class SectionHeader extends vscode.TreeItem {
  constructor(label: string, public readonly sectionType: "servers" | "tools") {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "section";
  }
}

export class KCodeMcpProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private servers: McpServer[] = [];
  private tools: McpTool[] = [];

  constructor(private readonly apiClient: KCodeApiClient) {}

  refresh(): void {
    this.fetchMcp();
  }

  private async fetchMcp(): Promise<void> {
    try {
      const data = await this.apiClient.getMcp();
      this.servers = data.servers ?? [];
      this.tools = data.tools ?? [];
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
      items.push(new SectionHeader(`Servers (${this.servers.length})`, "servers"));
      if (this.tools.length > 0) {
        items.push(new SectionHeader(`Tools (${this.tools.length})`, "tools"));
      }
      return items;
    }

    if (element instanceof SectionHeader) {
      if (element.sectionType === "servers") {
        if (this.servers.length === 0) {
          const empty = new vscode.TreeItem("No MCP servers connected");
          empty.description = "Configure in ~/.kcode/settings.json";
          return [empty];
        }
        return this.servers.map((s) => new McpServerItem(s));
      }
      if (element.sectionType === "tools") {
        return this.tools.map((t) => new McpToolItem(t));
      }
    }

    return [];
  }
}
