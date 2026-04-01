import type { Command } from "commander";

export function registerTriggersCommand(program: Command): void {
  const triggersCmd = program
    .command("triggers")
    .description("Manage remote agent triggers (scheduled cron agents)");

  triggersCmd
    .command("list")
    .alias("ls")
    .description("List all remote triggers")
    .action(async () => {
      const { TriggerApiClient } = await import("../../remote/triggers/trigger-api");
      const { TriggerManager } = await import("../../remote/triggers/trigger-manager");
      const client = new TriggerApiClient();
      const manager = new TriggerManager(client);

      try {
        const triggers = await manager.list();
        if (triggers.length === 0) {
          console.log("No triggers configured.");
          return;
        }

        console.log(`\n  Remote Triggers (${triggers.length}):\n`);
        for (const t of triggers) {
          const status =
            t.status === "active" ? "\u2713" : t.status === "paused" ? "\u2016" : "\u2717";
          const lastRun = t.lastRun
            ? `last: ${new Date(t.lastRun.timestamp).toLocaleDateString()} (${t.lastRun.status})`
            : "never run";
          console.log(`  ${status} ${t.name}  [${t.schedule}]  ${lastRun}`);
          console.log(`    ${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? "..." : ""}`);
        }
      } catch (err: any) {
        console.error(`\u2717 ${err.message}`);
        process.exit(1);
      }
    });

  triggersCmd
    .command("create")
    .description("Create a new remote trigger")
    .requiredOption("--name <name>", "Trigger name")
    .requiredOption("--schedule <cron>", "Cron schedule (5 fields: min hour dom month dow)")
    .requiredOption("--prompt <prompt>", "Agent prompt to execute")
    .option("--model <model>", "Model to use")
    .option("--max-turns <n>", "Max agent turns", (v: string) => parseInt(v, 10))
    .action(
      async (opts: {
        name: string;
        schedule: string;
        prompt: string;
        model?: string;
        maxTurns?: number;
      }) => {
        const { TriggerApiClient } = await import("../../remote/triggers/trigger-api");
        const { TriggerManager } = await import("../../remote/triggers/trigger-manager");
        const client = new TriggerApiClient();
        const manager = new TriggerManager(client);

        try {
          const trigger = await manager.create({
            name: opts.name,
            schedule: opts.schedule,
            prompt: opts.prompt,
            model: opts.model,
            maxTurns: opts.maxTurns,
          });
          console.log(`\u2713 Trigger "${trigger.name}" created (id: ${trigger.id})`);
          console.log(`  Schedule: ${trigger.schedule}`);
          if (trigger.nextRun) {
            console.log(`  Next run: ${new Date(trigger.nextRun).toLocaleString()}`);
          }
        } catch (err: any) {
          console.error(`\u2717 ${err.message}`);
          process.exit(1);
        }
      },
    );

  triggersCmd
    .command("delete <id>")
    .alias("rm")
    .description("Delete a remote trigger")
    .action(async (id: string) => {
      const { TriggerApiClient } = await import("../../remote/triggers/trigger-api");
      const { TriggerManager } = await import("../../remote/triggers/trigger-manager");
      const client = new TriggerApiClient();
      const manager = new TriggerManager(client);

      try {
        await manager.delete(id);
        console.log(`\u2713 Trigger ${id} deleted.`);
      } catch (err: any) {
        console.error(`\u2717 ${err.message}`);
        process.exit(1);
      }
    });

  triggersCmd
    .command("run <id>")
    .description("Run a trigger manually (without waiting for cron)")
    .action(async (id: string) => {
      const { TriggerApiClient } = await import("../../remote/triggers/trigger-api");
      const { TriggerManager } = await import("../../remote/triggers/trigger-manager");
      const client = new TriggerApiClient();
      const manager = new TriggerManager(client);

      try {
        console.log("Running trigger...");
        const result = await manager.runNow(id);
        console.log(`\u2713 ${result.status}: ${result.summary}`);
        console.log(
          `  Messages: ${result.messagesCount}, Tokens: ${result.tokensUsed}, Cost: $${result.costUsd.toFixed(4)}`,
        );
        console.log(`  Duration: ${result.durationMs}ms`);
      } catch (err: any) {
        console.error(`\u2717 ${err.message}`);
        process.exit(1);
      }
    });

  triggersCmd
    .command("history <id>")
    .description("Show execution history for a trigger")
    .option("--limit <n>", "Number of results", (v: string) => parseInt(v, 10), 10)
    .action(async (id: string, opts: { limit?: number }) => {
      const { TriggerApiClient } = await import("../../remote/triggers/trigger-api");
      const { TriggerManager } = await import("../../remote/triggers/trigger-manager");
      const client = new TriggerApiClient();
      const manager = new TriggerManager(client);

      try {
        const history = await manager.getHistory(id, opts.limit);
        if (history.length === 0) {
          console.log("No execution history.");
          return;
        }

        console.log(`\n  Execution History (${history.length}):\n`);
        for (const r of history) {
          const icon = r.status === "success" ? "\u2713" : "\u2717";
          console.log(`  ${icon} ${r.summary} (${r.durationMs}ms, $${r.costUsd.toFixed(4)})`);
        }
      } catch (err: any) {
        console.error(`\u2717 ${err.message}`);
        process.exit(1);
      }
    });

  triggersCmd
    .command("pause <id>")
    .description("Pause a trigger")
    .action(async (id: string) => {
      const { TriggerApiClient } = await import("../../remote/triggers/trigger-api");
      const { TriggerManager } = await import("../../remote/triggers/trigger-manager");
      const client = new TriggerApiClient();
      const manager = new TriggerManager(client);

      try {
        await manager.pause(id);
        console.log(`\u2713 Trigger ${id} paused.`);
      } catch (err: any) {
        console.error(`\u2717 ${err.message}`);
        process.exit(1);
      }
    });

  triggersCmd
    .command("resume <id>")
    .description("Resume a paused trigger")
    .action(async (id: string) => {
      const { TriggerApiClient } = await import("../../remote/triggers/trigger-api");
      const { TriggerManager } = await import("../../remote/triggers/trigger-manager");
      const client = new TriggerApiClient();
      const manager = new TriggerManager(client);

      try {
        await manager.resume(id);
        console.log(`\u2713 Trigger ${id} resumed.`);
      } catch (err: any) {
        console.error(`\u2717 ${err.message}`);
        process.exit(1);
      }
    });
}
