import type { Command } from "commander";
import { TranscriptManager } from "../../core/transcript";

export function registerSearchCommand(program: Command): void {
  program
    .command("search <query>")
    .description("Search through past session transcripts (FTS-powered)")
    .option("-n, --number <n>", "Max results to show", parseInt, 10)
    .option("-d, --days <days>", "Limit search to last N days", parseInt, 30)
    .option("--reindex", "Rebuild the FTS search index")
    .action(async (query: string, opts: { number?: number; days?: number; reindex?: boolean }) => {
      const { indexAllTranscripts, searchTranscripts, getIndexStats } = await import("../../core/transcript-search");
      const maxResults = opts.number ?? 10;

      // Auto-index on first use or when --reindex is passed
      const doReindex = opts.reindex ?? false;

      if (doReindex) {
        console.log("Rebuilding search index...");
      }

      const { indexed, entries } = indexAllTranscripts(doReindex);
      if (indexed > 0) {
        console.log(`Indexed ${indexed} new sessions (${entries} entries).`);
      }

      const stats = getIndexStats();
      if (stats.entries === 0) {
        console.log("No transcripts to search. Start a conversation first.");
        return;
      }

      // Use FTS search
      const results = await searchTranscripts(query, maxResults);

      if (results.length === 0) {
        // Fallback: try linear search for partial matches
        const transcript = new TranscriptManager();
        const sessions = transcript.listSessions();
        const cutoff = Date.now() - (opts.days ?? 30) * 24 * 60 * 60 * 1000;
        const queryLower = query.toLowerCase();
        let found = 0;

        console.log(`\nNo FTS matches for "${query}". Trying substring search...\n`);

        for (const session of sessions) {
          const dateStr = session.filename.slice(0, 10);
          const fileDate = new Date(dateStr).getTime();
          if (!isNaN(fileDate) && fileDate < cutoff) continue;

          const entries = transcript.loadSession(session.filename);
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]!;
            if (entry.content.toLowerCase().includes(queryLower)) {
              const preview = entry.content.slice(0, 120).replace(/\n/g, " ");
              console.log(`  \x1b[36m${session.startedAt}\x1b[0m [${entry.role}]`);
              console.log(`    ${preview}${entry.content.length > 120 ? "..." : ""}`);
              console.log(`    \x1b[2mSession: ${session.filename}:${i + 1}\x1b[0m`);
              console.log();
              found++;
              if (found >= maxResults) break;
            }
          }
          if (found >= maxResults) break;
        }

        if (found === 0) {
          console.log(`No matches for "${query}" in last ${opts.days ?? 30} days.`);
        }
        return;
      }

      console.log(`\nFound ${results.length} match(es) for "${query}" (${stats.sessions} sessions indexed):\n`);
      for (const r of results) {
        const preview = r.content.slice(0, 120).replace(/\n/g, " ");
        const dateStr = r.timestamp ? new Date(r.timestamp).toLocaleString() : "";
        console.log(`  \x1b[36m${dateStr}\x1b[0m [${r.role}]`);
        console.log(`    ${preview}${r.content.length > 120 ? "..." : ""}`);
        console.log(`    \x1b[2mSession: ${r.sessionFile}\x1b[0m`);
        console.log();
      }
    });
}
