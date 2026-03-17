// KCode - HTTP API Server
// Exposes KCode as a REST service for IDE integrations and external tools

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
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string; isError: boolean }>;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export async function startHttpServer(options: ServeOptions): Promise<void> {
  const { port, host, apiKey } = options;

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS headers for IDE integrations
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      };

      // Preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Auth check
      if (apiKey) {
        const authHeader = req.headers.get("Authorization");
        if (authHeader !== `Bearer ${apiKey}`) {
          return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }
      }

      // Health check
      if (url.pathname === "/health" || url.pathname === "/") {
        return Response.json({
          status: "ok",
          version: process.env.KCODE_VERSION ?? "unknown",
          uptime: process.uptime(),
        }, { headers: corsHeaders });
      }

      // Chat endpoint
      if (url.pathname === "/v1/chat" && req.method === "POST") {
        try {
          const body = await req.json() as ChatRequest;
          if (!body.message) {
            return Response.json({ error: "message is required" }, { status: 400, headers: corsHeaders });
          }

          const { buildConfig } = await import("./config.js");
          const { registerBuiltinTools } = await import("../tools/index.js");
          const { ConversationManager } = await import("./conversation.js");

          const cwd = body.cwd ?? process.cwd();
          const config = await buildConfig(cwd);
          if (body.model) config.model = body.model;
          if (body.permission) config.permissionMode = body.permission as any;

          // In no-tools mode, create a minimal tool registry
          const tools = body.noTools ? (() => {
            const { ToolRegistry } = require("./tool-registry.js");
            return new ToolRegistry();
          })() : registerBuiltinTools();

          const manager = new ConversationManager(config, tools);
          const toolResults: ChatResponse["toolCalls"] = [];
          let responseText = "";

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
          return Response.json({ error: msg }, { status: 500, headers: corsHeaders });
        }
      }

      // Tools list endpoint
      if (url.pathname === "/v1/tools" && req.method === "GET") {
        const { registerBuiltinTools } = await import("../tools/index.js");
        const tools = registerBuiltinTools();
        const defs = tools.getDefinitions().map(t => ({ name: t.name, description: t.description }));
        return Response.json({ tools: defs }, { headers: corsHeaders });
      }

      // Skills list endpoint
      if (url.pathname === "/v1/skills" && req.method === "GET") {
        const { builtinSkills } = await import("./builtin-skills.js");
        const skills = builtinSkills.map(s => ({ name: s.name, description: s.description, aliases: s.aliases }));
        return Response.json({ skills }, { headers: corsHeaders });
      }

      return Response.json({ error: "Not Found" }, { status: 404, headers: corsHeaders });
    },
  });

  console.log(`\x1b[32m✓\x1b[0m KCode HTTP API server running at \x1b[1mhttp://${host}:${port}\x1b[0m`);
  console.log(`\n  Endpoints:`);
  console.log(`    GET  /health      — Server health check`);
  console.log(`    POST /v1/chat     — Send a message (body: { message, model?, cwd?, noTools? })`);
  console.log(`    GET  /v1/tools    — List available tools`);
  console.log(`    GET  /v1/skills   — List available skills`);
  if (apiKey) {
    console.log(`\n  Auth: Bearer token required (set via --api-key)`);
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
