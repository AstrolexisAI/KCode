import type { Command } from "commander";
import {
  clearProCache,
  getTrialDaysRemaining,
  isPro,
  isTrialExpired,
  isTrialKey,
  PRO_FEATURES,
} from "../../core/pro";

export function registerProCommands(program: Command): void {
  // ─── Activate subcommand (legacy alias) ────────────────────────
  program
    .command("activate <pro-key>")
    .description("Activate a KCode Pro or trial key (legacy alias for 'kcode pro activate')")
    .action(async (proKey: string) => {
      try {
        const { loadUserSettingsRaw, saveUserSettingsRaw } = await import("../../core/config");
        const settings = await loadUserSettingsRaw();
        settings.proKey = proKey;
        await saveUserSettingsRaw(settings);
        clearProCache();

        if (await isPro()) {
          if (isTrialKey(proKey)) {
            const days = getTrialDaysRemaining(proKey);
            console.log(`\x1b[32m✓\x1b[0m KCode Pro trial activated!`);
            console.log(`  ${days} day${days !== 1 ? "s" : ""} remaining.\n`);
          } else {
            console.log(`\x1b[32m✓\x1b[0m KCode Pro activated!`);
            console.log(`  Pro features are now unlocked.\n`);
          }
        } else {
          if (isTrialKey(proKey) && isTrialExpired(proKey)) {
            console.error(`\x1b[31m✗\x1b[0m Trial key has expired.`);
            console.error(`  Upgrade to Pro: \x1b[36mhttps://kulvex.ai/pro\x1b[0m\n`);
          } else {
            console.error(`\x1b[31m✗\x1b[0m Pro key could not be validated.\n`);
            console.error(`  Check that it's correct, or try again if offline.`);
            console.error(`  Get a key: \x1b[36mhttps://kulvex.ai/pro\x1b[0m\n`);
          }
          // Only remove key if server explicitly rejected it (not network failure)
          const { loadProCache } = await import("../../core/pro");
          const cache = loadProCache();
          if (cache && cache.key === proKey && cache.serverValidated && !cache.valid) {
            settings.proKey = undefined;
            await saveUserSettingsRaw(settings);
          }
          clearProCache();
          process.exit(1);
        }
      } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  // ─── Pro subcommand ─────────────────────────────────────────
  const proCmd = program.command("pro").description("Manage KCode Pro subscription");

  proCmd
    .command("status")
    .description("Show Pro status and available features")
    .action(async () => {
      try {
        const pro = await isPro();
        const { loadUserSettingsRaw } = await import("../../core/config");
        const settings = await loadUserSettingsRaw();
        const key = (settings as Record<string, unknown>).proKey as string | undefined;
        const isTrial = key ? isTrialKey(key) : false;

        if (pro && isTrial) {
          const days = getTrialDaysRemaining(key!);
          console.log(`\x1b[33m● KCode Pro trial active\x1b[0m`);
          console.log(`  ${days} day${days !== 1 ? "s" : ""} remaining`);
          console.log(`  Upgrade: \x1b[36mhttps://kulvex.ai/pro\x1b[0m\n`);
        } else if (pro) {
          console.log(`\x1b[32m● KCode Pro active\x1b[0m\n`);
        } else if (isTrial && isTrialExpired(key!)) {
          console.log(`\x1b[31m● KCode Pro trial expired\x1b[0m`);
          console.log(`  Upgrade: \x1b[36mhttps://kulvex.ai/pro\x1b[0m\n`);
        } else {
          console.log(`\x1b[2m○ KCode Pro not active\x1b[0m`);
          console.log(`  Activate: kcode pro activate <your-pro-key>`);
          console.log(`  Get a key: \x1b[36mhttps://kulvex.ai/pro\x1b[0m`);
          console.log(`  Try free:  \x1b[36mhttps://kulvex.ai/pro/trial\x1b[0m\n`);
        }

        console.log(`  Pro features:`);
        for (const [feat, desc] of Object.entries(PRO_FEATURES)) {
          const icon = pro ? "\x1b[32m✓\x1b[0m" : "\x1b[2m○\x1b[0m";
          console.log(`    ${icon} ${desc} \x1b[2m(${feat})\x1b[0m`);
        }
        console.log();
      } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  proCmd
    .command("activate <pro-key>")
    .description("Activate a Pro or trial key")
    .action(async (proKey: string) => {
      try {
        const { loadUserSettingsRaw, saveUserSettingsRaw } = await import("../../core/config");
        const settings = await loadUserSettingsRaw();
        settings.proKey = proKey;
        await saveUserSettingsRaw(settings);
        clearProCache();

        if (await isPro()) {
          if (isTrialKey(proKey)) {
            const days = getTrialDaysRemaining(proKey);
            console.log(`\x1b[32m✓\x1b[0m KCode Pro trial activated!`);
            console.log(`  ${days} day${days !== 1 ? "s" : ""} remaining.`);
            console.log(`  Upgrade anytime: \x1b[36mhttps://kulvex.ai/pro\x1b[0m\n`);
          } else {
            console.log(`\x1b[32m✓\x1b[0m KCode Pro activated!`);
            console.log(`  Pro features are now unlocked.\n`);
          }
        } else {
          if (isTrialKey(proKey) && isTrialExpired(proKey)) {
            console.error(`\x1b[31m✗\x1b[0m Trial key has expired.`);
            console.error(`  Upgrade to Pro: \x1b[36mhttps://kulvex.ai/pro\x1b[0m\n`);
          } else {
            console.error(`\x1b[31m✗\x1b[0m Pro key not valid.`);
            console.error(`  The key was not recognized. Check that it's correct.`);
            console.error(`  Get a key: \x1b[36mhttps://kulvex.ai/pro\x1b[0m\n`);
          }
          delete settings.proKey;
          await saveUserSettingsRaw(settings);
          clearProCache();
          process.exit(1);
        }
      } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  proCmd
    .command("deactivate")
    .description("Remove Pro key from this machine")
    .action(async () => {
      try {
        const { loadUserSettingsRaw, saveUserSettingsRaw } = await import("../../core/config");
        const settings = await loadUserSettingsRaw();
        delete settings.proKey;
        await saveUserSettingsRaw(settings);
        clearProCache();
        console.log("Pro key removed.");
      } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  proCmd
    .command("checkout")
    .description("Open the KCode Pro purchase page in your browser")
    .action(async () => {
      try {
        const url = "https://kulvex.ai/pro";
        console.log(`\nOpening ${url} ...\n`);
        try {
          const { execFileSync } = await import("node:child_process");
          const cmd =
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
                ? "start"
                : "xdg-open";
          execFileSync(cmd, [url], { stdio: "ignore" });
          console.log("  Opened in your browser.");
        } catch {
          console.log(`  Open this URL in your browser: \x1b[36m${url}\x1b[0m`);
        }
        console.log();
      } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  proCmd
    .command("trial")
    .description("Learn about starting a KCode Pro trial")
    .action(async () => {
      try {
        const { loadUserSettingsRaw } = await import("../../core/config");
        const settings = await loadUserSettingsRaw();
        const key = (settings as Record<string, unknown>).proKey as string | undefined;

        if (key && isTrialKey(key) && !isTrialExpired(key)) {
          const days = getTrialDaysRemaining(key);
          console.log(`\n\x1b[33m● You already have an active trial\x1b[0m`);
          console.log(`  ${days} day${days !== 1 ? "s" : ""} remaining.\n`);
          return;
        }

        if (key && isTrialKey(key) && isTrialExpired(key)) {
          console.log(`\n\x1b[31m● Your trial has expired.\x1b[0m`);
          console.log(`  Upgrade to Pro: \x1b[36mhttps://kulvex.ai/pro\x1b[0m\n`);
          return;
        }

        console.log(`\n  Start a free trial of KCode Pro!`);
        console.log(`  Get your trial key at: \x1b[36mhttps://kulvex.ai/pro/trial\x1b[0m`);
        console.log(`  Then activate it with: kcode pro activate <trial-key>\n`);
      } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  proCmd
    .command("manage")
    .description("Open billing portal to manage subscription, cancel, or update payment")
    .action(async () => {
      try {
        if (!(await isPro())) {
          console.error("\x1b[31m✗\x1b[0m No active Pro subscription to manage.");
          console.error("  Activate first: kcode pro activate <your-pro-key>");
          process.exit(1);
        }

        const { loadUserSettingsRaw } = await import("../../core/config");
        const settings = await loadUserSettingsRaw();
        const key = (settings as Record<string, unknown>).proKey as string;

        console.log("\nOpening billing portal...\n");

        const resp = await fetch("https://kulvex.ai/api/pro/portal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
          signal: AbortSignal.timeout(10000),
        });

        const data = (await resp.json()) as { url?: string; error?: string };

        if (data.url) {
          console.log(`\x1b[32m✓\x1b[0m Billing portal: \x1b[36m${data.url}\x1b[0m\n`);
          // Try to open in browser
          try {
            const { execSync } = await import("node:child_process");
            const cmd =
              process.platform === "darwin"
                ? "open"
                : process.platform === "win32"
                  ? "start"
                  : "xdg-open";
            const { execFileSync: openExec } = await import("node:child_process");
            openExec(cmd, [data.url], { stdio: "ignore" });
            console.log("  Opened in your browser.");
          } catch {
            console.log("  Copy the URL above to open in your browser.");
          }
        } else {
          console.error(`\x1b[31m✗\x1b[0m ${data.error ?? "Failed to create portal session"}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
