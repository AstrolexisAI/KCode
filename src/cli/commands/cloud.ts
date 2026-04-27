import type { Command } from "commander";

export function registerCloudCommand(program: Command): void {
  const cloudCmd = program
    .command("cloud")
    .description("KCode Cloud — team sync, shared memory, and analytics");

  cloudCmd
    .command("login")
    .description("Authenticate with KCode Cloud")
    .option("--email <email>", "Account email")
    .option("--token <token>", "API token (skip interactive login)")
    .action(async (opts: { email?: string; token?: string }) => {
      const { CloudClient } = await import("../../core/cloud/client");
      const client = new CloudClient();

      if (opts.token) {
        // Direct token auth — save to settings
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const settingsPath = join(homedir(), ".kcode", "settings.json");
        let settings: Record<string, unknown> = {};
        try {
          settings = await Bun.file(settingsPath).json();
        } catch {
          /* no existing settings */
        }
        settings.cloudConfig = { token: opts.token, url: "https://cloud.kulvex.ai" };
        await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
        console.log("\u2713 Cloud token saved.");
        return;
      }

      if (!opts.email) {
        console.error("Usage: kcode cloud login --email <email> or --token <token>");
        process.exit(1);
      }

      // Interactive password prompt
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const password = await new Promise<string>((resolve) => {
        rl.question("Password: ", (answer) => {
          rl.close();
          resolve(answer);
        });
      });

      try {
        const result = await client.login(opts.email, password);
        console.log(`\u2713 Logged in. Token expires: ${result.expiresAt}`);
      } catch (err: any) {
        console.error(`\u2717 Login failed: ${err.message}`);
        process.exit(1);
      }
    });

  cloudCmd
    .command("team")
    .description("Show team information")
    .action(async () => {
      const { CloudClient } = await import("../../core/cloud/client");
      const client = new CloudClient();
      if (!client.isConfigured()) {
        console.error("Not configured. Run: kcode cloud login");
        process.exit(1);
      }

      try {
        const team = await client.getTeam();
        console.log(`\nTeam: ${team.name} (${team.plan})`);
        console.log(`Members: ${team.members.length}`);
        for (const m of team.members) {
          console.log(`  ${m.name} <${m.email}> [${m.role}] — last active: ${m.lastActive}`);
        }
        console.log(`\nUsage this month:`);
        console.log(`  Sessions: ${team.usage.sessionsThisMonth}`);
        console.log(`  Tokens: ${team.usage.tokensThisMonth.toLocaleString()}`);
        console.log(`  Storage: ${team.usage.storageUsedMb} MB`);
      } catch (err: any) {
        console.error(`\u2717 ${err.message}`);
        process.exit(1);
      }
    });

  cloudCmd
    .command("invite <email>")
    .description("Invite a member to the team")
    .option("--role <role>", "Member role (admin|member)", "member")
    .action(async (email: string, opts: { role?: string }) => {
      const { CloudClient } = await import("../../core/cloud/client");
      const client = new CloudClient();
      try {
        await client.inviteMember(email, opts.role as "admin" | "member" | undefined);
        console.log(`\u2713 Invitation sent to ${email}`);
      } catch (err: any) {
        console.error(`\u2717 ${err.message}`);
        process.exit(1);
      }
    });

  cloudCmd
    .command("sync")
    .description("Sync current session to the cloud")
    .action(async () => {
      const { CloudClient } = await import("../../core/cloud/client");
      const { SessionSync } = await import("../../core/cloud/sync");
      const client = new CloudClient();
      const sync = new SessionSync(client);
      try {
        const result = await sync.syncSession("current", [], {});
        console.log(`\u2713 Synced ${result.messagesSynced} messages`);
      } catch (err: any) {
        console.error(`\u2717 Sync failed: ${err.message}`);
        process.exit(1);
      }
    });

  cloudCmd
    .command("analytics")
    .description("View team analytics")
    .option("--period <period>", "Time period (day|week|month)", "week")
    .action(async (opts: { period?: string }) => {
      const { CloudClient } = await import("../../core/cloud/client");
      const client = new CloudClient();
      try {
        const period = (opts.period || "week") as "day" | "week" | "month";
        const analytics = await client.getAnalytics(period);
        console.log(`\nTeam Analytics (${analytics.period}):`);
        console.log(`  Sessions: ${analytics.totalSessions}`);
        console.log(`  Tokens: ${analytics.totalTokens.toLocaleString()}`);
        console.log(`  Cost: $${analytics.totalCostUsd.toFixed(2)}`);
        console.log(`  Active members: ${analytics.activeMembers}`);
        if (analytics.topModels.length > 0) {
          console.log(`\n  Top models:`);
          for (const m of analytics.topModels) {
            console.log(`    ${m.model}: ${m.sessions} sessions`);
          }
        }
      } catch (err: any) {
        console.error(`\u2717 ${err.message}`);
        process.exit(1);
      }
    });

  cloudCmd
    .command("policies")
    .description("View or update team policies")
    .option("--set <json>", "Update policies with JSON")
    .action(async (opts: { set?: string }) => {
      const { CloudClient } = await import("../../core/cloud/client");
      const client = new CloudClient();
      try {
        if (opts.set) {
          const updates = JSON.parse(opts.set);
          await client.updatePolicies(updates);
          console.log("\u2713 Policies updated.");
        } else {
          const policies = await client.getPolicies();
          console.log("\nTeam Policies:");
          console.log(`  Allowed models: ${policies.allowedModels.join(", ") || "all"}`);
          console.log(`  Max cost/session: $${policies.maxCostPerSession}`);
          console.log(`  Require review: ${policies.requireReview}`);
          console.log(`  Audit enabled: ${policies.auditEnabled}`);
          console.log(`  Session retention: ${policies.sessionRetentionDays} days`);
        }
      } catch (err: any) {
        console.error(`\u2717 ${err.message}`);
        process.exit(1);
      }
    });
}
