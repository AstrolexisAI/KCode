// Session actions
// Auto-extracted from builtin-actions.ts

import { CHARS_PER_TOKEN } from "../../core/token-budget.js";
import type { ActionContext } from "./action-helpers.js";

export async function handleSessionAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { conversationManager, setCompleted, appConfig, args, switchTheme } = ctx;

  switch (action) {
    case "clear": {
      setCompleted(() => [
        {
          kind: "banner",
          title: `KCode v${appConfig.version ?? "?"}`,
          subtitle: "Kulvex Code by Astrolexis",
        },
      ]);
      return "  Conversation cleared.";
    }
    case "compact": {
      const state = conversationManager.getState();
      if (state.messages.length <= 4) return "  Nothing to compact (too few messages).";

      const { CompactionManager } = await import("../../core/compaction.js");
      const compactor = new CompactionManager(
        appConfig.apiKey,
        appConfig.model,
        appConfig.apiBase,
        appConfig.customFetch,
      );

      const keepLast = 4;
      const toPrune = state.messages.slice(0, -keepLast);
      const kept = state.messages.slice(-keepLast);

      // Preview mode: show what would be compacted without applying
      if (args?.trim() === "preview") {
        const summary = await compactor.compact(toPrune);
        if (!summary) return "  Preview failed — could not generate summary.";
        const summaryText =
          typeof summary.content === "string"
            ? summary.content
            : (summary.content as Array<{ type: string; text?: string }>)
                .map((b) => b.text ?? "")
                .join("\n");
        const lines = [
          `  Compact Preview:`,
          `  Messages to compact: ${toPrune.length}`,
          `  Messages to keep:    ${kept.length} (most recent)`,
          ``,
          `  Generated Summary:`,
          `  ─────────────────────────────────────────`,
          ...summaryText.split("\n").map((l: string) => `  ${l}`),
          `  ─────────────────────────────────────────`,
          ``,
          `  Run /compact (without preview) to apply.`,
        ];
        return lines.join("\n");
      }

      const summary = await compactor.compact(toPrune);
      if (summary) {
        conversationManager.restoreMessages([summary, ...kept]);
        return `  Compacted ${toPrune.length} messages into summary. ${kept.length} recent messages preserved.`;
      }
      return "  Compaction failed -- conversation unchanged.";
    }
    case "context": {
      const state = conversationManager.getState();
      const usage = conversationManager.getUsage();
      const contextSize = appConfig.contextWindowSize ?? 200000;
      const usedTokens = usage.inputTokens + usage.outputTokens;
      const pct = Math.min(100, Math.round((usedTokens / contextSize) * 100));

      // Build a visual bar with color zones
      const barLen = 40;
      const filled = Math.round((barLen * pct) / 100);
      const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
      const status = pct >= 90 ? " CRITICAL" : pct >= 70 ? " WARNING" : "";

      // Analyze context breakdown by category
      const systemChars = 0;
      let userChars = 0;
      let assistantChars = 0;
      let toolResultChars = 0;
      let thinkingChars = 0;
      let toolCalls = 0;

      for (const msg of state.messages) {
        if (typeof msg.content === "string") {
          if (msg.role === "user") userChars += msg.content.length;
          else assistantChars += msg.content.length;
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text") {
              if (msg.role === "user") userChars += block.text.length;
              else assistantChars += block.text.length;
            } else if (block.type === "tool_result") {
              const c =
                typeof block.content === "string" ? block.content : JSON.stringify(block.content);
              toolResultChars += c.length;
            } else if (block.type === "tool_use") {
              toolCalls++;
              toolResultChars += JSON.stringify(block.input).length;
            } else if (block.type === "thinking") {
              thinkingChars += block.thinking.length;
            }
          }
        }
      }

      const totalChars = userChars + assistantChars + toolResultChars + thinkingChars;
      const pctOf = (chars: number) =>
        totalChars > 0 ? Math.round((chars / totalChars) * 100) : 0;

      // Breakdown bars
      const miniBar = (p: number) => {
        const w = 15;
        const f = Math.round((w * Math.min(p, 100)) / 100);
        return "\u2588".repeat(f) + "\u2591".repeat(w - f);
      };

      const lines = [
        `  Context: [${bar}] ${pct}%${status}`,
        `  Tokens:  ${usedTokens.toLocaleString()} / ${contextSize.toLocaleString()}`,
        `  Messages: ${state.messages.length} | Tool calls: ${state.toolUseCount}`,
        ``,
        `  Breakdown by category:`,
        `  User prompts   ${miniBar(pctOf(userChars))} ${pctOf(userChars)}% (${Math.round(userChars / CHARS_PER_TOKEN).toLocaleString()} est. tokens)`,
        `  Assistant text  ${miniBar(pctOf(assistantChars))} ${pctOf(assistantChars)}% (${Math.round(assistantChars / CHARS_PER_TOKEN).toLocaleString()} est. tokens)`,
        `  Tool results    ${miniBar(pctOf(toolResultChars))} ${pctOf(toolResultChars)}% (${Math.round(toolResultChars / CHARS_PER_TOKEN).toLocaleString()} est. tokens)`,
        `  Thinking        ${miniBar(pctOf(thinkingChars))} ${pctOf(thinkingChars)}% (${Math.round(thinkingChars / CHARS_PER_TOKEN).toLocaleString()} est. tokens)`,
      ];

      if (usage.cacheReadInputTokens > 0 || usage.cacheCreationInputTokens > 0) {
        lines.push(``);
        lines.push(
          `  Cache: ${usage.cacheReadInputTokens.toLocaleString()} read, ${usage.cacheCreationInputTokens.toLocaleString()} created`,
        );
      }

      if (pct >= 70) {
        lines.push(``);
        lines.push(`  Tip: Use /compact to summarize older messages and free context.`);
      }

      return lines.join("\n");
    }
    case "rewind": {
      const trimmed = args?.trim() ?? "";

      // /rewind or /rewind list — show all checkpoints
      if (trimmed === "" || trimmed === "list") {
        const cps = conversationManager.listCheckpoints();
        if (cps.length === 0) return "  No checkpoints available.";
        const lines = ["  Checkpoints:", ""];
        for (const cp of cps) {
          lines.push(`  ${cp.index}. [${cp.age}] "${cp.label}" (message ${cp.messageIndex})`);
        }
        lines.push(
          "",
          "  Use /rewind <number> to rewind to a checkpoint, or /rewind last for the most recent.",
        );
        return lines.join("\n");
      }

      // /rewind last — rewind to most recent checkpoint
      if (trimmed === "last" || trimmed === "checkpoint" || trimmed === "cp") {
        const result = conversationManager.rewindToCheckpoint();
        return result ?? "  No checkpoints available.";
      }

      // /rewind <number> — rewind to specific checkpoint index
      const idx = parseInt(trimmed);
      if (!isNaN(idx)) {
        const result = conversationManager.rewindToCheckpoint(idx);
        return result ?? "  No checkpoints available.";
      }

      // Fallback: use undo stack for file changes only
      const undo = conversationManager.getUndo();
      const undoCount = 1;
      const undoResults: string[] = [];
      for (let i = 0; i < undoCount; i++) {
        const result = undo.undo();
        if (result) {
          undoResults.push(result);
        } else {
          break;
        }
      }

      const cpCount = conversationManager.getCheckpointCount();
      const cpHint =
        cpCount > 0
          ? `\n  (${cpCount} conversation checkpoint${cpCount === 1 ? "" : "s"} available — use /rewind list)`
          : "";

      if (undoResults.length === 0) return `  Nothing to rewind.${cpHint}`;
      return undoResults.join("\n") + cpHint;
    }
    case "sessions": {
      const tm = new (await import("../../core/transcript.js")).TranscriptManager();
      const query = args?.trim();

      // /sessions search <query> — search across all sessions
      if (query?.startsWith("search ")) {
        const searchQuery = query.slice(7).trim();
        if (!searchQuery) return "  Usage: /sessions search <query>";
        const results = tm.searchSessions(searchQuery);
        if (results.length === 0) return `  No sessions matching "${searchQuery}"`;
        const lines = [`  Sessions matching "${searchQuery}" (${results.length}):\n`];
        for (const r of results) {
          const date = r.startedAt.replace(/T/g, " ").slice(0, 16);
          lines.push(`  ${date}  ${r.prompt.slice(0, 50)}`);
          lines.push(`    → ${r.snippet.slice(0, 80)}`);
          lines.push(`    ${r.filename}`);
        }
        return lines.join("\n");
      }

      // /sessions info <filename> — detailed session summary
      if (query?.startsWith("info ")) {
        const filename = query.slice(5).trim();
        const summary = tm.getSessionSummary(filename);
        if (!summary) return `  Session not found: ${filename}`;
        return [
          `  Session: ${filename}`,
          `  Prompt: ${summary.prompt}`,
          `  Messages: ${summary.messageCount} | Tools: ${summary.toolUseCount}`,
          `  Duration: ${summary.duration}`,
          `\n  Resume: kcode --continue (resumes latest)`,
        ].join("\n");
      }

      // /sessions — list recent sessions
      const sessions = tm.listSessions();
      if (sessions.length === 0) return "  No saved sessions.";

      const lines = [
        `  Recent Sessions (${Math.min(sessions.length, 20)} of ${sessions.length}):\n`,
      ];
      const recent = sessions.slice(0, 20);
      for (const s of recent) {
        const date = s.startedAt.replace(/T/g, " ").slice(0, 16);
        const summary = tm.getSessionSummary(s.filename);
        const tools = summary ? ` | ${summary.toolUseCount} tools | ${summary.duration}` : "";
        lines.push(`  ${date}  ${s.prompt.slice(0, 50)}${tools}`);
        lines.push(`    ${s.filename}`);
      }
      if (sessions.length > 20) lines.push(`\n  ... and ${sessions.length - 20} more`);
      lines.push(`\n  Search: /sessions search <query>`);
      lines.push(`  Details: /sessions info <filename>`);
      return lines.join("\n");
    }
    case "branches": {
      const { getBranchManager: getBM, formatBranchTree: fmtTree } = await import(
        "../../core/branch-manager.js"
      );
      const branchMgr = getBM();
      const allBranches = branchMgr.listBranches();

      if (allBranches.length === 0) {
        const tm2 = new (await import("../../core/transcript.js")).TranscriptManager();
        const sess = tm2.listSessions();
        if (sess.length === 0) return "  No saved sessions or branches.";
        const lines: string[] = ["  No persistent branches tracked yet.\n"];
        lines.push("  Use /fork to create tracked branches.\n");
        for (const s of sess.slice(0, 10)) {
          const date = s.startedAt.replace(/T/g, " ").slice(0, 16);
          lines.push(`  \u25CF ${date}  ${s.prompt.slice(0, 50)}`);
        }
        return lines.join("\n");
      }

      const branchTree = branchMgr.getBranchTree();
      const lines: string[] = ["  Conversation Branches:\n"];
      lines.push(...fmtTree(branchTree).map((l: string) => `  ${l}`));
      lines.push("");
      lines.push(`  Total: ${allBranches.length} branch(es)`);
      lines.push(`\n  Label:  /branch label <name>`);
      lines.push(`  Fork:   /fork [N]`);
      lines.push(`  Resume: /resume or kcode --continue`);
      return lines.join("\n");
    }
    case "branch": {
      const { getBranchManager: getBM2 } = await import("../../core/branch-manager.js");
      const { createBranch } = await import("../../core/session-branch.js");
      const bm2 = getBM2();
      const barg = args?.trim() ?? "";
      if (barg.startsWith("label ")) {
        const newLabel = barg.slice(6).trim();
        if (!newLabel) return "  Usage: /branch label <name>";
        const cid = conversationManager.getSessionId();
        const br = bm2.getBranch(cid);
        if (!br) {
          bm2.saveBranch(cid, null, newLabel, `session-${cid}`);
        } else {
          bm2.labelBranch(cid, newLabel);
        }
        return `  Branch labeled: "${newLabel}"`;
      }
      if (barg === "delete") {
        const cid = conversationManager.getSessionId();
        const br = bm2.getBranch(cid);
        if (!br) return "  Current session is not a tracked branch.";
        bm2.deleteBranch(cid);
        return `  Branch "${br.label || br.id}" marked as deleted.`;
      }
      // /branch [name] — create a fork from current conversation state
      const branchName = barg || "";
      const sessionId = conversationManager.getSessionId();
      const messages = conversationManager.getState().messages;
      const branch = await createBranch(sessionId, branchName, messages);
      bm2.saveBranch(branch.id, sessionId, branch.name, `session-${branch.id}`, messages.length);
      return `  Branch created: "${branch.name}" (id: ${branch.id})\n  ${messages.length} messages saved at branch point\n  Use /continue ${branch.id} to resume from this branch`;
    }
    case "continue": {
      const { loadBranch } = await import("../../core/session-branch.js");
      const branchId = args?.trim() ?? "";
      if (!branchId) return "  Usage: /continue <branchId>";
      const branch = await loadBranch(branchId);
      if (!branch) return `  Branch not found: ${branchId}`;
      conversationManager.restoreMessages(branch.messages);
      return `  Loaded branch: "${branch.name}" (${branch.messages.length} messages)\n  Branched at message ${branch.branchPoint} on ${branch.createdAt}\n  You can continue the conversation from here.`;
    }
    case "compare": {
      if (!args?.trim())
        return "  Usage: /compare <model1> <model2> <prompt>\n  Example: /compare gpt-4o gemini-2.5-pro explain this code";

      const parts = args.trim().split(/\s+/);
      if (parts.length < 3) return "  Usage: /compare <model1> <model2> <prompt>";

      const model1 = parts[0]!;
      const model2 = parts[1]!;
      const prompt = parts.slice(2).join(" ");

      const { getModelBaseUrl } = await import("../../core/models.js");

      const lines: string[] = [
        `  Comparing: ${model1} vs ${model2}\n  Prompt: "${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}"\n`,
      ];

      // Send to both models in parallel
      const fetchModel = async (
        model: string,
      ): Promise<{ text: string; tokens: number; timeMs: number }> => {
        const baseUrl =
          (await getModelBaseUrl(model)) ?? appConfig.apiBase ?? "http://localhost:10091";
        const start = Date.now();
        try {
          const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(appConfig.apiKey ? { Authorization: `Bearer ${appConfig.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: prompt }],
              max_tokens: 512,
              stream: false,
            }),
            signal: AbortSignal.timeout(30000),
          });
          const data = (await resp.json()) as Record<string, unknown>;
          const choices = data.choices as Record<string, unknown>[] | undefined;
          const usage = data.usage as Record<string, unknown> | undefined;
          const text = String(
            (choices?.[0]?.message as Record<string, unknown> | undefined)?.content ??
              "(no response)",
          );
          const tokens = Number(usage?.total_tokens ?? 0);
          return { text, tokens, timeMs: Date.now() - start };
        } catch (err) {
          return {
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            tokens: 0,
            timeMs: Date.now() - start,
          };
        }
      };

      const [r1, r2] = await Promise.all([fetchModel(model1), fetchModel(model2)]);

      lines.push(`  \u250C\u2500\u2500 ${model1} (${r1.timeMs}ms, ${r1.tokens} tok) \u2500\u2500`);
      for (const line of r1.text.split("\n").slice(0, 15)) {
        lines.push(`  \u2502 ${line}`);
      }
      if (r1.text.split("\n").length > 15) lines.push(`  \u2502 ... (truncated)`);
      lines.push(`  \u2514${"\u2500".repeat(40)}`);
      lines.push(``);
      lines.push(`  \u250C\u2500\u2500 ${model2} (${r2.timeMs}ms, ${r2.tokens} tok) \u2500\u2500`);
      for (const line of r2.text.split("\n").slice(0, 15)) {
        lines.push(`  \u2502 ${line}`);
      }
      if (r2.text.split("\n").length > 15) lines.push(`  \u2502 ... (truncated)`);
      lines.push(`  \u2514${"\u2500".repeat(40)}`);

      // Summary
      const faster = r1.timeMs < r2.timeMs ? model1 : model2;
      lines.push(`\n  Faster: ${faster} (${Math.abs(r1.timeMs - r2.timeMs)}ms difference)`);

      return lines.join("\n");
    }
    case "export": {
      const state = conversationManager.getState();
      const rawFilename = args?.trim() || "";
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");

      // Detect format from extension or flag
      let format = "md";
      let filename = rawFilename;

      if (rawFilename.endsWith(".json")) format = "json";
      else if (rawFilename.endsWith(".html")) format = "html";
      else if (rawFilename.endsWith(".txt")) format = "txt";
      else if (rawFilename === "json") {
        format = "json";
        filename = "";
      } else if (rawFilename === "html") {
        format = "html";
        filename = "";
      } else if (rawFilename === "txt") {
        format = "txt";
        filename = "";
      }

      if (
        !filename ||
        filename === "json" ||
        filename === "html" ||
        filename === "md" ||
        filename === "txt"
      ) {
        filename = `/tmp/kcode-export-${timestamp}.${format}`;
      }

      const { writeFileSync } = await import("node:fs");

      if (format === "json") {
        // JSON export — structured data
        const exported = {
          version: appConfig.version,
          model: appConfig.model,
          exportedAt: new Date().toISOString(),
          messageCount: state.messages.length,
          messages: state.messages.map((msg) => {
            if (typeof msg.content === "string") {
              return { role: msg.role, content: msg.content };
            }
            return {
              role: msg.role,
              blocks: msg.content.map((b) => {
                if (b.type === "text") return { type: "text", text: b.text };
                if (b.type === "tool_use")
                  return { type: "tool_use", name: b.name, input: b.input };
                if (b.type === "tool_result")
                  return {
                    type: "tool_result",
                    content: typeof b.content === "string" ? b.content.slice(0, 500) : "[complex]",
                    isError: b.is_error,
                  };
                return { type: b.type };
              }),
            };
          }),
        };
        writeFileSync(filename, JSON.stringify(exported, null, 2), "utf-8");
        return `  Exported ${state.messages.length} messages to ${filename} (JSON)`;
      }

      if (format === "html") {
        // HTML export — shareable page with collapsible tool calls and syntax highlighting
        const escHtml = (s: string) =>
          s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const htmlLines: string[] = [
          "<!DOCTYPE html>",
          '<html><head><meta charset="utf-8"><title>KCode Conversation</title>',
          "<style>",
          "*{box-sizing:border-box}",
          'body{font-family:"JetBrains Mono","Fira Code",monospace;max-width:860px;margin:2em auto;padding:0 1em;background:#1e1e2e;color:#cdd6f4;line-height:1.6}',
          ".user{background:#313244;padding:1em 1.2em;border-radius:8px;margin:1em 0;border-left:3px solid #89b4fa}",
          ".assistant{background:#181825;padding:1em 1.2em;border-radius:8px;margin:1em 0;border-left:3px solid #a6e3a1}",
          ".tool-group{margin:0.4em 0}",
          ".tool-header{cursor:pointer;background:#1e1e2e;padding:0.4em 0.8em;border-radius:4px;border-left:3px solid #fab387;color:#fab387;font-size:0.9em;user-select:none}",
          ".tool-header:hover{background:#313244}",
          '.tool-header::before{content:"▸ ";display:inline}',
          '.tool-header.open::before{content:"▾ "}',
          ".tool-body{display:none;padding:0.4em 0.8em 0.4em 1.2em;border-left:3px solid #45475a;margin-left:0.3em;font-size:0.85em;color:#a6adc8}",
          ".tool-body.open{display:block}",
          ".tool-error{border-left-color:#f38ba8}",
          "pre{background:#11111b;padding:1em;border-radius:4px;overflow-x:auto;margin:0.5em 0}",
          "code{font-family:inherit}",
          ".kw{color:#cba6f7;font-weight:bold}.str{color:#a6e3a1}.num{color:#fab387}.cmt{color:#6c7086;font-style:italic}.type{color:#f9e2af}.fn{color:#89b4fa}",
          "h1{color:#cba6f7;margin-bottom:0.3em}",
          ".meta{color:#6c7086;font-size:0.85em;margin-bottom:2em}",
          "</style></head><body>",
          `<h1>KCode Conversation</h1>`,
          `<p class="meta">Model: ${escHtml(appConfig.model)} | ${new Date().toISOString()} | ${state.messages.length} messages</p>`,
        ];

        for (const msg of state.messages) {
          if (typeof msg.content === "string") {
            const cls = msg.role === "user" ? "user" : "assistant";
            htmlLines.push(
              `<div class="${cls}"><strong>${escHtml(msg.role)}:</strong><br>${escHtml(msg.content).replace(/\n/g, "<br>")}</div>`,
            );
          } else {
            // Group consecutive tool_use + tool_result into collapsible blocks
            for (const block of msg.content) {
              if (block.type === "text") {
                const cls = msg.role === "user" ? "user" : "assistant";
                // Basic markdown: code blocks get <pre>
                let html = escHtml(block.text);
                html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
                  return `<pre><code>${code}</code></pre>`;
                });
                html = html.replace(
                  /`([^`]+)`/g,
                  '<code style="background:#313244;padding:0.1em 0.3em;border-radius:3px">$1</code>',
                );
                html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
                html = html.replace(/\n/g, "<br>");
                htmlLines.push(
                  `<div class="${cls}"><strong>${escHtml(msg.role)}:</strong><br>${html}</div>`,
                );
              } else if (block.type === "tool_use") {
                const inputStr = escHtml(JSON.stringify(block.input, null, 2).slice(0, 500));
                htmlLines.push(
                  `<div class="tool-group"><div class="tool-header" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('open')">⚡ ${escHtml(block.name)}</div>`,
                );
                htmlLines.push(`<div class="tool-body"><pre>${inputStr}</pre></div></div>`);
              } else if (block.type === "tool_result") {
                const content =
                  typeof block.content === "string" ? block.content.slice(0, 500) : "[complex]";
                const errCls = block.is_error ? " tool-error" : "";
                const icon = block.is_error ? "✗" : "✓";
                htmlLines.push(
                  `<div class="tool-group"><div class="tool-header${errCls}" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('open')">${icon} result</div>`,
                );
                htmlLines.push(`<div class="tool-body"><pre>${escHtml(content)}</pre></div></div>`);
              }
            }
          }
        }

        htmlLines.push(
          '<p class="meta" style="text-align:center;margin-top:2em">Exported by KCode (Kulvex Code by Astrolexis)</p>',
        );
        htmlLines.push("</body></html>");
        writeFileSync(filename, htmlLines.join("\n"), "utf-8");
        return `  Exported ${state.messages.length} messages to ${filename} (HTML)`;
      }

      if (format === "txt") {
        // Plain text export
        const txtLines: string[] = [
          `KCode Conversation Export`,
          `Date: ${new Date().toISOString()}`,
          ``,
        ];

        for (const msg of state.messages) {
          const role = msg.role === "user" ? "User" : "Assistant";
          if (typeof msg.content === "string") {
            txtLines.push(`${role}: ${msg.content}`, ``);
          } else {
            for (const block of msg.content) {
              if (block.type === "text") {
                txtLines.push(`${role}: ${block.text}`, ``);
              } else if (block.type === "tool_use") {
                txtLines.push(`[Tool: ${block.name}]`, ``);
              } else if (block.type === "tool_result") {
                const content =
                  typeof block.content === "string" ? block.content.slice(0, 500) : "[complex]";
                txtLines.push(`[Result${block.is_error ? " (Error)" : ""}]: ${content}`, ``);
              }
            }
          }
        }

        writeFileSync(filename, txtLines.join("\n"), "utf-8");
        return `  Exported ${state.messages.length} messages to ${filename} (TXT)`;
      }

      // Default: Markdown export (existing behavior)
      const lines: string[] = [
        `# KCode Conversation Export\n`,
        `Date: ${new Date().toISOString()}\n`,
      ];

      for (const msg of state.messages) {
        if (typeof msg.content === "string") {
          lines.push(`## ${msg.role === "user" ? "User" : "Assistant"}\n`, msg.content, "");
        } else {
          for (const block of msg.content) {
            if (block.type === "text") {
              lines.push(`## ${msg.role === "user" ? "User" : "Assistant"}\n`, block.text, "");
            } else if (block.type === "tool_use") {
              lines.push(
                `### Tool: ${block.name}\n`,
                "```json",
                JSON.stringify(block.input, null, 2),
                "```",
                "",
              );
            } else if (block.type === "tool_result") {
              const content =
                typeof block.content === "string" ? block.content : JSON.stringify(block.content);
              lines.push(
                `### Result${block.is_error ? " (Error)" : ""}\n`,
                "```",
                content.slice(0, 1000),
                "```",
                "",
              );
            }
          }
        }
      }

      writeFileSync(filename, lines.join("\n"), "utf-8");
      return `  Exported ${state.messages.length} messages to ${filename}`;
    }
    case "fork": {
      const keepCount = args?.trim() ? parseInt(args.trim()) : undefined;
      if (keepCount !== undefined && (isNaN(keepCount) || keepCount < 1)) {
        return "  Usage: /fork [message-number]. Number must be a positive integer.";
      }
      const result = conversationManager.forkConversation(keepCount);
      return `  Forked conversation with ${result.messageCount} messages. New transcript started.`;
    }
    case "replay": {
      const state = conversationManager.getState();
      if (state.messages.length === 0) return "  No messages to replay.";

      const lines = [`  Session Replay (${state.messages.length} messages)\n`];
      let toolCallCount = 0;

      for (let i = 0; i < state.messages.length; i++) {
        const msg = state.messages[i]!;
        const num = `#${(i + 1).toString().padStart(3)}`;

        if (typeof msg.content === "string") {
          const preview = msg.content.split("\n")[0]!.slice(0, 70);
          const icon = msg.role === "user" ? "\u25B6" : "\u25C0";
          lines.push(
            `  ${num} ${icon} [${msg.role}] ${preview}${msg.content.length > 70 ? "..." : ""}`,
          );
        } else {
          // Count blocks
          const textBlocks = msg.content.filter((b) => b.type === "text");
          const toolBlocks = msg.content.filter((b) => b.type === "tool_use");
          const resultBlocks = msg.content.filter((b) => b.type === "tool_result");
          toolCallCount += toolBlocks.length;

          if (textBlocks.length > 0) {
            const firstText = textBlocks[0]!.type === "text" ? textBlocks[0]!.text : "";
            const preview = firstText.split("\n")[0]!.slice(0, 60);
            const icon = msg.role === "user" ? "\u25B6" : "\u25C0";
            lines.push(
              `  ${num} ${icon} [${msg.role}] ${preview}${firstText.length > 60 ? "..." : ""}`,
            );
          }
          if (toolBlocks.length > 0) {
            const toolNames = toolBlocks
              .map((b) => (b.type === "tool_use" ? b.name : "?"))
              .join(", ");
            lines.push(`        \u2699 ${toolBlocks.length} tool(s): ${toolNames}`);
          }
          if (resultBlocks.length > 0) {
            const errors = resultBlocks.filter(
              (b) => b.type === "tool_result" && b.is_error,
            ).length;
            if (errors > 0) lines.push(`        \u2717 ${errors} error(s)`);
          }
        }
      }

      lines.push(``);
      lines.push(`  Summary: ${state.messages.length} messages, ${toolCallCount} tool calls`);
      return lines.join("\n");
    }
    case "bookmark": {
      const { addBookmark, loadBookmarks, getBookmark, removeBookmark } = await import(
        "../../core/bookmarks.js"
      );
      const arg = args?.trim() ?? "list";
      const state = conversationManager.getState();

      if (arg === "list") {
        const bookmarks = loadBookmarks();
        if (bookmarks.length === 0) return "  No bookmarks set. Usage: /bookmark <label>";
        const lines = ["  Bookmarks:\n"];
        for (const b of bookmarks) {
          lines.push(
            `  \u{1F4CC} ${b.label} \u2014 msg #${b.messageIndex} (${b.timestamp.slice(0, 16)})`,
          );
          lines.push(`     ${b.preview}`);
        }
        return lines.join("\n");
      }

      if (arg.startsWith("goto ")) {
        const label = arg.slice(5).trim();
        const bookmark = getBookmark(label);
        if (!bookmark) return `  Bookmark "${label}" not found.`;

        // Truncate conversation to bookmark point
        const msgCount = bookmark.messageIndex;
        if (msgCount >= state.messages.length)
          return `  Bookmark "${label}" points beyond current conversation.`;

        conversationManager.restoreMessages(state.messages.slice(0, msgCount));
        return `  Jumped to bookmark "${label}" (message #${msgCount}). ${state.messages.length - msgCount} messages removed.`;
      }

      if (arg.startsWith("delete ")) {
        const label = arg.slice(7).trim();
        const removed = removeBookmark(label);
        return removed ? `  Deleted bookmark "${label}"` : `  Bookmark "${label}" not found.`;
      }

      // Set a bookmark at the current position
      const label = arg;
      const lastMsg = state.messages[state.messages.length - 1];
      const preview = typeof lastMsg?.content === "string" ? lastMsg.content : "[complex message]";
      const bookmark = addBookmark(label, state.messages.length, preview);
      return `  \u{1F4CC} Bookmark "${label}" set at message #${bookmark.messageIndex}`;
    }
    case "search_chat": {
      if (!args?.trim()) return "  Usage: /search-chat <query>";

      const query = args.trim().toLowerCase();
      const state = conversationManager.getState();
      const matches: string[] = [];

      for (let i = 0; i < state.messages.length; i++) {
        const msg = state.messages[i]!;
        const texts: string[] = [];

        if (typeof msg.content === "string") {
          texts.push(msg.content);
        } else {
          for (const block of msg.content) {
            if (block.type === "text") texts.push(block.text);
            else if (block.type === "tool_use")
              texts.push(`${block.name}: ${JSON.stringify(block.input).slice(0, 200)}`);
          }
        }

        for (const text of texts) {
          if (text.toLowerCase().includes(query)) {
            const lineIdx = text.toLowerCase().indexOf(query);
            const start = Math.max(0, lineIdx - 40);
            const end = Math.min(text.length, lineIdx + query.length + 40);
            const snippet =
              (start > 0 ? "..." : "") +
              text.slice(start, end).replace(/\n/g, " ") +
              (end < text.length ? "..." : "");
            matches.push(`  #${i + 1} [${msg.role}] ${snippet}`);
            break; // One match per message
          }
        }
      }

      if (matches.length === 0)
        return `  No matches for "${args.trim()}" in ${state.messages.length} messages.`;

      return (
        [`  Search: "${args.trim()}" (${matches.length} matches)\n`, ...matches.slice(0, 20)].join(
          "\n",
        ) + (matches.length > 20 ? `\n  ... and ${matches.length - 20} more` : "")
      );
    }
    case "rename": {
      // Handled specially in processMessage since it needs setSessionName
      return `__rename__${args?.trim() ?? ""}`;
    }
    case "session_tags": {
      // Handled specially in processMessage since it needs setSessionTags
      return `__session_tags__${args?.trim() ?? ""}`;
    }
    case "auto_compact": {
      const trimmed = args?.trim() ?? "";

      if (!trimmed) {
        const current = conversationManager.getCompactThreshold();
        if (current <= 0) {
          return `  Auto-compaction: OFF`;
        }
        return `  Auto-compaction threshold: ${Math.round(current * 100)}% of context window`;
      }

      if (trimmed === "off" || trimmed === "disable" || trimmed === "0") {
        conversationManager.setCompactThreshold(0);
        return `  Auto-compaction: OFF`;
      }

      const pct = parseInt(trimmed);
      if (isNaN(pct) || pct < 10 || pct > 99) {
        return `  Invalid threshold. Use a number between 10-99, or 'off'.`;
      }

      conversationManager.setCompactThreshold(pct / 100);
      return `  Auto-compaction threshold set to ${pct}% of context window.`;
    }
    case "snapshot": {
      const { captureSnapshot, saveSnapshot, exportSnapshot } = await import(
        "../../core/session-snapshot.js"
      );
      const state = conversationManager.getState();
      const usage = conversationManager.getUsage();
      const startTime = Date.now() - 60_000; // approximate — real start time not available here

      // Try to get git info
      let gitBranch: string | undefined;
      let gitCommit: string | undefined;
      try {
        const { execSync } = await import("node:child_process");
        gitBranch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: appConfig.workingDirectory,
          timeout: 3000,
        })
          .toString()
          .trim();
        gitCommit = execSync("git rev-parse --short HEAD", {
          cwd: appConfig.workingDirectory,
          timeout: 3000,
        })
          .toString()
          .trim();
      } catch (_) {
        /* not a git repo */
      }

      // Calculate total cost from turn costs
      const turnCosts = conversationManager.getTurnCosts();
      const totalCost = turnCosts.reduce((sum, t) => sum + t.costUsd, 0);

      const snap = captureSnapshot(appConfig, state, usage, startTime, {
        provider: appConfig.model.includes("claude") ? "anthropic" : "openai",
        gitBranch,
        gitCommit,
        totalCost: totalCost > 0 ? totalCost : undefined,
      });

      const filePath = saveSnapshot(snap);

      // Optionally export in a specific format
      const format = args?.trim();
      if (format === "markdown" || format === "md") {
        const md = exportSnapshot(snap, "markdown");
        const { writeFileSync } = await import("node:fs");
        const mdPath = filePath.replace(/\.json$/, ".md");
        writeFileSync(mdPath, md, "utf-8");
        return [
          `  Snapshot captured: ${snap.id}`,
          `  JSON: ${filePath}`,
          `  Markdown: ${mdPath}`,
          ``,
          `  Model: ${snap.model} | Messages: ${snap.messages.length} | Turns: ${snap.turnCount}`,
          `  Tools: ${snap.toolsUsed.join(", ") || "none"}`,
          `  Files modified: ${snap.filesModified.length}`,
        ].join("\n");
      }

      return [
        `  Snapshot captured: ${snap.id}`,
        `  Saved to: ${filePath}`,
        ``,
        `  Model: ${snap.model} | Messages: ${snap.messages.length} | Turns: ${snap.turnCount}`,
        `  Tokens: ${snap.totalTokens.toLocaleString()}${snap.totalCost !== undefined ? ` | Cost: $${snap.totalCost.toFixed(4)}` : ""}`,
        `  Tools: ${snap.toolsUsed.join(", ") || "none"}`,
        `  Files modified: ${snap.filesModified.length}`,
        ``,
        `  View: /snapshots view ${snap.id}`,
        `  List: /snapshots`,
      ].join("\n");
    }
    case "snapshots": {
      const { listSnapshots, loadSnapshot, diffSnapshots, exportSnapshot } = await import(
        "../../core/session-snapshot.js"
      );
      const arg = args?.trim() ?? "";

      // /snapshots view <id>
      if (arg.startsWith("view ")) {
        const id = arg.slice(5).trim();
        const snap = loadSnapshot(id);
        if (!snap) return `  Snapshot not found: ${id}`;

        const md = exportSnapshot(snap, "markdown");
        // Show a truncated version in terminal
        const lines = md.split("\n").slice(0, 40);
        if (md.split("\n").length > 40)
          lines.push("", "  ... (truncated, use /snapshot markdown for full export)");
        return lines.map((l) => `  ${l}`).join("\n");
      }

      // /snapshots diff <id1> <id2>
      if (arg.startsWith("diff ")) {
        const parts = arg.slice(5).trim().split(/\s+/);
        if (parts.length < 2) return "  Usage: /snapshots diff <id1> <id2>";

        const snapA = loadSnapshot(parts[0]!);
        const snapB = loadSnapshot(parts[1]!);
        if (!snapA) return `  Snapshot not found: ${parts[0]}`;
        if (!snapB) return `  Snapshot not found: ${parts[1]}`;

        const diff = diffSnapshots(snapA, snapB);

        const lines = [`  Snapshot Diff: ${parts[0]} vs ${parts[1]}`, ``];

        if (diff.configChanges.length > 0) {
          lines.push(`  Config changes:`);
          for (const c of diff.configChanges) {
            lines.push(`    - ${c}`);
          }
        } else {
          lines.push(`  Config: identical`);
        }

        lines.push(
          `  Messages: ${diff.messageCountDelta >= 0 ? "+" : ""}${diff.messageCountDelta}`,
        );
        lines.push(
          `  Tokens: ${diff.tokenDelta >= 0 ? "+" : ""}${diff.tokenDelta.toLocaleString()}`,
        );
        if (diff.costDelta !== undefined) {
          lines.push(`  Cost: ${diff.costDelta >= 0 ? "+" : ""}$${diff.costDelta.toFixed(4)}`);
        }
        lines.push(
          `  Duration: ${diff.durationDelta >= 0 ? "+" : ""}${Math.round(diff.durationDelta / 1000)}s`,
        );

        if (diff.newTools.length > 0) lines.push(`  New tools: ${diff.newTools.join(", ")}`);
        if (diff.removedTools.length > 0)
          lines.push(`  Removed tools: ${diff.removedTools.join(", ")}`);
        if (diff.newFiles.length > 0) lines.push(`  New files: ${diff.newFiles.join(", ")}`);
        if (diff.removedFiles.length > 0)
          lines.push(`  Removed files: ${diff.removedFiles.join(", ")}`);

        return lines.join("\n");
      }

      // /snapshots [limit]
      const limit = arg ? parseInt(arg) : 20;
      const snapshots = listSnapshots(isNaN(limit) ? 20 : limit);
      if (snapshots.length === 0) return "  No saved snapshots. Use /snapshot to capture one.";

      const lines = [`  Saved Snapshots (${snapshots.length}):\n`];
      for (const s of snapshots) {
        const date = s.createdAt.slice(0, 16).replace("T", " ");
        const dur =
          s.duration < 60_000
            ? `${Math.round(s.duration / 1000)}s`
            : `${Math.round(s.duration / 60_000)}m`;
        lines.push(
          `  ${date}  ${s.model.slice(0, 20).padEnd(20)}  ${s.turnCount} turns  ${s.messageCount} msgs  ${dur}`,
        );
        lines.push(`    ${s.id}`);
      }
      lines.push(`\n  View: /snapshots view <id>`);
      lines.push(`  Diff: /snapshots diff <id1> <id2>`);
      return lines.join("\n");
    }
    case "scan": {
      const { isAuditSession, setAuditIntent } = await import("../../core/session-tracker.js");
      const sub = (args ?? "").trim().toLowerCase();
      const active = isAuditSession();

      if (sub === "status" || sub === "?") {
        return active
          ? "  Scan mode: ON — Edit/MultiEdit on source files is gated by AUDIT_REPORT.md."
          : "  Scan mode: OFF — normal Read/Edit flow.";
      }

      if (sub === "off" || sub === "exit" || sub === "stop") {
        if (!active) return "  Scan mode is already off.";
        setAuditIntent(false);
        return "  Scan mode OFF. Edit/MultiEdit on source files no longer gated.";
      }

      if (active) {
        return "  Scan mode is already ON. Use '/scan off' to exit, '/scan status' to inspect.";
      }
      setAuditIntent(true);
      const lines = [
        "  Scan mode ON.",
        "  Workflow now active:",
        "    1. Grep-first reconnaissance across the source tree",
        "    2. Read at least 10 hot files in full",
        "    3. Write AUDIT_REPORT.md with file:line citations",
        "    4. Source-file edits are BLOCKED until the report cites them",
        "  Exit with: /scan off",
      ];
      return lines.join("\n");
    }
    default:
      return null;
  }
}
