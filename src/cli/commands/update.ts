import type { Command } from "commander";
import {
  checkForUpdate,
  downloadAndInstall,
  hasRollbackAvailable,
  rollback,
} from "../../core/auto-update";

export function registerUpdateCommand(program: Command, VERSION: string): void {
  program
    .command("update")
    .description("Check for updates and self-update KCode (kulvex.ai manifest)")
    .option("--check", "Only check for updates, don't install")
    .option("--force", "Install without confirmation prompt")
    .option("--yes", "Alias for --force (skip confirmation)")
    .option("--beta", "Use the beta channel if the manifest advertises one")
    .option("--rollback", "Restore the previously-installed binary")
    .action(
      async (opts: {
        check?: boolean;
        force?: boolean;
        yes?: boolean;
        beta?: boolean;
        rollback?: boolean;
      }) => {
        if (opts.rollback) {
          if (!hasRollbackAvailable()) {
            console.log("\n  No previous binary saved — nothing to roll back to.\n");
            return;
          }
          console.log("\n  Rolling back to previous binary...");
          const r = await rollback();
          if (r.success) {
            console.log("  \x1b[32m✓\x1b[0m Rolled back. Restart KCode to use the previous version.\n");
          } else {
            console.error(`\n  \x1b[31m✗ Rollback failed: ${r.error}\x1b[0m\n`);
            process.exit(1);
          }
          return;
        }

        const skipConfirm = opts.force || opts.yes;
        const channel: "stable" | "beta" = opts.beta ? "beta" : "stable";

        console.log(`\n  Current version: v${VERSION}`);
        console.log(`  Channel: ${channel}\n`);
        console.log("  Checking for updates...\n");

        const info = await checkForUpdate(VERSION, { channel });

        if (!info.updateAvailable) {
          console.log(`  \x1b[32m✓\x1b[0m KCode v${VERSION} is up to date.\n`);
          return;
        }

        console.log(
          `  \x1b[33mUpdate available: v${info.currentVersion} → v${info.latestVersion}\x1b[0m`,
        );
        if (info.publishedAt) {
          console.log(`  Published: ${info.publishedAt.split("T")[0]}`);
        }
        if (info.size && info.size > 0) {
          console.log(`  Size: ${(info.size / 1024 / 1024).toFixed(1)} MB`);
        }
        if (info.releaseUrl) {
          console.log(`  Release notes: ${info.releaseUrl}`);
        }

        console.log();

        if (opts.check) {
          console.log("  Run \x1b[1mkcode update\x1b[0m to install.\n");
          return;
        }

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
          console.log("  Previous binary saved (rollback with: kcode update --rollback)");
          console.log("\n  Restart KCode to use the new version.\n");
        } else {
          console.error(`\n  \x1b[31m✗ Update failed: ${result.error}\x1b[0m\n`);
          process.exit(1);
        }
      },
    );
}
