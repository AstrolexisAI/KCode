// System, environment, and process actions
// Extracted from utility-actions.ts

import type { ActionContext } from "./action-helpers.js";

export async function handleSystemAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { conversationManager, appConfig, args } = ctx;

  switch (action) {
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
          return { size: match[1]!, path: match[2]!.replace(/^\.\//, "") || "." };
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
        const preview = text.split("\n")[0]!.slice(0, 60);
        return `  Copied to clipboard (${text.length} chars)${isFile ? ` from ${args.trim()}` : ""}\n  ${preview}${text.length > 60 ? "..." : ""}`;
      } catch (err: any) {
        return `  Clipboard error: ${err.message}`;
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

          const data = await resp.json() as Record<string, unknown>;
          const choices = data.choices as Record<string, unknown>[] | undefined;
          const usage = data.usage as Record<string, unknown> | undefined;
          const reply = String((choices?.[0]?.message as Record<string, unknown> | undefined)?.content ?? "(empty)");
          const tokens = (usage?.total_tokens as number) ?? 0;
          const completionTokens = (usage?.completion_tokens as number) ?? 0;
          const tokPerSec = latency > 0 ? Math.round((completionTokens / latency) * 1000) : 0;
          totalTokens += tokens;

          lines.push(`  ${test.name}`);
          lines.push(`    Latency:  ${latency}ms`);
          lines.push(`    Tokens:   ${tokens} (${completionTokens} completion)`);
          lines.push(`    Speed:    ${tokPerSec} tok/s`);
          lines.push(`    Reply:    ${reply.slice(0, 80).replace(/\n/g, " ")}${reply.length > 80 ? "..." : ""}`);
          lines.push(``);
        } catch (err: any) {
          lines.push(`  ${test.name}: ERROR \u2014 ${err.message}\n`);
        }
      }

      const avgLatency = tests.length > 0 ? Math.round(totalLatency / tests.length) : 0;
      lines.push(`  Summary`);
      lines.push(`    Avg latency: ${avgLatency}ms`);
      lines.push(`    Total tokens: ${totalTokens}`);
      lines.push(`    Endpoint: ${url}`);

      return lines.join("\n");
    }
    default:
      return null;
  }
}
