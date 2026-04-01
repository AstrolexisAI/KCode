import type { Command } from "commander";

export function registerSessionsCommand(program: Command): void {
  const sessionsCmd = program
    .command("sessions")
    .description("Browse, search, and export past sessions");

  sessionsCmd
    .command("list")
    .alias("ls")
    .description("List past sessions")
    .option("--limit <n>", "Number of sessions to show", (v: string) => parseInt(v, 10), 20)
    .option("--sort <field>", "Sort by field (date|turns)", "date")
    .action(async (opts: { limit?: number; sort?: string }) => {
      const { Database } = await import("bun:sqlite");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { SessionBrowser } = await import("../../core/session/browser");

      const dbPath = join(homedir(), ".kcode", "awareness.db");
      const db = new Database(dbPath);
      const browser = new SessionBrowser(db);

      const sessions = browser.listSessions({
        limit: opts.limit,
        sortBy: (opts.sort as "date" | "turns") || "date",
      });

      if (sessions.length === 0) {
        console.log("No sessions found.");
        db.close();
        return;
      }

      console.log(`\n  Sessions (${sessions.length}):\n`);
      for (const s of sessions) {
        const date = new Date(s.startedAt).toLocaleDateString();
        const time = new Date(s.startedAt).toLocaleTimeString();
        console.log(`  ${s.sessionId.slice(0, 8)}  ${date} ${time}  [${s.turnCount} turns]  ${s.model || ""}`);
        if (s.summary) {
          console.log(`    ${s.summary}`);
        }
      }

      db.close();
    });

  sessionsCmd
    .command("search <query>")
    .description("Full-text search across session transcripts")
    .option("--limit <n>", "Max results", (v: string) => parseInt(v, 10), 20)
    .action(async (query: string, opts: { limit?: number }) => {
      const { Database } = await import("bun:sqlite");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { SessionSearch } = await import("../../core/session/search");

      const dbPath = join(homedir(), ".kcode", "awareness.db");
      const db = new Database(dbPath);
      const search = new SessionSearch(db);

      const results = search.search(query, opts.limit);

      if (results.length === 0) {
        console.log(`No results for "${query}".`);
        db.close();
        return;
      }

      console.log(`\n  Search results for "${query}" (${results.length}):\n`);
      for (const r of results) {
        const date = new Date(r.timestamp).toLocaleDateString();
        console.log(`  [${r.sessionId.slice(0, 8)}] ${date} (${r.role}, turn ${r.turnIndex})`);
        console.log(`    ${r.matchSnippet}`);
      }

      db.close();
    });

  sessionsCmd
    .command("export <sessionId>")
    .description("Export a session to a file")
    .option("--format <fmt>", "Export format (markdown|json|html|txt)", "markdown")
    .option("--output <path>", "Output file path")
    .option("--no-timestamps", "Exclude timestamps")
    .option("--no-tool-calls", "Exclude tool call details")
    .action(async (sessionId: string, opts: { format?: string; output?: string; timestamps?: boolean; toolCalls?: boolean }) => {
      const { Database } = await import("bun:sqlite");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { SessionSearch } = await import("../../core/session/search");
      const { SessionExporter } = await import("../../core/session/exporter");

      const dbPath = join(homedir(), ".kcode", "awareness.db");
      const db = new Database(dbPath);
      const search = new SessionSearch(db);
      const exporter = new SessionExporter(search);

      try {
        const result = await exporter.exportSession({
          sessionId,
          format: (opts.format as "markdown" | "json" | "html" | "txt") || "markdown",
          includeTimestamps: opts.timestamps !== false,
          includeToolCalls: opts.toolCalls !== false,
          outputPath: opts.output,
        });

        if (opts.output) {
          console.log(`\u2713 Session exported to ${result}`);
        } else {
          console.log(result);
        }
      } catch (err: any) {
        console.error(`\u2717 ${err.message}`);
        process.exit(1);
      }

      db.close();
    });

  sessionsCmd
    .command("stats")
    .description("Show session statistics")
    .action(async () => {
      const { Database } = await import("bun:sqlite");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { SessionBrowser } = await import("../../core/session/browser");

      const dbPath = join(homedir(), ".kcode", "awareness.db");
      const db = new Database(dbPath);
      const browser = new SessionBrowser(db);

      const stats = browser.getStats();
      console.log("\n  Session Statistics:");
      console.log(`    Total sessions: ${stats.totalSessions}`);
      console.log(`    Total turns: ${stats.totalTurns}`);
      if (stats.oldestSession) {
        console.log(`    Oldest: ${stats.oldestSession}`);
        console.log(`    Newest: ${stats.newestSession}`);
      }

      db.close();
    });
}
