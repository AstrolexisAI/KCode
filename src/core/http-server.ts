// KCode - HTTP API Server
// Exposes KCode as a REST service for IDE integrations and external tools

import type { ConversationManager } from "./conversation";
import { log } from "./logger";

interface ServeOptions {
  port: number;
  host: string;
  apiKey?: string;
}

interface ChatRequest {
  message: string;
  model?: string;
  cwd?: string;
  permission?: string;
  noTools?: boolean;
}

interface ChatResponse {
  id: string;
  response: string;
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    result: string;
    isError: boolean;
  }>;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

interface PromptRequest {
  prompt: string;
  stream?: boolean;
  model?: string;
  cwd?: string;
  noTools?: boolean;
}

interface ToolExecRequest {
  name: string;
  input: Record<string, unknown>;
  cwd?: string; // Optional workspace override (must be absolute, no traversal)
}

// ─── Security ────────────────────────────────────────────────────

// Tools that CAN be executed via HTTP API (allowlist — read-only, no side effects)
export const ALLOWED_HTTP_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "DiffView",
  "GitStatus",
  "GitLog",
  "ToolSearch",
]);

// Legacy blocklist kept as a secondary guard
export const BLOCKED_TOOLS = new Set([
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "Agent",
  "MultiEdit",
  "GrepReplace",
  "Rename",
]);

// Maximum concurrent sessions to prevent memory exhaustion
const MAX_SESSIONS = 20;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ─── Server State ────────────────────────────────────────────────
// Tracks active sessions and agents for the /api/status endpoint

const serverState = {
  startTime: Date.now(),
  activeSessions: new Map<
    string,
    {
      manager: ConversationManager;
      model: string;
      createdAt: number;
      lastActivity: number;
    }
  >(),
  runningAgents: 0,
  totalRequests: 0,
};

// ─── Helpers ─────────────────────────────────────────────────────

function jsonError(message: string, code: number, corsHeaders: Record<string, string>): Response {
  log.warn("http", `Error ${code}: ${message}`);
  return Response.json({ error: message, code }, { status: code, headers: corsHeaders });
}

/** The server's initial working directory, captured at module load time. */
const SERVER_ROOT_CWD = process.cwd();

/** System directories that must never be used as a workspace. */
const BLOCKED_SYSTEM_DIRS = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/var/run",
  "/var/lock",
];

function sanitizeCwd(rawCwd: string): string | null {
  const { resolve, isAbsolute } = require("node:path") as typeof import("node:path");
  const { existsSync, realpathSync } = require("node:fs") as typeof import("node:fs");

  if (!isAbsolute(rawCwd)) return null;
  const resolved = resolve(rawCwd);
  if (!existsSync(resolved)) return null;

  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    return null;
  }

  const home = process.env.HOME ?? "/root";
  if (real === "/" || real === home) return null;

  // cwd must be under the server's initial working directory
  if (!real.startsWith(SERVER_ROOT_CWD + "/") && real !== SERVER_ROOT_CWD) return null;

  // Block system directories — reject if real path equals or is under any blocked dir
  for (const blocked of BLOCKED_SYSTEM_DIRS) {
    if (real === blocked || real.startsWith(blocked + "/")) return null;
  }

  return real;
}

async function getOrCreateSession(
  sessionId: string | undefined,
  opts: { model?: string; cwd?: string; noTools?: boolean },
): Promise<{ manager: ConversationManager; config: any; sid: string }> {
  // Reuse existing session if provided
  if (sessionId && serverState.activeSessions.has(sessionId)) {
    const session = serverState.activeSessions.get(sessionId)!;
    session.lastActivity = Date.now();
    return { manager: session.manager, config: session.manager.getConfig(), sid: sessionId };
  }

  // Evict idle sessions before creating a new one
  evictIdleSessions();

  // Enforce max session limit
  if (serverState.activeSessions.size >= MAX_SESSIONS) {
    throw new Error(
      `Maximum concurrent sessions (${MAX_SESSIONS}) reached. Close an existing session first.`,
    );
  }

  // Create a new session
  const { buildConfig } = await import("./config.js");
  const { registerBuiltinTools } = await import("../tools/index.js");
  const { ConversationManager: CM } = await import("./conversation.js");

  // Sanitize cwd — reuse shared validator
  let cwd = process.cwd();
  if (opts.cwd) {
    const validated = sanitizeCwd(opts.cwd);
    if (!validated) {
      throw new Error(
        `Invalid working directory: "${opts.cwd}" (must be absolute, exist, and not be root or home)`,
      );
    }
    cwd = validated;
  }
  const config = await buildConfig(cwd);
  if (opts.model) config.model = opts.model;

  const tools = opts.noTools
    ? (() => {
        const { ToolRegistry } = require("./tool-registry.js");
        return new ToolRegistry();
      })()
    : registerBuiltinTools().filterTo(ALLOWED_HTTP_TOOLS);
  // SECURITY: HTTP-initiated sessions are restricted to read-only tools.
  // Write/Bash/Edit/Agent require the interactive CLI where the user can approve each action.

  const manager = new CM(config, tools);
  const sid = sessionId ?? crypto.randomUUID();

  serverState.activeSessions.set(sid, {
    manager,
    model: config.model,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  });

  return { manager, config, sid };
}

/** Evict sessions idle for more than SESSION_IDLE_TIMEOUT_MS */
function evictIdleSessions(): void {
  const now = Date.now();
  for (const [sid, session] of serverState.activeSessions) {
    if (now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
      serverState.activeSessions.delete(sid);
      log.info("http", `Evicted idle session ${sid.slice(0, 8)}`);
    }
  }
}

// ─── Route Handler ───────────────────────────────────────────────

export async function handleRoute(
  req: Request,
  url: URL,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  // ── GET /api/health ──────────────────────────────────────────
  if (pathname === "/api/health" && method === "GET") {
    log.info("http", "GET /api/health");
    return Response.json(
      {
        ok: true,
        version: process.env.KCODE_VERSION ?? "unknown",
        model: process.env.KCODE_MODEL ?? "mnemo:mark5-nano",
      },
      { headers: corsHeaders },
    );
  }

  // ── GET /api/status ──────────────────────────────────────────
  if (pathname === "/api/status" && method === "GET") {
    log.info("http", "GET /api/status");

    // Aggregate stats from all active sessions
    let totalTokens = 0;
    let totalToolUse = 0;
    let currentModel = process.env.KCODE_MODEL ?? "mnemo:mark5-nano";
    let currentSessionId: string | null = null;

    for (const [sid, session] of serverState.activeSessions) {
      const state = session.manager.getState();
      const usage = session.manager.getUsage();
      totalTokens += usage.inputTokens + usage.outputTokens;
      totalToolUse += state.toolUseCount;
      currentModel = session.model;
      currentSessionId = sid;
    }

    const contextUsage =
      serverState.activeSessions.size > 0
        ? (() => {
            const [, session] = [...serverState.activeSessions.entries()].pop()!;
            const state = session.manager.getState();
            const config = session.manager.getConfig();
            const contextWindow = config.contextWindowSize ?? 32_000;
            return {
              messageCount: state.messages.length,
              tokenEstimate: state.tokenCount,
              contextWindow,
              usagePercent: Math.round((state.tokenCount / contextWindow) * 100),
            };
          })()
        : { messageCount: 0, tokenEstimate: 0, contextWindow: 32_000, usagePercent: 0 };

    return Response.json(
      {
        model: currentModel,
        sessionId: currentSessionId,
        tokenCount: totalTokens,
        toolUseCount: totalToolUse,
        runningAgents: serverState.runningAgents,
        contextUsage,
        uptime: Math.floor((Date.now() - serverState.startTime) / 1000),
      },
      { headers: corsHeaders },
    );
  }

  // ── POST /api/prompt ─────────────────────────────────────────
  if (pathname === "/api/prompt" && method === "POST") {
    log.info("http", "POST /api/prompt");

    let body: PromptRequest;
    try {
      body = (await req.json()) as PromptRequest;
    } catch {
      return jsonError("Invalid JSON body", 400, corsHeaders);
    }

    if (!body.prompt || typeof body.prompt !== "string") {
      return jsonError("'prompt' is required and must be a string", 400, corsHeaders);
    }

    const sessionId = req.headers.get("X-Session-Id") ?? undefined;

    try {
      const { manager, config, sid } = await getOrCreateSession(sessionId, {
        model: body.model,
        cwd: body.cwd,
        noTools: body.noTools,
      });

      // ── Streaming mode (SSE) ─────────────────────────────────
      if (body.stream) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            serverState.runningAgents++;
            try {
              controller.enqueue(
                encoder.encode(`event: session\ndata: ${JSON.stringify({ sessionId: sid })}\n\n`),
              );

              for await (const event of manager.sendMessage(body.prompt)) {
                if (event.type === "text_delta") {
                  controller.enqueue(
                    encoder.encode(
                      `event: text\ndata: ${JSON.stringify({ text: event.text })}\n\n`,
                    ),
                  );
                } else if (event.type === "tool_result") {
                  controller.enqueue(
                    encoder.encode(
                      `event: tool_result\ndata: ${JSON.stringify({
                        name: event.name,
                        result: event.result,
                        isError: event.isError ?? false,
                      })}\n\n`,
                    ),
                  );
                } else if (event.type === "tool_progress") {
                  controller.enqueue(
                    encoder.encode(
                      `event: tool_progress\ndata: ${JSON.stringify({
                        name: event.name,
                        status: event.status,
                        index: event.index,
                        total: event.total,
                      })}\n\n`,
                    ),
                  );
                } else if (event.type === "turn_start") {
                  controller.enqueue(encoder.encode(`event: turn_start\ndata: {}\n\n`));
                } else if (event.type === "compaction_end") {
                  controller.enqueue(
                    encoder.encode(
                      `event: compaction\ndata: ${JSON.stringify({ tokensAfter: event.tokensAfter })}\n\n`,
                    ),
                  );
                }
              }

              const usage = manager.getUsage();
              controller.enqueue(
                encoder.encode(
                  `event: done\ndata: ${JSON.stringify({
                    sessionId: sid,
                    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
                    model: config.model,
                  })}\n\n`,
                ),
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              controller.enqueue(
                encoder.encode(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`),
              );
              log.error("http", `Prompt stream error: ${msg}`);
            } finally {
              serverState.runningAgents--;
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // ── Non-streaming mode ───────────────────────────────────
      serverState.runningAgents++;
      try {
        const toolResults: ChatResponse["toolCalls"] = [];
        let responseText = "";

        for await (const event of manager.sendMessage(body.prompt)) {
          if (event.type === "text_delta") {
            responseText += event.text;
          } else if (event.type === "tool_result") {
            toolResults.push({
              name: event.name,
              input: {},
              result: event.result,
              isError: event.isError ?? false,
            });
          }
        }

        const usage = manager.getUsage();
        return Response.json(
          {
            id: crypto.randomUUID(),
            sessionId: sid,
            response: responseText,
            toolCalls: toolResults,
            usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
            model: config.model,
          },
          { headers: corsHeaders },
        );
      } finally {
        serverState.runningAgents--;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("http", `Prompt error: ${msg}`);
      return jsonError(msg, 500, corsHeaders);
    }
  }

  // ── GET /api/tools ───────────────────────────────────────────
  if (pathname === "/api/tools" && method === "GET") {
    log.info("http", "GET /api/tools");
    const { registerBuiltinTools } = await import("../tools/index.js");
    const tools = registerBuiltinTools();
    const defs = tools.getDefinitions().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
    return Response.json({ tools: defs }, { headers: corsHeaders });
  }

  // ── GET /api/sessions ────────────────────────────────────────
  if (pathname === "/api/sessions" && method === "GET") {
    log.info("http", "GET /api/sessions");

    const limit = Math.max(
      1,
      Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 200),
    );
    const { TranscriptManager } = await import("./transcript.js");
    const tm = new TranscriptManager();
    const sessions = tm.listSessions().slice(0, limit);

    const result = sessions.map((s) => {
      const summary = tm.getSessionSummary(s.filename);
      return {
        filename: s.filename,
        startedAt: s.startedAt,
        prompt: s.prompt,
        messageCount: summary?.messageCount ?? 0,
        toolUseCount: summary?.toolUseCount ?? 0,
        duration: summary?.duration ?? "unknown",
      };
    });

    // Also include active in-memory sessions
    const activeSessions = [...serverState.activeSessions.entries()].map(([sid, session]) => {
      const state = session.manager.getState();
      return {
        sessionId: sid,
        model: session.model,
        active: true,
        createdAt: new Date(session.createdAt).toISOString(),
        lastActivity: new Date(session.lastActivity).toISOString(),
        messageCount: state.messages.length,
        toolUseCount: state.toolUseCount,
        tokenCount: state.tokenCount,
      };
    });

    return Response.json(
      {
        active: activeSessions,
        recent: result,
      },
      { headers: corsHeaders },
    );
  }

  // ── POST /api/tool ───────────────────────────────────────────
  if (pathname === "/api/tool" && method === "POST") {
    log.info("http", "POST /api/tool");

    let body: ToolExecRequest;
    try {
      body = (await req.json()) as ToolExecRequest;
    } catch {
      return jsonError("Invalid JSON body", 400, corsHeaders);
    }

    if (!body.name || typeof body.name !== "string") {
      return jsonError("'name' is required and must be a string", 400, corsHeaders);
    }
    if (!body.input || typeof body.input !== "object") {
      return jsonError("'input' is required and must be an object", 400, corsHeaders);
    }

    // Security: only allow explicitly approved read-only tools via HTTP
    if (!ALLOWED_HTTP_TOOLS.has(body.name)) {
      const reason = BLOCKED_TOOLS.has(body.name)
        ? "dangerous tool blocked from HTTP execution"
        : "tool not in the HTTP API allowlist (only read-only tools are permitted)";
      return jsonError(
        `Tool "${body.name}" is not allowed via HTTP API: ${reason}`,
        403,
        corsHeaders,
      );
    }

    try {
      const { registerBuiltinTools } = await import("../tools/index.js");
      const tools = registerBuiltinTools();

      if (!tools.has(body.name)) {
        return jsonError(`Unknown tool: "${body.name}"`, 404, corsHeaders);
      }

      // Set workspace for Glob/Grep — same validation as session creation
      const { setToolWorkspace } = await import("../tools/workspace.js");
      const toolCwd =
        body.cwd && typeof body.cwd === "string"
          ? (sanitizeCwd(body.cwd) ?? process.cwd())
          : process.cwd();
      setToolWorkspace(toolCwd);

      // Audit log for tool execution via HTTP
      log.info(
        "http",
        `Executing tool via API: ${body.name} (input keys: ${Object.keys(body.input).join(", ")})`,
      );

      const result = await tools.execute(body.name, body.input);
      return Response.json(
        {
          name: body.name,
          content: result.content,
          isError: result.is_error ?? false,
        },
        { headers: corsHeaders },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("http", `Tool execution error: ${msg}`);
      return jsonError(msg, 500, corsHeaders);
    }
  }

  // ── GET /api/context ─────────────────────────────────────────
  if (pathname === "/api/context" && method === "GET") {
    log.info("http", "GET /api/context");

    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const lastN = Math.max(
      1,
      Math.min(parseInt(url.searchParams.get("lastN") ?? "10", 10) || 10, 200),
    );

    if (sessionId && serverState.activeSessions.has(sessionId)) {
      const session = serverState.activeSessions.get(sessionId)!;
      const state = session.manager.getState();
      const usage = session.manager.getUsage();
      const config = session.manager.getConfig();
      const contextWindow = config.contextWindowSize ?? 32_000;

      // Extract last N messages in a serializable format
      const recentMessages = state.messages.slice(-lastN).map((m) => ({
        role: m.role,
        content:
          typeof m.content === "string"
            ? m.content.slice(0, 500)
            : Array.isArray(m.content)
              ? m.content.map((block: any) => {
                  if (block.type === "text")
                    return { type: "text", text: block.text?.slice(0, 500) };
                  if (block.type === "tool_use") return { type: "tool_use", name: block.name };
                  if (block.type === "tool_result")
                    return { type: "tool_result", content: (block.content ?? "").slice(0, 200) };
                  return { type: block.type };
                })
              : "(unknown)",
      }));

      return Response.json(
        {
          sessionId,
          messageCount: state.messages.length,
          tokenEstimate: state.tokenCount,
          contextWindow,
          usagePercent: Math.round((state.tokenCount / contextWindow) * 100),
          cumulativeUsage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          },
          recentMessages,
        },
        { headers: corsHeaders },
      );
    }

    // No active session — return empty context
    return Response.json(
      {
        sessionId: null,
        messageCount: 0,
        tokenEstimate: 0,
        contextWindow: 32_000,
        usagePercent: 0,
        cumulativeUsage: { inputTokens: 0, outputTokens: 0 },
        recentMessages: [],
      },
      { headers: corsHeaders },
    );
  }

  // ── POST /api/compact ────────────────────────────────────────
  if (pathname === "/api/compact" && method === "POST") {
    log.info("http", "POST /api/compact");

    const sessionId = (() => {
      try {
        const h = req.headers.get("X-Session-Id");
        if (h) return h;
      } catch {
        /* header parsing may fail on malformed requests */
      }
      return undefined;
    })();

    // Find the session to compact
    let targetSid: string | undefined = sessionId;
    if (!targetSid && serverState.activeSessions.size > 0) {
      // Default to the most recently active session
      let latest = 0;
      for (const [sid, session] of serverState.activeSessions) {
        if (session.lastActivity > latest) {
          latest = session.lastActivity;
          targetSid = sid;
        }
      }
    }

    if (!targetSid || !serverState.activeSessions.has(targetSid)) {
      return jsonError("No active session to compact", 404, corsHeaders);
    }

    const session = serverState.activeSessions.get(targetSid)!;
    const stateBefore = session.manager.getState();
    const tokensBefore = stateBefore.tokenCount;
    const messagesBefore = stateBefore.messages.length;

    try {
      const config = session.manager.getConfig();
      const { CompactionManager } = await import("./compaction.js");
      const compactModel = config.tertiaryModel ?? config.fallbackModel ?? config.model;
      const compactor = new CompactionManager(
        config.apiKey,
        compactModel,
        config.apiBase,
        config.customFetch,
      );

      // Compact the middle portion of messages (keep first 2 and last 6)
      const messages = stateBefore.messages;
      if (messages.length <= 8) {
        return Response.json(
          {
            sessionId: targetSid,
            compacted: false,
            reason: "Not enough messages to compact",
            messageCount: messages.length,
            tokenCount: tokensBefore,
          },
          { headers: corsHeaders },
        );
      }

      const keepFirst = 2;
      const keepLast = 6;
      const pruneCount = messages.length - keepFirst - keepLast;
      const toPrune = messages.slice(keepFirst, keepFirst + pruneCount);

      const summary = await compactor.compact(toPrune);
      if (summary) {
        messages.splice(keepFirst, pruneCount, summary);
        const stateAfter = session.manager.getState();

        log.info("http", `Manual compaction: ${messagesBefore} -> ${messages.length} messages`);
        return Response.json(
          {
            sessionId: targetSid,
            compacted: true,
            messagesBefore,
            messagesAfter: messages.length,
            tokensBefore,
            tokensAfter: stateAfter.tokenCount,
          },
          { headers: corsHeaders },
        );
      }

      return Response.json(
        {
          sessionId: targetSid,
          compacted: false,
          reason: "Compaction returned no summary (LLM call may have failed)",
          messageCount: messagesBefore,
          tokenCount: tokensBefore,
        },
        { headers: corsHeaders },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("http", `Compaction error: ${msg}`);
      return jsonError(msg, 500, corsHeaders);
    }
  }

  // ── GET /api/plan ──────────────────────────────────────────
  if (pathname === "/api/plan" && method === "GET") {
    log.info("http", "GET /api/plan");

    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    let targetSid = sessionId;
    if (!targetSid && serverState.activeSessions.size > 0) {
      let latest = 0;
      for (const [sid, session] of serverState.activeSessions) {
        if (session.lastActivity > latest) {
          latest = session.lastActivity;
          targetSid = sid;
        }
      }
    }

    if (!targetSid || !serverState.activeSessions.has(targetSid)) {
      return Response.json({ plan: null, sessionId: null }, { headers: corsHeaders });
    }

    const session = serverState.activeSessions.get(targetSid)!;
    const state = session.manager.getState();

    // Extract plan from conversation state (plans are stored in state.plan)
    const plan = (state as unknown as Record<string, unknown>).plan ?? null;
    return Response.json({ sessionId: targetSid, plan }, { headers: corsHeaders });
  }

  // ── GET /api/mcp ──────────────────────────────────────────
  if (pathname === "/api/mcp" && method === "GET") {
    log.info("http", "GET /api/mcp");

    try {
      const { getMcpManager } = await import("./mcp.js");
      const manager = getMcpManager();
      const status = manager.getServerStatus();
      const tools = manager.discoverTools();

      return Response.json(
        {
          servers: status.map((s) => ({
            name: s.name,
            alive: s.alive,
            toolCount: s.toolCount,
          })),
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
          })),
        },
        { headers: corsHeaders },
      );
    } catch {
      return Response.json({ servers: [], tools: [] }, { headers: corsHeaders });
    }
  }

  // ── GET /api/session/:filename ──────────────────────────────
  if (pathname.startsWith("/api/session/") && method === "GET") {
    const filename = decodeURIComponent(pathname.slice("/api/session/".length));
    log.info("http", `GET /api/session/${filename}`);

    // Validate filename — must not contain path traversal
    if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\0")) {
      return jsonError("Invalid filename", 400, corsHeaders);
    }

    try {
      const { TranscriptManager } = await import("./transcript.js");
      const tm = new TranscriptManager();
      const entries = tm.loadSession(filename);

      if (!entries || entries.length === 0) {
        return jsonError("Session not found or empty", 404, corsHeaders);
      }

      // Return entries in a display-friendly format
      const messages = entries
        .map((entry: any) => ({
          role: entry.type === "user_message" ? "user" : "assistant",
          content: typeof entry.content === "string" ? entry.content.slice(0, 2000) : "",
        }))
        .filter((m: any) => m.content);

      return Response.json(
        {
          filename,
          messageCount: messages.length,
          messages: messages.slice(0, 100), // Limit to last 100 messages
        },
        { headers: corsHeaders },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(msg, 500, corsHeaders);
    }
  }

  // ── GET /api/agents ───────────────────────────────────────
  if (pathname === "/api/agents" && method === "GET") {
    log.info("http", "GET /api/agents");

    try {
      const { listAllAgents } = await import("./custom-agents.js");
      const { getRunningAgentsSummary } = await import("../tools/agent.js");

      // Validate cwd — only use process.cwd(), ignore user-supplied cwd to prevent path traversal
      const cwd = process.cwd();
      const agents = listAllAgents(cwd);
      const running = getRunningAgentsSummary();

      return Response.json(
        {
          available: agents.map((a) => ({
            name: a.name,
            description: a.description,
            model: a.model,
            effort: a.effort,
            memory: a.memory,
          })),
          running,
        },
        { headers: corsHeaders },
      );
    } catch {
      return Response.json({ available: [], running: [] }, { headers: corsHeaders });
    }
  }

  // ── Legacy endpoints (v1) ────────────────────────────────────
  // Keep backward compatibility with existing /v1/* endpoints

  if (url.pathname === "/health" || url.pathname === "/") {
    return Response.json(
      {
        status: "ok",
        version: process.env.KCODE_VERSION ?? "unknown",
        uptime: process.uptime(),
      },
      { headers: corsHeaders },
    );
  }

  if (url.pathname === "/v1/chat" && method === "POST") {
    try {
      const body = (await req.json()) as ChatRequest;
      if (!body.message) {
        return jsonError("message is required", 400, corsHeaders);
      }

      const { manager, config, sid } = await getOrCreateSession(undefined, {
        model: body.model,
        cwd: body.cwd,
        noTools: body.noTools,
      });

      const toolResults: ChatResponse["toolCalls"] = [];
      let responseText = "";

      serverState.runningAgents++;
      try {
        for await (const event of manager.sendMessage(body.message)) {
          if (event.type === "text_delta") {
            responseText += event.text;
          } else if (event.type === "tool_result") {
            toolResults.push({
              name: event.name,
              input: {},
              result: event.result,
              isError: event.isError ?? false,
            });
          }
        }
      } finally {
        serverState.runningAgents--;
      }

      const usage = manager.getUsage();
      const result: ChatResponse = {
        id: crypto.randomUUID(),
        response: responseText,
        toolCalls: toolResults,
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
        model: config.model,
      };

      return Response.json(result, { headers: corsHeaders });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("http", `Chat error: ${msg}`);
      return jsonError(msg, 500, corsHeaders);
    }
  }

  if (url.pathname === "/v1/tools" && method === "GET") {
    const { registerBuiltinTools } = await import("../tools/index.js");
    const tools = registerBuiltinTools();
    const defs = tools.getDefinitions().map((t) => ({ name: t.name, description: t.description }));
    return Response.json({ tools: defs }, { headers: corsHeaders });
  }

  if (url.pathname === "/v1/skills" && method === "GET") {
    const { builtinSkills } = await import("./builtin-skills.js");
    const skills = builtinSkills.map((s) => ({
      name: s.name,
      description: s.description,
      aliases: s.aliases,
    }));
    return Response.json({ skills }, { headers: corsHeaders });
  }

  // ── Stripe Webhook ──────────────────────────────────────────────

  if (pathname === "/api/webhook/stripe" && method === "POST") {
    try {
      const { loadPaymentConfig, verifyWebhookSignature, handleWebhookEvent } = await import(
        "./payments.js"
      );
      const config = await loadPaymentConfig();
      if (!config.stripeWebhookSecret) {
        return jsonError("Webhook not configured", 503, corsHeaders);
      }
      const payload = await req.text();
      const signature = req.headers.get("stripe-signature") ?? "";
      if (!verifyWebhookSignature(payload, signature, config.stripeWebhookSecret)) {
        return jsonError("Invalid signature", 401, corsHeaders);
      }
      const event = JSON.parse(payload);
      await handleWebhookEvent(event);
      return Response.json({ received: true }, { headers: corsHeaders });
    } catch (err) {
      log.warn("webhook", `Stripe webhook error: ${err instanceof Error ? err.message : err}`);
      return jsonError("Webhook processing failed", 500, corsHeaders);
    }
  }

  return jsonError("Not Found", 404, corsHeaders);
}

// ─── Server Entry Point ──────────────────────────────────────────

/**
 * Build the top-level fetch handler with auth + CORS + routing.
 * Exported so E2E tests can use the exact same code path as production.
 */
export function buildFetchHandler(apiKey?: string): (req: Request) => Promise<Response> {
  return async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // CORS headers for IDE integrations — restrict to localhost origins
    const origin = req.headers.get("Origin") ?? "";
    const isLocalOrigin =
      /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(origin) ||
      origin.startsWith("vscode-webview://");
    const corsHeaders = {
      "Access-Control-Allow-Origin": isLocalOrigin ? origin : "http://localhost",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Id",
      Vary: "Origin",
    };

    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Auth check
    if (apiKey) {
      const authHeader = req.headers.get("Authorization");
      if (authHeader !== `Bearer ${apiKey}`) {
        return jsonError("Unauthorized", 401, corsHeaders);
      }
    }

    serverState.totalRequests++;

    try {
      return await handleRoute(req, url, corsHeaders);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("http", `Unhandled error: ${msg}`);
      return jsonError("Internal Server Error", 500, corsHeaders);
    }
  };
}

export async function startHttpServer(options: ServeOptions): Promise<void> {
  const { requirePro } = await import("./pro.js");
  await requirePro("http-server");

  const { port, apiKey } = options;
  // Default to loopback — binding to 0.0.0.0 without auth is RCE from the network
  const host =
    options.host === "0.0.0.0" || options.host === "::"
      ? options.host
      : options.host || "127.0.0.1";
  const isExposed = host === "0.0.0.0" || host === "::";

  if (isExposed && !apiKey) {
    console.error(
      `\x1b[33m⚠ WARNING: HTTP server binding to ${host} WITHOUT authentication.\x1b[0m`,
    );
    console.error(`  Anyone on your network can execute commands via /api/prompt.`);
    console.error(`  Set --api-key to require authentication, or bind to 127.0.0.1.\n`);
  }

  serverState.startTime = Date.now();

  const server = Bun.serve({
    port,
    hostname: host,
    fetch: buildFetchHandler(apiKey),
  });

  console.log(
    `\x1b[32m✓\x1b[0m KCode HTTP API server running at \x1b[1mhttp://${host}:${port}\x1b[0m`,
  );
  console.log(`\n  IDE Integration Endpoints (new):`);
  console.log(`    GET  /api/health     — Health check { ok, version, model }`);
  console.log(`    GET  /api/status     — Server status { model, sessionId, tokenCount, ... }`);
  console.log(`    POST /api/prompt     — Send prompt (supports SSE streaming)`);
  console.log(`    GET  /api/tools      — List tools with full schemas`);
  console.log(`    GET  /api/sessions   — List active + recent sessions`);
  console.log(`    POST /api/tool       — Execute a single tool directly`);
  console.log(`    GET  /api/context    — Get conversation context summary`);
  console.log(`    POST /api/compact    — Trigger manual compaction`);
  console.log(`\n  Legacy Endpoints:`);
  console.log(`    GET  /health         — Server health check`);
  console.log(`    POST /v1/chat        — Send a message`);
  console.log(`    GET  /v1/tools       — List available tools`);
  console.log(`    GET  /v1/skills      — List available skills`);
  if (apiKey) {
    console.log(`\n  Auth: Bearer token required (set via --api-key)`);
  } else {
    console.log(`\n  \x1b[33mAuth: NONE — set --api-key for production use\x1b[0m`);
  }
  console.log(`\n  Press Ctrl+C to stop.\n`);

  log.info("http", `HTTP server started on ${host}:${port}`);

  // Keep process alive
  await new Promise(() => {
    process.on("SIGINT", () => {
      server.stop();
      console.log("\n  Server stopped.");
      process.exit(0);
    });
  });
}
