import type { Command } from "commander";

export function registerAuthCommand(program: Command): void {
  const authCmd = program
    .command("auth")
    .description("Manage OAuth authentication for cloud AI providers");

  authCmd
    .command("login [provider]")
    .description(
      "Login to an AI provider via OAuth. Providers: anthropic, openai-codex, gemini",
    )
    .action(async (provider?: string) => {
      const {
        getOAuthProviderNames,
        loginProvider,
      } = await import("../../core/auth/oauth-flow");
      const { openBrowser } = await import("../../core/auth/oauth-flow");

      const providers = getOAuthProviderNames();

      if (!provider) {
        // Interactive provider selection
        const { createInterface } = await import("node:readline");
        console.log("\nAvailable OAuth providers:\n");
        const loginable = providers.filter((p) => p !== "kcode-cloud");
        for (let i = 0; i < loginable.length; i++) {
          const { PROVIDER_CONFIGS } = await import("../../core/auth/oauth-flow");
          const label = PROVIDER_CONFIGS[loginable[i]!]?.label ?? loginable[i];
          console.log(`  ${i + 1}. ${label} (${loginable[i]})`);
        }
        console.log();

        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question("Select provider (number or name): ", resolve);
        });
        rl.close();

        const num = parseInt(answer);
        if (num >= 1 && num <= loginable.length) {
          provider = loginable[num - 1];
        } else if (loginable.includes(answer.trim())) {
          provider = answer.trim();
        } else {
          console.error(`Invalid selection: "${answer}"`);
          process.exit(1);
        }
      }

      if (!provider || !providers.includes(provider)) {
        console.error(
          `Unknown provider: "${provider ?? ""}". Supported: ${providers.join(", ")}`,
        );
        process.exit(1);
      }

      console.log(`\nStarting OAuth login for ${provider}...`);

      try {
        const result = await loginProvider(provider, {
          onAuthUrl: (url) => {
            console.log("\nIf the browser didn't open automatically, visit this URL:\n");
            console.log(`  ${url}\n`);
          },
        });

        if (result.method === "api_key") {
          console.log(`\u2713 Authenticated with ${provider} (API key created and stored securely)`);
          console.log("  The key is stored in your system keychain.");
        } else {
          console.log(`\u2713 Authenticated with ${provider} (OAuth tokens stored securely)`);
          console.log("  Tokens will auto-refresh when they expire.");
        }

        console.log("\nYou can now use this provider's models without setting API keys manually.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\u2717 OAuth login failed: ${msg}`);
        process.exit(1);
      }
    });

  authCmd
    .command("status")
    .description("Show authentication status for all providers")
    .action(async () => {
      const {
        getOAuthProviderNames,
        getProviderAuthStatus,
      } = await import("../../core/auth/oauth-flow");

      const providers = getOAuthProviderNames();
      console.log("\n  Authentication Status\n");

      for (const name of providers) {
        const status = await getProviderAuthStatus(name);
        const icon = status.authenticated ? "\u2713" : "\u2717";
        const methodLabel =
          status.method === "claude-code"
            ? `Claude Code${status.detail ? ` (${status.detail})` : ""}`
            : status.method === "oauth"
              ? "OAuth"
              : status.method === "api_key"
                ? "API Key (keychain)"
                : status.method === "env"
                  ? "Env var"
                  : "not configured";

        let expiry = "";
        if (status.method === "oauth" && status.expiresAt) {
          const remaining = status.expiresAt - Date.now();
          if (remaining > 0) {
            const mins = Math.floor(remaining / 60_000);
            expiry = mins > 60 ? ` (expires in ${Math.floor(mins / 60)}h)` : ` (expires in ${mins}m)`;
          } else {
            expiry = " (expired — will auto-refresh)";
          }
        }

        console.log(
          `  ${icon} ${status.label.padEnd(22)} ${methodLabel}${expiry}`,
        );
      }
      console.log();
    });

  authCmd
    .command("logout [provider]")
    .description("Logout from a provider (clear stored tokens and API keys)")
    .option("--all", "Logout from all providers")
    .action(async (provider?: string, opts?: { all?: boolean }) => {
      const {
        getOAuthProviderNames,
        clearTokens,
      } = await import("../../core/auth/oauth-flow");
      const { deleteSecret } = await import("../../core/auth/keychain");

      if (opts?.all) {
        const providers = getOAuthProviderNames();
        for (const name of providers) {
          await clearTokens(name);
          await deleteSecret(`apikey-${name}`);
        }
        console.log("\u2713 Logged out from all providers.");
        return;
      }

      if (!provider) {
        console.error("Usage: kcode auth logout <provider> or kcode auth logout --all");
        process.exit(1);
      }

      await clearTokens(provider);
      await deleteSecret(`apikey-${provider}`);
      console.log(`\u2713 Logged out from ${provider}.`);
    });
}
