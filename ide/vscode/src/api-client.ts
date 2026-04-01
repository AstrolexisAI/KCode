// KCode VS Code Extension - API Client
// Connects to the KCode HTTP API and WebSocket for streaming

import * as vscode from "vscode";

// ── Types ──────────────────────────────────────────────────────

export interface SessionInfo {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  messageCount: number;
  sessionId: string | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
}

export interface HealthStatus {
  ok: boolean;
  version: string;
  model: string;
}

export interface PromptResponse {
  id: string;
  sessionId: string;
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

/** Server event types received over WebSocket */
export type ServerEvent =
  | { type: "message.new"; id: string; role: "user" | "assistant"; content: string; timestamp: number }
  | { type: "message.delta"; id: string; delta: string }
  | { type: "message.thinking"; id: string; thinking: string }
  | { type: "tool.start"; id: string; messageId: string; name: string; input: Record<string, unknown> }
  | { type: "tool.result"; id: string; messageId: string; name: string; result: string; isError: boolean; durationMs?: number }
  | { type: "permission.request"; id: string; tool: string; input: Record<string, unknown>; description: string }
  | { type: "permission.resolved"; id: string; allowed: boolean }
  | { type: "session.stats"; model: string; inputTokens: number; outputTokens: number; costUsd: number; messageCount: number }
  | { type: "model.changed"; model: string }
  | { type: "compact.start"; messageCount: number; tokensBefore: number }
  | { type: "compact.done"; tokensAfter: number; method: string }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "connected"; sessionId: string; model: string };

/** Client event types sent over WebSocket */
export type ClientEvent =
  | { type: "message.send"; content: string }
  | { type: "message.cancel" }
  | { type: "permission.respond"; id: string; action: "allow" | "deny" | "always_allow" }
  | { type: "model.switch"; model: string }
  | { type: "command.run"; command: string }
  | { type: "file.read"; path: string };

// ── Event Emitter ──────────────────────────────────────────────

type EventHandler = (event: ServerEvent) => void;

// ── Client ─────────────────────────────────────────────────────

export class KCodeClient {
  private baseUrl: string;
  private apiKey: string;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelayMs = 1000;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private eventHandlers: EventHandler[] = [];
  private _connected = false;
  private sessionId: string | null = null;

  constructor(serverUrl: string, apiKey: string = "") {
    this.baseUrl = serverUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  // ── Connection State ───────────────────────────────────────

  get connected(): boolean {
    return this._connected;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  // ── Event Handling ─────────────────────────────────────────

  onEvent(handler: EventHandler): vscode.Disposable {
    this.eventHandlers.push(handler);
    return new vscode.Disposable(() => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx >= 0) this.eventHandlers.splice(idx, 1);
    });
  }

  private emit(event: ServerEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error("[KCode] Event handler error:", err);
      }
    }
  }

  // ── HTTP Methods ───────────────────────────────────────────

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (this.sessionId) {
      h["X-Session-Id"] = this.sessionId;
    }
    return h;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      ...options,
      headers: { ...this.headers(), ...options?.headers },
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
    }

    return resp.json() as Promise<T>;
  }

  /** Check if the KCode server is reachable */
  async healthCheck(): Promise<HealthStatus> {
    return this.fetch<HealthStatus>("/api/health");
  }

  /** Send a message and get a non-streaming response */
  async sendMessage(prompt: string, options?: { model?: string; noTools?: boolean }): Promise<PromptResponse> {
    return this.fetch<PromptResponse>("/api/prompt", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        stream: false,
        model: options?.model,
        noTools: options?.noTools,
      }),
    });
  }

  /**
   * Send a message with SSE streaming.
   * Returns an AbortController so the caller can cancel.
   * Text deltas are emitted as synthetic ServerEvents via onEvent.
   */
  async sendMessageStreaming(
    prompt: string,
    onText: (text: string) => void,
    onDone?: (usage: { inputTokens: number; outputTokens: number }) => void,
    onError?: (err: string) => void,
  ): Promise<AbortController> {
    const controller = new AbortController();
    const url = `${this.baseUrl}/api/prompt`;

    const resp = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ prompt, stream: true }),
      signal: controller.signal,
    });

    if (!resp.ok || !resp.body) {
      const body = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
    }

    // Parse SSE stream in background
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let currentEvent = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7);
            } else if (line.startsWith("data: ") && currentEvent) {
              try {
                const data = JSON.parse(line.slice(6));
                if (currentEvent === "text") {
                  onText(data.text);
                } else if (currentEvent === "done") {
                  onDone?.(data.usage);
                } else if (currentEvent === "error") {
                  onError?.(data.error);
                } else if (currentEvent === "session") {
                  this.sessionId = data.sessionId;
                }
              } catch {
                // Skip malformed data lines
              }
              currentEvent = "";
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          onError?.(String(err));
        }
      }
    })();

    return controller;
  }

  /** Get current session information */
  async getSession(): Promise<SessionInfo> {
    return this.fetch<SessionInfo>("/api/v1/session");
  }

  /** List available models */
  async getModels(): Promise<{ models: ModelInfo[]; active: string }> {
    return this.fetch<{ models: ModelInfo[]; active: string }>("/api/v1/models");
  }

  /** Switch the active model */
  async switchModel(model: string): Promise<void> {
    await this.fetch("/api/v1/model", {
      method: "POST",
      body: JSON.stringify({ model }),
    });
  }

  /** Abort the current operation */
  async abort(): Promise<void> {
    await this.fetch("/api/v1/cancel", { method: "POST" });
  }

  // ── WebSocket ──────────────────────────────────────────────

  /** Connect the WebSocket for real-time streaming */
  connectWebSocket(): void {
    if (this.ws) {
      this.ws.close();
    }

    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/ws";
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this._connected = true;
      this.reconnectAttempts = 0;
      console.log("[KCode] WebSocket connected");
      this.startHealthCheck();
    };

    this.ws.onmessage = (event) => {
      try {
        const serverEvent = JSON.parse(String(event.data)) as ServerEvent;

        // Track session ID from connected event
        if (serverEvent.type === "connected") {
          this.sessionId = serverEvent.sessionId;
        }

        this.emit(serverEvent);
      } catch {
        console.warn("[KCode] Failed to parse WebSocket message");
      }
    };

    this.ws.onerror = (event) => {
      console.error("[KCode] WebSocket error:", event);
    };

    this.ws.onclose = () => {
      this._connected = false;
      this.stopHealthCheck();
      console.log("[KCode] WebSocket disconnected");
      this.scheduleReconnect();
    };
  }

  /** Send a message via WebSocket */
  wsSend(event: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[KCode] WebSocket not connected, cannot send");
      return;
    }
    this.ws.send(JSON.stringify(event));
  }

  /** Send a chat message via WebSocket */
  wsSendMessage(content: string): void {
    this.wsSend({ type: "message.send", content });
  }

  /** Cancel current message via WebSocket */
  wsCancelMessage(): void {
    this.wsSend({ type: "message.cancel" });
  }

  /** Respond to a permission request via WebSocket */
  wsRespondPermission(id: string, action: "allow" | "deny" | "always_allow"): void {
    this.wsSend({ type: "permission.respond", id, action });
  }

  // ── Reconnection ──────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log("[KCode] Max reconnect attempts reached");
      return;
    }

    const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      console.log(`[KCode] Reconnecting (attempt ${this.reconnectAttempts})...`);
      this.connectWebSocket();
    }, delay);
  }

  // ── Health Check ──────────────────────────────────────────

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.healthCheck();
      } catch {
        console.warn("[KCode] Health check failed");
      }
    }, 30_000);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ── Cleanup ────────────────────────────────────────────────

  dispose(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHealthCheck();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    this.eventHandlers = [];
  }
}
