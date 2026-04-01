// ModelConfig actions
// Auto-extracted from builtin-actions.ts

import { log } from "../../core/logger.js";
import { listModels, loadModelsConfig } from "../../core/models.js";
import { kcodePath } from "../../core/paths.js";
import { getAvailableThemes, getCurrentThemeName } from "../../core/theme.js";
import type { KCodeConfig } from "../../core/types.js";
import type { ActionContext } from "./action-helpers.js";

export async function handleModelConfigAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { conversationManager, setCompleted, appConfig, args, switchTheme } = ctx;

  switch (action) {
    case "models": {
      const models = await listModels();
      const modelsConfig = await loadModelsConfig();
      if (models.length === 0)
        return "  No models registered. Use 'kcode models add' to register one.";
      const lines = models.map((m) => {
        const def = m.name === modelsConfig.defaultModel ? " (default)" : "";
        const ctx = m.contextSize ? `, ctx: ${m.contextSize.toLocaleString()}` : "";
        const gpu = m.gpu ? `, gpu: ${m.gpu}` : "";
        return `  ${m.name}${def} — ${m.baseUrl}${ctx}${gpu}`;
      });
      return lines.join("\n");
    }
    case "theme": {
      const available = getAvailableThemes();
      const current = getCurrentThemeName();
      const themeName = args?.trim();

      if (!themeName) {
        // List all themes with the current one marked
        const lines = ["  Available themes:"];
        for (const name of available) {
          const marker = name === current ? " (active)" : "";
          lines.push(`  ${name}${marker}`);
        }
        lines.push("");
        lines.push("  Usage: /theme <name>");
        return lines.join("\n");
      }

      if (available.includes(themeName)) {
        if (switchTheme) switchTheme(themeName);
        return `  Theme switched to: ${themeName}`;
      }

      return `  Unknown theme "${themeName}". Available: ${available.join(", ")}`;
    }
    case "config": {
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      const cwd = appConfig.workingDirectory;

      const lines = [
        `  Resolved Configuration`,
        ``,
        `  model:            ${appConfig.model}`,
        `  apiBase:          ${appConfig.apiBase ?? "(default)"}`,
        `  maxTokens:        ${appConfig.maxTokens}`,
        `  permissionMode:   ${appConfig.permissionMode}`,
        `  contextWindow:    ${(appConfig.contextWindowSize ?? 200000).toLocaleString()}`,
        `  autoRoute:        ${appConfig.autoRoute ?? true}`,
        `  compactThreshold: ${(appConfig.compactThreshold ?? 0.8) * 100}%`,
        `  theme:            ${appConfig.theme ?? "(default)"}`,
        `  thinking:         ${appConfig.thinking ? "on" : "off"}`,
        ``,
        `  Settings Sources (highest priority first):`,
      ];

      // Check which files exist
      const sources = [
        {
          name: "Environment vars",
          exists: !!(
            process.env.KCODE_MODEL ||
            process.env.KCODE_API_KEY ||
            process.env.KCODE_API_BASE
          ),
        },
        {
          name: ".kcode/settings.local.json",
          exists: existsSync(join(cwd, ".kcode", "settings.local.json")),
        },
        { name: ".kcode/settings.json", exists: existsSync(join(cwd, ".kcode", "settings.json")) },
        { name: "~/.kcode/settings.json", exists: existsSync(kcodePath("settings.json")) },
      ];

      for (const src of sources) {
        const icon = src.exists ? "\u2713" : "\u2717";
        lines.push(`    ${icon} ${src.name}`);
      }

      // Show env overrides if any
      const envVars = [
        "KCODE_MODEL",
        "KCODE_API_KEY",
        "KCODE_API_BASE",
        "KCODE_EFFORT_LEVEL",
        "KCODE_MAX_TOKENS",
        "KCODE_PERMISSION_MODE",
        "KCODE_THEME",
      ];
      const setVars = envVars.filter((v) => process.env[v]);
      if (setVars.length > 0) {
        lines.push(``, `  Active env vars:`);
        for (const v of setVars) {
          const val = v.includes("KEY") ? "****" : process.env[v];
          lines.push(`    ${v}=${val}`);
        }
      }

      return lines.join("\n");
    }
    case "effort": {
      const level = args?.trim().toLowerCase();
      if (!level || !["low", "medium", "high", "max"].includes(level)) {
        const current = appConfig.effortLevel ?? "medium";
        return [
          `  Effort Level: ${current}\n`,
          "  Usage: /effort <low|medium|high|max>",
          "",
          "  low    — Fast responses, max 4K tokens, temp 0.3",
          "  medium — Balanced (default), standard tokens",
          "  high   — Deep reasoning, max 32K tokens, temp 0.7",
          "  max    — Maximum reasoning, max 64K tokens, temp 0.9",
        ].join("\n");
      }
      appConfig.effortLevel = level as KCodeConfig["effortLevel"];
      return `  Effort level set to: ${level}`;
    }
    case "profile": {
      const { getProfile, listProfiles, applyProfile, getCurrentProfileName } = await import(
        "../../core/profiles.js"
      );
      const arg = (args ?? "").trim().toLowerCase();

      // /profile — list all profiles
      if (!arg || arg === "list") {
        const profiles = listProfiles();
        const current = getCurrentProfileName(appConfig);
        const lines = ["  Execution Profiles\n"];
        const maxName = Math.max(...profiles.map((p) => p.name.length));
        for (const p of profiles) {
          const active = p.name === current ? " \x1b[32m(active)\x1b[0m" : "";
          lines.push(
            `  ${p.icon} \x1b[1m${p.name.padEnd(maxName)}\x1b[0m — ${p.description}${active}`,
          );
          const flags = [
            `perm:${p.settings.permissionMode}`,
            `effort:${p.settings.effortLevel}`,
            p.settings.thinking ? "thinking" : null,
            p.settings.maxTokens ? `maxTokens:${p.settings.maxTokens}` : null,
            p.settings.allowedTools ? `tools:${p.settings.allowedTools.join(",")}` : null,
            p.settings.disallowedTools ? `blocked:${p.settings.disallowedTools.join(",")}` : null,
          ]
            .filter(Boolean)
            .join(", ");
          lines.push(`    ${flags}`);
        }
        lines.push("");
        lines.push("  Usage: /profile <name>  — switch profile");
        lines.push("         /profile off     — deactivate profile, return to defaults");
        return lines.join("\n");
      }

      // /profile off — deactivate
      if (arg === "off" || arg === "none" || arg === "default") {
        // Reset profile-specific settings to defaults
        appConfig.activeProfile = undefined;
        appConfig.permissionMode = "ask";
        appConfig.effortLevel = undefined;
        appConfig.thinking = undefined;
        appConfig.allowedTools = undefined;
        appConfig.disallowedTools = undefined;
        // Remove profile system prompt append (we can't easily undo just the profile part,
        // so clear it entirely — this is the expected behavior for /profile off)
        appConfig.systemPromptAppend = undefined;
        return "  Profile deactivated. Using default settings.";
      }

      // /profile <name> — switch to profile
      const profile = getProfile(arg);
      if (!profile) {
        const available = listProfiles()
          .map((p) => p.name)
          .join(", ");
        return `  Unknown profile "${arg}". Available: ${available}`;
      }

      applyProfile(appConfig, profile);
      return `  ${profile.icon} Profile switched to: \x1b[1m${profile.name}\x1b[0m — ${profile.description}`;
    }
    case "model_health": {
      const { listModels: getModels } = await import("../../core/models.js");
      const models = await getModels();

      if (models.length === 0)
        return "  No models registered. Use 'kcode models add' to register models.";

      const lines = [
        `  Model Health Check (${models.length} model${models.length > 1 ? "s" : ""})\n`,
      ];

      // Ping all models in parallel
      const ping = async (model: {
        name: string;
        baseUrl: string;
      }): Promise<{ name: string; status: string; latencyMs: number }> => {
        const start = Date.now();
        try {
          const resp = await fetch(`${model.baseUrl}/v1/models`, {
            method: "GET",
            headers: appConfig.apiKey ? { Authorization: `Bearer ${appConfig.apiKey}` } : {},
            signal: AbortSignal.timeout(10000),
          });
          const latencyMs = Date.now() - start;
          if (resp.ok) return { name: model.name, status: "ok", latencyMs };
          return { name: model.name, status: `HTTP ${resp.status}`, latencyMs };
        } catch (err) {
          return {
            name: model.name,
            status: err instanceof Error ? err.message : "error",
            latencyMs: Date.now() - start,
          };
        }
      };

      const results = await Promise.all(models.map((m) => ping(m)));

      const maxNameLen = Math.max(...results.map((r) => r.name.length), 8);
      for (const r of results) {
        const icon = r.status === "ok" ? "\u2713" : "\u2717";
        const latency = r.status === "ok" ? `${r.latencyMs}ms` : r.status;
        lines.push(`  ${icon} ${r.name.padEnd(maxNameLen)}  ${latency}`);
      }

      const okCount = results.filter((r) => r.status === "ok").length;
      lines.push(`\n  ${okCount}/${results.length} models responding`);

      if (okCount > 0) {
        const avgLatency = Math.round(
          results.filter((r) => r.status === "ok").reduce((a, b) => a + b.latencyMs, 0) / okCount,
        );
        lines.push(`  Avg latency: ${avgLatency}ms`);
      }

      return lines.join("\n");
    }
    case "style": {
      const { getCurrentStyle, setCurrentStyle, listStyles } = await import(
        "../../core/output-styles.js"
      );
      const styleName = args?.trim();

      if (!styleName) {
        // Show current style and list available styles
        const current = getCurrentStyle();
        const available = listStyles();
        const lines = [`  Current style: ${current}`, "", "  Available styles:"];
        for (const name of available) {
          const marker = name === current ? " (active)" : "";
          lines.push(`    ${name}${marker}`);
        }
        lines.push("", "  Usage: /style <name>");
        return lines.join("\n");
      }

      if (setCurrentStyle(styleName)) {
        return `  Output style switched to: ${styleName}`;
      }

      const available = listStyles();
      return `  Unknown style "${styleName}". Available: ${available.join(", ")}`;
    }
    case "cache": {
      const { getCacheStats, clearCache } = await import("../../core/response-cache");
      const cmd = args?.trim().toLowerCase();

      if (cmd === "clear") {
        const cleared = clearCache();
        return `  Cleared ${cleared} cached responses.`;
      }

      const stats = getCacheStats();
      return [
        `  Response Cache\n`,
        `  Entries:     ${stats.entries} / 500`,
        `  Total hits:  ${stats.totalHits}`,
        `  Oldest:      ${stats.oldestDays} days`,
        `  TTL:         7 days`,
        ``,
        `  /cache clear — clear all cached responses`,
      ].join("\n");
    }
    case "consensus": {
      if (!args?.trim())
        return "  Usage: /consensus <prompt>\n  Sends to all registered models and synthesizes responses.";

      const prompt = args.trim();
      const { listModels: getModels } = await import("../../core/models.js");
      const models = await getModels();

      if (models.length < 2)
        return "  Need at least 2 registered models for consensus. Use 'kcode models add' to register models.";

      // Use up to 4 models
      const selectedModels = models.slice(0, 4);
      const lines: string[] = [
        `  Consensus query across ${selectedModels.length} models\n  Prompt: "${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}"\n`,
      ];

      // Query all models in parallel
      const fetchModel = async (model: {
        name: string;
        baseUrl: string;
      }): Promise<{ name: string; text: string; timeMs: number }> => {
        const start = Date.now();
        try {
          const resp = await fetch(`${model.baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(appConfig.apiKey ? { Authorization: `Bearer ${appConfig.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: model.name,
              messages: [{ role: "user", content: prompt }],
              max_tokens: 512,
              stream: false,
            }),
            signal: AbortSignal.timeout(30000),
          });
          const data = (await resp.json()) as Record<string, unknown>;
          const choices = data.choices as Record<string, unknown>[] | undefined;
          return {
            name: model.name,
            text:
              ((choices?.[0]?.message as Record<string, unknown> | undefined)?.content as string) ??
              "(no response)",
            timeMs: Date.now() - start,
          };
        } catch (err) {
          return {
            name: model.name,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            timeMs: Date.now() - start,
          };
        }
      };

      const results = await Promise.all(selectedModels.map((m) => fetchModel(m)));

      // Show individual responses
      for (const r of results) {
        lines.push(`  \u2500\u2500 ${r.name} (${r.timeMs}ms) \u2500\u2500`);
        const preview = r.text.split("\n").slice(0, 8).join("\n");
        for (const line of preview.split("\n")) {
          lines.push(`  ${line}`);
        }
        if (r.text.split("\n").length > 8) lines.push(`  ... (truncated)`);
        lines.push(``);
      }

      // Simple agreement check
      const validResults = results.filter((r) => !r.text.startsWith("Error:"));
      if (validResults.length >= 2) {
        // Check if responses are similar (basic: compare first 100 chars lowercase)
        const normalized = validResults.map((r) => r.text.toLowerCase().slice(0, 100));
        const allSimilar = normalized.every((n) => {
          const words1 = new Set(n.split(/\s+/));
          const words2 = new Set(normalized[0]!.split(/\s+/));
          const overlap = [...words1].filter((w) => words2.has(w)).length;
          return overlap / Math.max(words1.size, words2.size) > 0.3;
        });

        lines.push(`  \u2500\u2500 Consensus \u2500\u2500`);
        if (allSimilar) {
          lines.push(`  \u2713 Models broadly agree.`);
        } else {
          lines.push(`  \u26A0 Models gave divergent responses \u2014 review individually.`);
        }

        // Show fastest
        const fastest = validResults.reduce((a, b) => (a.timeMs < b.timeMs ? a : b));
        lines.push(`  Fastest: ${fastest.name} (${fastest.timeMs}ms)`);
      }

      return lines.join("\n");
    }
    case "mcp": {
      const { getMcpManager } = await import("../../core/mcp");
      const manager = getMcpManager();
      const parts = (args ?? "").trim().split(/\s+/);
      const subCmd = parts[0] ?? "list";

      if (subCmd === "list" || subCmd === "") {
        const status = manager.getServerStatus();
        if (status.length === 0) {
          return "  No MCP servers connected.\n  Use /mcp add <name> <command> to add one.";
        }
        const lines = status.map((s) => {
          const icon = s.alive ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
          const state = s.alive ? "connected" : "disconnected";
          return `  ${icon} ${s.name} — ${state} (${s.toolCount} tools)`;
        });
        return `  MCP Servers:\n${lines.join("\n")}`;
      }

      if (subCmd === "tools") {
        const tools = manager.discoverTools();
        if (tools.length === 0) return "  No MCP tools discovered.";
        const lines = tools.map((t) => `  ${t.name}\n    ${(t.description ?? "").slice(0, 100)}`);
        return `  MCP Tools (${tools.length}):\n${lines.join("\n")}`;
      }

      if (subCmd === "add") {
        const name = parts[1];
        const command = parts[2];
        if (!name || !command) return "  Usage: /mcp add <name> <command> [args...]";
        const serverArgs = parts.slice(3);
        try {
          await manager.addServer(name, {
            command,
            args: serverArgs.length > 0 ? serverArgs : undefined,
          });
          // Count newly registered MCP tools
          const toolCount = manager
            .discoverTools()
            .filter((t) => t.name.startsWith(`mcp__${name}__`)).length;
          return `  Added MCP server "${name}" (${command}${serverArgs.length > 0 ? " " + serverArgs.join(" ") : ""}), registered ${toolCount} tool(s)`;
        } catch (err) {
          return `  Error adding MCP server: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (subCmd === "remove" || subCmd === "rm") {
        const name = parts[1];
        if (!name) return "  Usage: /mcp remove <name>";
        const removed = manager.removeServer(name);
        return removed ? `  Removed MCP server "${name}"` : `  MCP server "${name}" not found`;
      }

      if (subCmd === "auth") {
        const serverName = parts[1];
        if (!serverName)
          return "  Usage: /mcp auth <server-name>\n  Starts OAuth 2.0 flow for the specified MCP server.";

        const status = manager.getServerStatus();
        const serverInfo = status.find((s) => s.name === serverName);
        if (!serverInfo)
          return `  MCP server "${serverName}" not found. Run /mcp list to see available servers.`;

        try {
          const { McpOAuthClient, discoverOAuthConfig } = await import("../../core/mcp-oauth");

          // Try to get OAuth config from server settings
          const settingsPath = kcodePath("settings.json");
          let oauthConfig = null;
          try {
            const file = Bun.file(settingsPath);
            if (await file.exists()) {
              const settings = await file.json();
              const serverConfig = settings?.mcpServers?.[serverName];
              if (serverConfig?.oauth) {
                oauthConfig = serverConfig.oauth;
              } else if (serverConfig?.url) {
                // Try auto-discovery
                oauthConfig = await discoverOAuthConfig(serverConfig.url);
              }
            }
          } catch {
            /* OAuth discovery optional — server may not support it */
          }

          if (!oauthConfig || !oauthConfig.clientId) {
            return `  No OAuth config for "${serverName}".\n  Add oauth settings to ~/.kcode/settings.json:\n  {\n    "mcpServers": {\n      "${serverName}": {\n        "url": "https://...",\n        "oauth": {\n          "clientId": "YOUR_CLIENT_ID",\n          "authorizationUrl": "https://provider/authorize",\n          "tokenUrl": "https://provider/token"\n        }\n      }\n    }\n  }`;
          }

          const client = new McpOAuthClient(serverName, oauthConfig);
          const { url, port, waitForCallback } = await client.startAuthFlow();

          // Try to open browser
          try {
            const { execFileSync: execSync } = await import("node:child_process");
            const openCmd =
              process.platform === "darwin"
                ? "open"
                : process.platform === "win32"
                  ? "start"
                  : "xdg-open";
            execSync(openCmd, [url], { stdio: "pipe", timeout: 5000 });
          } catch {
            // Browser open failed, user can copy the URL
          }

          // Non-blocking — the callback will store tokens
          waitForCallback()
            .then(() => {
              log.info("mcp", `OAuth authentication successful for "${serverName}"`);
            })
            .catch((err) => {
              log.warn(
                "mcp",
                `OAuth authentication failed for "${serverName}": ${err instanceof Error ? err.message : String(err)}`,
              );
            });

          return `  OAuth flow started for "${serverName}".\n  Open this URL in your browser:\n  ${url}\n\n  Callback listening on port ${port}...`;
        } catch (err) {
          return `  OAuth error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (subCmd === "health") {
        return manager.healthMonitor.formatHealthReport();
      }

      if (subCmd === "reset") {
        const name = parts[1];
        if (!name) return "  Usage: /mcp reset <server-name>";
        manager.healthMonitor.resetCircuit(name);
        return `  Circuit breaker reset for "${name}"`;
      }

      if (subCmd === "alias" || subCmd === "aliases") {
        const { addAlias, removeAlias, listAliases } = await import("../../core/mcp-aliases");
        const action = parts[1];

        if (!action || action === "list") {
          const aliases = listAliases();
          if (aliases.length === 0)
            return "  No tool aliases defined.\n  Use /mcp alias add <alias> <target> to create one.";
          const lines = aliases.map(
            (a) => `  ${a.alias} -> ${a.target}${a.description ? ` (${a.description})` : ""}`,
          );
          return `  Tool Aliases:\n${lines.join("\n")}`;
        }

        if (action === "add") {
          const alias = parts[2];
          const target = parts[3];
          if (!alias || !target) return "  Usage: /mcp alias add <alias> <target> [description...]";
          const desc = parts.slice(4).join(" ") || undefined;
          addAlias(alias, target, desc);
          return `  Added alias "${alias}" -> "${target}"`;
        }

        if (action === "remove" || action === "rm") {
          const alias = parts[2];
          if (!alias) return "  Usage: /mcp alias remove <alias>";
          const removed = removeAlias(alias);
          return removed ? `  Removed alias "${alias}"` : `  Alias "${alias}" not found`;
        }

        return "  Usage: /mcp alias [list | add <alias> <target> | remove <alias>]";
      }

      return `  Unknown subcommand: ${subCmd}\n  Usage: /mcp [list | tools | health | reset <server> | alias | add <name> <command> | remove <name> | auth <name>]`;
    }
    case "telemetry": {
      const { isTelemetryEnabled, setTelemetryEnabled } = await import("../../core/analytics.js");

      const current = isTelemetryEnabled();
      const arg = args?.trim().toLowerCase();

      if (arg === "on" || arg === "enable" || arg === "true" || arg === "yes") {
        setTelemetryEnabled(true);
        const settingsPath = kcodePath("settings.json");
        try {
          const file = Bun.file(settingsPath);
          const existing = (await file.exists()) ? await file.json() : {};
          existing.telemetry = true;
          await Bun.write(settingsPath, JSON.stringify(existing, null, 2) + "\n");
        } catch {
          /* ignore write errors */
        }
        return "  Telemetry enabled. Anonymous tool usage analytics will be recorded locally.";
      }

      if (arg === "off" || arg === "disable" || arg === "false" || arg === "no") {
        setTelemetryEnabled(false);
        const settingsPath = kcodePath("settings.json");
        try {
          const file = Bun.file(settingsPath);
          const existing = (await file.exists()) ? await file.json() : {};
          existing.telemetry = false;
          await Bun.write(settingsPath, JSON.stringify(existing, null, 2) + "\n");
        } catch {
          /* ignore write errors */
        }
        return "  Telemetry disabled. No analytics will be recorded.";
      }

      const status =
        current === true
          ? "enabled"
          : current === false
            ? "disabled"
            : "not set (disabled by default)";
      return [
        `  Telemetry Status: ${status}`,
        ``,
        `  KCode collects anonymous tool usage analytics stored locally`,
        `  in ~/.kcode/awareness.db. Data is never sent externally.`,
        ``,
        `  Usage: /telemetry on   \u2014 enable local analytics`,
        `         /telemetry off  \u2014 disable local analytics`,
      ].join("\n");
    }
    case "agents": {
      const { listAllAgents, findCustomAgent } = await import("../../core/custom-agents");
      const name = (args ?? "").trim();

      if (name) {
        const agent = findCustomAgent(name, process.cwd());
        if (!agent) return `  Agent "${name}" not found.`;
        const lines = [
          `  \x1b[1m${agent.name}\x1b[0m — ${agent.description}`,
          `  Source: ${agent.sourcePath}`,
        ];
        if (agent.model) lines.push(`  Model: ${agent.model}`);
        if (agent.effort) lines.push(`  Effort: ${agent.effort}`);
        if (agent.permissionMode) lines.push(`  Permission: ${agent.permissionMode}`);
        if (agent.maxTurns) lines.push(`  Max turns: ${agent.maxTurns}`);
        if (agent.tools) lines.push(`  Tools: ${agent.tools.join(", ")}`);
        if (agent.disallowedTools) lines.push(`  Disallowed: ${agent.disallowedTools.join(", ")}`);
        if (agent.skills) lines.push(`  Skills: ${agent.skills.join(", ")}`);
        if (agent.mcpServers)
          lines.push(`  MCP servers: ${Object.keys(agent.mcpServers).join(", ")}`);
        if (agent.hooks) lines.push(`  Hooks: ${agent.hooks.length} configured`);
        if (agent.memory) lines.push(`  Memory: enabled`);
        if (agent.apiBase) lines.push(`  API base: ${agent.apiBase}`);
        if (agent.apiKey) lines.push(`  API key: ****${agent.apiKey.slice(-4)}`);
        if (agent.systemPrompt)
          lines.push(
            `  System prompt: ${agent.systemPrompt.slice(0, 80)}${agent.systemPrompt.length > 80 ? "..." : ""}`,
          );
        return lines.join("\n");
      }

      const all = listAllAgents(process.cwd());
      if (all.length === 0) {
        return "  No custom agents defined.\n  Create .md files in ~/.kcode/agents/ or .kcode/agents/ with YAML frontmatter.";
      }
      const lines = all.map((a) => {
        const flags: string[] = [];
        if (a.model) flags.push(a.model);
        if (a.effort) flags.push(a.effort);
        if (a.memory) flags.push("memory");
        if (a.mcpServers) flags.push(`${Object.keys(a.mcpServers).length} mcp`);
        const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
        return `  \x1b[36m${a.name}\x1b[0m — ${a.description}${flagStr}`;
      });
      return `  ${all.length} agent(s) available:\n${lines.join("\n")}`;
    }
    default:
      return null;
  }
}
