import type { Command } from "commander";
import {
  loadModelsConfig,
  listModels,
  addModel,
  removeModel,
  setDefaultModel,
} from "../../core/models";

export function registerModelsCommand(program: Command): void {
  const modelsCmd = program
    .command("models")
    .description("Manage registered LLM models");

  modelsCmd
    .command("list")
    .alias("ls")
    .description("List all registered models")
    .action(async () => {
      const models = await listModels();
      const config = await loadModelsConfig();

      if (models.length === 0) {
        console.log("No models registered. Use 'kcode models add' to register one.");
        console.log("\nExample:");
        console.log("  kcode models add mnemo:code3 http://localhost:8091 --context 32000 --gpu 'RTX 5090'");
        return;
      }

      console.log("Registered models:\n");
      for (const m of models) {
        const isDefault = m.name === config.defaultModel ? " (default)" : "";
        const ctx = m.contextSize ? `, ctx: ${m.contextSize.toLocaleString()}` : "";
        const gpu = m.gpu ? `, gpu: ${m.gpu}` : "";
        const caps = m.capabilities?.length ? `, caps: [${m.capabilities.join(", ")}]` : "";
        const desc = m.description ? `\n    ${m.description}` : "";
        console.log(`  ${m.name}${isDefault}`);
        console.log(`    ${m.baseUrl}${ctx}${gpu}${caps}${desc}`);
      }
    });

  modelsCmd
    .command("add <name> <baseUrl>")
    .description("Add or update a model")
    .option("--context <size>", "Context window size in tokens", (v: string) => parseInt(v, 10))
    .option("--gpu <gpu>", "GPU identifier (informational)")
    .option("--caps <capabilities>", "Comma-separated capabilities (e.g. code,vision)")
    .option("--desc <description>", "Description of the model")
    .option("--default", "Set as default model")
    .action(async (name: string, baseUrl: string, opts: any) => {
      await addModel({
        name,
        baseUrl,
        contextSize: opts.context,
        gpu: opts.gpu,
        capabilities: opts.caps ? opts.caps.split(",").map((s: string) => s.trim()) : undefined,
        description: opts.desc,
      });

      if (opts.default) {
        await setDefaultModel(name);
      }

      console.log(`Model "${name}" registered at ${baseUrl}`);
      if (opts.default) {
        console.log(`Set "${name}" as default model.`);
      }
    });

  modelsCmd
    .command("remove <name>")
    .alias("rm")
    .description("Remove a registered model")
    .action(async (name: string) => {
      const removed = await removeModel(name);
      if (removed) {
        console.log(`Model "${name}" removed.`);
      } else {
        console.error(`Model "${name}" not found.`);
        process.exit(1);
      }
    });

  modelsCmd
    .command("default <name>")
    .description("Set the default model")
    .action(async (name: string) => {
      await setDefaultModel(name);
      console.log(`Default model set to "${name}".`);
    });
}
