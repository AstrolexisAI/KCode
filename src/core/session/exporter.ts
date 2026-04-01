import type { SessionSearch } from "./search";

export type ExportFormat = "markdown" | "json" | "html" | "txt";

export interface SessionExportOptions {
  sessionId: string;
  format: ExportFormat;
  includeToolCalls?: boolean;
  includeTimestamps?: boolean;
  outputPath?: string;
}

interface Turn {
  turnIndex: number;
  role: string;
  content: string;
}

export class SessionExporter {
  private search: SessionSearch;

  constructor(search: SessionSearch) {
    this.search = search;
  }

  async exportSession(options: SessionExportOptions): Promise<string> {
    const {
      sessionId,
      format,
      includeToolCalls = true,
      includeTimestamps = true,
      outputPath,
    } = options;

    const turns = this.search.getSessionTurns(sessionId);
    const filtered = includeToolCalls ? turns : turns.filter((t) => t.role !== "tool");

    let output: string;
    switch (format) {
      case "markdown":
        output = this.formatMarkdown(filtered, { includeTimestamps });
        break;
      case "json":
        output = this.formatJson(filtered, { includeTimestamps, sessionId });
        break;
      case "html":
        output = this.formatHtml(filtered, { includeTimestamps, sessionId });
        break;
      case "txt":
        output = this.formatTxt(filtered, { includeTimestamps });
        break;
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }

    if (outputPath) {
      await Bun.write(outputPath, output);
    }

    return output;
  }

  private formatMarkdown(turns: Turn[], opts: { includeTimestamps: boolean }): string {
    if (turns.length === 0) {
      return "# Session Transcript\n\nNo turns recorded.\n";
    }

    const lines: string[] = ["# Session Transcript", ""];

    for (const turn of turns) {
      const roleLabel = this.capitalizeRole(turn.role);
      lines.push(`## ${roleLabel} (Turn ${turn.turnIndex})`);
      if (opts.includeTimestamps) {
        lines.push(`*${this.formatTimestamp(Date.now())}*`);
      }
      lines.push("");

      if (turn.role === "tool") {
        lines.push("```");
        lines.push(turn.content);
        lines.push("```");
      } else {
        lines.push(turn.content);
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  private formatJson(
    turns: Turn[],
    opts: { includeTimestamps: boolean; sessionId: string },
  ): string {
    const data: Record<string, unknown> = {
      sessionId: opts.sessionId,
      turnCount: turns.length,
      turns: turns.map((turn) => {
        const entry: Record<string, unknown> = {
          turnIndex: turn.turnIndex,
          role: turn.role,
          content: turn.content,
        };
        if (opts.includeTimestamps) {
          entry.timestamp = this.formatTimestamp(Date.now());
        }
        return entry;
      }),
    };

    return JSON.stringify(data, null, 2);
  }

  private formatHtml(
    turns: Turn[],
    opts: { includeTimestamps: boolean; sessionId: string },
  ): string {
    const roleColors: Record<string, string> = {
      user: "#2563eb",
      assistant: "#16a34a",
      tool: "#9333ea",
      system: "#dc2626",
    };

    const turnHtml = turns
      .map((turn) => {
        const color = roleColors[turn.role] || "#374151";
        const roleLabel = this.capitalizeRole(turn.role);
        const timestamp = opts.includeTimestamps
          ? `<span style="color: #6b7280; font-size: 0.85em;">${this.formatTimestamp(Date.now())}</span>`
          : "";

        const contentHtml =
          turn.role === "tool"
            ? `<pre style="background: #f3f4f6; padding: 8px; border-radius: 4px;">${this.escapeHtml(turn.content)}</pre>`
            : `<p>${this.escapeHtml(turn.content)}</p>`;

        return `<div style="margin-bottom: 16px; padding: 12px; border-left: 3px solid ${color};">
  <strong style="color: ${color};">${roleLabel} (Turn ${turn.turnIndex})</strong> ${timestamp}
  ${contentHtml}
</div>`;
      })
      .join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Session ${this.escapeHtml(opts.sessionId)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #111827; }
  </style>
</head>
<body>
  <h1>Session Transcript</h1>
  ${turns.length === 0 ? "<p>No turns recorded.</p>" : turnHtml}
</body>
</html>`;
  }

  private formatTxt(turns: Turn[], opts: { includeTimestamps: boolean }): string {
    if (turns.length === 0) {
      return "Session Transcript\n\nNo turns recorded.\n";
    }

    const sections: string[] = [];

    for (const turn of turns) {
      const roleLabel = this.capitalizeRole(turn.role);
      let header = `[${roleLabel}] Turn ${turn.turnIndex}`;
      if (opts.includeTimestamps) {
        header += ` | ${this.formatTimestamp(Date.now())}`;
      }

      sections.push(header);
      sections.push(turn.content);
    }

    return sections.join("\n---\n") + "\n";
  }

  private formatTimestamp(ts: number): string {
    return new Date(ts).toISOString();
  }

  private capitalizeRole(role: string): string {
    return role.charAt(0).toUpperCase() + role.slice(1);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
