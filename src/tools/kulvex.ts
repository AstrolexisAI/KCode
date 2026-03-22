// KCode - Kulvex Bridge Tool
// Connects KCode to the Kulvex API (Jarvis backend) running on localhost:9100.
// Enables KCode to use Kulvex's 73 orchestrator tools, channels, home automation, etc.

import type { ToolDefinition, ToolResult } from "../core/types";
import { log } from "../core/logger";

// ─── Constants ───────────────────────────────────────────────────

const KULVEX_API_BASE = process.env.KULVEX_API_BASE ?? "http://localhost:9100";
const KULVEX_API_KEY = process.env.KULVEX_API_KEY ?? process.env.ASTROLEXIS_API_KEY ?? "";
const REQUEST_TIMEOUT = 30_000; // 30 seconds

// ─── Tool Definition ────────────────────────────────────────────

export const kulvexDefinition: ToolDefinition = {
  name: "Kulvex",
  description: `Bridge to the Kulvex platform (localhost:9100). Use this to interact with Kulvex services that KCode doesn't have natively:

- **Messaging**: Send messages via Telegram, WhatsApp, Discord, Slack, Signal, Matrix
  action: "send_message", params: { channel: "telegram", message: "text", chat_id?: "..." }
- **Home automation**: Control lights, switches, sensors via Home Assistant
  action: "home", params: { command: "turn_on|turn_off|state", entity_id: "light.living_room" }
- **Image generation**: Generate images via cloud API (Flux, DALL-E)
  action: "image_gen", params: { prompt: "description", width?: 1024, height?: 1024 }
- **Voice**: Text-to-speech synthesis
  action: "tts", params: { text: "hello", voice?: "nova" }
- **Research**: Deep web research with browser automation
  action: "research", params: { query: "topic to research" }
- **Memory**: Query Kulvex's knowledge graph and memory store
  action: "memory", params: { query: "what do you know about X" }
- **Server**: Query server status, processes, containers
  action: "server", params: { command: "status|processes|containers" }
- **Custom**: Call any Kulvex API endpoint directly
  action: "api", params: { method: "GET|POST", path: "/api/...", body?: {} }

Only use this tool when KCode's built-in tools are insufficient for the task.`,
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "The Kulvex action to perform",
        enum: ["send_message", "home", "image_gen", "tts", "research", "memory", "server", "api"],
      },
      params: {
        type: "object",
        description: "Parameters for the action",
      },
    },
    required: ["action", "params"],
  },
};

// ─── Action Handlers ────────────────────────────────────────────

interface ActionParams {
  [key: string]: unknown;
}

async function kulvexFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const url = `${KULVEX_API_BASE}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (KULVEX_API_KEY) {
    headers["Authorization"] = `Bearer ${KULVEX_API_KEY}`;
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Kulvex API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  return resp.json();
}

const actionHandlers: Record<string, (params: ActionParams) => Promise<string>> = {
  async send_message(params) {
    const { channel, message, chat_id } = params as { channel: string; message: string; chat_id?: string };
    const data = await kulvexFetch("POST", "/api/channels/send", {
      channel,
      message,
      chat_id,
    });
    return `Message sent via ${channel}: ${data.status ?? "ok"}`;
  },

  async home(params) {
    const { command, entity_id, ...extra } = params as { command: string; entity_id?: string };
    const data = await kulvexFetch("POST", "/api/home/control", {
      command,
      entity_id,
      ...extra,
    });
    return JSON.stringify(data, null, 2);
  },

  async image_gen(params) {
    const data = await kulvexFetch("POST", "/api/image-gen/generate", params);
    return `Image generated: ${data.url ?? data.path ?? "saved"}`;
  },

  async tts(params) {
    const data = await kulvexFetch("POST", "/api/voice/tts", params);
    return `Audio generated: ${data.path ?? "ok"}`;
  },

  async research(params) {
    const { query } = params as { query: string };
    const data = await kulvexFetch("POST", "/api/intelligence/research", { query });
    return typeof data.result === "string" ? data.result : JSON.stringify(data, null, 2);
  },

  async memory(params) {
    const { query } = params as { query: string };
    const data = await kulvexFetch("POST", "/api/memory/search", { query });
    if (Array.isArray(data.results)) {
      return data.results.map((r: any) => `- ${r.content ?? r.text ?? JSON.stringify(r)}`).join("\n");
    }
    return JSON.stringify(data, null, 2);
  },

  async server(params) {
    const { command } = params as { command: string };
    const endpoints: Record<string, string> = {
      status: "/api/server/status",
      processes: "/api/server/processes",
      containers: "/api/server/containers",
    };
    const path = endpoints[command] ?? `/api/server/${command}`;
    const data = await kulvexFetch("GET", path);
    return JSON.stringify(data, null, 2);
  },

  async api(params) {
    const { method, path, body } = params as { method: string; path: string; body?: unknown };
    const data = await kulvexFetch(method ?? "GET", path, body);
    return typeof data === "string" ? data : JSON.stringify(data, null, 2);
  },
};

// ─── Executor ───────────────────────────────────────────────────

export async function executeKulvex(input: Record<string, unknown>): Promise<ToolResult> {
  const { action, params } = input as { action: string; params: ActionParams };

  // Check if Kulvex API is reachable
  try {
    await fetch(`${KULVEX_API_BASE}/api/monitoring/health`, {
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    return {
      tool_use_id: "",
      content: `Kulvex API is not reachable at ${KULVEX_API_BASE}. Make sure the Kulvex backend is running (systemctl --user status kulvex-api). You can also set KULVEX_API_BASE env var if it's on a different host.`,
      is_error: true,
    };
  }

  const handler = actionHandlers[action];
  if (!handler) {
    return {
      tool_use_id: "",
      content: `Unknown Kulvex action: "${action}". Available actions: ${Object.keys(actionHandlers).join(", ")}`,
      is_error: true,
    };
  }

  try {
    log.info("tool", `Kulvex bridge: ${action} ${JSON.stringify(params).slice(0, 100)}`);
    const result = await handler(params);
    return { tool_use_id: "", content: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("tool", `Kulvex bridge error: ${msg}`);
    return {
      tool_use_id: "",
      content: `Kulvex error: ${msg}`,
      is_error: true,
    };
  }
}
