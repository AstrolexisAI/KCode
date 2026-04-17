import type { Command } from "commander";

export function registerPluginCommand(program: Command): void {
  const pluginCmd = program.command("plugin").description("Manage KCode plugins");

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

  pluginCmd
    .command("list")
    .description("List installed plugins")
    .action(async () => {
      const { fetchRegistry } = await import("../../core/plugin-registry");
      const entries = await fetchRegistry();
      if (entries.length === 0) {
        console.log("No plugins installed.");
        return;
      }
      console.log(`\nInstalled plugins:\n`);
      for (const p of entries) {
        console.log(`  ${p.name} v${p.version} \u2014 ${p.description}`);
      }
    });

  // --- Plugin SDK subcommands ---

  pluginCmd
    .command("create <name>")
    .description("Scaffold a new plugin project")
    .option("--skills", "Include skills component")
    .option("--hooks", "Include hooks component")
    .option("--mcp", "Include MCP server component")
    .option("--output-styles", "Include output styles component")
    .option("--agents", "Include agents component")
    .option("--author <author>", "Plugin author", "anonymous")
    .option("--license <license>", "Plugin license", "MIT")
    .option("--language <lang>", "Plugin language (markdown|typescript)", "markdown")
    .action(async (name: string, opts: Record<string, unknown>) => {
      const { createPlugin } = await import("./plugin-sdk/create");
      const components: string[] = [];
      if (opts.skills) components.push("skills");
      if (opts.hooks) components.push("hooks");
      if (opts.mcp) components.push("mcp");
      if (opts.outputStyles) components.push("output-styles");
      if (opts.agents) components.push("agents");
      if (components.length === 0) components.push("skills"); // default

      const dir = await createPlugin({
        name,
        description: `KCode plugin: ${name}`,
        author: opts.author as string,
        license: opts.license as string,
        components: components as any,
        language: (opts.language as "markdown" | "typescript") || "markdown",
      });
      console.log(`\u2713 Plugin scaffolded at ${dir}`);
    });

  pluginCmd
    .command("validate [dir]")
    .description("Validate a plugin's manifest and structure")
    .action(async (dir?: string) => {
      const { validatePlugin } = await import("./plugin-sdk/validate");
      const report = await validatePlugin(dir || process.cwd());
      if (report.errors.length > 0) {
        console.log("\u2717 Errors:");
        for (const e of report.errors) console.log(`  - ${e.message}`);
      }
      if (report.warnings.length > 0) {
        console.log("\u26a0 Warnings:");
        for (const w of report.warnings) console.log(`  - ${w.message}`);
      }
      if (report.info.length > 0) {
        for (const i of report.info) console.log(`  ${i.message}`);
      }
      console.log(report.valid ? "\n\u2713 Plugin is valid." : "\n\u2717 Plugin has errors.");
    });

  pluginCmd
    .command("test [dir]")
    .description("Run automated tests on a plugin")
    .action(async (dir?: string) => {
      const { testPlugin } = await import("./plugin-sdk/test-runner");
      const results = await testPlugin(dir || process.cwd());
      for (const r of results) {
        const icon = r.status === "pass" ? "\u2713" : r.status === "fail" ? "\u2717" : "\u2015";
        console.log(`  ${icon} ${r.name} (${r.duration}ms)${r.error ? ` — ${r.error}` : ""}`);
      }
      const failed = results.filter((r) => r.status === "fail");
      console.log(
        failed.length === 0
          ? `\n\u2713 All ${results.length} tests passed.`
          : `\n\u2717 ${failed.length}/${results.length} tests failed.`,
      );
    });

  pluginCmd
    .command("publish [dir]")
    .description("Publish a plugin to the marketplace")
    .option("--registry <url>", "Marketplace registry URL")
    .action(async (dir: string | undefined, opts: { registry?: string }) => {
      const { publishPlugin } = await import("./plugin-sdk/publish");
      const result = await publishPlugin(dir || process.cwd(), opts.registry);
      console.log(
        `\u2713 Published ${result.name}@${result.version} (sha256: ${result.sha256.slice(0, 12)}...)`,
      );
    });

  pluginCmd
    .command("docs [dir]")
    .description("Generate documentation for a plugin")
    .option("--output <path>", "Output directory for generated docs")
    .action(async (dir: string | undefined, opts: { output?: string }) => {
      const { generateDocs } = await import("./plugin-sdk/docs-gen");
      const sections = await generateDocs(dir || process.cwd());
      const content = sections.map((s) => `## ${s.title}\n\n${s.content}`).join("\n\n---\n\n");
      if (opts.output) {
        const outPath = require("node:path").join(opts.output, "PLUGIN.md");
        require("node:fs").mkdirSync(opts.output, { recursive: true });
        require("node:fs").writeFileSync(outPath, content);
        console.log(`\u2713 Docs written to ${outPath}`);
      } else {
        console.log(content);
      }
    });
}
