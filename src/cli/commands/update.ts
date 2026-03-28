import type { Command } from "commander";
import { checkForUpdate, performUpdate } from "../../core/updater";

export function registerUpdateCommand(program: Command, VERSION: string): void {
  program
    .command("update")
    .description("Check for updates and self-update KCode")
    .option("--check", "Only check, don't download")
    .option("--url <url>", "Custom update URL")
    .action(async (opts: { check?: boolean; url?: string }) => {
      if (opts.check) {
        const newVersion = await checkForUpdate(VERSION);
        if (newVersion) {
          console.log(`\x1b[33mUpdate available: v${VERSION} → v${newVersion}\x1b[0m`);
          console.log("Run \x1b[1mkcode update\x1b[0m to install.");
        } else {
          console.log(`\x1b[32m✓\x1b[0m KCode v${VERSION} is up to date.`);
        }
        return;
      }

      const result = await performUpdate(VERSION, opts.url);
      if (result.error) {
        console.error(`\x1b[31m✗ ${result.error}\x1b[0m`);
        process.exit(1);
      }
    });
}
