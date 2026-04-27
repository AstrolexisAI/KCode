// KCode - Web UI WebSocket Handler
// Handles client WebSocket messages and bridges to ConversationManager

import type { ServerWebSocket } from "bun";
import { log } from "../core/logger";
import type { StreamEvent } from "../core/types";
import { getActiveModel, getConversationManager, setActiveModel } from "./session-bridge";
import type { ClientEvent, PendingPermission, ServerEvent, WebSessionContext } from "./types";

// ─── State ──────────────────────────────────────────────────────

const sessionContext: WebSessionContext = {
  sessionId: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  model: "unknown",
  startTime: Date.now(),
  messageIdCounter: 0,
};

const pendingPermissions = new Map<string, PendingPermission>();
let activeGenerator: AsyncGenerator<StreamEvent> | null = null;
let isProcessing = false;
const messageQueue: Array<{ content: string; id: string }> = [];

// Broadcast callback (set by server.ts)
type BroadcastFn = (event: ServerEvent) => void;

// Module-level broadcast reference. Set the first time server.ts hands us
// one (on WebSocket connect / first client message). enqueueMessage uses
// this to drain the queue even when the REST endpoint fires before any
// WebSocket has connected — otherwise POST /api/v1/messages would enqueue
// and never process, because processQueue only ran from inside
// handleMessageSend.finally().
let storedBroadcast: BroadcastFn | null = null;

/** Register the broadcast function so REST enqueue can drain the queue. */
export function setBroadcastFn(fn: BroadcastFn): void {
  storedBroadcast = fn;
}

// ─── Public API ─────────────────────────────────────────────────

/** Initialize or return session context */
export function setSessionContext(): WebSessionContext {
  sessionContext.model = getActiveModel();
  return sessionContext;
}

/** Handle an incoming WebSocket message from a client */
export function handleClientMessage(
  ws: ServerWebSocket<unknown>,
  raw: string,
  broadcast: BroadcastFn,
): void {
  const event = parseClientEvent(raw);
  if (!event) {
    log.debug("web-ws", `Invalid client event: ${raw.slice(0, 100)}`);
    return;
  }

  handleClientEvent(event, broadcast).catch((err) => {
    log.warn("web-ws", `Error handling event ${event.type}: ${err}`);
    broadcast({ type: "error", message: String(err), retryable: false });
  });
}

/** Enqueue a message for processing (called from REST API) */
export function enqueueMessage(content: string): string {
  const id = `msg-${++sessionContext.messageIdCounter}`;
  messageQueue.push({ content, id });
  // Drain immediately if we have a broadcast and nothing is running. Without
  // this a POST /api/v1/messages made before any WebSocket has connected
  // would queue the message and wait forever.
  if (storedBroadcast && !isProcessing) {
    processQueue(storedBroadcast);
  }
  return id;
}

/** Resolve a pending permission request */
export function resolvePermission(id: string, action: "allow" | "deny" | "always_allow"): boolean {
  const pending = pendingPermissions.get(id);
  if (!pending) return false;

  pending.resolve(action);
  pendingPermissions.delete(id);
  return true;
}

/** Switch the active model */
export function switchModel(model: string): { success: boolean; error?: string } {
  const manager = getConversationManager();
  if (!manager) {
    return { success: false, error: "No active session" };
  }

  try {
    const config = manager.getConfig();
    (config as unknown as Record<string, unknown>).model = model;
    setActiveModel(model);
    sessionContext.model = model;
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ─── Event Parsing ──────────────────────────────────────────────

function parseClientEvent(raw: string): ClientEvent | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.type !== "string") return null;

    switch (parsed.type) {
      case "message.send":
        if (typeof parsed.content !== "string" || !parsed.content.trim()) return null;
        return { type: "message.send", content: parsed.content };

      case "message.cancel":
        return { type: "message.cancel" };

      case "permission.respond":
        if (!parsed.id || !["allow", "deny", "always_allow"].includes(parsed.action)) return null;
        return { type: "permission.respond", id: parsed.id, action: parsed.action };

      case "model.switch":
        if (typeof parsed.model !== "string") return null;
        return { type: "model.switch", model: parsed.model };

      case "command.run":
        if (typeof parsed.command !== "string") return null;
        return { type: "command.run", command: parsed.command };

      case "file.read":
        if (typeof parsed.path !== "string") return null;
        return { type: "file.read", path: parsed.path };

      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ─── Event Handlers ─────────────────────────────────────────────

async function handleClientEvent(event: ClientEvent, broadcast: BroadcastFn): Promise<void> {
  switch (event.type) {
    case "message.send":
      return handleMessageSend(event.content, broadcast);

    case "message.cancel":
      return handleMessageCancel(broadcast);

    case "permission.respond":
      return handlePermissionRespond(event.id, event.action, broadcast);

    case "model.switch":
      return handleModelSwitch(event.model, broadcast);

    case "command.run":
      return handleCommandRun(event.command, broadcast);

    case "file.read":
      return handleFileRead(event.path, broadcast);
  }
}

async function handleMessageSend(content: string, broadcast: BroadcastFn): Promise<void> {
  const manager = getConversationManager();
  if (!manager) {
    broadcast({
      type: "error",
      message: "No active session. Start KCode first.",
      retryable: false,
    });
    return;
  }

  if (isProcessing) {
    broadcast({
      type: "error",
      message: "Already processing a message. Cancel first or wait.",
      retryable: false,
    });
    return;
  }

  isProcessing = true;
  const userMsgId = `msg-${++sessionContext.messageIdCounter}`;
  const assistantMsgId = `msg-${++sessionContext.messageIdCounter}`;

  // Broadcast user message
  broadcast({
    type: "message.new",
    id: userMsgId,
    role: "user",
    content,
    timestamp: Date.now(),
  });

  // Broadcast assistant message start
  broadcast({
    type: "message.new",
    id: assistantMsgId,
    role: "assistant",
    content: "",
    timestamp: Date.now(),
  });

  try {
    activeGenerator = manager.sendMessage(content);

    for await (const event of activeGenerator) {
      const serverEvent = mapStreamEvent(event, assistantMsgId);
      if (serverEvent) {
        broadcast(serverEvent);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("aborted")) {
      broadcast({ type: "error", message: msg, retryable: true });
    }
  } finally {
    activeGenerator = null;
    isProcessing = false;

    // Send updated stats
    broadcastStats(broadcast, manager);

    // Process any queued messages
    processQueue(broadcast);
  }
}

async function handleMessageCancel(broadcast: BroadcastFn): Promise<void> {
  const manager = getConversationManager();
  if (manager) {
    manager.abort();
  }
  activeGenerator = null;
  isProcessing = false;
  log.info("web-ws", "Message cancelled by client");
}

async function handlePermissionRespond(
  id: string,
  action: "allow" | "deny" | "always_allow",
  broadcast: BroadcastFn,
): Promise<void> {
  const resolved = resolvePermission(id, action);
  if (resolved) {
    broadcast({ type: "permission.resolved", id, allowed: action !== "deny" });
  }
}

async function handleModelSwitch(model: string, broadcast: BroadcastFn): Promise<void> {
  const result = switchModel(model);
  if (result.success) {
    broadcast({ type: "model.changed", model });
  } else {
    broadcast({
      type: "error",
      message: result.error ?? "Failed to switch model",
      retryable: false,
    });
  }
}

async function handleCommandRun(command: string, broadcast: BroadcastFn): Promise<void> {
  // Slash commands are sent as regular messages prefixed with /
  if (command.startsWith("/")) {
    await handleMessageSend(command, broadcast);
  } else {
    broadcast({ type: "error", message: "Commands must start with /", retryable: false });
  }
}

async function handleFileRead(path: string, broadcast: BroadcastFn): Promise<void> {
  try {
    const file = Bun.file(path);
    const exists = await file.exists();
    if (!exists) {
      broadcast({ type: "error", message: `File not found: ${path}`, retryable: false });
      return;
    }

    if (file.size > 1_048_576) {
      broadcast({ type: "error", message: "File too large (max 1MB)", retryable: false });
      return;
    }

    const content = await file.text();
    // Send as a user-facing message containing the file content
    const msgId = `msg-${++sessionContext.messageIdCounter}`;
    broadcast({
      type: "message.new",
      id: msgId,
      role: "assistant",
      content: `\`\`\`\n${content}\n\`\`\``,
      timestamp: Date.now(),
    });
  } catch (err) {
    broadcast({ type: "error", message: `Read error: ${err}`, retryable: false });
  }
}

// ─── Stream Event Mapping ───────────────────────────────────────

function mapStreamEvent(event: StreamEvent, messageId: string): ServerEvent | null {
  switch (event.type) {
    case "text_delta":
      return { type: "message.delta", id: messageId, delta: event.text };

    case "thinking_delta":
      return { type: "message.thinking", id: messageId, thinking: event.thinking };

    case "tool_use_start":
      return {
        type: "tool.start",
        id: event.toolUseId,
        messageId,
        name: event.name,
        input: {},
      };

    case "tool_executing":
      return {
        type: "tool.start",
        id: event.toolUseId,
        messageId,
        name: event.name,
        input: event.input,
      };

    case "tool_result":
      return {
        type: "tool.result",
        id: event.toolUseId,
        messageId,
        name: event.name,
        result: event.result,
        isError: event.isError ?? false,
        durationMs: event.durationMs,
      };

    case "compaction_start":
      return {
        type: "compact.start",
        messageCount: event.messageCount,
        tokensBefore: event.tokensBefore,
      };

    case "compaction_end":
      return {
        type: "compact.done",
        tokensAfter: event.tokensAfter,
        method: event.method,
      };

    case "error":
      return {
        type: "error",
        message: event.error.message,
        retryable: event.retryable,
      };

    // Events we don't forward to the client
    case "usage_update":
    case "token_count":
    case "turn_start":
    case "turn_end":
    case "suggestion":
    case "budget_warning":
    case "tool_input_delta":
    case "tool_progress":
    case "tool_stream":
    case "partial_progress":
      return null;

    default:
      return null;
  }
}

// ─── Utilities ──────────────────────────────────────────────────

async function broadcastStats(
  broadcast: BroadcastFn,
  manager: import("../core/conversation").ConversationManager,
): Promise<void> {
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

  broadcast({
    type: "session.stats",
    model: manager.getConfig().model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd,
    messageCount: state.messages.length,
  });
}

function processQueue(broadcast: BroadcastFn): void {
  if (messageQueue.length > 0 && !isProcessing) {
    const next = messageQueue.shift();
    if (next) {
      handleMessageSend(next.content, broadcast);
    }
  }
}
