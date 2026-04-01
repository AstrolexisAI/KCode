import type { Command } from "commander";
import { kcodePath } from "../../core/paths";

export function registerMcpCommand(program: Command): void {
  const mcpCmd = program.command("mcp").description("Manage MCP (Model Context Protocol) servers");

  mcpCmd
    .command("list")
    .alias("ls")
    .description("List configured MCP servers and their status")
    .action(async () => {
      const cwd = process.cwd();
      const { join } = await import("node:path");

      // Read configs directly (don't start servers for a listing)
      const paths = [
        { path: kcodePath("settings.json"), scope: "user" },
        { path: join(cwd, ".kcode", "settings.json"), scope: "project" },
      ];

      let found = false;
      for (const { path, scope } of paths) {
        try {
          const file = Bun.file(path);
          if (!(await file.exists())) continue;
          const data = await file.json();
          if (!data?.mcpServers || typeof data.mcpServers !== "object") continue;
          const entries = Object.entries(data.mcpServers);
          if (entries.length === 0) continue;

          found = true;
          console.log(`\n  ${scope === "user" ? "User" : "Project"} servers (${path}):`);
          for (const [name, config] of entries) {
            const cfg = config as { command?: string; args?: string[] };
            const cmd = cfg.command ?? "(unknown)";
            const args = cfg.args ? ` ${cfg.args.join(" ")}` : "";
            console.log(`    ${name} — ${cmd}${args}`);
          }
        } catch {
          /* skip */
        }
      }

      if (!found) {
        console.log("\n  No MCP servers configured.");
        console.log("  Add one with: kcode mcp add <name> <command> [args...]\n");
      }
    });

  mcpCmd
    .command("add <name> <command> [args...]")
    .description("Add an MCP server to project settings")
    .option("--user", "Add to user-level settings instead of project")
    .action(async (name: string, command: string, args: string[], opts: { user?: boolean }) => {
      // Validate server name
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
        console.error(
          "\u2717 Invalid server name. Use only letters, digits, hyphens, and underscores (max 64 chars).",
        );
        return;
      }

      const { join } = await import("node:path");

      const settingsPath = opts.user
        ? kcodePath("settings.json")
        : join(process.cwd(), ".kcode", "settings.json");

      let data: Record<string, any> = {};
      try {
        const file = Bun.file(settingsPath);
        if (await file.exists()) data = await file.json();
      } catch {
        /* start fresh */
      }

      if (!data.mcpServers) data.mcpServers = {};

      if (data.mcpServers[name]) {
        console.log(
          `\u2717 MCP server "${name}" already exists. Remove it first with: kcode mcp remove ${name}`,
        );
        return;
      }

      const entry: Record<string, unknown> = { command };
      if (args.length > 0) entry.args = args;

      data.mcpServers[name] = entry;

      // Ensure directory exists
      const { mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(settingsPath), { recursive: true });
      await Bun.write(settingsPath, JSON.stringify(data, null, 2) + "\n");

      console.log(
        `\u2713 Added MCP server "${name}" (${command}${args.length > 0 ? " " + args.join(" ") : ""})`,
      );
      console.log(`  Config: ${settingsPath}`);
    });

  mcpCmd
    .command("remove <name>")
    .alias("rm")
    .description("Remove an MCP server from settings")
    .option("--user", "Remove from user-level settings")
    .action(async (name: string, opts: { user?: boolean }) => {
      const { join } = await import("node:path");

      const settingsPath = opts.user
        ? kcodePath("settings.json")
        : join(process.cwd(), ".kcode", "settings.json");

      try {
        const file = Bun.file(settingsPath);
        if (!(await file.exists())) {
          console.log(`\u2717 No settings file at ${settingsPath}`);
          return;
        }
        const data = await file.json();
        if (!data?.mcpServers?.[name]) {
          console.log(`\u2717 MCP server "${name}" not found in ${settingsPath}`);
          return;
        }

        delete data.mcpServers[name];
        if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;

        await Bun.write(settingsPath, JSON.stringify(data, null, 2) + "\n");
        console.log(`\u2713 Removed MCP server "${name}" from ${settingsPath}`);
      } catch (err) {
        console.error(`\u2717 Error: ${err instanceof Error ? err.message : err}`);
      }
    });

  mcpCmd
    .command("tools [server]")
    .description("List tools from running MCP servers")
    .action(async (server?: string) => {
      const { getMcpManager } = await import("../../core/mcp");
      const manager = getMcpManager();
      try {
        await manager.loadAndStart(process.cwd());
        const tools = await manager.discoverTools();

        const filtered = server
          ? tools.filter((t) => t.name.startsWith(`mcp__${server}__`))
          : tools;

        if (filtered.length === 0) {
          console.log(
            server ? `  No tools from server "${server}".` : "  No MCP tools discovered.",
          );
          return;
        }

        console.log(`\n  MCP Tools (${filtered.length}):\n`);
        for (const tool of filtered) {
          console.log(`    ${tool.name}`);
          if (tool.description) console.log(`      ${tool.description.slice(0, 100)}`);
        }
      } catch (err) {
        console.error(`\u2717 Error: ${err instanceof Error ? err.message : err}`);
      } finally {
        const { shutdownMcpManager } = await import("../../core/mcp");
        shutdownMcpManager();
      }
    });
}
