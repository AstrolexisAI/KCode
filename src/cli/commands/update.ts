import type { Command } from "commander";
import { checkForUpdate, downloadAndInstall } from "../../core/auto-update";

export function registerUpdateCommand(program: Command, VERSION: string): void {
  program
    .command("update")
    .description("Check for updates and self-update KCode")
    .option("--check", "Only check for updates, don't install")
    .option("--force", "Install without confirmation prompt")
    .option("--yes", "Alias for --force (skip confirmation)")
    .action(async (opts: { check?: boolean; force?: boolean; yes?: boolean }) => {
      const skipConfirm = opts.force || opts.yes;

      console.log(`\n  Current version: v${VERSION}\n`);
      console.log("  Checking for updates...\n");

      const info = await checkForUpdate(VERSION);

      if (!info.updateAvailable) {
        console.log(`  \x1b[32m✓\x1b[0m KCode v${VERSION} is up to date.\n`);
        return;
      }

      console.log(`  \x1b[33mUpdate available: v${info.currentVersion} → v${info.latestVersion}\x1b[0m`);
      if (info.publishedAt) {
        console.log(`  Published: ${info.publishedAt.split("T")[0]}`);
      }

      // Show release notes (truncated)
      if (info.releaseNotes) {
        console.log("\n  \x1b[1mChangelog:\x1b[0m");
        const lines = info.releaseNotes.split("\n").slice(0, 20);
        for (const line of lines) {
          console.log(`    ${line}`);
        }
        if (info.releaseNotes.split("\n").length > 20) {
          console.log("    ...(truncated)");
        }
      }

      if (info.releaseUrl) {
        console.log(`\n  Release: ${info.releaseUrl}`);
      }

      console.log();

      if (opts.check) {
        console.log("  Run \x1b[1mkcode update\x1b[0m to install.\n");
        return;
      }

      // Confirmation prompt (unless --force or --yes)
      if (!skipConfirm) {
        process.stdout.write("  Install update? [Y/n] ");
        const answer = await new Promise<string>((resolve) => {
          if (!process.stdin.isTTY) {
            resolve("y");
            return;
          }
          process.stdin.resume();
          process.stdin.setRawMode?.(false);
          process.stdin.once("data", (data) => {
            process.stdin.pause();
            resolve(data.toString().trim().toLowerCase());
          });
          // Auto-accept after 30s
          setTimeout(() => {
            process.stdin.pause();
            resolve("y");
          }, 30_000);
        });

        if (answer === "n" || answer === "no") {
          console.log("  Update cancelled.\n");
          return;
        }
      }

      // Download with progress
      console.log(`\n  Downloading v${info.latestVersion}...`);
      let lastPct = -1;

      const result = await downloadAndInstall(info, (pct) => {
        if (pct !== lastPct) {
          lastPct = pct;
          process.stderr.write(`\r  Downloading... ${pct}%`);
        }
      });

      process.stderr.write("\r" + " ".repeat(40) + "\r");

      if (result.success) {
        console.log(`  \x1b[32m✓\x1b[0m Updated to v${info.latestVersion}`);
        console.log(`\n  Restart KCode to use the new version.\n`);
      } else {
        console.error(`\n  \x1b[31m✗ Update failed: ${result.error}\x1b[0m\n`);
        process.exit(1);
      }
    });
}
