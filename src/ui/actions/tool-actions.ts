// Tool actions
// Auto-extracted from builtin-actions.ts

import type { ActionContext } from "./action-helpers.js";
import { kcodePath } from "../../core/paths.js";

export async function handleToolAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { conversationManager, setCompleted, appConfig, args, switchTheme } = ctx;

  switch (action) {
    case "plan": {
      const { getActivePlan, formatPlan, executePlan: execPlan } = await import("../../tools/plan.js");

      if (args?.trim() === "clear") {
        await execPlan({ mode: "clear" });
        return "  Plan cleared.";
      }

      const plan = getActivePlan();
      if (!plan) return "  No active plan. The AI will create one when tackling multi-step tasks.";
      return "  " + formatPlan(plan).split("\n").join("\n  ");
    }
    case "pin": {
      const { resolve } = await import("node:path");
      const { pinFile, listPinnedFiles } = await import("../../core/context-pin.js");

      if (!args?.trim()) {
        const pinned = listPinnedFiles();
        if (pinned.length === 0) return "  No pinned files. Usage: /pin <file-path>";
        const lines = ["  Pinned files:"];
        for (const p of pinned) {
          lines.push(`    ${p.path} (${p.size} chars)`);
        }
        return lines.join("\n");
      }

      const filePath = resolve(appConfig.workingDirectory, args.trim());
      const result = pinFile(filePath, appConfig.workingDirectory);
      return `  ${result.message}`;
    }
    case "unpin": {
      const { resolve } = await import("node:path");
      const { unpinFile, clearPinnedFiles } = await import("../../core/context-pin.js");

      if (args?.trim() === "all") {
        clearPinnedFiles();
        return "  All files unpinned.";
      }

      if (!args?.trim()) return "  Usage: /unpin <file-path> or /unpin all";

      const filePath = resolve(appConfig.workingDirectory, args.trim());
      const result = unpinFile(filePath, appConfig.workingDirectory);
      return `  ${result.message}`;
    }
    case "index": {
      const { getCodebaseIndex } = await import("../../core/codebase-index.js");
      const idx = getCodebaseIndex(appConfig.workingDirectory);

      if (!args?.trim()) {
        const count = idx.build();
        const stats = idx.getStats();
        const extLines = Object.entries(stats.extensions)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([ext, n]) => `${ext}: ${n}`)
          .join(", ");
        return `  Indexed ${count} files (${stats.exportCount} exports). Types: ${extLines}`;
      }

      const results = idx.search(args.trim());
      if (results.length === 0) return `  No results for "${args.trim()}"`;

      const lines = [`  Results for "${args.trim()}" (${results.length}):`];
      for (const r of results.slice(0, 10)) {
        const exports = r.exports.length > 0 ? ` [${r.exports.slice(0, 3).join(", ")}]` : "";
        lines.push(`    ${r.relativePath}${exports}`);
      }
      return lines.join("\n");
    }
    case "memory": {
      const cwd = appConfig.workingDirectory;
      const arg = args?.trim() ?? "";

      // ── Enhanced memory store subcommands ──
      if (arg.startsWith("add ")) {
        const rest = arg.slice(4).trim();
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx === -1) return "  Usage: /memory add <category> <content>\n  Categories: preference, convention, fact, decision, learned";
        const category = rest.slice(0, spaceIdx);
        const validCategories = ["preference", "convention", "fact", "decision", "learned"];
        if (!validCategories.includes(category)) {
          return `  Invalid category: ${category}\n  Valid: ${validCategories.join(", ")}`;
        }
        const content = rest.slice(spaceIdx + 1).trim();
        if (!content) return "  Content cannot be empty.";

        const { addMemory, initMemoryStoreSchema } = await import("../../core/memory-store.js");
        const { getDb } = await import("../../core/db.js");
        const db = getDb();
        initMemoryStoreSchema(db);
        const key = content.slice(0, 40).replace(/\s+/g, "-").toLowerCase();
        const id = addMemory({
          category: category as "preference" | "convention" | "fact" | "decision" | "learned",
          key,
          content,
          project: cwd,
          confidence: 1.0,
          source: "user",
          approved: true,
        });
        return `  Memory #${id} added [${category}]: ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`;
      }

      if (arg.startsWith("edit ")) {
        const rest = arg.slice(5).trim();
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx === -1) return "  Usage: /memory edit <id> <new-content>";
        const id = parseInt(rest.slice(0, spaceIdx));
        if (isNaN(id)) return "  Invalid ID. Usage: /memory edit <id> <new-content>";
        const content = rest.slice(spaceIdx + 1).trim();
        if (!content) return "  Content cannot be empty.";

        const { updateMemory, initMemoryStoreSchema } = await import("../../core/memory-store.js");
        const { getDb } = await import("../../core/db.js");
        const db = getDb();
        initMemoryStoreSchema(db);
        const updated = updateMemory(id, { content });
        return updated ? `  Memory #${id} updated.` : `  Memory #${id} not found.`;
      }

      if (arg.startsWith("delete ")) {
        const idStr = arg.slice(7).trim();

        // Check if it's a numeric ID (enhanced store) or a filename (legacy)
        const id = parseInt(idStr);
        if (!isNaN(id) && String(id) === idStr) {
          const { deleteMemory, initMemoryStoreSchema } = await import("../../core/memory-store.js");
          const { getDb } = await import("../../core/db.js");
          const db = getDb();
          initMemoryStoreSchema(db);
          const deleted = deleteMemory(id);
          return deleted ? `  Memory #${id} deleted.` : `  Memory #${id} not found.`;
        }

        // Fall through to legacy file-based delete
        const { getMemoryDir, deleteMemoryFile } = await import("../../core/memory.js");
        const { join } = await import("node:path");
        const dir = getMemoryDir(cwd);
        const deleted = await deleteMemoryFile(join(dir, idStr));
        return deleted ? `  Deleted: ${idStr}` : `  File "${idStr}" not found.`;
      }

      if (arg.startsWith("approve ")) {
        const id = parseInt(arg.slice(8).trim());
        if (isNaN(id)) return "  Usage: /memory approve <id>";

        const { promoteMemory, initMemoryStoreSchema } = await import("../../core/memory-store.js");
        const { getDb } = await import("../../core/db.js");
        const db = getDb();
        initMemoryStoreSchema(db);
        const ok = promoteMemory(id);
        return ok ? `  Memory #${id} approved and promoted.` : `  Memory #${id} not found.`;
      }

      if (arg.startsWith("search ")) {
        const query = arg.slice(7).trim();
        if (!query) return "  Usage: /memory search <query>";

        // Search enhanced store first
        const { searchMemories: searchStore, initMemoryStoreSchema } = await import("../../core/memory-store.js");
        const { getDb } = await import("../../core/db.js");
        const db = getDb();
        initMemoryStoreSchema(db);
        const storeResults = searchStore(query);

        // Also search legacy file-based memories
        const { searchMemories: searchFiles } = await import("../../core/memory.js");
        const fileResults = await searchFiles(cwd, query);

        if (storeResults.length === 0 && fileResults.length === 0) {
          return `  No memories matching "${query}"`;
        }

        const lines = [`  Search results for "${query}":\n`];

        if (storeResults.length > 0) {
          for (const m of storeResults) {
            const approvedTag = m.approved ? "" : " (pending)";
            lines.push(`  #${String(m.id).padEnd(4)} [${m.category}] ${m.key}${approvedTag}`);
            lines.push(`         ${m.content.slice(0, 70)}${m.content.length > 70 ? "..." : ""}`);
          }
        }

        if (fileResults.length > 0) {
          lines.push(`\n  Legacy file memories:`);
          for (const m of fileResults) {
            lines.push(`  [${m.meta.type}] ${m.meta.title}  (${m.filename})`);
          }
        }

        return lines.join("\n");
      }

      if (arg === "stats") {
        const { getMemoryStats, initMemoryStoreSchema } = await import("../../core/memory-store.js");
        const { getDb } = await import("../../core/db.js");
        const db = getDb();
        initMemoryStoreSchema(db);
        const stats = getMemoryStats();

        const lines = [`  Memory Statistics\n`];
        lines.push(`  Total entries:    ${stats.total}`);
        lines.push(`  Expiring soon:    ${stats.expiringSoon}\n`);

        if (Object.keys(stats.byCategory).length > 0) {
          lines.push(`  By category:`);
          for (const [cat, cnt] of Object.entries(stats.byCategory)) {
            lines.push(`    ${cat.padEnd(14)} ${cnt}`);
          }
          lines.push(``);
        }

        if (Object.keys(stats.bySource).length > 0) {
          lines.push(`  By source:`);
          for (const [src, cnt] of Object.entries(stats.bySource)) {
            lines.push(`    ${src.padEnd(14)} ${cnt}`);
          }
        }

        return lines.join("\n");
      }

      if (arg === "expire") {
        const { expireStaleMemories, initMemoryStoreSchema } = await import("../../core/memory-store.js");
        const { getDb } = await import("../../core/db.js");
        const db = getDb();
        initMemoryStoreSchema(db);
        const count = expireStaleMemories();
        return count > 0 ? `  Expired ${count} stale memor${count === 1 ? "y" : "ies"}.` : "  No expired memories to clean up.";
      }

      if (arg === "global") {
        const { getMemories, initMemoryStoreSchema } = await import("../../core/memory-store.js");
        const { getDb } = await import("../../core/db.js");
        const db = getDb();
        initMemoryStoreSchema(db);
        const memories = getMemories({ project: "" });

        if (memories.length === 0) return "  No global memories. Use /memory add <category> <content> without project scope.";

        const lines = [`  Global Memories (${memories.length}):\n`];
        for (const m of memories) {
          const approvedTag = m.approved ? "" : " (pending)";
          const confTag = m.confidence < 1.0 ? ` [${Math.round(m.confidence * 100)}%]` : "";
          lines.push(`  #${String(m.id).padEnd(4)} [${m.category}] ${m.key}${confTag}${approvedTag}`);
          lines.push(`         ${m.content.slice(0, 70)}${m.content.length > 70 ? "..." : ""}`);
        }
        return lines.join("\n");
      }

      // Default: list project memories (enhanced + legacy)
      if (arg === "" || arg === "list") {
        const { getMemories, initMemoryStoreSchema } = await import("../../core/memory-store.js");
        const { getDb } = await import("../../core/db.js");
        const db = getDb();
        initMemoryStoreSchema(db);
        const storeMemories = getMemories({ project: cwd });

        const { loadAllMemories } = await import("../../core/memory.js");
        const fileMemories = await loadAllMemories(cwd);

        if (storeMemories.length === 0 && fileMemories.length === 0) {
          return "  No memories found.\n  Add one: /memory add <category> <content>\n  Categories: preference, convention, fact, decision, learned";
        }

        const lines: string[] = [];

        if (storeMemories.length > 0) {
          lines.push(`  Structured Memories (${storeMemories.length}):\n`);
          lines.push(`  ${"ID".padEnd(6)} ${"Category".padEnd(14)} ${"Key".padEnd(30)} Conf  Status`);
          lines.push(`  ${"--".padEnd(6)} ${"--------".padEnd(14)} ${"---".padEnd(30)} ----  ------`);
          for (const m of storeMemories) {
            const conf = `${Math.round(m.confidence * 100)}%`.padEnd(6);
            const status = m.approved ? "approved" : "pending";
            lines.push(`  ${String(m.id).padEnd(6)} ${m.category.padEnd(14)} ${m.key.slice(0, 28).padEnd(30)} ${conf}${status}`);
          }
        }

        if (fileMemories.length > 0) {
          if (lines.length > 0) lines.push(``);
          lines.push(`  File Memories (${fileMemories.length}):\n`);
          for (const m of fileMemories) {
            const typeTag = `[${m.meta.type}]`;
            lines.push(`  ${typeTag.padEnd(12)} ${m.meta.title}  (${m.filename})`);
          }
        }

        return lines.join("\n");
      }

      // Legacy subcommands
      if (arg.startsWith("show ")) {
        const { getMemoryDir, readMemoryFile } = await import("../../core/memory.js");
        const filename = arg.slice(5).trim();
        const { join } = await import("node:path");
        const dir = getMemoryDir(cwd);
        const entry = await readMemoryFile(join(dir, filename));
        if (!entry) return `  Memory file "${filename}" not found.`;

        const lines = [
          `  ${entry.meta.title}`,
          `  Type: ${entry.meta.type}`,
          entry.meta.tags ? `  Tags: ${entry.meta.tags.join(", ")}` : null,
          entry.meta.created ? `  Created: ${entry.meta.created}` : null,
          ``,
          entry.content,
        ].filter(Boolean);
        return (lines as string[]).join("\n");
      }

      if (arg === "index") {
        const { readMemoryIndex } = await import("../../core/memory.js");
        const index = await readMemoryIndex(cwd);
        return index ? `  MEMORY.md:\n\n${index}` : "  No MEMORY.md index found.";
      }

      return [
        "  Usage: /memory [subcommand]\n",
        "  Subcommands:",
        "    (none), list      List all memories for current project",
        "    add <cat> <text>  Add memory (preference|convention|fact|decision|learned)",
        "    edit <id> <text>  Edit a memory's content",
        "    delete <id>       Delete a memory by ID",
        "    approve <id>      Promote to persistent/approved",
        "    search <query>    Full-text search across memories",
        "    stats             Show memory statistics",
        "    expire            Clean up expired entries",
        "    global            Show global (non-project) memories",
        "    show <file>       Show a legacy file memory",
        "    index             Show MEMORY.md index",
      ].join("\n");
    }
    case "snippet": {
      const { saveSnippet, loadSnippet, listSnippets, deleteSnippet } = await import("../../core/snippets.js");
      const arg = args?.trim() ?? "list";

      if (arg === "list") {
        const snippets = listSnippets();
        if (snippets.length === 0) return "  No snippets saved. Usage: /snippet save <name> <content>";
        const lines = [`  Saved Snippets (${snippets.length}):\n`];
        for (const s of snippets) {
          const preview = s.content.split("\n")[0]!.slice(0, 60);
          lines.push(`  ${s.name.padEnd(20)} ${preview}${s.content.length > 60 ? "..." : ""}`);
        }
        return lines.join("\n");
      }

      if (arg.startsWith("save ")) {
        const rest = arg.slice(5).trim();
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx === -1) return "  Usage: /snippet save <name> <content>";
        const name = rest.slice(0, spaceIdx);
        const content = rest.slice(spaceIdx + 1);
        saveSnippet(name, content);
        return `  Snippet "${name}" saved (${content.length} chars).`;
      }

      if (arg.startsWith("paste ")) {
        const name = arg.slice(6).trim();
        const snippet = loadSnippet(name);
        if (!snippet) return `  Snippet "${name}" not found.`;
        return `  [${snippet.name}]:\n${snippet.content}`;
      }

      if (arg.startsWith("delete ")) {
        const name = arg.slice(7).trim();
        const deleted = deleteSnippet(name);
        return deleted ? `  Deleted snippet "${name}"` : `  Snippet "${name}" not found.`;
      }

      return "  Usage: /snippet save <name> <content> | list | paste <name> | delete <name>";
    }
    case "alias": {
      const { addAlias, removeAlias, loadAliases } = await import("../../core/aliases.js");
      const arg = args?.trim() ?? "list";

      if (arg === "list") {
        const aliases = loadAliases();
        if (aliases.length === 0) return "  No custom aliases. Usage: /alias set <shortcut> <expansion>";
        const lines = [`  Custom Aliases (${aliases.length}):\n`];
        for (const a of aliases) {
          lines.push(`  /${a.shortcut} \u2192 ${a.expansion}`);
        }
        return lines.join("\n");
      }

      if (arg.startsWith("set ")) {
        const rest = arg.slice(4).trim();
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx === -1) return "  Usage: /alias set <shortcut> <expansion>\n  Example: /alias set s /simplify";
        const shortcut = rest.slice(0, spaceIdx).replace(/^\//, ""); // strip leading /
        const expansion = rest.slice(spaceIdx + 1);
        addAlias(shortcut, expansion);
        return `  Alias set: /${shortcut} \u2192 ${expansion}`;
      }

      if (arg.startsWith("remove ") || arg.startsWith("delete ")) {
        const shortcut = arg.replace(/^(remove|delete)\s+/, "").trim().replace(/^\//, "");
        const removed = removeAlias(shortcut);
        return removed ? `  Alias /${shortcut} removed.` : `  Alias /${shortcut} not found.`;
      }

      return "  Usage: /alias set <shortcut> <expansion> | list | remove <shortcut>";
    }
    case "gallery": {
      const { TemplateManager } = await import("../../core/templates.js");
      const tm = new TemplateManager(appConfig.workingDirectory);
      tm.load();
      const templates = tm.listTemplates();

      // Also show builtin skills as "built-in templates"
      const { builtinSkills } = await import("../../core/builtin-skills.js");

      const lines = [`  Template Gallery\n`];

      // User templates
      if (templates.length > 0) {
        lines.push(`  \u2500\u2500 User Templates (${templates.length}) \u2500\u2500`);
        for (const t of templates) {
          const argStr = t.args.length > 0 ? ` [${t.args.join(", ")}]` : "";
          const preview = t.body.split("\n")[0]!.slice(0, 50);
          lines.push(`  /${t.name}${argStr}`);
          lines.push(`    ${t.description || preview}${t.body.length > 50 ? "..." : ""}`);
        }
        lines.push(``);
      }

      // Categorize builtin skills
      const categories: Record<string, typeof builtinSkills> = {
        "Git": builtinSkills.filter(s => ["commit", "diff", "branch", "log", "stash", "stashes", "blame", "resolve"].includes(s.name)),
        "Code Quality": builtinSkills.filter(s => ["simplify", "lint", "find-bug", "security", "security-review", "type", "test", "test-for", "auto-test", "change-review"].includes(s.name)),
        "Session": builtinSkills.filter(s => ["context", "usage", "analytics", "budget", "compact", "export", "replay", "note", "bookmark", "search-chat", "diff-session", "profile", "session-tags", "auto-compact"].includes(s.name)),
        "Models": builtinSkills.filter(s => ["models", "compare", "consensus", "model-health", "ratelimit", "estimate", "project-cost"].includes(s.name)),
        "Utilities": builtinSkills.filter(s => ["explain", "doc", "deps", "depgraph", "todo", "batch", "loop", "env", "snippet", "alias", "chain", "workspace", "index", "retry"].includes(s.name)),
        "System": builtinSkills.filter(s => ["help", "clear", "rewind", "plugins", "theme", "config", "hooks", "pin", "unpin", "template", "plan", "stats", "doctor", "memory", "fork", "branches", "branch", "gallery"].includes(s.name)),
      };

      // Collect categorized skill names to find uncategorized ones
      const categorizedNames = new Set<string>();
      for (const skills of Object.values(categories)) {
        for (const s of skills) categorizedNames.add(s.name);
      }
      const uncategorized = builtinSkills.filter(s => !categorizedNames.has(s.name));
      if (uncategorized.length > 0) {
        categories["Other"] = uncategorized;
      }

      for (const [cat, skills] of Object.entries(categories)) {
        if (skills.length === 0) continue;
        lines.push(`  \u2500\u2500 ${cat} (${skills.length}) \u2500\u2500`);
        for (const s of skills) {
          const aliasStr = s.aliases.length > 0 ? ` (${s.aliases.join(", ")})` : "";
          lines.push(`  /${s.name}${aliasStr} \u2014 ${s.description}`);
        }
        lines.push(``);
      }

      lines.push(`  Total: ${builtinSkills.length} built-in + ${templates.length} user templates`);
      return lines.join("\n");
    }
    case "hooks": {
      const { readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      const sources = [
        { label: "User (~/.kcode/settings.json)", path: kcodePath("settings.json") },
        { label: "Project (.kcode/settings.json)", path: join(appConfig.workingDirectory, ".kcode", "settings.json") },
      ];

      const lines = ["  Configured Hooks\n"];
      let totalHooks = 0;

      for (const src of sources) {
        if (!existsSync(src.path)) continue;
        try {
          const raw = JSON.parse(readFileSync(src.path, "utf-8"));
          const hooks = raw.hooks;
          if (!hooks || Object.keys(hooks).length === 0) continue;

          lines.push(`  ── ${src.label} ──`);
          for (const [event, configs] of Object.entries(hooks)) {
            if (!Array.isArray(configs)) continue;
            for (const config of configs as Array<{ matcher?: string; hooks?: Array<{ type?: string; url?: string; command?: string }> }>) {
              const hookCount = config.hooks?.length ?? 0;
              totalHooks += hookCount;
              lines.push(`  ${event} [${config.matcher}] - ${hookCount} action(s)`);
              for (const h of config.hooks ?? []) {
                const label = h.type === "http" ? `http: ${h.url}` : `command: ${h.command}`;
                lines.push(`    ${label}`);
              }
            }
          }
          lines.push("");
        } catch { /* skip malformed */ }
      }

      if (totalHooks === 0) {
        return [
          "  No hooks configured.\n",
          "  Add hooks to .kcode/settings.json or ~/.kcode/settings.json:",
          "  {",
          '    "hooks": {',
          '      "PreToolUse": [{',
          '        "matcher": "Bash",',
          '        "hooks": [{ "type": "command", "command": "echo check" }]',
          "      }]",
          "    }",
          "  }",
          "",
          "  Hook types: command (stdin JSON), http (POST JSON)",
          "  Events: SessionStart, PreToolUse, PostToolUse, PostToolUseFailure,",
          "          PreCompact, PostCompact, UserPromptSubmit, PermissionRequest,",
          "          Stop, Notification, ConfigChange, InstructionsLoaded",
        ].join("\n");
      }

      lines.push(`  Total: ${totalHooks} hook action(s)`);
      return lines.join("\n");
    }
    case "plugins": {
      const { getPluginManager } = await import("../../core/plugins.js");
      return getPluginManager().formatList();
    }
    case "auto_test": {
      const { getTestSuggestionsForFiles } = await import("../../core/auto-test.js");
      const files = conversationManager.getModifiedFiles();

      if (files.length === 0) return "  No files modified in this session.";

      const suggestions = getTestSuggestionsForFiles(files, appConfig.workingDirectory);
      if (suggestions.length === 0) return `  No related test files found for ${files.length} modified file(s).`;

      const lines = [`  Found ${suggestions.length} test file(s) for modified code:\n`];
      for (const s of suggestions) {
        lines.push(`  ${s.sourceFile}`);
        lines.push(`    Test: ${s.testFile}`);
        lines.push(`    Run:  ${s.command}\n`);
      }
      lines.push(`  Run all: paste the commands above, or use /test`);
      return lines.join("\n");
    }
    case "change_review": {
      const { reviewChanges, formatReview } = await import("../../core/change-review.js");
      const staged = args?.trim() === "--staged";
      const review = await reviewChanges(appConfig.workingDirectory, staged);
      return formatReview(review);
    }
    case "swarm": {
      if (!args?.trim()) return [
        "  Agent Swarm\n",
        "  Run N agents in parallel on a task.\n",
        "  Usage:",
        "    /swarm <prompt>                    Run 4 agents with the prompt",
        "    /swarm <prompt> --agents 6         Use 6 agents",
        "    /swarm <prompt> --files '*.ts'     Distribute files among agents",
        "",
        "  Agents run in --permission deny mode (read-only).",
        "  Max 8 agents. Each agent gets a subset of files.",
      ].join("\n");

      // Parse args
      let prompt = args.trim();
      let agentCount = 4;
      let fileGlob = "";

      const agentsMatch = prompt.match(/--agents\s+(\d+)/);
      if (agentsMatch) {
        agentCount = Math.min(8, Math.max(1, parseInt(agentsMatch[1]!)));
        prompt = prompt.replace(/--agents\s+\d+/, "").trim();
      }

      const filesMatch = prompt.match(/--files\s+'([^']+)'/);
      if (filesMatch) {
        fileGlob = filesMatch[1]!;
        prompt = prompt.replace(/--files\s+'[^']+'/, "").trim();
      }

      if (!prompt) return "  Provide a task prompt for the swarm.";

      const { runSwarm, runSwarmOnFiles, formatSwarmResult } = await import("../../core/swarm");
      const cwd = appConfig.workingDirectory;

      if (fileGlob) {
        // Find matching files
        const { execSync } = await import("node:child_process");
        try {
          const filesRaw = execSync(
            `find . -type f -name '${fileGlob.replace(/'/g, "")}' -not -path '*/node_modules/*' -not -path '*/.git/*' | head -100`,
            { cwd, timeout: 5000 }
          ).toString().trim();

          const files = filesRaw ? filesRaw.split("\n").map(f => f.replace(/^\.\//, "")) : [];
          if (files.length === 0) return `  No files matching: ${fileGlob}`;

          const result = await runSwarmOnFiles(prompt, files, cwd, agentCount, appConfig.model);
          return formatSwarmResult(result);
        } catch (err: any) {
          return `  Error finding files: ${err.message}`;
        }
      }

      // No files specified — create N identical task agents
      const tasks = Array.from({ length: agentCount }, (_, i) =>
        `${prompt}\n\nYou are agent ${i + 1}/${agentCount}. Be concise.`
      );
      const result = await runSwarm(prompt, tasks, cwd, appConfig.model);
      return formatSwarmResult(result);
    }
    case "sandbox": {
      const { getSandboxCapabilities, getDefaultSandboxConfig } = await import("../../core/sandbox");
      const arg = args?.trim() ?? "status";
      const caps = getSandboxCapabilities();
      const cwd = appConfig.workingDirectory;

      if (arg === "status") {
        const lines = [
          "  Sandbox Status\n",
          `  Platform:    ${process.platform}`,
          `  bwrap:       ${caps.bwrap ? "\u2713 available" : "\u2717 not found"}`,
          `  unshare:     ${caps.unshare ? "\u2713 available" : "\u2717 not found"}`,
          `  Supported:   ${caps.available ? "yes (Linux)" : process.platform === "linux" ? "install bubblewrap" : "Linux only"}`,
          "",
          "  Sandbox modes:",
          "    off    — No isolation (default)",
          "    light  — Restricted PATH, blocked dangerous commands",
          "    strict — bwrap namespace isolation (PID, IPC, optional NET)",
          "",
          "  Configure in .kcode/settings.json:",
          '    { "sandbox": { "mode": "light", "allowNetwork": true } }',
        ];
        return lines.join("\n");
      }

      if (arg === "on" || arg === "strict") {
        if (!caps.available) {
          return process.platform === "linux"
            ? "  Install bubblewrap for strict sandbox: sudo dnf install bubblewrap"
            : "  Sandbox requires Linux with bubblewrap.";
        }
        return "  Sandbox enabled. Set in .kcode/settings.json:\n  { \"sandbox\": { \"mode\": \"strict\" } }";
      }

      if (arg === "off" || arg === "light") {
        return `  Sandbox mode: ${arg}. Set in .kcode/settings.json:\n  { "sandbox": { "mode": "${arg}" } }`;
      }

      return "  Usage: /sandbox [status | on | off | strict | light]";
    }
    case "dry_run": {
      if (!args?.trim()) return "  Usage: /dry-run <description of changes>\n  Simulates changes and shows diffs without writing to disk.";

      // Inject a system instruction that forces read-only mode
      const dryPrompt = `[DRY RUN MODE] The user wants to preview what changes would be made WITHOUT actually modifying any files.

IMPORTANT RULES:
- Do NOT use Edit, Write, MultiEdit, or any file-modifying tools
- Instead, for each change you would make, show the file path and a unified diff of what would change
- Use Read and Grep to understand the current state, then describe the exact changes as diffs
- Format each proposed change as:
  --- a/<file>
  +++ b/<file>
  @@ ... @@
  (unified diff lines)
- At the end, provide a summary: N files would be modified, M lines added, K lines removed

Task to preview: ${args.trim()}`;

      // Return the prompt for the AI to process in the conversation
      return `__dry_run_prompt__${dryPrompt}`;
    }
    case "auto_fix": {
      const rawTarget = args?.trim() || "build";
      const target = rawTarget.toLowerCase();
      const cwd = appConfig.workingDirectory;
      const { execSync } = await import("node:child_process");

      // Determine the command to run
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      let command: string;

      if (target === "build") {
        if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bunfig.toml"))) command = "bun run build";
        else if (existsSync(join(cwd, "package.json"))) command = "npm run build";
        else if (existsSync(join(cwd, "Cargo.toml"))) command = "cargo build";
        else if (existsSync(join(cwd, "go.mod"))) command = "go build ./...";
        else command = "make";
      } else if (target === "test") {
        if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bunfig.toml"))) command = "bun test";
        else if (existsSync(join(cwd, "package.json"))) command = "npm test";
        else if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml"))) command = "pytest";
        else if (existsSync(join(cwd, "go.mod"))) command = "go test ./...";
        else if (existsSync(join(cwd, "Cargo.toml"))) command = "cargo test";
        else command = "npm test";
      } else {
        // Custom command — only allow safe characters (no shell metacharacters)
        if (/[;&|`$(){}!<>]/.test(rawTarget)) {
          return "  Error: Custom commands cannot contain shell metacharacters. Use /auto-fix build or /auto-fix test.";
        }
        command = rawTarget;
      }

      // Run the command and capture errors
      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      try {
        stdout = execSync(command, { cwd, timeout: 60000, stdio: "pipe" }).toString();
        return `  /auto-fix: "${command}" passed successfully. No errors to fix.`;
      } catch (err: any) {
        exitCode = err.status ?? 1;
        stderr = err.stderr?.toString() ?? "";
        stdout = err.stdout?.toString() ?? "";
      }

      // Build error context for the AI
      const errorOutput = (stderr || stdout).trim();
      if (!errorOutput) {
        return `  /auto-fix: "${command}" failed with exit code ${exitCode} but produced no output. Cannot diagnose.`;
      }
      // Sanitize backtick sequences to prevent prompt injection via error output
      const sanitized = errorOutput.replace(/`{3,}/g, "~~~");
      const truncated = sanitized.length > 4000 ? sanitized.slice(-4000) : sanitized;

      const fixPrompt = `[AUTO-FIX] The command "${command}" failed with exit code ${exitCode}.

Error output (last ${truncated.length} chars):
\`\`\`
${truncated}
\`\`\`

INSTRUCTIONS:
1. Analyze the error output to identify the root cause
2. Read the failing file(s) mentioned in the errors
3. Apply the minimal fix needed to resolve the errors
4. After fixing, run "${command}" again to verify the fix works
5. If the fix introduces new errors, iterate until the command passes
6. Report what you fixed and why`;

      return `__auto_fix_prompt__${fixPrompt}`;
    }
    case "btw": {
      if (!args?.trim()) return "  Usage: /btw <question>\n  Asks a quick side question without adding to conversation history.";

      const { getModelBaseUrl } = await import("../../core/models.js");
      const baseUrl = await getModelBaseUrl(appConfig.model, appConfig.apiBase) ?? appConfig.apiBase ?? "http://localhost:10091";

      try {
        const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(appConfig.apiKey ? { Authorization: `Bearer ${appConfig.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: appConfig.model,
            messages: [
              { role: "system", content: "You are a helpful assistant. Answer concisely in 1-3 sentences." },
              { role: "user", content: args.trim() },
            ],
            max_tokens: 1024,
            stream: false,
          }),
        });

        if (!resp.ok) return `  /btw error: ${resp.status} ${resp.statusText}`;

        const data = await resp.json() as Record<string, unknown>;
        const choices = data.choices as Record<string, unknown>[] | undefined;
        const answer = (choices?.[0]?.message as Record<string, unknown> | undefined)?.content ?? "(no response)";
        return `  [btw] ${answer}`;
      } catch (err) {
        return `  /btw error: ${err instanceof Error ? err.message : err}`;
      }
    }
    case "suggest_files": {
      const description = args?.trim() || "the current task";
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      try {
        // Get git-tracked files, sorted by recency
        const filesRaw = execSync("git ls-files --full-name", { cwd, encoding: "utf-8", timeout: 5000 });
        const allFiles = filesRaw.trim().split("\n").filter(Boolean);

        if (allFiles.length === 0) return "  No files found (not a git repo or empty).";

        // Get recently modified files
        let recentFiles: string[] = [];
        try {
          const recent = execSync("git log --diff-filter=M --name-only --pretty=format: -20", { cwd, encoding: "utf-8", timeout: 5000 });
          recentFiles = [...new Set(recent.trim().split("\n").filter(Boolean))].slice(0, 10);
        } catch { /* ignore */ }

        // Use keyword matching from description to find relevant files
        const keywords = description.toLowerCase().split(/\s+/).filter(w => w.length > 1);
        const scored = allFiles.map(f => {
          const lower = f.toLowerCase();
          let score = 0;
          for (const kw of keywords) {
            if (lower.includes(kw)) score += 2;
          }
          if (recentFiles.includes(f)) score += 3;
          // Boost source files over configs/docs
          if (lower.match(/\.(ts|tsx|js|jsx|py|go|rs|swift|java|c|cpp|rb)$/)) score += 1;
          return { file: f, score };
        }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 15);

        if (scored.length === 0) {
          // Fall back to recently modified
          if (recentFiles.length > 0) {
            return [
              `  Suggested Files (recently modified):\n`,
              ...recentFiles.map(f => `    ${f}`),
            ].join("\n");
          }
          return "  No matching files found. Try a more specific description.";
        }

        return [
          `  Suggested Files for: "${description}"\n`,
          ...scored.map(s => `  ${s.score >= 4 ? "*" : " "} ${s.file}`),
          "",
          "  * = high relevance",
        ].join("\n");
      } catch (err) {
        return `  Error: ${err instanceof Error ? err.message : err}`;
      }
    }
    case "new_project": {
      const { listTemplates, findTemplate, createFromTemplate } = await import("../../core/project-templates");
      const input = args?.trim();

      if (!input) {
        const templates = listTemplates();
        const lines = [`  Project Templates (${templates.length})\n`];
        for (const t of templates) {
          lines.push(`  ${t.name.padEnd(14)} ${t.description}  [${t.source}]`);
        }
        lines.push(``);
        lines.push(`  Usage: /new-project <template> <project-name>`);
        lines.push(`  Example: /new-project bun-ts my-app`);
        return lines.join("\n");
      }

      const parts = input.split(/\s+/);
      if (parts.length < 2) return "  Usage: /new-project <template> <project-name>";

      const templateName = parts[0]!;
      const projectName = parts[1]!;

      const template = findTemplate(templateName);
      if (!template) return `  Template not found: ${templateName}\n  Run /new-project to see available templates.`;

      // Validate project name
      if (!/^[a-zA-Z][\w.-]*$/.test(projectName)) {
        return "  Invalid project name. Use alphanumeric, hyphens, dots, underscores.";
      }

      const { resolve: resolvePath } = await import("node:path");
      const targetDir = resolvePath(appConfig.workingDirectory, projectName);

      const { existsSync } = await import("node:fs");
      if (existsSync(targetDir)) return `  Directory already exists: ${projectName}`;

      const result = createFromTemplate(template, projectName, targetDir);

      const lines = [
        `  Created ${projectName} from "${templateName}" template\n`,
        `  Files:`,
      ];
      for (const f of result.filesCreated) {
        lines.push(`    ${f}`);
      }
      if (result.postCreate) {
        lines.push(``);
        lines.push(`  Run: cd ${projectName} && ${result.postCreate}`);
      }

      return lines.join("\n");
    }
    default:
      return null;
  }
}
