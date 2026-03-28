import type { Command } from "commander";
import { runSetup, getAvailableModels } from "../../core/model-manager";

export function registerSetupCommand(program: Command, exitWithPause: (code: number, errorMsg?: string) => Promise<never>): void {
  program
    .command("setup")
    .description("Auto-detect hardware, download engine and AI model")
    .option("--model <codename>", "Install a specific model (e.g. mnemo:mark5-14b)")
    .option("--force", "Force re-download even if already installed")
    .option("--list", "List available models")
    .action(async (opts: { model?: string; force?: boolean; list?: boolean }) => {
      if (opts.list) {
        console.log("\nAvailable mnemo:mark5 models:\n");
        for (const m of getAvailableModels()) {
          console.log(`  ${m.codename.padEnd(20)} ${m.paramBillions}B params, ~${m.sizeGB} GB — ${m.description}`);
          console.log(`  ${"".padEnd(20)} Min VRAM: ${(m.minVramMB / 1024).toFixed(0)} GB`);
        }
        console.log();
        return;
      }

      try {
        await runSetup({ model: opts.model, force: opts.force });
      } catch (err) {
        console.error(`\x1b[31mSetup failed: ${err instanceof Error ? err.message : err}\x1b[0m`);
        await exitWithPause(1);
      }
    });
}
