import type { Command } from "commander";
import { kcodePath } from "../../core/paths";

export function registerHistoryCommand(program: Command): void {
  program
    .command("history")
    .description("Browse and manage session history")
    .option("-n, --limit <count>", "Number of sessions to show", parseInt, 20)
    .option("--load <filename>", "Load a specific session by filename")
    .option("--delete <filename>", "Delete a specific session")
    .option("--clear", "Delete all sessions")
    .action(async (opts: { limit?: number; load?: string; delete?: string; clear?: boolean }) => {
      const { readdirSync, unlinkSync, statSync } = await import("node:fs");
      const { join } = await import("node:path");
      const transcriptsDir = kcodePath("transcripts");

      if (opts.clear) {
        try {
          const files = readdirSync(transcriptsDir).filter(f => f.endsWith(".jsonl"));
          for (const f of files) unlinkSync(join(transcriptsDir, f));
          console.log(`Deleted ${files.length} sessions.`);
        } catch { console.log("No sessions to delete."); }
        return;
      }

      if (opts.delete) {
        try {
          unlinkSync(join(transcriptsDir, opts.delete));
          console.log(`Deleted: ${opts.delete}`);
        } catch { console.error(`Session not found: ${opts.delete}`); process.exit(1); }
        return;
      }

      if (opts.load) {
        // Load and display session contents
        try {
          const { readFileSync } = await import("node:fs");
          const content = readFileSync(join(transcriptsDir, opts.load), "utf-8");
          const entries = content.trim().split("\n").filter(Boolean).map(line => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);

          console.log(`\n\x1b[1mSession: ${opts.load}\x1b[0m`);
          console.log(`Entries: ${entries.length}\n`);

          for (const entry of entries) {
            const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString("en-US", { hour12: false }) : "??:??";
            const role = entry.role ?? "?";
            const type = entry.type ?? "?";
            const content = (entry.content ?? "").slice(0, 120);

            if (type === "user_message") {
              console.log(`  \x1b[36m${time}\x1b[0m \x1b[1m❯\x1b[0m ${content}`);
            } else if (type === "assistant_text") {
              console.log(`  \x1b[36m${time}\x1b[0m   ${content}`);
            } else if (type === "tool_use") {
              try {
                const parsed = JSON.parse(content);
                console.log(`  \x1b[36m${time}\x1b[0m \x1b[33m⚡ ${parsed.name}\x1b[0m`);
              } catch {
                console.log(`  \x1b[36m${time}\x1b[0m \x1b[33m⚡ tool\x1b[0m`);
              }
            }
          }
          console.log();
        } catch {
          console.error(`Could not read session: ${opts.load}`);
          process.exit(1);
        }
        return;
      }

      // List recent sessions
      try {
        const files = readdirSync(transcriptsDir)
          .filter(f => f.endsWith(".jsonl"))
          .sort()
          .reverse()
          .slice(0, opts.limit ?? 20);

        if (files.length === 0) {
          console.log("No session history found.");
          return;
        }

        console.log(`\n\x1b[1mRecent sessions\x1b[0m (${files.length}):\n`);
        for (const f of files) {
          try {
            const stat = statSync(join(transcriptsDir, f));
            const sizeKB = Math.round(stat.size / 1024);
            // Extract date and slug from filename: 2026-03-17T12-30-45-slug.jsonl
            const match = f.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})-(.+)\.jsonl$/);
            if (match) {
              const date = match[1]!;
              const time = match[2]!.replace(/-/g, ":");
              const slug = match[3]!.replace(/-/g, " ");
              console.log(`  \x1b[36m${date} ${time}\x1b[0m  ${slug.slice(0, 50).padEnd(52)} \x1b[2m${sizeKB}KB\x1b[0m`);
            } else {
              console.log(`  ${f}  \x1b[2m${sizeKB}KB\x1b[0m`);
            }
          } catch {
            console.log(`  ${f}`);
          }
        }
        console.log(`\n  Load a session: \x1b[1mkcode history --load <filename>\x1b[0m`);
        console.log(`  Continue it:    \x1b[1mkcode --continue\x1b[0m\n`);
      } catch {
        console.log("No session history found.");
      }
    });
}
