import type { Command } from "commander";

export function registerPluginCommand(program: Command): void {
  const pluginCmd = program
    .command("plugin")
    .description("Manage KCode plugins");

  pluginCmd
    .command("search [query]")
    .description("Search the plugin registry")
    .action(async (query?: string) => {
      const { fetchRegistry, searchRegistry } = await import("../../core/plugin-registry");
      const entries = await fetchRegistry();
      const results = query ? searchRegistry(entries, query) : entries;

      if (results.length === 0) {
        console.log("No plugins found.");
        return;
      }

      console.log(`\nAvailable plugins${query ? ` matching "${query}"` : ""}:\n`);
      for (const p of results) {
        console.log(`  ${p.name} v${p.version} \u2014 ${p.description}`);
        console.log(`    by ${p.author} [${p.tags.join(", ")}]`);
      }
    });

  pluginCmd
    .command("install <name>")
    .alias("add")
    .description("Install a plugin from the registry")
    .action(async (name: string) => {
      const { installPlugin } = await import("../../core/plugin-registry");
      const result = await installPlugin(name);
      console.log(result.success ? `\u2713 ${result.message}` : `\u2717 ${result.message}`);
    });

  pluginCmd
    .command("uninstall <name>")
    .alias("rm")
    .description("Uninstall a plugin")
    .action(async (name: string) => {
      const { uninstallPlugin } = await import("../../core/plugin-registry");
      const result = await uninstallPlugin(name);
      console.log(result.success ? `\u2713 ${result.message}` : `\u2717 ${result.message}`);
    });
}
