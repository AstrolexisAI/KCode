// Utility actions
// Auto-extracted from builtin-actions.ts

import type { ActionContext } from "./action-helpers.js";

export async function handleUtilityAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { conversationManager, setCompleted, appConfig, args, switchTheme } = ctx;

  switch (action) {
    case "depgraph": {
      if (!args?.trim()) return "  Usage: /depgraph <file path>";

      const { resolve: resolvePath } = await import("node:path");
      const { readFileSync, existsSync } = await import("node:fs");
      const { dirname, basename, relative } = await import("node:path");

      const filePath = resolvePath(appConfig.workingDirectory, args.trim());
      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;

      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        return `  Cannot read: ${args.trim()}`;
      }

      // Extract imports (handles multiline imports)
      const importRegex = /(?:import\s+[\s\S]*?from\s+["'](.+?)["']|require\s*\(\s*["'](.+?)["']\s*\))/g;
      const imports: string[] = [];
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        imports.push(match[1] ?? match[2]);
      }

      // Extract exports
      const exportRegex = /export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
      const exports: string[] = [];
      while ((match = exportRegex.exec(content)) !== null) {
        exports.push(match[1]);
      }
      // Also check for `export { ... }`
      const reExportRegex = /export\s*\{([^}]+)\}/g;
      while ((match = reExportRegex.exec(content)) !== null) {
        const names = match[1].split(",").map(s => s.trim().split(/\s+as\s+/).pop()?.trim()).filter(Boolean);
        exports.push(...(names as string[]));
      }

      const relPath = relative(appConfig.workingDirectory, filePath) || basename(filePath);
      const lines = [`  Dependency Graph: ${relPath}\n`];

      // Imports tree
      if (imports.length > 0) {
        lines.push(`  Imports (${imports.length}):`);
        for (let i = 0; i < imports.length; i++) {
          const isLast = i === imports.length - 1;
          const prefix = isLast ? "\u2514\u2500" : "\u251C\u2500";
          const imp = imports[i];
          const isLocal = imp.startsWith(".") || imp.startsWith("/");
          const tag = isLocal ? "" : " (external)";
          lines.push(`    ${prefix} ${imp}${tag}`);
        }
      } else {
        lines.push(`  No imports found.`);
      }

      lines.push(``);

      // Exports tree
      if (exports.length > 0) {
        lines.push(`  Exports (${exports.length}):`);
        for (let i = 0; i < exports.length; i++) {
          const isLast = i === exports.length - 1;
          const prefix = isLast ? "\u2514\u2500" : "\u251C\u2500";
          lines.push(`    ${prefix} ${exports[i]}`);
        }
      } else {
        lines.push(`  No exports found.`);
      }

      return lines.join("\n");
    }
    case "project_cost": {
      const usage = conversationManager.getUsage();
      const state = conversationManager.getState();

      const { getModelPricing, calculateCost, formatCost } = await import("../../core/pricing.js");
      const pricing = await getModelPricing(appConfig.model);

      const msgCount = state.messages.length;
      if (msgCount === 0) return "  No messages yet — cannot project costs.";

      const n = parseInt(args?.trim() || "") || 10;

      // Current averages
      const avgInputPerMsg = Math.round(usage.inputTokens / msgCount);
      const avgOutputPerMsg = Math.round(usage.outputTokens / msgCount);
      const currentCost = pricing ? calculateCost(pricing, usage.inputTokens, usage.outputTokens) : 0;

      // Project
      const projInputTokens = avgInputPerMsg * n;
      const projOutputTokens = avgOutputPerMsg * n;
      const projCost = pricing ? calculateCost(pricing, projInputTokens, projOutputTokens) : 0;
      const totalProjectedCost = currentCost + projCost;

      const lines = [
        `  Cost Projection \u2014 Next ${n} Messages`,
        ``,
        `  Current Session:`,
        `    Messages:      ${msgCount}`,
        `    Input tokens:  ${usage.inputTokens.toLocaleString()} (avg ${avgInputPerMsg.toLocaleString()}/msg)`,
        `    Output tokens: ${usage.outputTokens.toLocaleString()} (avg ${avgOutputPerMsg.toLocaleString()}/msg)`,
        `    Cost so far:   ${formatCost(currentCost)}`,
        ``,
        `  Projection (+${n} messages):`,
        `    Est. input:    +${projInputTokens.toLocaleString()} tokens`,
        `    Est. output:   +${projOutputTokens.toLocaleString()} tokens`,
        `    Est. cost:     +${formatCost(projCost)}`,
        `    Total:         ${formatCost(totalProjectedCost)}`,
      ];

      if (pricing) {
        lines.push(``, `  Rate: $${pricing.inputPer1M}/M in, $${pricing.outputPer1M}/M out`);
      } else {
        lines.push(``, `  \u2139 No pricing data for ${appConfig.model} (local model — free)`);
      }

      // Context budget check
      const contextSize = appConfig.contextWindowSize ?? 200000;
      const totalTokens = usage.inputTokens + usage.outputTokens + projInputTokens + projOutputTokens;
      const pct = Math.round((totalTokens / contextSize) * 100);
      if (pct > 80) {
        lines.push(``, `  \u26A0 Projected to use ${pct}% of context window — may trigger auto-compact`);
      }

      return lines.join("\n");
    }
    case "filesize": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      const rawPattern = args?.trim() || "**/*.*";
      // Sanitize pattern: only allow alphanumeric, *, ?, ., -, _, /
      const pattern = rawPattern.replace(/[^a-zA-Z0-9*?._\-\/]/g, "");
      if (!pattern) return "  Invalid pattern. Use glob characters like *.ts or **/*.js";

      // Use find to get files matching pattern, sorted by size
      let files: Array<{ path: string; size: number }> = [];
      try {
        const namePattern = pattern.includes("*") ? pattern.split("/").pop() || "*" : pattern;
        const output = execSync(`find . -type f -name '${namePattern.replace(/'/g, "")}' -not -path '*/node_modules/*' -not -path '*/.git/*' -printf '%s\\t%p\\n' 2>/dev/null | sort -rn | head -30`, {
          cwd,
          timeout: 10000,
        }).toString().trim();

        if (output) {
          for (const line of output.split("\n")) {
            const [sizeStr, ...pathParts] = line.split("\t");
            const filePath = pathParts.join("\t");
            const size = parseInt(sizeStr) || 0;
            if (filePath) files.push({ path: filePath.replace(/^\.\//, ""), size });
          }
        }
      } catch {
        return "  Error scanning files. Check the glob pattern.";
      }

      if (files.length === 0) return `  No files found matching: ${pattern}`;

      const maxSize = files[0]?.size ?? 1;
      const barWidth = 20;

      const formatSize = (bytes: number): string => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      };

      const lines = [`  File Sizes (top ${files.length}, pattern: ${pattern})\n`];
      for (const f of files) {
        const filled = Math.max(1, Math.round((f.size / maxSize) * barWidth));
        const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
        lines.push(`  ${bar} ${formatSize(f.size).padStart(10)}  ${f.path}`);
      }

      const totalSize = files.reduce((a, b) => a + b.size, 0);
      lines.push(`\n  Total: ${formatSize(totalSize)} across ${files.length} file(s)`);
      return lines.join("\n");
    }
    case "regex": {
      if (!args?.trim()) return "  Usage: /regex <pattern> <text or file path>\n  Example: /regex \"\\d+\\.\\d+\" package.json";

      const input = args.trim();
      // Parse: first quoted or unquoted token is the pattern, rest is text/file
      let pattern: string;
      let target: string;

      const quotedMatch = input.match(/^["'](.+?)["']\s+(.+)$/);
      if (quotedMatch) {
        pattern = quotedMatch[1];
        target = quotedMatch[2];
      } else {
        const spaceIdx = input.indexOf(" ");
        if (spaceIdx === -1) return "  Usage: /regex <pattern> <text or file path>";
        pattern = input.slice(0, spaceIdx);
        target = input.slice(spaceIdx + 1);
      }

      // Check if target is a file
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      let text = target;
      let isFile = false;
      const filePath = resolvePath(appConfig.workingDirectory, target);

      if (existsSync(filePath) && statSyncFn(filePath).isFile()) {
        if (statSyncFn(filePath).size > 1024 * 1024) return "  File too large (max 1 MB for regex testing).";
        text = readFileSync(filePath, "utf-8");
        isFile = true;
      }

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, "g");
      } catch (err) {
        return `  Invalid regex: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Guard against ReDoS: run regex with a timeout
      const matches: Array<{ index: number; match: string; groups?: string[] }> = [];
      const startTime = Date.now();
      let m;
      while ((m = regex.exec(text)) !== null && matches.length < 50) {
        if (Date.now() - startTime > 3000) {
          return `  Regex execution timed out (>3s). Pattern may cause catastrophic backtracking.`;
        }
        const groups = m.slice(1).length > 0 ? m.slice(1) : undefined;
        matches.push({ index: m.index, match: m[0], groups });
        if (m[0].length === 0) { regex.lastIndex++; } // prevent infinite loop on zero-length matches
        if (!regex.global) break;
      }

      if (matches.length === 0) return `  No matches for /${pattern}/${isFile ? ` in ${target}` : ""}`;

      const lines = [`  Regex: /${pattern}/g${isFile ? ` in ${target}` : ""}\n  ${matches.length} match(es)\n`];

      for (let i = 0; i < Math.min(matches.length, 20); i++) {
        const match = matches[i];
        const context = text.slice(Math.max(0, match.index - 20), match.index + match.match.length + 20).replace(/\n/g, "\\n");
        lines.push(`  [${i + 1}] "${match.match}" at index ${match.index}`);
        if (match.groups) {
          lines.push(`       Groups: ${match.groups.map((g, j) => `$${j + 1}="${g}"`).join(", ")}`);
        }
      }

      if (matches.length > 20) lines.push(`\n  ... ${matches.length - 20} more matches`);
      return lines.join("\n");
    }
    case "processes": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      const lines = [`  Project-Related Processes\n`];

      // Common dev process patterns
      const patterns = [
        { label: "Node/Bun", cmd: `ps aux | grep -E "(node|bun|tsx|ts-node)" | grep -v grep` },
        { label: "Python", cmd: `ps aux | grep -E "(python|uvicorn|gunicorn|flask)" | grep -v grep` },
        { label: "Go", cmd: `ps aux | grep -E "go (run|build|test)" | grep -v grep` },
        { label: "Docker", cmd: `ps aux | grep -E "docker" | grep -v grep | head -5` },
        { label: "Servers", cmd: `ps aux | grep -E "(vite|webpack|next|nuxt|nginx|httpd|caddy)" | grep -v grep` },
      ];

      let totalFound = 0;
      for (const { label, cmd } of patterns) {
        try {
          const output = execSync(`${cmd} 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim();
          if (output) {
            const procs = output.split("\n");
            totalFound += procs.length;
            lines.push(`  \u2500\u2500 ${label} (${procs.length}) \u2500\u2500`);
            for (const proc of procs.slice(0, 5)) {
              // Extract PID and command
              const parts = proc.trim().split(/\s+/);
              const pid = parts[1] ?? "?";
              const cpu = parts[2] ?? "?";
              const mem = parts[3] ?? "?";
              const command = parts.slice(10).join(" ").slice(0, 60);
              lines.push(`  PID ${pid.padStart(6)}  CPU ${cpu}%  MEM ${mem}%  ${command}`);
            }
            if (procs.length > 5) lines.push(`    ... ${procs.length - 5} more`);
            lines.push(``);
          }
        } catch { /* not found */ }
      }

      // Show listening ports
      try {
        const ports = execSync(`ss -tlnp 2>/dev/null | tail -n +2 | head -10`, { cwd, timeout: 5000 }).toString().trim();
        if (ports) {
          const portLines = ports.split("\n");
          lines.push(`  \u2500\u2500 Listening Ports (${portLines.length}) \u2500\u2500`);
          for (const pl of portLines) {
            const parts = pl.trim().split(/\s+/);
            const addr = parts[3] ?? "?";
            const proc = parts[5]?.replace(/.*"(.+?)".*/, "$1") ?? "";
            lines.push(`  ${addr.padEnd(25)} ${proc}`);
          }
          lines.push(``);
        }
      } catch { /* ignore */ }

      if (totalFound === 0 && lines.length <= 1) {
        lines.push(`  No development processes detected.`);
      }

      return lines.join("\n");
    }
    case "filediff": {
      if (!args?.trim()) return "  Usage: /filediff <file1> <file2>";

      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) return "  Usage: /filediff <file1> <file2>";

      const { resolve: resolvePath } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      const file1 = resolvePath(cwd, parts[0]);
      const file2 = resolvePath(cwd, parts[1]);

      if (!existsSync(file1)) return `  File not found: ${parts[0]}`;
      if (!existsSync(file2)) return `  File not found: ${parts[1]}`;

      try {
        // Use diff command (returns exit code 1 if files differ, which is normal)
        // Escape single quotes in paths to prevent injection
        const esc = (s: string) => s.replace(/'/g, "'\\''");
        const output = execSync(`diff -u '${esc(file1)}' '${esc(file2)}' 2>&1; true`, { cwd, timeout: 10000 }).toString().trim();

        if (!output) return `  Files are identical: ${parts[0]} = ${parts[1]}`;

        const diffLines = output.split("\n");
        const lines = [`  File Diff: ${parts[0]} vs ${parts[1]}\n`];

        // Show first 50 lines of diff
        const maxLines = 50;
        for (let i = 0; i < Math.min(diffLines.length, maxLines); i++) {
          lines.push(`  ${diffLines[i]}`);
        }
        if (diffLines.length > maxLines) {
          lines.push(`\n  ... ${diffLines.length - maxLines} more lines`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "crons": {
      const { execSync } = await import("node:child_process");
      const lines = [`  Scheduled Tasks\n`];
      let found = false;

      // User crontab
      try {
        const crontab = execSync(`crontab -l 2>/dev/null`, { timeout: 5000 }).toString().trim();
        if (crontab && !crontab.includes("no crontab")) {
          found = true;
          const entries = crontab.split("\n").filter(l => l.trim() && !l.startsWith("#"));
          lines.push(`  \u2500\u2500 Crontab (${entries.length} entries) \u2500\u2500`);
          for (const entry of entries.slice(0, 15)) {
            lines.push(`  ${entry}`);
          }
          if (entries.length > 15) lines.push(`  ... ${entries.length - 15} more`);
          lines.push(``);
        }
      } catch { /* no crontab */ }

      // Systemd user timers
      try {
        const timers = execSync(`systemctl --user list-timers --no-pager 2>/dev/null`, { timeout: 5000 }).toString().trim();
        if (timers && timers.includes("NEXT")) {
          found = true;
          const timerLines = timers.split("\n");
          lines.push(`  \u2500\u2500 Systemd User Timers \u2500\u2500`);
          for (const tl of timerLines.slice(0, 10)) {
            lines.push(`  ${tl}`);
          }
          lines.push(``);
        }
      } catch { /* no systemd */ }

      // System timers (relevant ones)
      try {
        const sysTimers = execSync(`systemctl list-timers --no-pager 2>/dev/null | head -10`, { timeout: 5000 }).toString().trim();
        if (sysTimers && sysTimers.includes("NEXT")) {
          found = true;
          const sysLines = sysTimers.split("\n");
          lines.push(`  \u2500\u2500 System Timers \u2500\u2500`);
          for (const sl of sysLines) {
            lines.push(`  ${sl}`);
          }
          lines.push(``);
        }
      } catch { /* ignore */ }

      if (!found) {
        lines.push(`  No crontabs or timers found.`);
      }

      return lines.join("\n");
    }
    case "ports": {
      const { execSync } = await import("node:child_process");
      const lines = [`  Listening Ports\n`];

      try {
        const output = execSync(`ss -tlnp 2>/dev/null`, { timeout: 5000 }).toString().trim();
        const rows = output.split("\n").slice(1); // skip header

        if (rows.length === 0) {
          return "  No listening TCP ports found.";
        }

        // Common dev ports
        const knownPorts: Record<number, string> = {
          3000: "React/Next.js", 3001: "Dev server", 4000: "GraphQL",
          4200: "Angular", 5000: "Flask/Vite", 5173: "Vite",
          5432: "PostgreSQL", 6379: "Redis", 8000: "Django/FastAPI",
          8080: "HTTP alt", 8443: "HTTPS alt", 9090: "Prometheus",
          10091: "KCode LLM", 27017: "MongoDB",
        };

        const maxAddrLen = Math.max(...rows.map(r => (r.trim().split(/\s+/)[3] ?? "").length), 10);

        for (const row of rows) {
          const parts = row.trim().split(/\s+/);
          const addr = parts[3] ?? "?";
          const procInfo = parts[5] ?? "";
          const procName = procInfo.replace(/.*users:\(\("(.+?)".*/, "$1") || procInfo;
          const portMatch = addr.match(/:(\d+)$/);
          const port = portMatch ? parseInt(portMatch[1]) : 0;
          const label = knownPorts[port] ? ` (${knownPorts[port]})` : "";
          lines.push(`  ${addr.padEnd(maxAddrLen)}  ${procName}${label}`);
        }

        lines.push(`\n  ${rows.length} port(s) listening`);
      } catch {
        // Fallback to netstat
        try {
          const output = execSync(`netstat -tlnp 2>/dev/null | tail -n +3`, { timeout: 5000 }).toString().trim();
          if (output) {
            lines.push(output);
          } else {
            return "  Cannot detect listening ports (ss/netstat not available).";
          }
        } catch {
          return "  Cannot detect listening ports (ss/netstat not available).";
        }
      }

      return lines.join("\n");
    }
    case "copy": {
      if (!args?.trim()) return "  Usage: /copy <text or file path>";

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const { execSync } = await import("node:child_process");

      let text = args.trim();
      let isFile = false;
      const filePath = resolvePath(appConfig.workingDirectory, text);

      const fileStat = existsSync(filePath) ? statSyncFn(filePath) : null;
      if (fileStat?.isFile()) {
        if (fileStat.size > 1024 * 1024) return "  File too large for clipboard (max 1 MB).";
        text = readFileSync(filePath, "utf-8");
        isFile = true;
      }

      // Detect clipboard command
      const clipCmds = [
        { test: "which xclip", cmd: "xclip -selection clipboard" },
        { test: "which xsel", cmd: "xsel --clipboard --input" },
        { test: "which wl-copy", cmd: "wl-copy" },
        { test: "which pbcopy", cmd: "pbcopy" },
      ];

      let clipCmd: string | null = null;
      for (const { test, cmd } of clipCmds) {
        try {
          execSync(`${test} 2>/dev/null`, { timeout: 2000 });
          clipCmd = cmd;
          break;
        } catch { /* not available */ }
      }

      if (!clipCmd) return "  No clipboard tool found (install xclip, xsel, or wl-copy).";

      try {
        execSync(clipCmd, { input: text, timeout: 5000 });
        const preview = text.split("\n")[0].slice(0, 60);
        return `  Copied to clipboard (${text.length} chars)${isFile ? ` from ${args.trim()}` : ""}\n  ${preview}${text.length > 60 ? "..." : ""}`;
      } catch (err: any) {
        return `  Clipboard error: ${err.message}`;
      }
    }
    case "json": {
      if (!args?.trim()) return "  Usage: /json <file path or JSON text>";

      const input = args.trim();
      let text = input;
      let isFile = false;

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const filePath = resolvePath(appConfig.workingDirectory, input);

      if (existsSync(filePath) && statSyncFn(filePath).isFile()) {
        if (statSyncFn(filePath).size > 5 * 1024 * 1024) return "  File too large (max 5 MB).";
        text = readFileSync(filePath, "utf-8");
        isFile = true;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return `  Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Analyze structure
      const countKeys = (obj: unknown, depth = 0): { keys: number; maxDepth: number; arrays: number; objects: number } => {
        const result = { keys: 0, maxDepth: depth, arrays: 0, objects: 0 };
        if (depth > 100) return result;
        if (Array.isArray(obj)) {
          result.arrays++;
          for (const item of obj) {
            const sub = countKeys(item, depth + 1);
            result.keys += sub.keys;
            result.maxDepth = Math.max(result.maxDepth, sub.maxDepth);
            result.arrays += sub.arrays;
            result.objects += sub.objects;
          }
        } else if (obj && typeof obj === "object") {
          result.objects++;
          const entries = Object.entries(obj as Record<string, unknown>);
          result.keys += entries.length;
          for (const [, val] of entries) {
            const sub = countKeys(val, depth + 1);
            result.keys += sub.keys;
            result.maxDepth = Math.max(result.maxDepth, sub.maxDepth);
            result.arrays += sub.arrays;
            result.objects += sub.objects;
          }
        }
        return result;
      };

      const stats = countKeys(parsed);
      const formatted = JSON.stringify(parsed, null, 2);
      const preview = formatted.split("\n").slice(0, 30).join("\n");

      const lines = [
        `  JSON Inspector${isFile ? ` (${input})` : ""}\n`,
        `  Valid:    \u2713`,
        `  Type:     ${Array.isArray(parsed) ? "array" : typeof parsed}`,
        `  Keys:     ${stats.keys}`,
        `  Depth:    ${stats.maxDepth}`,
        `  Objects:  ${stats.objects}`,
        `  Arrays:   ${stats.arrays}`,
        `  Size:     ${text.length.toLocaleString()} chars`,
        ``,
        `  Preview:`,
      ];

      for (const line of preview.split("\n")) {
        lines.push(`  ${line}`);
      }
      if (formatted.split("\n").length > 30) {
        lines.push(`  ... ${formatted.split("\n").length - 30} more lines`);
      }

      return lines.join("\n");
    }
    case "disk": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      try {
        // Get top-level directory sizes
        const output = execSync(`du -h --max-depth=1 2>/dev/null | sort -rh | head -20`, { cwd, timeout: 15000 }).toString().trim();
        if (!output) return "  Cannot determine disk usage.";

        const entries = output.split("\n").map(line => {
          const match = line.match(/^([\d.]+[BKMGT]?)\s+(.+)$/);
          if (!match) return null;
          return { size: match[1], path: match[2].replace(/^\.\//, "") || "." };
        }).filter(Boolean) as Array<{ size: string; path: string }>;

        // Parse sizes for bar chart
        const parseBytes = (s: string): number => {
          const num = parseFloat(s);
          if (s.endsWith("G")) return num * 1024 * 1024 * 1024;
          if (s.endsWith("M")) return num * 1024 * 1024;
          if (s.endsWith("K")) return num * 1024;
          return num;
        };

        const withBytes = entries.map(e => ({ ...e, bytes: parseBytes(e.size) }));
        const maxBytes = withBytes[0]?.bytes ?? 1;
        const barWidth = 20;

        const lines = [`  Disk Usage: ${cwd}\n`];
        for (const e of withBytes.slice(0, 15)) {
          const filled = Math.max(1, Math.round((e.bytes / maxBytes) * barWidth));
          const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
          lines.push(`  ${bar} ${e.size.padStart(7)}  ${e.path}`);
        }

        if (withBytes.length > 15) {
          lines.push(`\n  ... ${withBytes.length - 15} more directories`);
        }

        // Total project size
        const total = withBytes.find(e => e.path === ".");
        if (total) {
          lines.push(`\n  Total project size: ${total.size}`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "http": {
      if (!args?.trim()) return "  Usage: /http [GET|POST|PUT|DELETE] <url> [body]";

      const parts = args.trim().split(/\s+/);
      let method = "GET";
      let url: string;
      let body: string | undefined;

      const httpMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
      if (httpMethods.includes(parts[0]!.toUpperCase())) {
        method = parts[0]!.toUpperCase();
        url = parts[1] ?? "";
        body = parts.slice(2).join(" ") || undefined;
      } else {
        url = parts[0]!;
        body = parts.slice(1).join(" ") || undefined;
      }

      if (!url) return "  Usage: /http [METHOD] <url> [body]";
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;

      try {
        const startTime = performance.now();
        const fetchOpts: RequestInit = { method, signal: AbortSignal.timeout(15000) };
        if (body && method !== "GET" && method !== "HEAD") {
          fetchOpts.body = body;
          fetchOpts.headers = { "Content-Type": "application/json" };
        }

        const resp = await fetch(url, fetchOpts);
        const elapsed = Math.round(performance.now() - startTime);
        const contentType = resp.headers.get("content-type") ?? "";
        // Limit response to 1 MB to avoid OOM
        const reader = resp.body?.getReader();
        let responseText = "";
        if (reader) {
          const decoder = new TextDecoder();
          let totalBytes = 0;
          const maxBytes = 1024 * 1024;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
              responseText += decoder.decode(value, { stream: false });
              reader.cancel();
              responseText = responseText.slice(0, maxBytes) + "\n[truncated at 1 MB]";
              break;
            }
            responseText += decoder.decode(value, { stream: true });
          }
        }

        const lines = [
          `  HTTP ${method} ${url}\n`,
          `  Status:  ${resp.status} ${resp.statusText}`,
          `  Time:    ${elapsed}ms`,
          `  Type:    ${contentType}`,
          `  Size:    ${responseText.length.toLocaleString()} chars`,
        ];

        // Show headers summary
        const headerCount = [...resp.headers].length;
        lines.push(`  Headers: ${headerCount}`);
        lines.push(``);

        // Preview body
        if (contentType.includes("json")) {
          try {
            const json = JSON.parse(responseText);
            const formatted = JSON.stringify(json, null, 2);
            const preview = formatted.split("\n").slice(0, 25);
            lines.push(`  Response (JSON):`);
            for (const l of preview) lines.push(`  ${l}`);
            if (formatted.split("\n").length > 25) lines.push(`  ... ${formatted.split("\n").length - 25} more lines`);
          } catch {
            const preview = responseText.slice(0, 500);
            lines.push(`  Response:`);
            lines.push(`  ${preview}${responseText.length > 500 ? "..." : ""}`);
          }
        } else {
          const preview = responseText.slice(0, 500);
          lines.push(`  Response:`);
          for (const l of preview.split("\n").slice(0, 15)) lines.push(`  ${l}`);
          if (responseText.length > 500) lines.push(`  ... truncated`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  HTTP error: ${err.message}`;
      }
    }
    case "encode": {
      if (!args?.trim()) return "  Usage: /encode base64|url|hex encode|decode <text>";

      const parts = args.trim().split(/\s+/);
      if (parts.length < 3) return "  Usage: /encode base64|url|hex encode|decode <text>";

      const format = parts[0]!.toLowerCase();
      const direction = parts[1]!.toLowerCase();
      const text = parts.slice(2).join(" ");

      if (!["base64", "url", "hex"].includes(format)) {
        return "  Formats: base64, url, hex";
      }
      if (!["encode", "decode"].includes(direction)) {
        return "  Direction: encode or decode";
      }

      try {
        let result: string;

        if (format === "base64") {
          if (direction === "encode") {
            result = Buffer.from(text, "utf-8").toString("base64");
          } else {
            result = Buffer.from(text, "base64").toString("utf-8");
          }
        } else if (format === "url") {
          if (direction === "encode") {
            result = encodeURIComponent(text);
          } else {
            result = decodeURIComponent(text);
          }
        } else {
          // hex
          if (direction === "encode") {
            result = Buffer.from(text, "utf-8").toString("hex");
          } else {
            result = Buffer.from(text, "hex").toString("utf-8");
          }
        }

        return [
          `  ${format.toUpperCase()} ${direction}`,
          ``,
          `  Input:  ${text.length > 80 ? text.slice(0, 80) + "..." : text}`,
          `  Output: ${result.length > 200 ? result.slice(0, 200) + "..." : result}`,
        ].join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "checksum": {
      if (!args?.trim()) return "  Usage: /checksum [md5|sha256|sha512] <file or text>";

      const { createHash } = await import("node:crypto");
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");

      const parts = args.trim().split(/\s+/);
      let algo = "sha256";
      let target: string;

      if (["md5", "sha256", "sha512", "sha1"].includes(parts[0]!.toLowerCase())) {
        algo = parts[0]!.toLowerCase();
        target = parts.slice(1).join(" ");
      } else {
        target = args.trim();
      }

      if (!target) return "  Usage: /checksum [md5|sha256|sha512] <file or text>";

      let data: string | Buffer;
      let isFile = false;
      const filePath = resolvePath(appConfig.workingDirectory, target);

      const fileStat = existsSync(filePath) ? statSyncFn(filePath) : null;
      if (fileStat?.isFile()) {
        if (fileStat.size > 100 * 1024 * 1024) return "  File too large (max 100 MB).";
        data = readFileSync(filePath);
        isFile = true;
      } else {
        data = target;
      }

      const hash = createHash(algo).update(data).digest("hex");

      return [
        `  Checksum (${algo.toUpperCase()})`,
        ``,
        `  ${isFile ? "File" : "Text"}:  ${isFile ? target : (target.length > 60 ? target.slice(0, 60) + "..." : target)}`,
        `  Hash:  ${hash}`,
      ].join("\n");
    }
    case "outline": {
      if (!args?.trim()) return "  Usage: /outline <file path>";

      const { existsSync, readFileSync } = await import("node:fs");
      const { resolve: resolvePath, extname, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());

      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;

      const { statSync: statSyncOutline } = await import("node:fs");
      if (statSyncOutline(filePath).size > 5 * 1024 * 1024) return "  File too large for outline (max 5 MB).";

      const content = readFileSync(filePath, "utf-8");
      const ext = extname(filePath).toLowerCase();
      const relPath = relative(cwd, filePath);
      const fileLines = content.split("\n");
      const symbols: Array<{ line: number; kind: string; name: string }> = [];

      // Language-specific patterns
      if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*export\s+(default\s+)?(async\s+)?function\s+(\w+)/))) symbols.push({ line: i + 1, kind: "fn", name: m[3]! });
          else if ((m = l.match(/^\s*(export\s+)?(async\s+)?function\s+(\w+)/))) symbols.push({ line: i + 1, kind: "fn", name: m[3]! });
          else if ((m = l.match(/^\s*export\s+(default\s+)?class\s+(\w+)/))) symbols.push({ line: i + 1, kind: "class", name: m[2]! });
          else if ((m = l.match(/^\s*class\s+(\w+)/))) symbols.push({ line: i + 1, kind: "class", name: m[1]! });
          else if ((m = l.match(/^\s*export\s+(default\s+)?interface\s+(\w+)/))) symbols.push({ line: i + 1, kind: "iface", name: m[2]! });
          else if ((m = l.match(/^\s*interface\s+(\w+)/))) symbols.push({ line: i + 1, kind: "iface", name: m[1]! });
          else if ((m = l.match(/^\s*export\s+(default\s+)?type\s+(\w+)/))) symbols.push({ line: i + 1, kind: "type", name: m[2]! });
          else if ((m = l.match(/^\s*type\s+(\w+)\s*=/))) symbols.push({ line: i + 1, kind: "type", name: m[1]! });
          else if ((m = l.match(/^\s*export\s+(const|let|var)\s+(\w+)/))) symbols.push({ line: i + 1, kind: "var", name: m[2]! });
          else if ((m = l.match(/^\s*const\s+(\w+)\s*=\s*(async\s+)?\(/))) symbols.push({ line: i + 1, kind: "fn", name: m[1]! });
        }
      } else if ([".py"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^class\s+(\w+)/))) symbols.push({ line: i + 1, kind: "class", name: m[1]! });
          else if ((m = l.match(/^(\s*)def\s+(\w+)/))) symbols.push({ line: i + 1, kind: m[1] ? "method" : "fn", name: m[2]! });
          else if ((m = l.match(/^(\s*)async\s+def\s+(\w+)/))) symbols.push({ line: i + 1, kind: m[1] ? "method" : "fn", name: m[2]! });
        }
      } else if ([".go"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^func\s+\((\w+)\s+\*?(\w+)\)\s+(\w+)/))) symbols.push({ line: i + 1, kind: "method", name: `${m[2]}.${m[3]}` });
          else if ((m = l.match(/^func\s+(\w+)/))) symbols.push({ line: i + 1, kind: "fn", name: m[1]! });
          else if ((m = l.match(/^type\s+(\w+)\s+struct/))) symbols.push({ line: i + 1, kind: "struct", name: m[1]! });
          else if ((m = l.match(/^type\s+(\w+)\s+interface/))) symbols.push({ line: i + 1, kind: "iface", name: m[1]! });
        }
      } else if ([".rs"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*(pub\s+)?fn\s+(\w+)/))) symbols.push({ line: i + 1, kind: "fn", name: m[2]! });
          else if ((m = l.match(/^\s*(pub\s+)?struct\s+(\w+)/))) symbols.push({ line: i + 1, kind: "struct", name: m[2]! });
          else if ((m = l.match(/^\s*(pub\s+)?enum\s+(\w+)/))) symbols.push({ line: i + 1, kind: "enum", name: m[2]! });
          else if ((m = l.match(/^\s*(pub\s+)?trait\s+(\w+)/))) symbols.push({ line: i + 1, kind: "trait", name: m[2]! });
          else if ((m = l.match(/^\s*impl\s+(\w+)/))) symbols.push({ line: i + 1, kind: "impl", name: m[1]! });
        }
      } else if ([".swift"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?class\s+(\w+)/))) symbols.push({ line: i + 1, kind: "class", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?struct\s+(\w+)/))) symbols.push({ line: i + 1, kind: "struct", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?func\s+(\w+)/))) symbols.push({ line: i + 1, kind: "fn", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?enum\s+(\w+)/))) symbols.push({ line: i + 1, kind: "enum", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?protocol\s+(\w+)/))) symbols.push({ line: i + 1, kind: "proto", name: m[2]! });
        }
      } else {
        // Generic: look for common patterns
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*(public|private|protected)?\s*(static\s+)?(void|int|string|boolean|async)?\s*(\w+)\s*\(/))) {
            if (!["if", "for", "while", "switch", "catch", "return", "else"].includes(m[4]!)) {
              symbols.push({ line: i + 1, kind: "fn", name: m[4]! });
            }
          }
        }
      }

      if (symbols.length === 0) return `  No symbols found in ${relPath}`;

      const kindIcons: Record<string, string> = {
        fn: "f", method: "m", class: "C", struct: "S", iface: "I",
        type: "T", var: "v", enum: "E", trait: "R", impl: "M", proto: "P",
      };

      const lines = [`  Outline: ${relPath} (${symbols.length} symbols, ${fileLines.length} lines)\n`];
      for (const sym of symbols) {
        const icon = kindIcons[sym.kind] ?? "?";
        lines.push(`  ${String(sym.line).padStart(5)}  [${icon}] ${sym.name}`);
      }

      return lines.join("\n");
    }
    case "weather": {
      const city = args?.trim() || "";
      const query = city ? encodeURIComponent(city) : "";

      try {
        const urlDetail = `https://wttr.in/${query}?format=%l%n%c+%C+%t+(feels+like+%f)%nHumidity:+%h%nWind:+%w%nPrecip:+%p%nUV:+%u%nMoon:+%m+%M`;
        const respDetail = await fetch(urlDetail, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "curl/8.0" } });
        const detail = (await respDetail.text()).trim();

        const lines = [`  Weather\n`];
        for (const l of detail.split("\n")) {
          lines.push(`  ${l}`);
        }
        return lines.join("\n");
      } catch (err: any) {
        return `  Weather error: ${err.message}`;
      }
    }
    case "lorem": {
      const parts = (args?.trim() || "paragraphs 3").split(/\s+/);
      const unit = parts[0]?.toLowerCase() ?? "paragraphs";
      const count = Math.min(Math.max(parseInt(parts[1] ?? "3") || 3, 1), 50);

      const loremWords = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum".split(" ");

      const genSentence = (): string => {
        const len = 8 + Math.floor(Math.random() * 12);
        const words: string[] = [];
        for (let i = 0; i < len; i++) {
          words.push(loremWords[Math.floor(Math.random() * loremWords.length)]!);
        }
        words[0] = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1);
        return words.join(" ") + ".";
      };

      const genParagraph = (): string => {
        const sentences = 3 + Math.floor(Math.random() * 4);
        const result: string[] = [];
        for (let i = 0; i < sentences; i++) result.push(genSentence());
        return result.join(" ");
      };

      let output: string;

      if (unit.startsWith("w")) {
        // words
        const words: string[] = [];
        for (let i = 0; i < count; i++) {
          words.push(loremWords[Math.floor(Math.random() * loremWords.length)]!);
        }
        words[0] = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1);
        output = words.join(" ") + ".";
      } else if (unit.startsWith("s")) {
        // sentences
        const sentences: string[] = [];
        for (let i = 0; i < count; i++) sentences.push(genSentence());
        output = sentences.join(" ");
      } else {
        // paragraphs
        const paragraphs: string[] = [];
        for (let i = 0; i < count; i++) paragraphs.push(genParagraph());
        output = paragraphs.join("\n\n");
      }

      const wordCount = output.split(/\s+/).length;
      const lines = [
        `  Lorem Ipsum (${count} ${unit.startsWith("w") ? "words" : unit.startsWith("s") ? "sentences" : "paragraphs"}, ${wordCount} words total)\n`,
      ];
      for (const l of output.split("\n")) {
        lines.push(`  ${l}`);
      }
      return lines.join("\n");
    }
    case "uuid": {
      const { randomUUID } = await import("node:crypto");
      const count = Math.min(Math.max(parseInt(args?.trim() || "1") || 1, 1), 100);

      const lines = [`  UUID v4${count > 1 ? ` (${count})` : ""}\n`];
      for (let i = 0; i < count; i++) {
        lines.push(`  ${randomUUID()}`);
      }
      return lines.join("\n");
    }
    case "color": {
      if (!args?.trim()) return "  Usage: /color <#hex | rgb(r,g,b) | hsl(h,s,l)>";

      const input = args.trim();
      let r = 0, g = 0, b = 0;
      let parsed = false;

      // Parse hex
      const hexMatch = input.match(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/);
      if (hexMatch) {
        let hex = hexMatch[1]!;
        if (hex.length === 3) hex = hex[0]! + hex[0]! + hex[1]! + hex[1]! + hex[2]! + hex[2]!;
        if (hex.length >= 6) {
          r = parseInt(hex.slice(0, 2), 16);
          g = parseInt(hex.slice(2, 4), 16);
          b = parseInt(hex.slice(4, 6), 16);
          parsed = true;
        }
      }

      // Parse rgb(r, g, b)
      if (!parsed) {
        const rgbMatch = input.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
        if (rgbMatch) {
          r = Math.min(255, parseInt(rgbMatch[1]!));
          g = Math.min(255, parseInt(rgbMatch[2]!));
          b = Math.min(255, parseInt(rgbMatch[3]!));
          parsed = true;
        }
      }

      // Parse hsl(h, s%, l%)
      if (!parsed) {
        const hslMatch = input.match(/hsl\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?\s*\)/i);
        if (hslMatch) {
          const h = parseInt(hslMatch[1]!) / 360;
          const s = parseInt(hslMatch[2]!) / 100;
          const l = parseInt(hslMatch[3]!) / 100;
          // HSL to RGB conversion
          if (s === 0) {
            r = g = b = Math.round(l * 255);
          } else {
            const hue2rgb = (p: number, q: number, t: number) => {
              if (t < 0) t += 1;
              if (t > 1) t -= 1;
              if (t < 1 / 6) return p + (q - p) * 6 * t;
              if (t < 1 / 2) return q;
              if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
              return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
            g = Math.round(hue2rgb(p, q, h) * 255);
            b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
          }
          parsed = true;
        }
      }

      if (!parsed) return "  Could not parse color. Use #hex, rgb(r,g,b), or hsl(h,s%,l%).";

      // Convert to all formats
      const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      const max = Math.max(r, g, b) / 255;
      const min = Math.min(r, g, b) / 255;
      const l = (max + min) / 2;
      let h = 0, s = 0;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        const rn = r / 255, gn = g / 255, bn = b / 255;
        if (rn === max) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
        else if (gn === max) h = ((bn - rn) / d + 2) / 6;
        else h = ((rn - gn) / d + 4) / 6;
      }

      // ANSI color preview block
      const preview = `\x1b[48;2;${r};${g};${b}m      \x1b[0m`;

      return [
        `  Color\n`,
        `  Preview: ${preview}`,
        `  HEX:     ${hex}`,
        `  RGB:     rgb(${r}, ${g}, ${b})`,
        `  HSL:     hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`,
        `  Decimal: ${(r << 16 | g << 8 | b) >>> 0}`,
      ].join("\n");
    }
    case "timestamp": {
      const input = args?.trim() || "";

      const now = new Date();
      const nowEpoch = Math.floor(now.getTime() / 1000);

      if (!input) {
        return [
          `  Timestamp\n`,
          `  Now (UTC):   ${now.toISOString()}`,
          `  Now (local): ${now.toLocaleString()}`,
          `  Epoch (s):   ${nowEpoch}`,
          `  Epoch (ms):  ${now.getTime()}`,
        ].join("\n");
      }

      // Try epoch (seconds or milliseconds)
      if (/^\d+$/.test(input)) {
        const num = parseInt(input);
        // If > 10 billion, it's likely milliseconds
        const date = num > 1e10 ? new Date(num) : new Date(num * 1000);
        if (isNaN(date.getTime())) return "  Invalid epoch value.";

        return [
          `  Epoch → Date\n`,
          `  Input:       ${input}${num > 1e10 ? " (ms)" : " (s)"}`,
          `  UTC:         ${date.toISOString()}`,
          `  Local:       ${date.toLocaleString()}`,
          `  Relative:    ${formatRelative(date, now)}`,
        ].join("\n");
      }

      // Try date string
      const date = new Date(input);
      if (isNaN(date.getTime())) return `  Cannot parse date: ${input}`;

      return [
        `  Date → Epoch\n`,
        `  Input:       ${input}`,
        `  UTC:         ${date.toISOString()}`,
        `  Epoch (s):   ${Math.floor(date.getTime() / 1000)}`,
        `  Epoch (ms):  ${date.getTime()}`,
        `  Relative:    ${formatRelative(date, now)}`,
      ].join("\n");

      function formatRelative(d: Date, ref: Date): string {
        const diff = ref.getTime() - d.getTime();
        const abs = Math.abs(diff);
        const suffix = diff > 0 ? "ago" : "from now";
        if (abs < 60000) return `${Math.round(abs / 1000)}s ${suffix}`;
        if (abs < 3600000) return `${Math.round(abs / 60000)}m ${suffix}`;
        if (abs < 86400000) return `${Math.round(abs / 3600000)}h ${suffix}`;
        return `${Math.round(abs / 86400000)}d ${suffix}`;
      }
    }
    case "csv": {
      if (!args?.trim()) return "  Usage: /csv <file path>";

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative, extname } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());

      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 10 * 1024 * 1024) return "  File too large (max 10 MB).";

      const content = readFileSync(filePath, "utf-8");
      const relPath = relative(cwd, filePath);
      const ext = extname(filePath).toLowerCase();

      // Detect delimiter
      const delimiter = ext === ".tsv" || content.split("\t").length > content.split(",").length ? "\t" : ",";
      const delimName = delimiter === "\t" ? "TAB" : "COMMA";

      const rows = content.split("\n").filter(l => l.trim());
      if (rows.length === 0) return "  Empty file.";

      // Parse with simple CSV logic (handles quoted fields)
      const parseRow = (line: string): string[] => {
        const fields: string[] = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i]!;
          if (ch === '"') {
            inQuotes = !inQuotes;
          } else if (ch === delimiter && !inQuotes) {
            fields.push(current.trim());
            current = "";
          } else {
            current += ch;
          }
        }
        fields.push(current.trim());
        return fields;
      };

      const headers = parseRow(rows[0]!);
      const dataRows = rows.slice(1).map(parseRow);

      // Column widths for preview
      const colWidths = headers.map((h, i) => {
        const values = [h, ...dataRows.slice(0, 10).map(r => r[i] ?? "")];
        return Math.min(Math.max(...values.map(v => v.length), 3), 25);
      });

      const lines = [
        `  CSV Inspector: ${relPath}\n`,
        `  Delimiter: ${delimName}`,
        `  Columns:   ${headers.length}`,
        `  Rows:      ${dataRows.length}`,
        `  Size:      ${(stat.size / 1024).toFixed(1)} KB`,
        ``,
        `  Columns: ${headers.map((h, i) => `${h} (${i + 1})`).join(", ")}`,
        ``,
      ];

      // Table preview (header + first 10 rows)
      const formatRow = (fields: string[]) =>
        fields.map((f, i) => (f.length > colWidths[i]! ? f.slice(0, colWidths[i]! - 1) + "\u2026" : f.padEnd(colWidths[i]!))).join("  ");

      lines.push(`  ${formatRow(headers)}`);
      lines.push(`  ${colWidths.map(w => "\u2500".repeat(w)).join("  ")}`);
      for (const row of dataRows.slice(0, 10)) {
        lines.push(`  ${formatRow(row)}`);
      }
      if (dataRows.length > 10) {
        lines.push(`\n  ... ${dataRows.length - 10} more rows`);
      }

      return lines.join("\n");
    }
    case "ip": {
      const { execSync } = await import("node:child_process");
      const lines = [`  Network Info\n`];

      // Public IP
      try {
        const resp = await fetch("https://ifconfig.me/ip", { signal: AbortSignal.timeout(5000), headers: { "User-Agent": "curl/8.0" } });
        const publicIp = (await resp.text()).trim();
        lines.push(`  Public IP:  ${publicIp}`);
      } catch {
        lines.push(`  Public IP:  (unavailable)`);
      }

      // Local interfaces
      try {
        const output = execSync(`ip -4 addr show 2>/dev/null | grep -oP '(?<=inet\\s)\\S+'`, { timeout: 3000 }).toString().trim();
        if (output) {
          lines.push(``);
          lines.push(`  Local Interfaces:`);
          for (const line of output.split("\n")) {
            lines.push(`    ${line}`);
          }
        }
      } catch {
        // Fallback: hostname -I
        try {
          const output = execSync(`hostname -I 2>/dev/null`, { timeout: 3000 }).toString().trim();
          if (output) {
            lines.push(`  Local IPs:  ${output}`);
          }
        } catch { /* skip */ }
      }

      // Hostname
      try {
        const hostname = execSync(`hostname 2>/dev/null`, { timeout: 2000 }).toString().trim();
        lines.push(`  Hostname:   ${hostname}`);
      } catch { /* skip */ }

      // Default gateway
      try {
        const gw = execSync(`ip route show default 2>/dev/null | grep -oP '(?<=via\\s)\\S+'`, { timeout: 3000 }).toString().trim();
        if (gw) lines.push(`  Gateway:    ${gw}`);
      } catch { /* skip */ }

      // DNS
      try {
        const dns = execSync(`grep '^nameserver' /etc/resolv.conf 2>/dev/null | head -3`, { timeout: 2000 }).toString().trim();
        if (dns) {
          const servers = dns.split("\n").map(l => l.replace("nameserver ", "").trim());
          lines.push(`  DNS:        ${servers.join(", ")}`);
        }
      } catch { /* skip */ }

      return lines.join("\n");
    }
    case "count": {
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative, extname } = await import("node:path");
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const target = args?.trim() || ".";
      const targetPath = resolvePath(cwd, target);

      if (!existsSync(targetPath)) return `  Not found: ${target}`;

      const stat = statSyncFn(targetPath);

      if (stat.isFile()) {
        if (stat.size > 50 * 1024 * 1024) return "  File too large (max 50 MB).";
        const content = readFileSync(targetPath, "utf-8");
        const lineCount = content.split("\n").length;
        const wordCount = content.split(/\s+/).filter(Boolean).length;
        const charCount = content.length;
        const relPath = relative(cwd, targetPath);

        return [
          `  Count: ${relPath}\n`,
          `  Lines:      ${lineCount.toLocaleString()}`,
          `  Words:      ${wordCount.toLocaleString()}`,
          `  Characters: ${charCount.toLocaleString()}`,
          `  Size:       ${(stat.size / 1024).toFixed(1)} KB`,
        ].join("\n");
      }

      // Directory: count files by extension
      try {
        const output = execSync(
          `find '${targetPath.replace(/'/g, "'\\''")}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null`,
          { cwd, timeout: 10000 }
        ).toString().trim();

        if (!output) return "  No files found.";

        const files = output.split("\n");
        const extCounts: Record<string, { count: number; lines: number }> = {};
        let totalLines = 0;
        let totalFiles = files.length;

        for (const file of files) {
          const ext = extname(file).toLowerCase() || "(no ext)";
          if (!extCounts[ext]) extCounts[ext] = { count: 0, lines: 0 };
          extCounts[ext]!.count++;
        }

        // Batch line count via wc -l (much faster than reading each file)
        try {
          const wcOutput = execSync(
            `find '${targetPath.replace(/'/g, "'\\''")}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -size -1M -exec wc -l {} + 2>/dev/null | tail -1`,
            { cwd, timeout: 15000 }
          ).toString().trim();
          const totalMatch = wcOutput.match(/^\s*(\d+)\s+total$/);
          if (totalMatch) totalLines = parseInt(totalMatch[1]!);
        } catch { /* skip line counting */ }

        const sorted = Object.entries(extCounts).sort((a, b) => b[1].count - a[1].count);
        const relDir = relative(cwd, targetPath) || ".";

        const lines = [
          `  Count: ${relDir}\n`,
          `  Total files: ${totalFiles.toLocaleString()}`,
          `  Total lines: ${totalLines > 0 ? totalLines.toLocaleString() : "(unknown)"}`,
          ``,
        ];

        const maxExtLen = Math.max(...sorted.map(([e]) => e.length), 5);
        lines.push(`  ${"Ext".padEnd(maxExtLen)}  ${"Files".padStart(6)}`);
        lines.push(`  ${"\u2500".repeat(maxExtLen)}  ${"\u2500".repeat(6)}`);

        for (const [ext, data] of sorted.slice(0, 20)) {
          lines.push(`  ${ext.padEnd(maxExtLen)}  ${String(data.count).padStart(6)}`);
        }
        if (sorted.length > 20) lines.push(`\n  ... ${sorted.length - 20} more extensions`);

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "random": {
      const input = args?.trim() || "1-100";

      // Dice notation: NdM (e.g., 2d6, 1d20)
      const diceMatch = input.match(/^(\d+)d(\d+)$/i);
      if (diceMatch) {
        const n = Math.min(parseInt(diceMatch[1]!), 100);
        const sides = Math.min(parseInt(diceMatch[2]!), 1000);
        if (n < 1 || sides < 1) return "  Invalid dice: use NdM (e.g., 2d6).";
        const rolls: number[] = [];
        for (let i = 0; i < n; i++) {
          rolls.push(1 + Math.floor(Math.random() * sides));
        }
        const total = rolls.reduce((a, b) => a + b, 0);
        return [
          `  Dice Roll: ${n}d${sides}\n`,
          `  Rolls: ${rolls.join(", ")}`,
          `  Total: ${total}`,
          n > 1 ? `  Avg:   ${(total / n).toFixed(1)}` : "",
        ].filter(Boolean).join("\n");
      }

      // Pick from comma-separated list
      if (input.includes(",")) {
        const items = input.split(",").map(s => s.trim()).filter(Boolean);
        if (items.length < 2) return "  Provide at least 2 comma-separated items.";
        const pick = items[Math.floor(Math.random() * items.length)]!;
        return [
          `  Random Pick\n`,
          `  From: ${items.join(", ")}`,
          `  Pick: ${pick}`,
        ].join("\n");
      }

      // Range: min-max
      const rangeMatch = input.match(/^(-?\d+)\s*[-–]\s*(-?\d+)$/);
      if (rangeMatch) {
        const min = parseInt(rangeMatch[1]!);
        const max = parseInt(rangeMatch[2]!);
        if (min >= max) return "  Min must be less than max.";
        const result = min + Math.floor(Math.random() * (max - min + 1));
        return `  Random: ${result}  (range: ${min}–${max})`;
      }

      // Single number = 1 to N
      const num = parseInt(input);
      if (!isNaN(num) && num > 0) {
        const result = 1 + Math.floor(Math.random() * num);
        return `  Random: ${result}  (range: 1–${num})`;
      }

      return "  Usage: /random [min-max | NdM | item1,item2,...]\n  Examples: /random 1-100, /random 2d6, /random red,blue,green";
    }
    case "serve": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const port = parseInt(args?.trim() || "10080") || 10080;

      if (port < 1024 || port > 65535) return "  Port must be between 1024 and 65535.";

      // Check if port is in use
      try {
        execSync(`ss -tlnp 2>/dev/null | grep -q ':${port} '`, { timeout: 3000 });
        return `  Port ${port} is already in use.`;
      } catch { /* port is free */ }

      // Try python3 http.server, then npx serve
      const cmds = [
        { test: "which python3", cmd: `python3 -m http.server ${port}`, name: "python3" },
        { test: "which npx", cmd: `npx -y serve -l ${port}`, name: "npx serve" },
        { test: "which php", cmd: `php -S 0.0.0.0:${port}`, name: "php" },
      ];

      let serverCmd: string | null = null;
      let serverName = "";
      for (const { test, cmd, name } of cmds) {
        try {
          execSync(`${test} 2>/dev/null`, { timeout: 2000 });
          serverCmd = cmd;
          serverName = name;
          break;
        } catch { /* not available */ }
      }

      if (!serverCmd) return "  No HTTP server found (install python3, npx, or php).";

      try {
        // Start in background
        execSync(`cd '${cwd.replace(/'/g, "'\\''")}' && nohup ${serverCmd} > /dev/null 2>&1 &`, {
          timeout: 3000,
          shell: "/bin/sh",
        });
        return [
          `  Static Server Started\n`,
          `  URL:     http://localhost:${port}`,
          `  Root:    ${cwd}`,
          `  Server:  ${serverName}`,
          `  Stop:    kill the ${serverName} process or use /processes`,
        ].join("\n");
      } catch (err: any) {
        return `  Failed to start server: ${err.message}`;
      }
    }
    case "open": {
      if (!args?.trim()) return "  Usage: /open <file path or URL>";

      const { execSync } = await import("node:child_process");
      const { resolve: resolvePath } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const cwd = appConfig.workingDirectory;
      const target = args.trim();

      // Determine what to open
      let openTarget: string;
      if (/^https?:\/\//.test(target)) {
        openTarget = target;
      } else {
        const filePath = resolvePath(cwd, target);
        if (!existsSync(filePath)) return `  Not found: ${target}`;
        openTarget = filePath;
      }

      // Detect opener
      const openers = ["xdg-open", "open", "wslview"];
      let opener: string | null = null;
      for (const cmd of openers) {
        try {
          execSync(`which ${cmd} 2>/dev/null`, { timeout: 2000 });
          opener = cmd;
          break;
        } catch { /* not available */ }
      }

      if (!opener) return "  No system opener found (xdg-open, open, wslview).";

      try {
        execSync(`${opener} '${openTarget.replace(/'/g, "'\\''")}' 2>/dev/null &`, {
          timeout: 5000,
          shell: "/bin/sh",
        });
        return `  Opened: ${target}  (via ${opener})`;
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "qr": {
      if (!args?.trim()) return "  Usage: /qr <text or URL>";

      const text = args.trim();
      if (text.length > 2048) return "  Text too long for QR (max 2048 chars).";

      // QR encoding using a minimal implementation
      // We'll use the qrencode CLI if available, else generate with Unicode blocks
      const { execSync } = await import("node:child_process");

      try {
        // Try qrencode
        const output = execSync(
          `echo -n '${text.replace(/'/g, "'\\''")}' | qrencode -t UTF8 2>/dev/null`,
          { timeout: 5000 }
        ).toString();

        const lines = [`  QR Code\n`];
        for (const line of output.split("\n")) {
          lines.push(`  ${line}`);
        }
        lines.push(`\n  Data: ${text.length > 60 ? text.slice(0, 60) + "..." : text}`);
        return lines.join("\n");
      } catch {
        // Fallback: try python3
        try {
          const output = execSync(
            `python3 -c "import qrcode,sys; q=qrcode.QRCode(border=1); q.add_data(sys.stdin.read()); q.make(); q.print_ascii()" 2>/dev/null`,
            { timeout: 5000, input: text }
          ).toString();

          const lines = [`  QR Code\n`];
          for (const line of output.split("\n")) {
            lines.push(`  ${line}`);
          }
          lines.push(`\n  Data: ${text.length > 60 ? text.slice(0, 60) + "..." : text}`);
          return lines.join("\n");
        } catch {
          return "  QR generation requires 'qrencode' or python3 'qrcode' module.\n  Install: sudo dnf install qrencode  OR  pip install qrcode";
        }
      }
    }
    case "calc": {
      if (!args?.trim()) return "  Usage: /calc <expression>\n  Examples: /calc 2+3*4, /calc sqrt(144), /calc 2**10";

      const expr = args.trim();

      // Strict whitelist: only digits, operators, parens, dots, commas, spaces,
      // and known math function/constant names
      const allowedNames = new Set([
        "abs", "ceil", "floor", "round", "sqrt", "cbrt", "pow",
        "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
        "log", "log2", "log10", "exp", "min", "max", "random",
        "PI", "E", "TAU",
      ]);

      // Tokenize: split into numbers, identifiers, and operators
      const tokens = expr.match(/[a-zA-Z_]\w*|\d+\.?\d*(?:[eE][+-]?\d+)?|[+\-*/().,%^*\s]+/g);
      if (!tokens || tokens.join("").replace(/\s/g, "") !== expr.replace(/\s/g, "")) {
        return "  Invalid expression. Only numbers, operators, and math functions allowed.";
      }

      // Validate every identifier token against the whitelist
      for (const tok of tokens) {
        if (/^[a-zA-Z_]/.test(tok) && !allowedNames.has(tok)) {
          return `  Unknown identifier: ${tok}. Allowed: ${[...allowedNames].join(", ")}`;
        }
      }

      // No brackets, backticks, quotes, assignment, or dangerous constructs allowed
      if (/[\[\]`'"\\{}=;]/.test(expr)) {
        return "  Invalid characters in expression.";
      }
      // Block property access, template literals, and function constructor escape
      if (/\.\s*\w|=>|import|require|eval|Function|this|global|process|constructor|prototype|__proto__/.test(expr)) {
        return "  Invalid expression. Only numbers, operators, and math functions allowed.";
      }
      // Limit expression length to prevent abuse
      if (expr.length > 500) {
        return "  Expression too long (max 500 characters).";
      }

      try {
        const mathFns: Record<string, unknown> = {
          abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round,
          sqrt: Math.sqrt, cbrt: Math.cbrt, pow: Math.pow,
          sin: Math.sin, cos: Math.cos, tan: Math.tan,
          asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
          log: Math.log, log2: Math.log2, log10: Math.log10,
          exp: Math.exp, min: Math.min, max: Math.max,
          PI: Math.PI, E: Math.E, TAU: Math.PI * 2, random: Math.random,
        };
        const keys = Object.keys(mathFns);
        const values = Object.values(mathFns);
        const fn = new Function(...keys, `"use strict"; return (${expr});`);
        const result = fn(...values);

        if (typeof result !== "number" && typeof result !== "bigint") {
          return `  Result: ${String(result)}`;
        }

        const lines = [`  Calc\n`];
        lines.push(`  Expression: ${expr}`);
        lines.push(`  Result:     ${result}`);

        // Show extra representations for integers
        if (typeof result === "number" && Number.isInteger(result) && result >= 0 && result <= 0xFFFFFFFF) {
          lines.push(`  Hex:        0x${result.toString(16).toUpperCase()}`);
          lines.push(`  Binary:     0b${result.toString(2)}`);
          lines.push(`  Octal:      0o${result.toString(8)}`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "stopwatch": {
      const input = args?.trim() || "0";

      // Parse duration
      const durationMatch = input.match(/^(\d+)\s*(s|sec|m|min|h|hr|hour)?$/i);
      if (!durationMatch) return "  Usage: /stopwatch <duration>\n  Examples: /stopwatch 30s, /stopwatch 5m, /stopwatch 1h";

      let seconds = parseInt(durationMatch[1]!);
      const unit = (durationMatch[2] ?? "s").toLowerCase();
      if (unit.startsWith("m")) seconds *= 60;
      else if (unit.startsWith("h")) seconds *= 3600;

      if (seconds <= 0) return "  Duration must be positive.";
      if (seconds > 86400) return "  Max duration: 24 hours.";

      const endTime = Date.now() + seconds * 1000;
      const formatTime = (ms: number) => {
        const totalSec = Math.ceil(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
        if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
        return `${s}s`;
      };

      const totalStr = formatTime(seconds * 1000);

      // We can't block the event loop, so report start time and end time
      const endDate = new Date(endTime);
      return [
        `  Timer Started\n`,
        `  Duration:  ${totalStr}`,
        `  Started:   ${new Date().toLocaleTimeString()}`,
        `  Ends at:   ${endDate.toLocaleTimeString()}`,
        `  Epoch end: ${Math.floor(endTime / 1000)}`,
        `\n  Tip: Use /timestamp ${Math.floor(endTime / 1000)} to check remaining time`,
      ].join("\n");
    }
    case "password": {
      const { randomBytes } = await import("node:crypto");
      const parts = (args?.trim() || "").split(/\s+/).filter(Boolean);

      let length = 20;
      let useSymbols = true;
      let count = 1;

      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === "--no-symbols" || parts[i] === "-n") useSymbols = false;
        else if ((parts[i] === "--count" || parts[i] === "-c") && parts[i + 1]) { count = parseInt(parts[++i]!) || 1; }
        else if (/^\d+$/.test(parts[i]!)) length = parseInt(parts[i]!);
      }

      length = Math.min(Math.max(length, 8), 128);
      count = Math.min(Math.max(count, 1), 20);

      const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const lower = "abcdefghijklmnopqrstuvwxyz";
      const digits = "0123456789";
      const symbols = "!@#$%^&*()-_=+[]{}|;:,.<>?";
      const charset = upper + lower + digits + (useSymbols ? symbols : "");

      const generate = (): string => {
        const chars: string[] = [];
        const maxValid = 256 - (256 % charset.length); // rejection sampling threshold
        let i = 0;
        while (chars.length < length) {
          const bytes = randomBytes(Math.max(length - chars.length, 32));
          for (let j = 0; j < bytes.length && chars.length < length; j++) {
            if (bytes[j]! < maxValid) {
              chars.push(charset[bytes[j]! % charset.length]!);
            }
          }
        }
        return chars.join("");
      };

      const lines = [`  Password Generator\n`];
      lines.push(`  Length:  ${length}`);
      lines.push(`  Symbols: ${useSymbols ? "yes" : "no"}`);
      lines.push(`  Charset: ${charset.length} chars`);
      lines.push(``);

      for (let i = 0; i < count; i++) {
        const pw = generate();
        // Estimate entropy
        const entropy = Math.round(Math.log2(charset.length) * length);
        lines.push(`  ${count > 1 ? `${i + 1}. ` : ""}${pw}  (${entropy}-bit)`);
      }

      return lines.join("\n");
    }
    case "sort_lines": {
      if (!args?.trim()) return "  Usage: /sort-lines <file> [--reverse] [--numeric] [--unique]";

      const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;

      const parts = args.trim().split(/\s+/);
      const flags = new Set(parts.filter(p => p.startsWith("--")));
      const filePart = parts.find(p => !p.startsWith("--"));
      if (!filePart) return "  Usage: /sort-lines <file> [--reverse] [--numeric] [--unique]";

      const filePath = resolvePath(cwd, filePart);
      if (!existsSync(filePath)) return `  File not found: ${filePart}`;

      const { statSync: statSyncFn } = await import("node:fs");
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 10 * 1024 * 1024) return "  File too large (max 10 MB).";

      const content = readFileSync(filePath, "utf-8");
      let lines = content.split("\n");

      // Remove trailing empty line if present
      if (lines[lines.length - 1] === "") lines.pop();

      const originalCount = lines.length;

      // Sort
      if (flags.has("--numeric")) {
        lines.sort((a, b) => {
          const na = parseFloat(a) || 0;
          const nb = parseFloat(b) || 0;
          return na - nb;
        });
      } else {
        lines.sort((a, b) => a.localeCompare(b));
      }

      if (flags.has("--reverse")) lines.reverse();
      if (flags.has("--unique")) lines = [...new Set(lines)];

      const relPath = relative(cwd, filePath);
      const removed = originalCount - lines.length;

      writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

      return [
        `  Sorted: ${relPath}`,
        ``,
        `  Lines:   ${originalCount}${removed > 0 ? ` → ${lines.length} (${removed} duplicates removed)` : ""}`,
        `  Order:   ${flags.has("--numeric") ? "numeric" : "alphabetic"}${flags.has("--reverse") ? " (reversed)" : ""}`,
        `  Unique:  ${flags.has("--unique") ? "yes" : "no"}`,
      ].join("\n");
    }
    case "montecarlo": {
      const input = args?.trim() || "pi";
      const parts = input.split(/\s+/);
      const mode = parts[0]!.toLowerCase();

      if (mode === "pi") {
        const iterations = Math.min(parseInt(parts[1] ?? "1000000") || 1000000, 5000000);
        let inside = 0;

        const startTime = performance.now();
        for (let i = 0; i < iterations; i++) {
          const x = Math.random();
          const y = Math.random();
          if (x * x + y * y <= 1) inside++;
        }
        const elapsed = Math.round(performance.now() - startTime);

        const estimate = (4 * inside) / iterations;
        const error = Math.abs(estimate - Math.PI);

        return [
          `  Monte Carlo: Estimate Pi\n`,
          `  Iterations: ${iterations.toLocaleString()}`,
          `  Estimate:   ${estimate.toFixed(8)}`,
          `  Actual Pi:  ${Math.PI.toFixed(8)}`,
          `  Error:      ${error.toFixed(8)} (${(error / Math.PI * 100).toFixed(4)}%)`,
          `  Time:       ${elapsed}ms`,
        ].join("\n");
      }

      if (mode === "coin") {
        const flips = Math.min(parseInt(parts[1] ?? "10000") || 10000, 5000000);
        let heads = 0;

        const startTime = performance.now();
        for (let i = 0; i < flips; i++) {
          if (Math.random() < 0.5) heads++;
        }
        const elapsed = Math.round(performance.now() - startTime);
        const tails = flips - heads;

        return [
          `  Monte Carlo: Coin Flips\n`,
          `  Flips:  ${flips.toLocaleString()}`,
          `  Heads:  ${heads.toLocaleString()} (${(heads / flips * 100).toFixed(2)}%)`,
          `  Tails:  ${tails.toLocaleString()} (${(tails / flips * 100).toFixed(2)}%)`,
          `  Ratio:  ${(heads / tails).toFixed(4)}`,
          `  Time:   ${elapsed}ms`,
        ].join("\n");
      }

      if (mode === "dice") {
        const diceMatch = parts[1]?.match(/^(\d+)d(\d+)$/i);
        if (!diceMatch) return "  Usage: /montecarlo dice NdM [iterations]\n  Example: /montecarlo dice 2d6 100000";

        const n = Math.min(parseInt(diceMatch[1]!), 20);
        const sides = Math.min(parseInt(diceMatch[2]!), 100);
        const iterations = Math.min(parseInt(parts[2] ?? "100000") || 100000, 5000000);

        if (n < 1 || sides < 1) return "  Invalid dice notation.";

        const freq: Record<number, number> = {};
        const minVal = n;
        const maxVal = n * sides;

        const startTime = performance.now();
        for (let i = 0; i < iterations; i++) {
          let sum = 0;
          for (let d = 0; d < n; d++) {
            sum += 1 + Math.floor(Math.random() * sides);
          }
          freq[sum] = (freq[sum] ?? 0) + 1;
        }
        const elapsed = Math.round(performance.now() - startTime);

        // Build distribution
        const sorted = Object.entries(freq).map(([k, v]) => [parseInt(k), v] as [number, number]).sort((a, b) => a[0] - b[0]);
        const maxFreq = Math.max(...sorted.map(([, v]) => v));
        const barWidth = 25;

        const lines = [
          `  Monte Carlo: ${n}d${sides} Distribution\n`,
          `  Iterations: ${iterations.toLocaleString()}`,
          `  Range:      ${minVal}–${maxVal}`,
          `  Time:       ${elapsed}ms`,
          ``,
        ];

        // Show top values or full distribution if small enough
        const display = sorted.length <= 25 ? sorted : sorted.slice(0, 20);
        for (const [val, count] of display) {
          const pct = (count / iterations * 100).toFixed(1);
          const filled = Math.max(1, Math.round((count / maxFreq) * barWidth));
          const bar = "\u2588".repeat(filled);
          lines.push(`  ${String(val).padStart(4)}  ${bar} ${pct}%`);
        }
        if (sorted.length > 25) lines.push(`\n  ... ${sorted.length - 20} more values`);

        return lines.join("\n");
      }

      return "  Usage: /montecarlo pi [N] | coin [N] | dice NdM [N]\n  Examples: /montecarlo pi 1000000, /montecarlo coin 50000, /montecarlo dice 2d6 100000";
    }
    case "ascii": {
      if (!args?.trim()) return "  Usage: /ascii <text>";

      const text = args.trim().slice(0, 20); // limit length
      const { execSync } = await import("node:child_process");

      // Try figlet first, then toilet, then built-in
      const cmds = ["figlet", "toilet -f mono12"];
      for (const cmd of cmds) {
        try {
          const bin = cmd.split(" ")[0]!;
          execSync(`which ${bin} 2>/dev/null`, { timeout: 2000 });
          const output = execSync(`${cmd} '${text.replace(/'/g, "'\\''")}' 2>/dev/null`, { timeout: 5000 }).toString();
          const lines = [`  ASCII Art\n`];
          for (const line of output.split("\n")) {
            lines.push(`  ${line}`);
          }
          return lines.join("\n");
        } catch { /* not available */ }
      }

      // Built-in simple block letters
      const font: Record<string, string[]> = {
        A: ["  ##  ", " #  # ", " #### ", " #  # ", " #  # "],
        B: [" ### ", " #  #", " ### ", " #  #", " ### "],
        C: ["  ###", " #   ", " #   ", " #   ", "  ###"],
        D: [" ### ", " #  #", " #  #", " #  #", " ### "],
        E: [" ####", " #   ", " ### ", " #   ", " ####"],
        F: [" ####", " #   ", " ### ", " #   ", " #   "],
        G: ["  ###", " #   ", " # ##", " #  #", "  ## "],
        H: [" #  #", " #  #", " ####", " #  #", " #  #"],
        I: [" ### ", "  #  ", "  #  ", "  #  ", " ### "],
        J: ["  ###", "   # ", "   # ", " # # ", "  #  "],
        K: [" #  #", " # # ", " ##  ", " # # ", " #  #"],
        L: [" #   ", " #   ", " #   ", " #   ", " ####"],
        M: [" #   #", " ## ##", " # # #", " #   #", " #   #"],
        N: [" #  #", " ## #", " # ##", " #  #", " #  #"],
        O: ["  ## ", " #  #", " #  #", " #  #", "  ## "],
        P: [" ### ", " #  #", " ### ", " #   ", " #   "],
        Q: ["  ## ", " #  #", " # ##", " #  #", "  ## #"],
        R: [" ### ", " #  #", " ### ", " # # ", " #  #"],
        S: ["  ###", " #   ", "  ## ", "    #", " ### "],
        T: [" ####", "  #  ", "  #  ", "  #  ", "  #  "],
        U: [" #  #", " #  #", " #  #", " #  #", "  ## "],
        V: [" #  #", " #  #", " #  #", "  ## ", "  #  "],
        W: [" #   #", " #   #", " # # #", " ## ##", " #   #"],
        X: [" #  #", "  ## ", "  #  ", "  ## ", " #  #"],
        Y: [" #  #", "  ## ", "  #  ", "  #  ", "  #  "],
        Z: [" ####", "   # ", "  #  ", " #   ", " ####"],
        " ": ["     ", "     ", "     ", "     ", "     "],
        "0": ["  ## ", " #  #", " #  #", " #  #", "  ## "],
        "1": ["  #  ", " ##  ", "  #  ", "  #  ", " ### "],
        "2": ["  ## ", " #  #", "   # ", "  #  ", " ####"],
        "3": [" ### ", "    #", "  ## ", "    #", " ### "],
        "4": [" #  #", " #  #", " ####", "    #", "    #"],
        "5": [" ####", " #   ", " ### ", "    #", " ### "],
        "6": ["  ## ", " #   ", " ### ", " #  #", "  ## "],
        "7": [" ####", "    #", "   # ", "  #  ", "  #  "],
        "8": ["  ## ", " #  #", "  ## ", " #  #", "  ## "],
        "9": ["  ## ", " #  #", "  ###", "    #", "  ## "],
      };

      const upper = text.toUpperCase();
      const artLines: string[] = ["  ASCII Art\n"];
      for (let row = 0; row < 5; row++) {
        let line = "  ";
        for (const ch of upper) {
          const glyph = font[ch];
          line += glyph ? glyph[row]! : "     ";
          line += " ";
        }
        artLines.push(line);
      }
      return artLines.join("\n");
    }
    case "crontab": {
      if (!args?.trim()) return "  Usage: /crontab <cron expression>\n  Example: /crontab */5 * * * *";

      const parts = args.trim().split(/\s+/);
      if (parts.length < 5) return "  Invalid cron: need 5 fields (minute hour day month weekday)";

      const [minF, hourF, dayF, monthF, dowF] = parts.slice(0, 5);
      const fieldNames = ["Minute", "Hour", "Day", "Month", "Weekday"];
      const fieldRanges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
      const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const fields = [minF!, hourF!, dayF!, monthF!, dowF!];

      // Parse a single cron field into matching values
      const parseField = (field: string, min: number, max: number): number[] => {
        const values = new Set<number>();
        for (const part of field.split(",")) {
          const stepMatch = part.match(/^(.+)\/(\d+)$/);
          const step = stepMatch ? parseInt(stepMatch[2]!) : 1;
          const range = stepMatch ? stepMatch[1]! : part;

          if (range === "*") {
            for (let i = min; i <= max; i += step) values.add(i);
          } else if (range.includes("-")) {
            const [a, b] = range.split("-").map(Number);
            for (let i = a!; i <= b!; i += step) values.add(i);
          } else {
            values.add(parseInt(range));
          }
        }
        return [...values].filter(v => v >= min && v <= max).sort((a, b) => a - b);
      };

      const parsed = fields.map((f, i) => parseField(f, fieldRanges[i]![0]!, fieldRanges[i]![1]!));

      const lines = [
        `  Cron Expression: ${fields.join(" ")}\n`,
      ];

      // Describe each field
      for (let i = 0; i < 5; i++) {
        const vals = parsed[i]!;
        let desc: string;
        if (fields[i] === "*") desc = "every";
        else if (i === 4) desc = vals.map(v => dowNames[v]!).join(", ");
        else if (i === 3) desc = vals.map(v => monthNames[v]!).join(", ");
        else desc = vals.join(", ");
        lines.push(`  ${fieldNames[i]!.padEnd(8)} ${fields[i]!.padEnd(10)} → ${desc}`);
      }

      // Calculate next 5 runs
      lines.push(`\n  Next 5 runs:`);
      const now = new Date();
      let cursor = new Date(now);
      cursor.setSeconds(0, 0);
      cursor.setMinutes(cursor.getMinutes() + 1);
      let found = 0;

      for (let attempt = 0; attempt < 100000 && found < 5; attempt++) { // max ~69 days of minutes
        const m = cursor.getMinutes();
        const h = cursor.getHours();
        const d = cursor.getDate();
        const mo = cursor.getMonth() + 1;
        const dow = cursor.getDay();

        if (parsed[0]!.includes(m) && parsed[1]!.includes(h) && parsed[2]!.includes(d) && parsed[3]!.includes(mo) && parsed[4]!.includes(dow)) {
          lines.push(`    ${cursor.toLocaleString()}`);
          found++;
        }
        cursor.setMinutes(cursor.getMinutes() + 1);
      }

      if (found === 0) lines.push(`    (no matches in next 69 days)`);

      return lines.join("\n");
    }
    case "diff_lines": {
      if (!args?.trim() || !args.includes("|")) return "  Usage: /diff-lines <string1> | <string2>";

      const pipeIdx = args.indexOf("|");
      const left = args.slice(0, pipeIdx).trim();
      const right = args.slice(pipeIdx + 1).trim();

      if (!left && !right) return "  Both strings are empty.";
      if (left === right) return "  Strings are identical.";

      // Character-level diff
      const maxLen = Math.max(left.length, right.length);
      let diffChars = 0;
      let diffMap = "";

      for (let i = 0; i < maxLen; i++) {
        const lc = left[i] ?? "";
        const rc = right[i] ?? "";
        if (lc === rc) {
          diffMap += " ";
        } else {
          diffMap += "^";
          diffChars++;
        }
      }

      const similarity = maxLen > 0 ? ((1 - diffChars / maxLen) * 100).toFixed(1) : "100.0";

      // Truncate for display
      const displayLen = 80;
      const l = left.length > displayLen ? left.slice(0, displayLen) + "..." : left;
      const r = right.length > displayLen ? right.slice(0, displayLen) + "..." : right;
      const d = diffMap.length > displayLen ? diffMap.slice(0, displayLen) + "..." : diffMap;

      return [
        `  Line Diff\n`,
        `  A: ${l}`,
        `  B: ${r}`,
        `     ${d}`,
        ``,
        `  Length A:    ${left.length}`,
        `  Length B:    ${right.length}`,
        `  Differences: ${diffChars} chars`,
        `  Similarity:  ${similarity}%`,
      ].join("\n");
    }
    case "progress": {
      if (!args?.trim()) return "  Usage: /progress <value> [max] [label]\n  Examples: /progress 75, /progress 3 10 Tasks, /progress 50,80,30";

      const input = args.trim();

      // Multiple bars: comma-separated values
      if (input.includes(",") && !input.includes(" ")) {
        const values = input.split(",").map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
        const max = Math.max(...values, 100);
        const barWidth = 30;

        const lines = [`  Progress Bars\n`];
        for (let i = 0; i < values.length; i++) {
          const val = values[i]!;
          const pct = Math.min(val / max * 100, 100);
          const filled = Math.round(pct / 100 * barWidth);
          const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
          lines.push(`  ${String(i + 1).padStart(3)}  ${bar}  ${val}/${max} (${pct.toFixed(0)}%)`);
        }
        return lines.join("\n");
      }

      const parts = input.split(/\s+/);
      const value = parseFloat(parts[0]!);
      if (isNaN(value)) return "  Value must be a number.";

      const max = parts[1] ? parseFloat(parts[1]) : 100;
      if (!max || max <= 0) return "  Max must be greater than 0.";
      const label = parts.slice(2).join(" ") || "";
      const pct = Math.min(value / max * 100, 100);
      const barWidth = 30;
      const filled = Math.round(pct / 100 * barWidth);
      const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);

      return [
        `  Progress${label ? `: ${label}` : ""}\n`,
        `  ${bar}  ${value}/${max} (${pct.toFixed(1)}%)`,
        ``,
        `  ${"0".padEnd(barWidth / 2)}${"50%".padEnd(barWidth / 2)}100%`,
      ].join("\n");
    }
    case "jwt": {
      if (!args?.trim()) return "  Usage: /jwt <token>";

      const token = args.trim();
      if (token.length > 100000) return "  Token too large (max 100 KB).";
      const parts = token.split(".");

      if (parts.length !== 3) return "  Invalid JWT: expected 3 parts (header.payload.signature).";

      const decodeBase64Url = (str: string): string => {
        // Base64url to base64
        let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
        while (base64.length % 4) base64 += "=";
        return Buffer.from(base64, "base64").toString("utf-8");
      };

      try {
        const header = JSON.parse(decodeBase64Url(parts[0]!));
        const payload = JSON.parse(decodeBase64Url(parts[1]!));
        const sig = parts[2]!;

        const lines = [
          `  JWT Decode\n`,
          `  Header:`,
        ];
        for (const line of JSON.stringify(header, null, 2).split("\n")) {
          lines.push(`    ${line}`);
        }

        lines.push(`\n  Payload:`);
        for (const line of JSON.stringify(payload, null, 2).split("\n")) {
          lines.push(`    ${line}`);
        }

        // Decode common fields
        lines.push(`\n  Details:`);
        if (header.alg) lines.push(`    Algorithm: ${header.alg}`);
        if (header.typ) lines.push(`    Type:      ${header.typ}`);
        if (payload.sub) lines.push(`    Subject:   ${payload.sub}`);
        if (payload.iss) lines.push(`    Issuer:    ${payload.iss}`);
        if (payload.aud) lines.push(`    Audience:  ${Array.isArray(payload.aud) ? payload.aud.join(", ") : payload.aud}`);

        if (payload.iat) {
          const iat = new Date(payload.iat * 1000);
          lines.push(`    Issued:    ${iat.toISOString()}`);
        }
        if (payload.exp) {
          const exp = new Date(payload.exp * 1000);
          const now = new Date();
          const expired = exp < now;
          lines.push(`    Expires:   ${exp.toISOString()} ${expired ? "(EXPIRED)" : "(valid)"}`);
        }
        if (payload.nbf) {
          lines.push(`    Not Before: ${new Date(payload.nbf * 1000).toISOString()}`);
        }

        lines.push(`\n  Signature: ${sig.slice(0, 20)}...${sig.length > 20 ? ` (${sig.length} chars)` : ""}`);
        lines.push(`  \u26a0 Signature NOT verified (decode only)`);

        return lines.join("\n");
      } catch (err: any) {
        return `  Failed to decode JWT: ${err.message}`;
      }
    }
    case "dotenv": {
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args?.trim() || ".env");

      if (!existsSync(filePath)) return `  File not found: ${relative(cwd, filePath)}`;
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 1024 * 1024) return "  File too large (max 1 MB).";

      const content = readFileSync(filePath, "utf-8");
      const relPath = relative(cwd, filePath);
      const rawLines = content.split("\n");

      const keys: string[] = [];
      const duplicates: string[] = [];
      const empty: string[] = [];
      const comments = rawLines.filter(l => l.trim().startsWith("#")).length;
      const seen = new Set<string>();

      for (const line of rawLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();

        keys.push(key);
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
        if (!val || val === '""' || val === "''") empty.push(key);
      }

      const lines = [
        `  Dotenv Inspector: ${relPath}\n`,
        `  Variables:   ${keys.length}`,
        `  Unique:      ${seen.size}`,
        `  Comments:    ${comments}`,
        `  Empty:       ${empty.length}`,
        `  Duplicates:  ${duplicates.length}`,
        ``,
        `  Keys:`,
      ];

      for (const key of [...seen].sort()) {
        const flags: string[] = [];
        if (duplicates.includes(key)) flags.push("DUP");
        if (empty.includes(key)) flags.push("EMPTY");
        lines.push(`    ${key}${flags.length ? `  [${flags.join(", ")}]` : ""}`);
      }

      if (duplicates.length > 0) {
        lines.push(`\n  \u26a0 Duplicate keys: ${[...new Set(duplicates)].join(", ")}`);
      }
      if (empty.length > 0) {
        lines.push(`  \u26a0 Empty values: ${empty.join(", ")}`);
      }

      return lines.join("\n");
    }
    case "table_fmt": {
      if (!args?.trim()) return "  Usage: /table-fmt header1,header2 | row1col1,row1col2 | row2col1,row2col2\n  Example: /table-fmt Name,Age,City | Alice,30,NYC | Bob,25,LA";

      const sections = args.split("|").map(s => s.trim()).filter(Boolean);
      if (sections.length < 1) return "  Provide at least headers.";

      const rows = sections.map(s => s.split(",").map(c => c.trim()));
      const headers = rows[0]!;
      const dataRows = rows.slice(1);
      const numCols = headers.length;

      // Calculate column widths
      const colWidths = headers.map((h, i) => {
        const values = [h, ...dataRows.map(r => r[i] ?? "")];
        return Math.max(...values.map(v => v.length), 3);
      });

      const formatRow = (cells: string[]) =>
        "| " + cells.map((c, i) => (c ?? "").padEnd(colWidths[i]!)).join(" | ") + " |";

      const separator = "| " + colWidths.map(w => "-".repeat(w)).join(" | ") + " |";

      const lines = [`  Markdown Table\n`];
      lines.push(`  ${formatRow(headers)}`);
      lines.push(`  ${separator}`);
      for (const row of dataRows) {
        lines.push(`  ${formatRow(row)}`);
      }

      return lines.join("\n");
    }
    case "reverse": {
      if (!args?.trim()) return "  Usage: /reverse <text>\n  Options: --words (reverse word order), --lines (reverse line order)";

      const input = args.trim();
      let mode = "chars";
      let text = input;

      if (input.startsWith("--words ")) {
        mode = "words";
        text = input.slice(8);
      } else if (input.startsWith("--lines ")) {
        mode = "lines";
        text = input.slice(8);
      }

      let result: string;
      if (mode === "words") {
        result = text.split(/\s+/).reverse().join(" ");
      } else if (mode === "lines") {
        result = text.split("\n").reverse().join("\n");
      } else {
        result = [...text].reverse().join("");
      }

      return [
        `  Reverse (${mode})\n`,
        `  Input:  ${text.length > 80 ? text.slice(0, 80) + "..." : text}`,
        `  Output: ${result.length > 80 ? result.slice(0, 80) + "..." : result}`,
      ].join("\n");
    }
    case "uptime_check": {
      if (!args?.trim()) return "  Usage: /uptime-check <URL>";

      let url = args.trim();
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;

      const lines = [`  Uptime Check: ${url}\n`];

      try {
        const startTime = performance.now();
        const resp = await fetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(10000),
          redirect: "follow",
        });
        const latency = Math.round(performance.now() - startTime);

        const status = resp.status;
        const statusText = resp.statusText;
        const isUp = status >= 200 && status < 400;

        lines.push(`  Status:    ${isUp ? "\u2714" : "\u2718"} ${status} ${statusText}`);
        lines.push(`  Latency:   ${latency}ms`);

        // TLS info
        if (url.startsWith("https")) {
          lines.push(`  TLS:       \u2714 Secure`);
        } else {
          lines.push(`  TLS:       \u2718 Not encrypted`);
        }

        // Headers info
        const server = resp.headers.get("server");
        const contentType = resp.headers.get("content-type");
        const poweredBy = resp.headers.get("x-powered-by");
        if (server) lines.push(`  Server:    ${server}`);
        if (contentType) lines.push(`  Type:      ${contentType}`);
        if (poweredBy) lines.push(`  Powered:   ${poweredBy}`);

        // Redirects
        if (resp.redirected) {
          lines.push(`  Redirected: \u2714 (final: ${resp.url})`);
        }

        // Response size
        const contentLength = resp.headers.get("content-length");
        if (contentLength) lines.push(`  Size:      ${parseInt(contentLength).toLocaleString()} bytes`);

        lines.push(`\n  Verdict:   ${isUp ? "UP \u2714" : "DOWN \u2718"}`);
      } catch (err: any) {
        lines.push(`  Status:    \u2718 UNREACHABLE`);
        lines.push(`  Error:     ${err.message}`);
        lines.push(`\n  Verdict:   DOWN \u2718`);
      }

      return lines.join("\n");
    }
    case "chmod_calc": {
      if (!args?.trim()) return "  Usage: /chmod-calc <octal or symbolic>\n  Examples: /chmod-calc 755, /chmod-calc rwxr-xr-x";

      const input = args.trim();

      const octalToSymbolic = (octal: string): string => {
        const map: Record<string, string> = {
          "0": "---", "1": "--x", "2": "-w-", "3": "-wx",
          "4": "r--", "5": "r-x", "6": "rw-", "7": "rwx",
        };
        const digits = octal.padStart(3, "0").slice(-3);
        return digits.split("").map(d => map[d] ?? "---").join("");
      };

      const symbolicToOctal = (sym: string): string => {
        const map: Record<string, string> = {
          "---": "0", "--x": "1", "-w-": "2", "-wx": "3",
          "r--": "4", "r-x": "5", "rw-": "6", "rwx": "7",
        };
        const clean = sym.replace(/^[-d]/, "").slice(0, 9);
        if (clean.length !== 9) return "";
        const u = map[clean.slice(0, 3)] ?? "0";
        const g = map[clean.slice(3, 6)] ?? "0";
        const o = map[clean.slice(6, 9)] ?? "0";
        return u + g + o;
      };

      let octal: string;
      let symbolic: string;
      let mode: string;
      let specialBit = "";

      if (/^\d{3,4}$/.test(input)) {
        // Octal input
        const full = input.padStart(4, "0");
        const special = full[0]!;
        octal = full.slice(-3);
        symbolic = octalToSymbolic(octal);
        mode = "Octal → Symbolic";
        if (special === "1") specialBit = "sticky";
        else if (special === "2") specialBit = "setgid";
        else if (special === "4") specialBit = "setuid";
        else if (special === "6") specialBit = "setuid + setgid";
        else if (special === "5") specialBit = "setuid + sticky";
        else if (special === "3") specialBit = "setgid + sticky";
        else if (special === "7") specialBit = "setuid + setgid + sticky";
      } else if (/^[-drwx]{9,10}$/.test(input)) {
        // Symbolic input
        symbolic = input.replace(/^[-d]/, "").slice(0, 9);
        octal = symbolicToOctal(input);
        mode = "Symbolic → Octal";
        if (!octal) return "  Invalid symbolic permissions.";
      } else {
        return "  Invalid format. Use octal (755) or symbolic (rwxr-xr-x).";
      }

      const u = symbolic.slice(0, 3);
      const g = symbolic.slice(3, 6);
      const o = symbolic.slice(6, 9);
      const fullOctal = specialBit ? input.padStart(4, "0") : octal;

      const lines = [
        `  chmod Calculator: ${mode}\n`,
        `  Octal:    ${fullOctal}`,
        `  Symbolic: ${symbolic}`,
        ``,
        `  Owner:  ${u}  (${u.replace(/-/g, " ").trim() || "none"})`,
        `  Group:  ${g}  (${g.replace(/-/g, " ").trim() || "none"})`,
        `  Other:  ${o}  (${o.replace(/-/g, " ").trim() || "none"})`,
      ];

      if (specialBit) {
        lines.push(`  Special: ${specialBit}`);
      }

      lines.push(``, `  Command: chmod ${fullOctal} <file>`);

      return lines.join("\n");
    }
    case "semver": {
      if (!args?.trim()) return "  Usage: /semver <version> [bump major|minor|patch|prerelease]\n  Examples: /semver 1.2.3, /semver 1.2.3 bump minor";

      const input = args.trim();
      const parts = input.split(/\s+/);
      const raw = parts[0]!;
      const action2 = parts[1]?.toLowerCase();
      const bumpType = parts[2]?.toLowerCase();

      // Parse semver
      const match = raw.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?(?:\+([a-zA-Z0-9.]+))?$/);
      if (!match) return `  Invalid semver: ${raw}\n  Expected format: MAJOR.MINOR.PATCH[-prerelease][+build]`;

      let major = parseInt(match[1]!);
      let minor = parseInt(match[2]!);
      let patch = parseInt(match[3]!);
      const pre = match[4] || "";
      const build = match[5] || "";

      const lines = [`  Semver: ${raw}\n`];
      lines.push(`  Major:      ${major}`);
      lines.push(`  Minor:      ${minor}`);
      lines.push(`  Patch:      ${patch}`);
      if (pre) lines.push(`  Prerelease: ${pre}`);
      if (build) lines.push(`  Build:      ${build}`);

      if (action2 === "bump" && bumpType) {
        let bumped: string;
        if (bumpType === "major") {
          bumped = `${major + 1}.0.0`;
        } else if (bumpType === "minor") {
          bumped = `${major}.${minor + 1}.0`;
        } else if (bumpType === "patch") {
          bumped = `${major}.${minor}.${patch + 1}`;
        } else if (bumpType === "prerelease") {
          // Increment last numeric in prerelease, or append .0
          if (pre) {
            const preParts = pre.split(".");
            const last = preParts[preParts.length - 1]!;
            if (/^\d+$/.test(last)) {
              preParts[preParts.length - 1] = String(parseInt(last) + 1);
            } else {
              preParts.push("1");
            }
            bumped = `${major}.${minor}.${patch}-${preParts.join(".")}`;
          } else {
            bumped = `${major}.${minor}.${patch + 1}-0`;
          }
        } else {
          return `  Unknown bump type: ${bumpType}. Use major, minor, patch, or prerelease.`;
        }
        lines.push(`\n  Bump ${bumpType}: ${bumped}`);
      }

      return lines.join("\n");
    }
    case "wordfreq": {
      const input = args?.trim();
      if (!input) return "  Usage: /wordfreq <text or file path> [--top N]";

      // Parse --top N
      let topN = 20;
      let text = input;
      const topMatch = input.match(/--top\s+(\d+)/);
      if (topMatch) {
        topN = Math.min(Math.max(parseInt(topMatch[1]!) || 20, 1), 100);
        text = input.replace(/--top\s+\d+/, "").trim();
      }

      // Try to read as file
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, text);

      if (existsSync(filePath)) {
        const stat = statSyncFn(filePath);
        if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
          text = readFileSync(filePath, "utf-8");
        }
      }

      // Count words
      const words = text.toLowerCase().match(/[a-zA-Z\u00C0-\u024F]+(?:'[a-zA-Z]+)?/g);
      if (!words || words.length === 0) return "  No words found.";

      const freq = new Map<string, number>();
      for (const w of words) {
        freq.set(w, (freq.get(w) || 0) + 1);
      }

      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
      const maxCount = sorted[0]![1];
      const barWidth = 20;

      const lines = [`  Word Frequency (top ${Math.min(topN, sorted.length)} of ${freq.size} unique)\n`];
      lines.push(`  Total words: ${words.length}\n`);

      const maxWordLen = Math.max(...sorted.map(([w]) => w.length), 4);
      for (const [word, count] of sorted) {
        const bar = "\u2588".repeat(Math.max(1, Math.round((count / maxCount) * barWidth)));
        lines.push(`  ${word.padEnd(maxWordLen)}  ${String(count).padStart(5)}  ${bar}`);
      }

      return lines.join("\n");
    }
    case "network_ports": {
      const PORTS: Record<number, string> = {
        20: "FTP Data", 21: "FTP Control", 22: "SSH", 23: "Telnet",
        25: "SMTP", 53: "DNS", 67: "DHCP Server", 68: "DHCP Client",
        69: "TFTP", 80: "HTTP", 110: "POP3", 119: "NNTP",
        123: "NTP", 135: "MS RPC", 137: "NetBIOS Name", 138: "NetBIOS Datagram",
        139: "NetBIOS Session", 143: "IMAP", 161: "SNMP", 162: "SNMP Trap",
        179: "BGP", 194: "IRC", 389: "LDAP", 443: "HTTPS",
        445: "SMB", 465: "SMTPS", 514: "Syslog", 515: "LPD/LPR",
        543: "Kerberos Login", 544: "Kerberos Shell", 546: "DHCPv6 Client",
        547: "DHCPv6 Server", 554: "RTSP", 587: "SMTP Submission",
        631: "IPP/CUPS", 636: "LDAPS", 873: "rsync", 993: "IMAPS",
        995: "POP3S", 1080: "SOCKS", 1433: "MS SQL", 1434: "MS SQL Monitor",
        1521: "Oracle DB", 1723: "PPTP", 2049: "NFS", 2181: "ZooKeeper",
        3000: "Dev Server", 3306: "MySQL", 3389: "RDP", 4443: "Pharos",
        5000: "Flask/UPnP", 5432: "PostgreSQL", 5672: "AMQP/RabbitMQ",
        5900: "VNC", 6379: "Redis", 6443: "Kubernetes API",
        8000: "HTTP Alt", 8080: "HTTP Proxy", 8443: "HTTPS Alt",
        8888: "Jupyter", 9090: "Prometheus", 9200: "Elasticsearch",
        9300: "Elasticsearch Transport", 9418: "Git", 11211: "Memcached",
        27017: "MongoDB", 27018: "MongoDB Shard", 27019: "MongoDB Config",
      };

      const input = args?.trim();
      if (!input) {
        // Show all known ports
        const lines = [`  Well-Known Ports\n`];
        const sorted = Object.entries(PORTS).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
        for (const [port, name] of sorted) {
          lines.push(`  ${String(port).padStart(5)}  ${name}`);
        }
        return lines.join("\n");
      }

      // Lookup by port number
      const portNum = parseInt(input);
      if (!isNaN(portNum) && portNum > 0 && portNum <= 65535) {
        const name = PORTS[portNum];
        if (name) {
          return `  Port ${portNum}: ${name}`;
        }
        return `  Port ${portNum}: Unknown (no well-known service)`;
      }

      // Lookup by service name
      const query = input.toLowerCase();
      const matches = Object.entries(PORTS).filter(([, name]) =>
        name.toLowerCase().includes(query)
      );

      if (matches.length === 0) return `  No service matching "${input}" found.`;

      const lines = [`  Services matching "${input}"\n`];
      for (const [port, name] of matches) {
        lines.push(`  ${String(port).padStart(5)}  ${name}`);
      }
      return lines.join("\n");
    }
    case "wrap": {
      if (!args?.trim()) return "  Usage: /wrap [--width N] <text>\n  Default width: 80";

      let width = 80;
      let text = args.trim();

      const widthMatch = text.match(/^--width\s+(\d+)\s+/);
      if (widthMatch) {
        width = Math.min(Math.max(parseInt(widthMatch[1]!) || 80, 10), 200);
        text = text.slice(widthMatch[0].length);
      }

      // Try reading as file
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, text);

      if (existsSync(filePath)) {
        const stat = statSyncFn(filePath);
        if (stat.isFile() && stat.size <= 1024 * 1024) {
          text = readFileSync(filePath, "utf-8");
        }
      }

      // Word wrap
      const paragraphs = text.split(/\n\s*\n/);
      const wrapped = paragraphs.map(para => {
        const words = para.replace(/\n/g, " ").split(/\s+/).filter(Boolean);
        const resultLines: string[] = [];
        let currentLine = "";

        for (const word of words) {
          if (!currentLine) {
            currentLine = word;
          } else if (currentLine.length + 1 + word.length <= width) {
            currentLine += " " + word;
          } else {
            resultLines.push(currentLine);
            currentLine = word;
          }
        }
        if (currentLine) resultLines.push(currentLine);
        return resultLines.join("\n");
      });

      const result = wrapped.join("\n\n");
      const lineCount = result.split("\n").length;

      const lines = [`  Word Wrap (width: ${width})\n`];
      for (const line of result.split("\n").slice(0, 100)) {
        lines.push(`  ${line}`);
      }
      if (lineCount > 100) {
        lines.push(`  ... (${lineCount - 100} more lines)`);
      }
      lines.push(`\n  Lines: ${lineCount}  |  Width: ${width}`);

      return lines.join("\n");
    }
    case "char_info": {
      const input = args?.trim();
      if (!input) return "  Usage: /char-info <character(s)>\n  Examples: /char-info A, /char-info U+1F600, /char-info \u00e9\u00f1";

      const lines = [`  Unicode Character Info\n`];

      // Check if input is U+XXXX format
      const codePointMatch = input.match(/^[Uu]\+([0-9A-Fa-f]{1,6})$/);
      let chars: string[];

      if (codePointMatch) {
        const cp = parseInt(codePointMatch[1]!, 16);
        if (cp > 0x10FFFF) return "  Invalid codepoint (max U+10FFFF).";
        chars = [String.fromCodePoint(cp)];
      } else {
        // Spread to handle surrogate pairs correctly
        chars = [...input].slice(0, 20);
      }

      for (const char of chars) {
        const cp = char.codePointAt(0)!;
        const hex = cp.toString(16).toUpperCase().padStart(4, "0");

        // UTF-8 byte representation
        const encoder = new TextEncoder();
        const utf8Bytes = encoder.encode(char);
        const bytesStr = [...utf8Bytes].map(b => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

        // Category heuristic
        let category = "Other";
        if (cp >= 0x41 && cp <= 0x5A) category = "Uppercase Letter";
        else if (cp >= 0x61 && cp <= 0x7A) category = "Lowercase Letter";
        else if (cp >= 0x30 && cp <= 0x39) category = "Digit";
        else if (cp >= 0x00 && cp <= 0x1F) category = "Control";
        else if (cp >= 0x20 && cp <= 0x2F) category = "Punctuation/Symbol";
        else if (cp >= 0x3A && cp <= 0x40) category = "Punctuation/Symbol";
        else if (cp >= 0x5B && cp <= 0x60) category = "Punctuation/Symbol";
        else if (cp >= 0x7B && cp <= 0x7E) category = "Punctuation/Symbol";
        else if (cp >= 0x80 && cp <= 0xFF) category = "Latin Extended";
        else if (cp >= 0x100 && cp <= 0x24F) category = "Latin Extended";
        else if (cp >= 0x370 && cp <= 0x3FF) category = "Greek";
        else if (cp >= 0x400 && cp <= 0x4FF) category = "Cyrillic";
        else if (cp >= 0x4E00 && cp <= 0x9FFF) category = "CJK Ideograph";
        else if (cp >= 0x3040 && cp <= 0x309F) category = "Hiragana";
        else if (cp >= 0x30A0 && cp <= 0x30FF) category = "Katakana";
        else if (cp >= 0xAC00 && cp <= 0xD7AF) category = "Hangul";
        else if (cp >= 0x0600 && cp <= 0x06FF) category = "Arabic";
        else if (cp >= 0x0590 && cp <= 0x05FF) category = "Hebrew";
        else if (cp >= 0x0900 && cp <= 0x097F) category = "Devanagari";
        else if (cp >= 0x1F600 && cp <= 0x1F64F) category = "Emoji (Faces)";
        else if (cp >= 0x1F300 && cp <= 0x1F5FF) category = "Emoji (Symbols)";
        else if (cp >= 0x1F680 && cp <= 0x1F6FF) category = "Emoji (Transport)";
        else if (cp >= 0x2600 && cp <= 0x26FF) category = "Misc Symbols";
        else if (cp >= 0x2700 && cp <= 0x27BF) category = "Dingbats";
        else if (cp >= 0x2000 && cp <= 0x206F) category = "General Punctuation";
        else if (cp >= 0x2190 && cp <= 0x21FF) category = "Arrows";
        else if (cp >= 0x2200 && cp <= 0x22FF) category = "Math Operators";
        else if (cp >= 0x2500 && cp <= 0x257F) category = "Box Drawing";
        else if (cp >= 0x2580 && cp <= 0x259F) category = "Block Elements";
        else if (cp >= 0xFE00 && cp <= 0xFE0F) category = "Variation Selector";
        else if (cp >= 0xE0000 && cp <= 0xE007F) category = "Tags";

        lines.push(`  '${char}'  U+${hex}`);
        lines.push(`    Decimal:   ${cp}`);
        lines.push(`    UTF-8:     ${bytesStr} (${utf8Bytes.length} byte${utf8Bytes.length > 1 ? "s" : ""})`);
        lines.push(`    Category:  ${category}`);
        lines.push(`    HTML:      &#${cp}; / &#x${hex};`);
        lines.push(``);
      }

      return lines.join("\n");
    }
    case "run_benchmark": {
      const { getModelBaseUrl } = await import("../../core/models");
      const model = appConfig.model;
      const apiBase = await getModelBaseUrl(model, appConfig.apiBase);
      const url = `${apiBase}/v1/chat/completions`;

      const lines = [`  Model Benchmark: ${model}\n`];

      const tests = [
        { name: "Simple Q&A", prompt: "What is 2+2? Reply with just the number." },
        { name: "Code Gen", prompt: "Write a JavaScript function that reverses a string. Reply with just the code, no explanation." },
        { name: "Reasoning", prompt: "If all roses are flowers and some flowers fade quickly, can we conclude that some roses fade quickly? Answer yes or no with one sentence of reasoning." },
      ];

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (appConfig.apiKey) headers["Authorization"] = `Bearer ${appConfig.apiKey}`;

      let totalTokens = 0;
      let totalLatency = 0;

      for (const test of tests) {
        try {
          const start = performance.now();
          const resp = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: test.prompt }],
              max_tokens: 256,
              stream: false,
            }),
            signal: AbortSignal.timeout(30000),
          });

          const latency = Math.round(performance.now() - start);
          totalLatency += latency;

          if (!resp.ok) {
            lines.push(`  ${test.name}: FAILED (HTTP ${resp.status})`);
            continue;
          }

          const data = await resp.json() as any;
          const reply = data.choices?.[0]?.message?.content ?? "(empty)";
          const tokens = data.usage?.total_tokens ?? 0;
          const completionTokens = data.usage?.completion_tokens ?? 0;
          const tokPerSec = latency > 0 ? Math.round((completionTokens / latency) * 1000) : 0;
          totalTokens += tokens;

          lines.push(`  ${test.name}`);
          lines.push(`    Latency:  ${latency}ms`);
          lines.push(`    Tokens:   ${tokens} (${completionTokens} completion)`);
          lines.push(`    Speed:    ${tokPerSec} tok/s`);
          lines.push(`    Reply:    ${reply.slice(0, 80).replace(/\n/g, " ")}${reply.length > 80 ? "..." : ""}`);
          lines.push(``);
        } catch (err: any) {
          lines.push(`  ${test.name}: ERROR — ${err.message}\n`);
        }
      }

      const avgLatency = tests.length > 0 ? Math.round(totalLatency / tests.length) : 0;
      lines.push(`  Summary`);
      lines.push(`    Avg latency: ${avgLatency}ms`);
      lines.push(`    Total tokens: ${totalTokens}`);
      lines.push(`    Endpoint: ${url}`);

      return lines.join("\n");
    }
    case "gpu": {
      const { execSync } = await import("node:child_process");
      const lines = [`  GPU Monitor\n`];

      // NVIDIA GPUs
      try {
        const raw = execSync(
          "nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit,driver_version --format=csv,noheader,nounits",
          { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
        ).toString().trim();

        if (raw) {
          for (const line of raw.split("\n")) {
            const [idx, name, temp, util, memUsed, memTotal, powerDraw, powerLimit, driver] = line.split(",").map(s => s.trim());
            const memUsedMB = parseInt(memUsed!);
            const memTotalMB = parseInt(memTotal!);
            const memPct = memTotalMB > 0 ? Math.round((memUsedMB / memTotalMB) * 100) : 0;
            const barWidth = 20;
            const filledBar = Math.round((memPct / 100) * barWidth);
            const bar = "\u2588".repeat(filledBar) + "\u2591".repeat(barWidth - filledBar);

            lines.push(`  GPU ${idx}: ${name}`);
            lines.push(`    VRAM:   ${memUsed} / ${memTotal} MB (${memPct}%)  [${bar}]`);
            lines.push(`    Temp:   ${temp}\u00b0C`);
            lines.push(`    Util:   ${util}%`);
            lines.push(`    Power:  ${powerDraw}W / ${powerLimit}W`);
            lines.push(`    Driver: ${driver}`);
            lines.push(``);
          }
        }
      } catch {
        lines.push("  No NVIDIA GPU detected (nvidia-smi not available).\n");
      }

      // Check for AMD GPUs
      try {
        const amd = execSync("rocm-smi --showmeminfo vram --csv 2>/dev/null", { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
        if (amd && amd.includes("vram")) {
          lines.push("  AMD GPU detected (rocm-smi available)");
          for (const line of amd.split("\n").slice(1, 5)) {
            lines.push(`    ${line.trim()}`);
          }
        }
      } catch { /* no AMD */ }

      // Check for running inference processes
      try {
        const procs = execSync("nvidia-smi --query-compute-apps=pid,name,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null", { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
        if (procs) {
          lines.push(`  Running GPU Processes:`);
          for (const proc of procs.split("\n")) {
            const [pid, pname, mem] = proc.split(",").map(s => s.trim());
            lines.push(`    PID ${pid}: ${pname} (${mem} MB)`);
          }
        }
      } catch { /* skip */ }

      return lines.join("\n");
    }
    case "slug": {
      if (!args?.trim()) return "  Usage: /slug <text>\n  Example: /slug Hello World! This is a Test";

      const text = args.trim();

      // Normalize unicode, strip diacritics, lowercase, replace non-alnum with hyphens
      const slug = text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")   // strip diacritics
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")       // non-alnum → hyphen
        .replace(/^-+|-+$/g, "")           // trim leading/trailing hyphens
        .replace(/-{2,}/g, "-");           // collapse multiple hyphens

      return [
        `  Slug Generator\n`,
        `  Input:  ${text.length > 80 ? text.slice(0, 80) + "..." : text}`,
        `  Slug:   ${slug}`,
        `  Length:  ${slug.length} chars`,
      ].join("\n");
    }
    case "diff_words": {
      if (!args?.trim() || !args.includes("|"))
        return "  Usage: /diff-words text1 | text2\n  Example: /diff-words the quick brown fox | the slow brown dog";

      const [left, right] = args.split("|", 2).map(s => s!.trim());
      if (!left || !right) return "  Provide two texts separated by |";

      const wordsA = left.split(/\s+/);
      const wordsB = right.split(/\s+/);

      // Simple LCS-based word diff
      const m = wordsA.length;
      const n = wordsB.length;

      // Guard against excessive input
      if (m > 500 || n > 500) return "  Input too long (max 500 words per side).";

      // Build LCS table
      const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          if (wordsA[i - 1] === wordsB[j - 1]) {
            dp[i]![j] = dp[i - 1]![j - 1]! + 1;
          } else {
            dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
          }
        }
      }

      // Backtrack to produce diff
      const diff: { type: string; word: string }[] = [];
      let i = m, j = n;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && wordsA[i - 1] === wordsB[j - 1]) {
          diff.unshift({ type: " ", word: wordsA[i - 1]! });
          i--; j--;
        } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
          diff.unshift({ type: "+", word: wordsB[j - 1]! });
          j--;
        } else {
          diff.unshift({ type: "-", word: wordsA[i - 1]! });
          i--;
        }
      }

      const removed = diff.filter(d => d.type === "-").length;
      const added = diff.filter(d => d.type === "+").length;
      const unchanged = diff.filter(d => d.type === " ").length;

      const lines = [`  Word Diff\n`];
      let line = "  ";
      for (const d of diff) {
        const token = d.type === "-" ? `[-${d.word}-]` : d.type === "+" ? `{+${d.word}+}` : d.word;
        if (line.length + token.length + 1 > 100) {
          lines.push(line);
          line = "  ";
        }
        line += (line.length > 2 ? " " : "") + token;
      }
      if (line.length > 2) lines.push(line);

      lines.push(``);
      lines.push(`  Removed: ${removed}  Added: ${added}  Unchanged: ${unchanged}`);

      return lines.join("\n");
    }
    case "headers": {
      if (!args?.trim()) return "  Usage: /headers <URL>";

      let url = args.trim();
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;

      const lines = [`  HTTP Headers: ${url}\n`];

      try {
        const resp = await fetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(10000),
          redirect: "follow",
        });

        lines.push(`  Status: ${resp.status} ${resp.statusText}\n`);

        const maxKeyLen = Math.max(...[...resp.headers.keys()].map(k => k.length), 4);
        const sorted = [...resp.headers.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        for (const [key, value] of sorted) {
          lines.push(`  ${key.padEnd(maxKeyLen)}  ${value}`);
        }

        lines.push(`\n  Total: ${sorted.length} headers`);
        if (resp.redirected) {
          lines.push(`  Redirected to: ${resp.url}`);
        }
      } catch (err: any) {
        lines.push(`  Error: ${err.message}`);
      }

      return lines.join("\n");
    }
    case "extract_urls": {
      let text = args?.trim();
      if (!text) return "  Usage: /extract-urls <text or file path>";

      // Try reading as file
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, text);

      if (existsSync(filePath)) {
        const stat = statSyncFn(filePath);
        if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
          text = readFileSync(filePath, "utf-8");
        }
      }

      // Extract URLs
      const urlPattern = /https?:\/\/[^\s<>"')\]},;]+/gi;
      const matches = text.match(urlPattern);

      if (!matches || matches.length === 0) return "  No URLs found.";

      // Deduplicate preserving order
      const unique = [...new Set(matches)];

      const lines = [`  Extracted URLs (${unique.length} unique, ${matches.length} total)\n`];
      for (const [i, url] of unique.slice(0, 100).entries()) {
        lines.push(`  ${String(i + 1).padStart(3)}. ${url}`);
      }
      if (unique.length > 100) {
        lines.push(`  ... and ${unique.length - 100} more`);
      }

      return lines.join("\n");
    }
    case "nato": {
      if (!args?.trim()) return "  Usage: /nato <text>\n  Example: /nato Hello";

      const NATO: Record<string, string> = {
        A: "Alfa", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo",
        F: "Foxtrot", G: "Golf", H: "Hotel", I: "India", J: "Juliet",
        K: "Kilo", L: "Lima", M: "Mike", N: "November", O: "Oscar",
        P: "Papa", Q: "Quebec", R: "Romeo", S: "Sierra", T: "Tango",
        U: "Uniform", V: "Victor", W: "Whiskey", X: "X-ray", Y: "Yankee",
        Z: "Zulu",
        "0": "Zero", "1": "One", "2": "Two", "3": "Three", "4": "Four",
        "5": "Five", "6": "Six", "7": "Seven", "8": "Eight", "9": "Niner",
      };

      const text = args.trim().slice(0, 200);
      const lines = [`  NATO Phonetic: ${text.length > 60 ? text.slice(0, 60) + "..." : text}\n`];

      const words: string[] = [];
      for (const char of text) {
        const upper = char.toUpperCase();
        if (NATO[upper]) {
          words.push(NATO[upper]!);
          lines.push(`  ${char}  →  ${NATO[upper]}`);
        } else if (char === " ") {
          words.push("(space)");
          lines.push(`     →  (space)`);
        }
      }

      lines.push(``);
      lines.push(`  Spoken: ${words.join(" ")}`);

      return lines.join("\n");
    }
    case "markdown_toc": {
      if (!args?.trim()) return "  Usage: /markdown-toc <file.md>";

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());

      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 2 * 1024 * 1024) return "  File too large (max 2 MB).";

      const content = readFileSync(filePath, "utf-8");
      const relPath = relative(cwd, filePath);

      // Extract headings (skip code blocks)
      let inCodeBlock = false;
      const headings: { level: number; text: string; anchor: string }[] = [];

      for (const line of content.split("\n")) {
        if (line.trim().startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (inCodeBlock) continue;

        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
          const level = headingMatch[1]!.length;
          const text = headingMatch[2]!.trim();
          const anchor = text
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-{2,}/g, "-");
          headings.push({ level, text, anchor });
        }
      }

      if (headings.length === 0) return `  No headings found in ${relPath}`;

      const minLevel = Math.min(...headings.map(h => h.level));
      const lines = [`  Table of Contents: ${relPath}\n`];

      for (const h of headings.slice(0, 100)) {
        const indent = "  ".repeat(h.level - minLevel);
        lines.push(`  ${indent}- [${h.text}](#${h.anchor})`);
      }
      if (headings.length > 100) {
        lines.push(`  ... and ${headings.length - 100} more`);
      }

      lines.push(``);
      lines.push(`  Headings: ${headings.length}  |  Levels: ${minLevel}-${Math.max(...headings.map(h => h.level))}`);

      return lines.join("\n");
    }
    default:
      return null;
  }
}
