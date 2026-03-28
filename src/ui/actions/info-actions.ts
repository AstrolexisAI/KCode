// Info actions
// Auto-extracted from builtin-actions.ts

import type { ActionContext } from "./action-helpers.js";
import { collectStats, formatStats } from "../../core/stats.js";
import { runDiagnostics } from "../../core/doctor.js";

export async function handleInfoAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { conversationManager, setCompleted, appConfig, args, switchTheme } = ctx;

  switch (action) {
    case "stats": {
      const stats = await collectStats(7);
      let output = formatStats(stats);
      const breakdown = conversationManager.formatCostBreakdown();
      if (breakdown) {
        output += "\n" + breakdown;
      }
      return output;
    }
    case "doctor": {
      const checks = await runDiagnostics();
      const lines = checks.map((c) => {
        const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "⚠" : "✗";
        return `  ${icon} ${c.name}: ${c.message}`;
      });
      return lines.join("\n");
    }
    case "usage": {
      const usage = conversationManager.getUsage();
      const state = conversationManager.getState();
      const contextSize = appConfig.contextWindowSize ?? 200000;
      const totalTokens = usage.inputTokens + usage.outputTokens;

      const { getModelPricing, calculateCost, formatCost } = await import("../../core/pricing.js");
      const pricing = await getModelPricing(appConfig.model);
      const cost = pricing ? calculateCost(pricing, usage.inputTokens, usage.outputTokens) : 0;

      const lines = [
        `  Session Token Usage`,
        ``,
        `  Input tokens:   ${usage.inputTokens.toLocaleString()}`,
        `  Output tokens:  ${usage.outputTokens.toLocaleString()}`,
        `  Total tokens:   ${totalTokens.toLocaleString()}`,
        `  Cache created:  ${usage.cacheCreationInputTokens.toLocaleString()}`,
        `  Cache read:     ${usage.cacheReadInputTokens.toLocaleString()}`,
        ``,
        `  Messages:       ${state.messages.length}`,
        `  Tool calls:     ${state.toolUseCount}`,
        `  Context window: ${totalTokens.toLocaleString()} / ${contextSize.toLocaleString()} (${Math.round((totalTokens / contextSize) * 100)}%)`,
        ``,
        `  Model:  ${appConfig.model}`,
        `  Cost:   ${formatCost(cost)}`,
      ];
      if (pricing) {
        lines.push(`  Rate:   $${pricing.inputPer1M}/M in, $${pricing.outputPer1M}/M out`);
      }
      return lines.join("\n");
    }
    case "analytics": {
      const state = conversationManager.getState();
      const usage = conversationManager.getUsage();

      // Count tool usage from messages (current session)
      const toolCounts: Record<string, number> = {};
      const toolErrors: Record<string, number> = {};
      let totalToolCalls = 0;

      for (const msg of state.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            totalToolCalls++;
            toolCounts[block.name] = (toolCounts[block.name] ?? 0) + 1;
          }
          if (block.type === "tool_result" && block.is_error) {
            const prevMsg = state.messages.find(m =>
              Array.isArray(m.content) && m.content.some(b =>
                b.type === "tool_use" && b.id === block.tool_use_id
              )
            );
            if (prevMsg && Array.isArray(prevMsg.content)) {
              const toolBlock = prevMsg.content.find(b => b.type === "tool_use" && b.id === block.tool_use_id);
              if (toolBlock && toolBlock.type === "tool_use") {
                toolErrors[toolBlock.name] = (toolErrors[toolBlock.name] ?? 0) + 1;
              }
            }
          }
        }
      }

      // Build session analytics
      const sorted = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
      const maxNameLen = Math.max(...sorted.map(([n]) => n.length), 8);
      const maxCount = sorted[0]?.[1] ?? 1;
      const barWidth = 20;

      const lines = [
        `  Session Analytics`,
        ``,
        `  Messages:    ${state.messages.length}`,
        `  Tool calls:  ${totalToolCalls}`,
        `  Tokens:      ${(usage.inputTokens + usage.outputTokens).toLocaleString()}`,
      ];

      if (totalToolCalls > 0) {
        lines.push(``, `  Tool Usage:`);
        for (const [name, count] of sorted) {
          const pct = Math.round((count / totalToolCalls) * 100);
          const filled = Math.round((count / maxCount) * barWidth);
          const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
          const errors = toolErrors[name] ? ` (${toolErrors[name]} err)` : "";
          lines.push(`  ${name.padEnd(maxNameLen)} ${bar} ${count} (${pct}%)${errors}`);
        }

        const totalErrors = Object.values(toolErrors).reduce((a, b) => a + b, 0);
        if (totalErrors > 0) {
          lines.push(``, `  Error rate: ${totalErrors}/${totalToolCalls} (${Math.round((totalErrors / totalToolCalls) * 100)}%)`);
        }
      }

      // Persistent analytics (cross-session, last 7 days)
      try {
        const { getAnalyticsSummary, formatAnalyticsSummary } = await import("../../core/analytics.js");
        const summary = getAnalyticsSummary(7);
        if (summary.totalToolCalls > 0) {
          lines.push(``, `  ─── Historical (7 days) ───`, ``);
          lines.push(formatAnalyticsSummary(summary, 7));
        }
      } catch { /* analytics table may not exist yet */ }

      return lines.join("\n");
    }
    case "budget": {
      const state = conversationManager.getState();
      const usage = conversationManager.getUsage();
      const contextSize = appConfig.contextWindowSize ?? 200000;
      const usedTokens = usage.inputTokens + usage.outputTokens;
      const threshold = (appConfig.compactThreshold ?? 0.8) * contextSize;
      const remaining = Math.max(0, threshold - usedTokens);
      const pctUsed = Math.min(100, Math.round((usedTokens / contextSize) * 100));
      const pctThreshold = Math.round((appConfig.compactThreshold ?? 0.8) * 100);

      // Estimate tokens per message (average)
      const msgCount = state.messages.length;
      const tokPerMsg = msgCount > 0 ? Math.round(usedTokens / msgCount) : 0;
      const msgsUntilCompact = tokPerMsg > 0 ? Math.floor(remaining / tokPerMsg) : 0;

      // Visual bar showing used, threshold, and total
      const barLen = 40;
      const usedBar = Math.round(barLen * pctUsed / 100);
      const threshBar = Math.round(barLen * pctThreshold / 100);

      let bar = "";
      for (let i = 0; i < barLen; i++) {
        if (i < usedBar) bar += "\u2588";
        else if (i === threshBar) bar += "|";
        else bar += "\u2591";
      }

      const lines = [
        `  Context Budget Planner`,
        ``,
        `  [${bar}] ${pctUsed}%`,
        `  Used:      ${usedTokens.toLocaleString()} tokens`,
        `  Threshold: ${Math.round(threshold).toLocaleString()} tokens (${pctThreshold}%)`,
        `  Window:    ${contextSize.toLocaleString()} tokens`,
        `  Remaining: ${remaining.toLocaleString()} tokens until auto-compact`,
        ``,
        `  Estimates:`,
        `    Avg tokens/message: ~${tokPerMsg.toLocaleString()}`,
        `    Messages until compact: ~${msgsUntilCompact}`,
        `    Messages so far: ${msgCount}`,
        `    Tool calls: ${state.toolUseCount}`,
      ];

      // Warn if close to threshold
      if (pctUsed >= pctThreshold - 5) {
        lines.push(``, `  \u26A0 Approaching auto-compact threshold! Consider /compact manually.`);
      } else if (pctUsed >= pctThreshold * 0.7) {
        lines.push(``, `  \u2139 Context is ${pctUsed}% full. Plenty of room.`);
      }

      return lines.join("\n");
    }
    case "changes": {
      const files = conversationManager.getModifiedFiles();
      if (files.length === 0) return "  No files modified in this session.";

      const { execSync } = await import("node:child_process");
      const lines = [`  Files modified this session (${files.length}):\n`];

      for (const f of files) {
        // Try to get a short git diff stat for each file
        let diffStat = "";
        try {
          diffStat = execSync(`git diff --stat -- "${f}" 2>/dev/null`, {
            cwd: appConfig.workingDirectory,
            timeout: 3000,
          }).toString().trim();
        } catch { /* not in git or no changes */ }

        if (diffStat) {
          lines.push(`  ${f}`);
          for (const dl of diffStat.split("\n")) {
            lines.push(`    ${dl}`);
          }
        } else {
          lines.push(`  ${f}`);
        }
      }

      // Overall summary if in a git repo
      try {
        const summary = execSync("git diff --stat 2>/dev/null", {
          cwd: appConfig.workingDirectory,
          timeout: 3000,
        }).toString().trim();
        if (summary) {
          lines.push("");
          lines.push(`  ${summary.split("\n").pop() ?? ""}`);
        }
      } catch { /* ignore */ }

      return lines.join("\n");
    }
    case "diff_session": {
      const files = conversationManager.getModifiedFiles();
      if (files.length === 0) return "  No files modified in this session.";

      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const lines = [`  Session Diff \u2014 ${files.length} file(s) modified\n`];

      let totalAdded = 0;
      let totalRemoved = 0;

      for (const f of files) {
        try {
          // Get diff stat for each file
          const stat = execSync(`git diff --numstat -- "${f}" 2>/dev/null`, { cwd, timeout: 3000 }).toString().trim();
          if (stat) {
            const parts = stat.split("\t");
            const added = parseInt(parts[0]) || 0;
            const removed = parseInt(parts[1]) || 0;
            totalAdded += added;
            totalRemoved += removed;
            lines.push(`  ${f}`);
            lines.push(`    +${added} -${removed}`);
          } else {
            // Check if it's a new untracked file
            const isUntracked = execSync(`git ls-files --others --exclude-standard -- "${f}" 2>/dev/null`, { cwd, timeout: 3000 }).toString().trim();
            if (isUntracked) {
              lines.push(`  ${f} (new file)`);
            } else {
              lines.push(`  ${f} (no git changes)`);
            }
          }
        } catch {
          lines.push(`  ${f} (not in git)`);
        }
      }

      // Summary
      lines.push(``);
      lines.push(`  Total: +${totalAdded} -${totalRemoved} across ${files.length} file(s)`);

      // Show combined diff preview (truncated)
      try {
        const fileArgs = files.map(f => `"${f}"`).join(" ");
        const diff = execSync(`git diff --stat -- ${fileArgs} 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim();
        if (diff) {
          lines.push(``);
          const lastLine = diff.split("\n").pop() ?? "";
          lines.push(`  ${lastLine}`);
        }
      } catch { /* ignore */ }

      return lines.join("\n");
    }
    case "ratelimit": {
      const rl = conversationManager.getRateLimiter();
      const stats = rl.stats;
      const lines = [
        `  Rate Limiter Dashboard`,
        ``,
        `  Active requests:    ${stats.activeRequests}`,
        `  Pending (queued):   ${stats.pending}`,
        `  Requests this min:  ${stats.requestsThisMinute}`,
        ``,
        `  Config:`,
        `    Max per minute:   ${appConfig.rateLimit?.maxPerMinute ?? 60}`,
        `    Max concurrent:   ${appConfig.rateLimit?.maxConcurrent ?? 2}`,
      ];

      // Visual gauge for requests this minute
      const maxRpm = appConfig.rateLimit?.maxPerMinute ?? 60;
      const pct = Math.min(100, Math.round((stats.requestsThisMinute / maxRpm) * 100));
      const barLen = 30;
      const filled = Math.round(barLen * pct / 100);
      const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
      lines.push(``, `  Rate:  [${bar}] ${pct}% (${stats.requestsThisMinute}/${maxRpm})`);

      return lines.join("\n");
    }
    case "env": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      const detect = (cmd: string): string => {
        try {
          return execSync(`${cmd} 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim().split("\n")[0];
        } catch {
          return "";
        }
      };

      const checks = [
        { name: "OS", cmd: "uname -sr" },
        { name: "Shell", cmd: "echo $SHELL" },
        { name: "Bun", cmd: "bun --version" },
        { name: "Node", cmd: "node --version" },
        { name: "npm", cmd: "npm --version" },
        { name: "Git", cmd: "git --version" },
        { name: "Python", cmd: "python3 --version" },
        { name: "Cargo", cmd: "cargo --version" },
        { name: "Go", cmd: "go version" },
        { name: "Docker", cmd: "docker --version" },
        { name: "GCC", cmd: "gcc --version | head -1" },
      ];

      const lines = [`  Development Environment\n`];
      const maxNameLen = Math.max(...checks.map(c => c.name.length));

      for (const { name, cmd } of checks) {
        const ver = detect(cmd);
        if (ver) {
          lines.push(`  \u2713 ${name.padEnd(maxNameLen)}  ${ver}`);
        }
      }

      // Git repo info
      const gitBranch = detect("git rev-parse --abbrev-ref HEAD");
      const gitRemote = detect("git remote get-url origin");
      if (gitBranch) {
        lines.push(``);
        lines.push(`  Git branch: ${gitBranch}`);
        if (gitRemote) lines.push(`  Remote:     ${gitRemote}`);
      }

      // Project info
      lines.push(``);
      lines.push(`  CWD: ${cwd}`);
      lines.push(`  KCode: v${appConfig.version ?? "?"}`);
      lines.push(`  Model: ${appConfig.model}`);

      return lines.join("\n");
    }
    case "estimate": {
      if (!args?.trim()) return "  Usage: /estimate <text or file path>";

      const input = args.trim();
      let text = input;

      // Check if it's a file path
      const { existsSync, readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const filePath = resolve(appConfig.workingDirectory, input);
      let isFile = false;

      if (existsSync(filePath)) {
        try {
          const { statSync } = await import("node:fs");
          const fileStat = statSync(filePath);
          if (fileStat.size > 10 * 1024 * 1024) {
            return `  File too large (${(fileStat.size / (1024 * 1024)).toFixed(1)} MB). Max 10 MB for estimation.`;
          }
          text = readFileSync(filePath, "utf-8");
          isFile = true;
        } catch { /* use input as text */ }
      }

      // Simple token estimation: ~4 chars per token for English text, ~3 for code
      const charCount = text.length;
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const lineCount = text.split("\n").length;

      // Heuristic: code has more special chars
      const codeRatio = (text.match(/[{}()\[\];=<>|&]/g)?.length ?? 0) / Math.max(charCount, 1);
      const charsPerToken = codeRatio > 0.02 ? 3.2 : 4.0;
      const estimatedTokens = Math.round(charCount / charsPerToken);

      const contextSize = appConfig.contextWindowSize ?? 200000;
      const pct = Math.round((estimatedTokens / contextSize) * 100);

      const lines = [
        `  Token Estimate${isFile ? ` (${input})` : ""}`,
        ``,
        `  Characters:  ${charCount.toLocaleString()}`,
        `  Words:       ${wordCount.toLocaleString()}`,
        `  Lines:       ${lineCount.toLocaleString()}`,
        ``,
        `  Est. tokens: ~${estimatedTokens.toLocaleString()}`,
        `  Context:     ${pct}% of ${contextSize.toLocaleString()} window`,
        `  Type:        ${codeRatio > 0.02 ? "code" : "text"} (~${charsPerToken} chars/token)`,
      ];

      if (pct > 50) {
        lines.push(``, `  \u26A0 This would use ${pct}% of your context window.`);
      }

      return lines.join("\n");
    }
    case "profile": {
      const { getAnalyticsSummary } = await import("../../core/analytics.js");
      const summary = getAnalyticsSummary(365);

      const errorRate = summary.totalToolCalls > 0
        ? ((summary.totalErrors / summary.totalToolCalls) * 100).toFixed(1)
        : "0.0";

      const topTools = summary.toolBreakdown.slice(0, 5);
      const topModel = summary.modelBreakdown[0];

      const lines = [
        `  User Profile`,
        `  ${"─".repeat(40)}`,
        ``,
        `  Total Sessions:    ${summary.totalSessions}`,
        `  Total Tool Calls:  ${summary.totalToolCalls}`,
        `  Error Rate:        ${errorRate}%`,
        `  Total Tokens:      ${(summary.totalInputTokens + summary.totalOutputTokens).toLocaleString()}`,
        `  Total Cost:        $${summary.totalCostUsd.toFixed(4)}`,
        ``,
      ];

      if (topModel) {
        lines.push(`  Favorite Model:    ${topModel.model} (${topModel.calls} calls)`);
        lines.push(``);
      }

      if (topTools.length > 0) {
        lines.push(`  Top 5 Tools:`);
        const maxNameLen = Math.max(...topTools.map(t => t.tool.length));
        for (const t of topTools) {
          const bar = "\u2588".repeat(Math.max(1, Math.round((t.count / topTools[0].count) * 20)));
          lines.push(`    ${t.tool.padEnd(maxNameLen + 2)}${bar} ${t.count} calls (${t.avgMs}ms avg)`);
        }
      }

      lines.push(`  ${"─".repeat(40)}`);
      return lines.join("\n");
    }
    case "sysinfo": {
      const { execSync } = await import("node:child_process");
      const os = await import("node:os");

      const lines = [`  System Info\n`];

      // OS
      lines.push(`  OS:        ${os.type()} ${os.release()} (${os.arch()})`);
      lines.push(`  Hostname:  ${os.hostname()}`);

      // Kernel
      try {
        const kernel = execSync(`uname -r 2>/dev/null`, { timeout: 2000 }).toString().trim();
        lines.push(`  Kernel:    ${kernel}`);
      } catch { /* skip */ }

      // CPU
      const cpus = os.cpus();
      if (cpus.length > 0) {
        lines.push(`  CPU:       ${cpus[0]!.model.trim()}`);
        lines.push(`  Cores:     ${cpus.length}`);
        lines.push(`  Speed:     ${cpus[0]!.speed} MHz`);
      }

      // RAM
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memPct = (usedMem / totalMem * 100).toFixed(1);
      lines.push(`  RAM:       ${(usedMem / 1024 / 1024 / 1024).toFixed(1)} / ${(totalMem / 1024 / 1024 / 1024).toFixed(1)} GB (${memPct}%)`);

      // GPU
      try {
        const gpu = execSync(`nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>/dev/null`, { timeout: 5000 }).toString().trim();
        if (gpu) {
          for (const line of gpu.split("\n")) {
            const [name, mem, driver] = line.split(", ");
            lines.push(`  GPU:       ${name} (${mem} MB, driver ${driver})`);
          }
        }
      } catch {
        try {
          const lspci = execSync(`lspci 2>/dev/null | grep -i 'vga\\|3d' | head -2`, { timeout: 3000 }).toString().trim();
          if (lspci) {
            for (const line of lspci.split("\n")) {
              const name = line.replace(/.*:\s*/, "");
              lines.push(`  GPU:       ${name}`);
            }
          }
        } catch { /* skip */ }
      }

      // Uptime
      const uptimeSec = os.uptime();
      const days = Math.floor(uptimeSec / 86400);
      const hours = Math.floor((uptimeSec % 86400) / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      lines.push(`  Uptime:    ${days}d ${hours}h ${mins}m`);

      // Load average
      const load = os.loadavg();
      lines.push(`  Load:      ${load[0]!.toFixed(2)} ${load[1]!.toFixed(2)} ${load[2]!.toFixed(2)}`);

      // Disk
      try {
        const df = execSync(`df -h / 2>/dev/null | tail -1`, { timeout: 3000 }).toString().trim();
        const dfParts = df.split(/\s+/);
        if (dfParts.length >= 5) {
          lines.push(`  Disk (/):  ${dfParts[2]} / ${dfParts[1]} (${dfParts[4]})`);
        }
      } catch { /* skip */ }

      return lines.join("\n");
    }
    case "debug": {
      const { getDebugTracer } = await import("../../core/debug-tracer.js");
      const tracer = getDebugTracer();
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "" || arg === "on") {
        tracer.enable();
        // Also attach to conversation manager if not already
        if (!conversationManager.getDebugTracer()) {
          conversationManager.setDebugTracer(tracer);
        }
        return "  Debug tracing enabled. Agent decisions will be recorded.\n  Use /debug trace to view, /debug off to disable.";
      }

      if (arg === "off") {
        tracer.disable();
        return "  Debug tracing disabled.";
      }

      if (arg === "clear") {
        const count = tracer.size;
        tracer.clear();
        return `  Debug trace cleared (${count} events removed).`;
      }

      if (arg === "trace" || arg.startsWith("trace ")) {
        const category = arg.replace("trace", "").trim() || undefined;
        const validCategories = ["decision", "routing", "tool", "context", "permission", "guard", "hook", "model"];
        if (category && !validCategories.includes(category)) {
          return `  Unknown category: "${category}"\n  Valid categories: ${validCategories.join(", ")}`;
        }
        const events = tracer.getEvents({
          category: category as any,
          limit: 50,
        });
        if (!tracer.isEnabled()) {
          return "  Debug tracing is not enabled. Use /debug on to start recording.";
        }
        return tracer.formatTrace(events);
      }

      return [
        "  Debug Tracer",
        `  Status: ${tracer.isEnabled() ? "enabled" : "disabled"}`,
        `  Events: ${tracer.size}`,
        "",
        "  Commands:",
        "    /debug on         Enable tracing",
        "    /debug off        Disable tracing",
        "    /debug trace      Show recent trace events",
        "    /debug trace <cat> Filter by category (decision, routing, tool, context, permission, guard, hook, model)",
        "    /debug clear      Clear trace buffer",
      ].join("\n");
    }
    default:
      return null;
  }
}
