// System, environment, and process actions
// Extracted from utility-actions.ts
//
// SECURITY (Bruno 2026-05-26): all shell-mode `execSync` calls replaced with
// `execFileSync(cmd, [...argv])` to eliminate command-injection surface.
// Two confirmed real injection sinks were patched here:
//   - `open` action: `${opener} '${openTarget}'` interpolated user input
//   - `qr`  action: `echo -n '${text}' | qrencode` interpolated user input
// Pipes (`| tail`, `| head`, `| grep`) and shell redirects (`2>/dev/null`)
// are now reproduced in JavaScript by reading full stdout and post-filtering.

import type { ActionContext } from "./action-helpers.js";

type ExecOpts = {
  cwd?: string;
  timeout?: number;
  input?: string;
  swallowStderr?: boolean;
};

/** Run a command via execFileSync — no shell, argv array. Returns trimmed stdout. */
async function run(cmd: string, args: string[], opts: ExecOpts = {}): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  return execFileSync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 5000,
    input: opts.input,
    stdio: opts.swallowStderr === false
      ? ["pipe", "pipe", "pipe"]
      : ["pipe", "pipe", "ignore"],
  })
    .toString()
    .trim();
}

/** Variant that returns "" on failure (mimics ` || true` and `2>/dev/null` swallowing). */
async function runTry(cmd: string, args: string[], opts: ExecOpts = {}): Promise<string> {
  try {
    return await run(cmd, args, opts);
  } catch {
    return "";
  }
}

/** Substring filter for ps output (replaces `| grep -E "pattern" | grep -v grep`). */
function psGrep(psOutput: string, regex: RegExp): string[] {
  return psOutput
    .split("\n")
    .filter((line) => regex.test(line) && !/\bgrep\b/.test(line));
}

export async function handleSystemAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { appConfig, args } = ctx;
  const cwd = appConfig.workingDirectory;

  switch (action) {
    case "processes": {
      const lines = [`  Project-Related Processes\n`];

      // Get full ps output once, then filter in JS — no shell pipes.
      const psFull = await runTry("ps", ["aux"], { cwd, timeout: 5000 });

      const patterns: Array<{ label: string; regex: RegExp; cap?: number }> = [
        { label: "Node/Bun", regex: /\b(node|bun|tsx|ts-node)\b/ },
        { label: "Python", regex: /\b(python|uvicorn|gunicorn|flask)\b/ },
        { label: "Go", regex: /\bgo\s+(run|build|test)\b/ },
        { label: "Docker", regex: /\bdocker\b/, cap: 5 },
        { label: "Servers", regex: /\b(vite|webpack|next|nuxt|nginx|httpd|caddy)\b/ },
      ];

      let totalFound = 0;
      for (const { label, regex, cap } of patterns) {
        const procs = psGrep(psFull, regex);
        if (procs.length === 0) continue;
        const display = cap !== undefined ? procs.slice(0, cap) : procs;
        totalFound += procs.length;
        lines.push(`  ── ${label} (${procs.length}) ──`);
        for (const proc of display.slice(0, 5)) {
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

      // Show listening ports — was `ss -tlnp | tail -n +2 | head -10`
      try {
        const ssFull = await runTry("ss", ["-tlnp"], { cwd, timeout: 5000 });
        const ssLines = ssFull.split("\n").slice(1).slice(0, 10);
        if (ssLines.length > 0) {
          lines.push(`  ── Listening Ports (${ssLines.length}) ──`);
          for (const pl of ssLines) {
            const parts = pl.trim().split(/\s+/);
            const addr = parts[3] ?? "?";
            const proc = parts[5]?.replace(/.*"(.+?)".*/, "$1") ?? "";
            lines.push(`  ${addr.padEnd(25)} ${proc}`);
          }
          lines.push(``);
        }
      } catch {
        /* ignore */
      }

      if (totalFound === 0 && lines.length <= 1) {
        lines.push(`  No development processes detected.`);
      }

      return lines.join("\n");
    }
    case "disk": {
      try {
        // Was: `du -h --max-depth=1 | sort -rh | head -20`. Do `du` only,
        // sort and slice in JS.
        const output = await runTry("du", ["-h", "--max-depth=1"], { cwd, timeout: 15000 });
        if (!output) return "  Cannot determine disk usage.";

        const parseBytes = (s: string): number => {
          const num = parseFloat(s);
          if (s.endsWith("G")) return num * 1024 * 1024 * 1024;
          if (s.endsWith("M")) return num * 1024 * 1024;
          if (s.endsWith("K")) return num * 1024;
          return num;
        };

        const entries = output
          .split("\n")
          .map((line) => {
            const match = line.match(/^([\d.]+[BKMGT]?)\s+(.+)$/);
            if (!match) return null;
            return {
              size: match[1]!,
              path: match[2]!.replace(/^\.\//, "") || ".",
              bytes: parseBytes(match[1]!),
            };
          })
          .filter(Boolean) as Array<{ size: string; path: string; bytes: number }>;

        // Sort by bytes desc and take top 20
        entries.sort((a, b) => b.bytes - a.bytes);
        const withBytes = entries.slice(0, 20);

        const maxBytes = withBytes[0]?.bytes ?? 1;
        const barWidth = 20;

        const lines = [`  Disk Usage: ${cwd}\n`];
        for (const e of withBytes.slice(0, 15)) {
          const filled = Math.max(1, Math.round((e.bytes / maxBytes) * barWidth));
          const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
          lines.push(`  ${bar} ${e.size.padStart(7)}  ${e.path}`);
        }

        if (withBytes.length > 15) {
          lines.push(`\n  ... ${withBytes.length - 15} more directories`);
        }

        // Total project size
        const total = withBytes.find((e) => e.path === ".");
        if (total) {
          lines.push(`\n  Total project size: ${total.size}`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "crons": {
      const lines = [`  Scheduled Tasks\n`];
      let found = false;

      // User crontab
      try {
        const crontab = await runTry("crontab", ["-l"], { timeout: 5000 });
        if (crontab && !crontab.includes("no crontab")) {
          found = true;
          const entries = crontab.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
          lines.push(`  ── Crontab (${entries.length} entries) ──`);
          for (const entry of entries.slice(0, 15)) {
            lines.push(`  ${entry}`);
          }
          if (entries.length > 15) lines.push(`  ... ${entries.length - 15} more`);
          lines.push(``);
        }
      } catch {
        /* no crontab */
      }

      // Systemd user timers
      try {
        const timers = await runTry(
          "systemctl",
          ["--user", "list-timers", "--no-pager"],
          { timeout: 5000 },
        );
        if (timers && timers.includes("NEXT")) {
          found = true;
          const timerLines = timers.split("\n");
          lines.push(`  ── Systemd User Timers ──`);
          for (const tl of timerLines.slice(0, 10)) {
            lines.push(`  ${tl}`);
          }
          lines.push(``);
        }
      } catch {
        /* no systemd */
      }

      // System timers — was `systemctl list-timers --no-pager | head -10`
      try {
        const sysFull = await runTry(
          "systemctl",
          ["list-timers", "--no-pager"],
          { timeout: 5000 },
        );
        const sysTimers = sysFull.split("\n").slice(0, 10).join("\n");
        if (sysTimers && sysTimers.includes("NEXT")) {
          found = true;
          const sysLines = sysTimers.split("\n");
          lines.push(`  ── System Timers ──`);
          for (const sl of sysLines) {
            lines.push(`  ${sl}`);
          }
          lines.push(``);
        }
      } catch {
        /* ignore */
      }

      if (!found) {
        lines.push(`  No crontabs or timers found.`);
      }

      return lines.join("\n");
    }
    case "gpu": {
      const lines = [`  GPU Monitor\n`];

      // NVIDIA GPUs — all argv, no shell
      try {
        const raw = await run(
          "nvidia-smi",
          [
            "--query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit,driver_version",
            "--format=csv,noheader,nounits",
          ],
          { timeout: 5000, swallowStderr: false },
        );

        if (raw) {
          for (const line of raw.split("\n")) {
            const [idx, name, temp, util, memUsed, memTotal, powerDraw, powerLimit, driver] = line
              .split(",")
              .map((s) => s.trim());
            const memUsedMB = parseInt(memUsed!);
            const memTotalMB = parseInt(memTotal!);
            const memPct = memTotalMB > 0 ? Math.round((memUsedMB / memTotalMB) * 100) : 0;
            const barWidth = 20;
            const filledBar = Math.round((memPct / 100) * barWidth);
            const bar = "█".repeat(filledBar) + "░".repeat(barWidth - filledBar);

            lines.push(`  GPU ${idx}: ${name}`);
            lines.push(`    VRAM:   ${memUsed} / ${memTotal} MB (${memPct}%)  [${bar}]`);
            lines.push(`    Temp:   ${temp}°C`);
            lines.push(`    Util:   ${util}%`);
            lines.push(`    Power:  ${powerDraw}W / ${powerLimit}W`);
            lines.push(`    Driver: ${driver}`);
            lines.push(``);
          }
        }
      } catch {
        lines.push("  No NVIDIA GPU detected (nvidia-smi not available).\n");
      }

      // AMD GPUs
      try {
        const amd = await run(
          "rocm-smi",
          ["--showmeminfo", "vram", "--csv"],
          { timeout: 5000, swallowStderr: false },
        );
        if (amd && amd.includes("vram")) {
          lines.push("  AMD GPU detected (rocm-smi available)");
          for (const line of amd.split("\n").slice(1, 5)) {
            lines.push(`    ${line.trim()}`);
          }
        }
      } catch {
        /* no AMD */
      }

      // Running GPU processes
      try {
        const procs = await run(
          "nvidia-smi",
          [
            "--query-compute-apps=pid,name,used_gpu_memory",
            "--format=csv,noheader,nounits",
          ],
          { timeout: 3000, swallowStderr: false },
        );
        if (procs) {
          lines.push(`  Running GPU Processes:`);
          for (const proc of procs.split("\n")) {
            const [pid, pname, mem] = proc.split(",").map((s) => s.trim());
            lines.push(`    PID ${pid}: ${pname} (${mem} MB)`);
          }
        }
      } catch {
        /* skip */
      }

      return lines.join("\n");
    }
    case "copy": {
      if (!args?.trim()) return "  Usage: /copy <text or file path>";

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");

      let text = args.trim();
      let isFile = false;
      const filePath = resolvePath(appConfig.workingDirectory, text);

      const fileStat = existsSync(filePath) ? statSyncFn(filePath) : null;
      if (fileStat?.isFile()) {
        if (fileStat.size > 1024 * 1024) return "  File too large for clipboard (max 1 MB).";
        text = readFileSync(filePath, "utf-8");
        isFile = true;
      }

      // Detect clipboard tool by probing `which`. All inputs are hardcoded.
      const clipCmds: Array<{ probe: string; cmd: string; argv: string[] }> = [
        { probe: "xclip", cmd: "xclip", argv: ["-selection", "clipboard"] },
        { probe: "xsel", cmd: "xsel", argv: ["--clipboard", "--input"] },
        { probe: "wl-copy", cmd: "wl-copy", argv: [] },
        { probe: "pbcopy", cmd: "pbcopy", argv: [] },
      ];

      let chosen: { cmd: string; argv: string[] } | null = null;
      for (const { probe, cmd, argv } of clipCmds) {
        try {
          await run("which", [probe], { timeout: 2000 });
          chosen = { cmd, argv };
          break;
        } catch {
          /* not available */
        }
      }

      if (!chosen) return "  No clipboard tool found (install xclip, xsel, or wl-copy).";

      try {
        await run(chosen.cmd, chosen.argv, { input: text, timeout: 5000 });
        const preview = text.split("\n")[0]!.slice(0, 60);
        return `  Copied to clipboard (${text.length} chars)${isFile ? ` from ${args.trim()}` : ""}\n  ${preview}${text.length > 60 ? "..." : ""}`;
      } catch (err: any) {
        return `  Clipboard error: ${err.message}`;
      }
    }
    case "open": {
      if (!args?.trim()) return "  Usage: /open <file path or URL>";

      const { resolve: resolvePath } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const target = args.trim();

      let openTarget: string;
      if (/^https?:\/\//.test(target)) {
        openTarget = target;
      } else {
        const filePath = resolvePath(cwd, target);
        if (!existsSync(filePath)) return `  Not found: ${target}`;
        openTarget = filePath;
      }

      // Detect opener — hardcoded list, only `which` is shelled out via argv.
      const openers = ["xdg-open", "open", "wslview"];
      let opener: string | null = null;
      for (const candidate of openers) {
        try {
          await run("which", [candidate], { timeout: 2000 });
          opener = candidate;
          break;
        } catch {
          /* not available */
        }
      }

      if (!opener) return "  No system opener found (xdg-open, open, wslview).";

      // PATCH: was `execSync(\`${opener} '${openTarget}' 2>/dev/null &\`, { shell: "/bin/sh" })`.
      // openTarget came directly from user args → command injection sink.
      // Now: spawn with argv array, detached so it survives daemon, ignoring i/o.
      try {
        const { spawn } = await import("node:child_process");
        const child = spawn(opener, [openTarget], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        return `  Opened: ${target}  (via ${opener})`;
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "qr": {
      if (!args?.trim()) return "  Usage: /qr <text or URL>";

      const text = args.trim();
      if (text.length > 2048) return "  Text too long for QR (max 2048 chars).";

      try {
        // PATCH: was `echo -n '${text}' | qrencode -t UTF8`. Now feed `text`
        // through stdin of qrencode directly — no shell, no echo, no quoting.
        const output = await run("qrencode", ["-t", "UTF8"], { input: text, timeout: 5000 });

        const lines = [`  QR Code\n`];
        for (const line of output.split("\n")) {
          lines.push(`  ${line}`);
        }
        lines.push(`\n  Data: ${text.length > 60 ? text.slice(0, 60) + "..." : text}`);
        return lines.join("\n");
      } catch {
        // Fallback: python3 with qrcode module — stdin pipe, argv array.
        try {
          const pyScript =
            "import qrcode,sys; q=qrcode.QRCode(border=1); q.add_data(sys.stdin.read()); q.make(); q.print_ascii()";
          const output = await run("python3", ["-c", pyScript], { input: text, timeout: 5000 });

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
        else if ((parts[i] === "--count" || parts[i] === "-c") && parts[i + 1]) {
          count = parseInt(parts[++i]!) || 1;
        } else if (/^\d+$/.test(parts[i]!)) length = parseInt(parts[i]!);
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
        const entropy = Math.round(Math.log2(charset.length) * length);
        lines.push(`  ${count > 1 ? `${i + 1}. ` : ""}${pw}  (${entropy}-bit)`);
      }

      return lines.join("\n");
    }
    case "stopwatch": {
      const input = args?.trim() || "0";

      const durationMatch = input.match(/^(\d+)\s*(s|sec|m|min|h|hr|hour)?$/i);
      if (!durationMatch)
        return "  Usage: /stopwatch <duration>\n  Examples: /stopwatch 30s, /stopwatch 5m, /stopwatch 1h";

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
        {
          name: "Code Gen",
          prompt:
            "Write a JavaScript function that reverses a string. Reply with just the code, no explanation.",
        },
        {
          name: "Reasoning",
          prompt:
            "If all roses are flowers and some flowers fade quickly, can we conclude that some roses fade quickly? Answer yes or no with one sentence of reasoning.",
        },
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

          const data = (await resp.json()) as Record<string, unknown>;
          const choices = data.choices as Record<string, unknown>[] | undefined;
          const usage = data.usage as Record<string, unknown> | undefined;
          const reply = String(
            (choices?.[0]?.message as Record<string, unknown> | undefined)?.content ?? "(empty)",
          );
          const tokens = (usage?.total_tokens as number) ?? 0;
          const completionTokens = (usage?.completion_tokens as number) ?? 0;
          const tokPerSec = latency > 0 ? Math.round((completionTokens / latency) * 1000) : 0;
          totalTokens += tokens;

          lines.push(`  ${test.name}`);
          lines.push(`    Latency:  ${latency}ms`);
          lines.push(`    Tokens:   ${tokens} (${completionTokens} completion)`);
          lines.push(`    Speed:    ${tokPerSec} tok/s`);
          lines.push(
            `    Reply:    ${reply.slice(0, 80).replace(/\n/g, " ")}${reply.length > 80 ? "..." : ""}`,
          );
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
    default:
      return null;
  }
}
