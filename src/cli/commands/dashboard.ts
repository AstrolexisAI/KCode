import type { Command } from "commander";
import { ProjectAnalyzer } from "../../core/dashboard/analyzer";
import { renderDashboard, renderDashboardJson } from "../../core/dashboard/renderer";

export function registerDashboardCommand(program: Command): void {
  program
    .command("dashboard")
    .description("Show project dashboard with metrics, tests, quality, and activity")
    .option("--watch", "Auto-refresh every 30 seconds")
    .option("--json", "Output as JSON")
    .option("--refresh <seconds>", "Refresh interval in seconds (with --watch)", parseInt, 30)
    .action(async (opts: { watch?: boolean; json?: boolean; refresh?: number }) => {
      const analyzer = new ProjectAnalyzer();
      const cwd = process.cwd();

      const display = async () => {
        const dashboard = await analyzer.analyze(cwd);
        if (opts.json) {
          console.log(renderDashboardJson(dashboard));
        } else {
          // Clear screen for watch mode
          if (opts.watch) process.stdout.write("\x1b[2J\x1b[H");
          console.log(renderDashboard(dashboard));
          if (opts.watch) {
            console.log(`\n  Auto-refreshing every ${opts.refresh ?? 30}s. Press Ctrl+C to stop.`);
          }
        }
      };

      await display();

      if (opts.watch) {
        const interval = (opts.refresh ?? 30) * 1000;
        setInterval(display, interval);
        // Keep alive
        await new Promise(() => {});
      }
    });
}
