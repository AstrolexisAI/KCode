import type { Command } from "commander";
import { TranscriptManager } from "../../core/transcript";

export function registerResumeCommand(program: Command): void {
  program
    .command("resume")
    .description("List and resume previous sessions")
    .option("-l, --list", "List recent sessions")
    .option("-n, --number <n>", "Number of sessions to show", parseInt, 10)
    .action(async (opts: { list?: boolean; number?: number }) => {
      const transcript = new TranscriptManager();
      const sessions = transcript.listSessions();

      if (sessions.length === 0) {
        console.log("No previous sessions found.");
        return;
      }

      const count = Math.min(opts.number ?? 10, sessions.length);
      console.log(`\nRecent sessions (${count} of ${sessions.length}):\n`);

      for (let i = 0; i < count; i++) {
        const s = sessions[i]!;
        const date = s.startedAt.replace("T", " ");
        const prompt = s.prompt.slice(0, 60);
        console.log(`  \x1b[36m${i + 1}.\x1b[0m ${date}  ${prompt}`);
      }

      console.log("\nTo resume a session:");
      console.log("  \x1b[1mkcode --continue\x1b[0m         Resume the most recent session");
      console.log(
        "  \x1b[1mkcode --fork\x1b[0m             Fork the most recent session (new transcript)",
      );
    });
}
