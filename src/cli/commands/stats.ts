import type { Command } from "commander";
import { collectStats, formatStats } from "../../core/stats";

export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description("Show usage statistics")
    .option("--days <n>", "Number of days to look back", parseInt, 7)
    .action(async (opts: { days: number }) => {
      const stats = await collectStats(opts.days);
      console.log(formatStats(stats));
    });
}
