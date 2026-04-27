import type { Command } from "commander";
import { buildConfig } from "../../core/config";
import { TemplateEngine } from "../../core/templates/engine";
import { TemplateRegistry } from "../../core/templates/registry";
import { Scaffolder } from "../../core/templates/scaffolder";

export function registerTemplateCommand(program: Command): void {
  const tmpl = program
    .command("template")
    .description("Smart project templates — scaffold complete projects using AI");

  // ─── list ────────────────────────────────────────────────────

  tmpl
    .command("list")
    .description("List all available templates")
    .action(async () => {
      const registry = new TemplateRegistry();
      await registry.loadAll(process.cwd());
      const templates = registry.list();

      if (templates.length === 0) {
        console.log("No templates found.");
        return;
      }

      console.log("\n  Available Templates\n");
      for (const t of templates) {
        const tags = t.tags.length > 0 ? ` [${t.tags.join(", ")}]` : "";
        const src = t.source !== "builtin" ? ` (${t.source})` : "";
        console.log(`  ${t.name.padEnd(20)} ${t.description}${tags}${src}`);
        console.log(`  ${"".padEnd(20)} ${t.parameterCount} parameter(s)`);
      }
      console.log();
    });

  // ─── show ────────────────────────────────────────────────────

  tmpl
    .command("show <name>")
    .description("Show template details and parameters")
    .action(async (name: string) => {
      const registry = new TemplateRegistry();
      await registry.loadAll(process.cwd());
      const t = registry.get(name);

      if (!t) {
        console.error(
          `Template "${name}" not found. Use "kcode template list" to see available templates.`,
        );
        process.exit(1);
      }

      console.log(`\n  Template: ${t.name}`);
      console.log(`  Description: ${t.description}`);
      console.log(`  Source: ${t.source}`);
      console.log(`  Tags: ${t.tags.join(", ") || "none"}`);
      console.log(`\n  Parameters:\n`);

      for (const p of t.parameters) {
        const req = p.required ? "(required)" : `(default: ${p.default ?? "none"})`;
        const choices = p.choices ? ` [${p.choices.join("|")}]` : "";
        console.log(`    --${p.name.padEnd(18)} ${p.description} ${req}${choices}`);
      }
      console.log();
    });

  // ─── create ──────────────────────────────────────────────────

  tmpl
    .command("create <name>")
    .description("Scaffold a project from a template")
    .option("-o, --output <dir>", "Output directory", ".")
    .option("--dry-run", "Preview the expanded prompt without calling the AI")
    .allowUnknownOption(true)
    .action(async (name: string, opts: { output: string; dryRun?: boolean }, cmd: Command) => {
      const registry = new TemplateRegistry();
      await registry.loadAll(process.cwd());
      const t = registry.get(name);

      if (!t) {
        console.error(
          `Template "${name}" not found. Use "kcode template list" to see available templates.`,
        );
        process.exit(1);
      }

      // Parse extra --param value options
      const params: Record<string, unknown> = {};
      const rawArgs = cmd.parent?.args ?? [];
      for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i]!;
        if (arg.startsWith("--") && arg !== "--dry-run" && arg !== "--output") {
          const key = arg.replace(/^--/, "");
          const value = rawArgs[i + 1];
          if (value && !value.startsWith("--")) {
            params[key] = value === "true" ? true : value === "false" ? false : value;
            i++;
          } else {
            params[key] = true;
          }
        }
      }

      // Interactive prompt for missing required params
      const engine = new TemplateEngine();
      const missing = t.parameters.filter((p) => p.required && params[p.name] === undefined);
      if (missing.length > 0) {
        console.log(`\n  Template: ${t.name}\n`);
        const interactive = await engine.interactivePrompt({
          ...t,
          parameters: missing,
        });
        Object.assign(params, interactive);
      }

      // Dry run
      if (opts.dryRun) {
        const scaffolder = new Scaffolder();
        console.log("\n--- Expanded Prompt ---\n");
        console.log(scaffolder.dryRun(t, params));
        console.log("\n--- End ---\n");
        return;
      }

      // Scaffold
      const config = await buildConfig(process.cwd());
      const scaffolder = new Scaffolder();
      const outputDir = require("node:path").resolve(opts.output);

      console.log(`\n  Scaffolding "${t.name}" to ${outputDir}...\n`);

      const result = await scaffolder.scaffold(t, params, outputDir, {
        apiBase: config.apiBase ?? "",
        model: config.model,
        apiKey: config.apiKey,
      });

      console.log(`  Created ${result.filesCreated} files:`);
      for (const f of result.files) {
        console.log(`    ${f.path} (${f.size} bytes)`);
      }

      if (result.postSetupResults.length > 0) {
        console.log("\n  Post-setup:");
        for (const r of result.postSetupResults) {
          console.log(`    ${r.command}: ${r.success ? "OK" : "FAILED"}`);
        }
      }
      console.log();
    });

  // ─── add ─────────────────────────────────────────────────────

  tmpl
    .command("add <file>")
    .description("Add a custom template from a markdown file")
    .action(async (file: string) => {
      const registry = new TemplateRegistry();
      await registry.loadAll(process.cwd());
      await registry.add(file);
      console.log(`Template added from ${file}.`);
    });

  // ─── remove ──────────────────────────────────────────────────

  tmpl
    .command("remove <name>")
    .description("Remove a user template")
    .action(async (name: string) => {
      const registry = new TemplateRegistry();
      await registry.loadAll(process.cwd());
      const removed = await registry.remove(name);
      if (removed) {
        console.log(`Template "${name}" removed.`);
      } else {
        console.error(`Template "${name}" not found.`);
        process.exit(1);
      }
    });
}
