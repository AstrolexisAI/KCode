// KCode - Web UI REST API
// Endpoint handlers for /api/v1/* routes

import { join, normalize, resolve, sep } from "node:path";
import { log } from "../core/logger";
import { getActiveModel, getConversationManager, getWorkingDirectory } from "./session-bridge";
import type { ServerEvent } from "./types";

// ─── Helpers ────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function error(msg: string, status = 400): Response {
  return Response.json({ error: msg }, { status });
}

function parseIntParam(url: URL, name: string, defaultValue: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

// ─── Route Dispatcher ───────────────────────────────────────────

export async function handleApiRequest(req: Request, pathname: string): Promise<Response> {
  const method = req.method;
  const url = new URL(req.url);

  try {
    // Strip /api/v1 prefix
    const route = pathname.replace(/^\/api\/v1/, "");

    // POST /api/v1/messages
    if (route === "/messages" && method === "POST") return handleSendMessage(req);
    // GET /api/v1/messages
    if (route === "/messages" && method === "GET") return handleGetMessages(url);
    // GET /api/v1/session
    if (route === "/session" && method === "GET") return handleGetSession();
    // POST /api/v1/cancel
    if (route === "/cancel" && method === "POST") return handleCancel();
    // GET /api/v1/files
    if (route === "/files" && method === "GET") return handleListFiles(url);
    // GET /api/v1/files/:path (encoded path after /files/)
    if (route.startsWith("/files/") && method === "GET") return handleReadFile(route.slice(7));
    // GET /api/v1/tools
    if (route === "/tools" && method === "GET") return handleListTools();
    // GET /api/v1/stats
    if (route === "/stats" && method === "GET") return handleGetStats();
    // GET /api/v1/config
    if (route === "/config" && method === "GET") return handleGetConfig();
    // GET /api/v1/models
    if (route === "/models" && method === "GET") return handleListModels();
    // POST /api/v1/model
    if (route === "/model" && method === "POST") return handleSwitchModel(req);
    // GET /api/v1/plan
    if (route === "/plan" && method === "GET") return handleGetPlan();
    // POST /api/v1/permission/:id
    if (route.startsWith("/permission/") && method === "POST")
      return handlePermissionResponse(req, route.slice(12));
    // GET /api/v1/health
    if (route === "/health" && method === "GET")
      return json({ status: "ok", timestamp: Date.now() });

    return error("Not found", 404);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("web-api", `Error handling ${method} ${pathname}: ${msg}`);
    return error("Internal server error", 500);
  }
}

// ─── Endpoint Handlers ──────────────────────────────────────────

async function handleGetSession(): Promise<Response> {
  const manager = getConversationManager();
  if (!manager) {
    return json({
      model: getActiveModel(),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      messageCount: 0,
      sessionId: null,
    });
  }

  const usage = manager.getUsage();
  const state = manager.getState();
  let costUsd = 0;
  try {
    const { getModelPricing, calculateCost } = await import("../core/pricing.js");
    const pricing = await getModelPricing(manager.getConfig().model);
    if (pricing) {
      costUsd = calculateCost(pricing, usage.inputTokens, usage.outputTokens);
    }
  } catch {
    /* pricing not available */
  }

  return json({
    model: manager.getConfig().model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd,
    messageCount: state.messages.length,
    sessionId: manager.getSessionId(),
  });
}

async function handleGetMessages(url: URL): Promise<Response> {
  const manager = getConversationManager();
  if (!manager) {
    return json({ messages: [], total: 0 });
  }

  const state = manager.getState();
  const limit = parseIntParam(url, "limit", 50);
  const offset = parseIntParam(url, "offset", 0);
  const total = state.messages.length;

  // Convert internal messages to serializable format
  const messages = state.messages.slice(offset, offset + limit).map((msg, i) => ({
    index: offset + i,
    role: msg.role,
    content: serializeContent(msg.content),
    timestamp: Date.now(), // Messages don't store timestamps internally
  }));

  return json({ messages, total, limit, offset });
}

async function handleSendMessage(req: Request): Promise<Response> {
  const manager = getConversationManager();
  if (!manager) {
    return error("No active session. Start KCode first.", 503);
  }

  let body: { content?: string };
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body");
  }

  if (!body.content || typeof body.content !== "string") {
    return error("Missing or invalid 'content' field");
  }

  // The actual message processing happens via WebSocket streaming.
  // This REST endpoint enqueues the message and returns immediately.
  const { enqueueMessage } = await import("./ws-handler.js");
  const messageId = enqueueMessage(body.content);

  return json({ queued: true, messageId }, 202);
}

async function handleCancel(): Promise<Response> {
  const manager = getConversationManager();
  if (!manager) {
    return error("No active session", 503);
  }

  manager.abort();
  return json({ cancelled: true });
}

async function handleListFiles(url: URL): Promise<Response> {
  const cwd = getWorkingDirectory();
  const pattern = url.searchParams.get("pattern") ?? "**/*";
  const maxResults = parseIntParam(url, "limit", 200);

  try {
    const glob = new Bun.Glob(pattern);
    const files: string[] = [];
    for await (const file of glob.scan({ cwd, onlyFiles: true })) {
      files.push(file);
      if (files.length >= maxResults) break;
    }
    return json({ files, cwd, pattern, total: files.length });
  } catch (err) {
    return error(`Glob error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleReadFile(encodedPath: string): Promise<Response> {
  const cwd = getWorkingDirectory();
  const requestedPath = decodeURIComponent(encodedPath);

  // Resolve against cwd and ensure no path traversal.
  //
  // Security fix: plain startsWith comparison is INSUFFICIENT because
  // "/home/curly/KCode-other/secret.txt" startsWith "/home/curly/KCode"
  // returns true and bypasses the check. The requested path must
  // either equal the cwd exactly or be prefixed with cwd + path
  // separator so sibling-directory traversal is impossible.
  const resolved = resolve(cwd, requestedPath);
  const normalizedCwd = normalize(cwd).replace(new RegExp(`${sep.replace(/[/\\]/g, "\\$&")}+$`), "");
  const cwdWithSep = normalizedCwd + sep;
  if (resolved !== normalizedCwd && !resolved.startsWith(cwdWithSep)) {
    return error("Path traversal denied", 403);
  }

  try {
    const file = Bun.file(resolved);
    const exists = await file.exists();
    if (!exists) {
      return error("File not found", 404);
    }

    const size = file.size;
    // Limit file reads to 1MB to prevent memory issues
    if (size > 1_048_576) {
      return error("File too large (max 1MB via API)", 413);
    }

    const content = await file.text();
    return json({ path: requestedPath, content, size });
  } catch (err) {
    return error(`Read error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleListTools(): Promise<Response> {
  try {
    const { registerBuiltinTools } = await import("../tools/index.js");
    const registry = registerBuiltinTools();
    const tools = registry.getDefinitions().map((def) => ({
      name: def.name,
      description: def.description,
    }));
    return json({ tools, count: tools.length });
  } catch {
    return json({ tools: [], count: 0 });
  }
}

async function handleGetStats(): Promise<Response> {
  const manager = getConversationManager();
  if (!manager) {
    return json({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      turnCosts: [],
      model: getActiveModel(),
    });
  }

  const usage = manager.getUsage();
  const turnCosts = manager.getTurnCosts();
  let costUsd = 0;
  try {
    const { getModelPricing, calculateCost } = await import("../core/pricing.js");
    const pricing = await getModelPricing(manager.getConfig().model);
    if (pricing) {
      costUsd = calculateCost(pricing, usage.inputTokens, usage.outputTokens);
    }
  } catch {
    /* pricing not available */
  }

  return json({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    costUsd,
    turnCosts: turnCosts.slice(-20), // Last 20 turns
    model: manager.getConfig().model,
  });
}

async function handleGetConfig(): Promise<Response> {
  const manager = getConversationManager();
  const config = manager?.getConfig();

  if (!config) {
    return json({ model: getActiveModel(), workingDirectory: getWorkingDirectory() });
  }

  // Redact sensitive fields
  return json({
    model: config.model,
    maxTokens: config.maxTokens,
    permissionMode: config.permissionMode,
    workingDirectory: config.workingDirectory,
    effortLevel: config.effortLevel ?? "medium",
    compactThreshold: config.compactThreshold,
    contextWindowSize: config.contextWindowSize,
    theme: config.theme,
    fallbackModel: config.fallbackModel,
    pro: config.pro ?? false,
    // Explicitly omit: apiKey, anthropicApiKey, proKey
  });
}

async function handleListModels(): Promise<Response> {
  try {
    const { listModels } = await import("../core/models.js");
    const models = await listModels();
    const formatted = models.map((m) => ({
      id: m.name,
      name: m.name,
      provider: m.provider ?? "openai",
      contextWindow: m.contextSize,
    }));
    return json({ models: formatted, active: getActiveModel() });
  } catch {
    return json({ models: [], active: getActiveModel() });
  }
}

async function handleSwitchModel(req: Request): Promise<Response> {
  let body: { model?: string };
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body");
  }

  if (!body.model || typeof body.model !== "string") {
    return error("Missing or invalid 'model' field");
  }

  const { switchModel } = await import("./ws-handler.js");
  const result = switchModel(body.model);
  if (!result.success) {
    return error(result.error ?? "Failed to switch model", 400);
  }

  return json({ model: body.model, switched: true });
}

async function handleGetPlan(): Promise<Response> {
  try {
    const { getActivePlan } = await import("../tools/plan.js");
    const plan = getActivePlan();
    if (!plan) {
      return json({ plan: null });
    }
    return json({ plan });
  } catch {
    return json({ plan: null });
  }
}

async function handlePermissionResponse(req: Request, permissionId: string): Promise<Response> {
  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body");
  }

  const action = body.action;
  if (action !== "allow" && action !== "deny" && action !== "always_allow") {
    return error("Invalid action. Must be 'allow', 'deny', or 'always_allow'");
  }

  const { resolvePermission } = await import("./ws-handler.js");
  const resolved = resolvePermission(permissionId, action);
  if (!resolved) {
    return error("Permission request not found or already resolved", 404);
  }

  return json({ resolved: true, action });
}

// ─── Utilities ──────────────────────────────────────────────────

function serializeContent(content: string | import("../core/types").ContentBlock[]): string {
  if (typeof content === "string") return content;

  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "thinking":
        parts.push(`[thinking] ${block.thinking}`);
        break;
      case "tool_use":
        parts.push(`[tool: ${block.name}]`);
        break;
      case "tool_result": {
        const text =
          typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        parts.push(`[result${block.is_error ? " (error)" : ""}] ${text}`);
        break;
      }
    }
  }
  return parts.join("\n");
}
