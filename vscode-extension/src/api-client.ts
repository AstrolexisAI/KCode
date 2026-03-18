import * as vscode from "vscode";

// ─── Types ────────────────────────────────────────────────────────

export interface HealthResponse {
  ok: boolean;
  version: string;
  model: string;
}

export interface StatusResponse {
  model: string;
  sessionId: string | null;
  tokenCount: number;
  toolUseCount: number;
  runningAgents: number;
  contextUsage: {
    messageCount: number;
    tokenEstimate: number;
    contextWindow: number;
    usagePercent: number;
  };
  uptime: number;
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

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolExecResponse {
  name: string;
  content: unknown;
  isError: boolean;
}

export type SSEEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_result"; name: string; result: string; isError: boolean }
  | { type: "tool_progress"; name: string; status: string; index?: number; total?: number }
  | { type: "turn_start" }
  | { type: "compaction"; tokensAfter: number }
  | { type: "done"; sessionId: string; usage: { inputTokens: number; outputTokens: number }; model: string }
  | { type: "error"; error: string };

export type ConnectionState = "connected" | "disconnected" | "connecting";

type ConnectionListener = (state: ConnectionState) => void;

// ─── API Client ───────────────────────────────────────────────────

export class KCodeApiClient {
  private baseUrl: string;
  private sessionId: string | undefined;
  private state: ConnectionState = "disconnected";
  private listeners: ConnectionListener[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private abortController: AbortController | undefined;

  constructor() {
    this.baseUrl = this.getServerUrl();
  }

  // ── Configuration ─────────────────────────────────────────────

  private getServerUrl(): string {
    const config = vscode.workspace.getConfiguration("kcode");
    return config.get<string>("serverUrl", "http://localhost:10091");
  }

  public updateBaseUrl(): void {
    this.baseUrl = this.getServerUrl();
  }

  public getSessionId(): string | undefined {
    return this.sessionId;
  }

  public clearSession(): void {
    this.sessionId = undefined;
  }

  public setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  // ── Connection State ──────────────────────────────────────────

  public getState(): ConnectionState {
    return this.state;
  }

  public onStateChange(listener: ConnectionListener): vscode.Disposable {
    this.listeners.push(listener);
    return new vscode.Disposable(() => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) {
        this.listeners.splice(idx, 1);
      }
    });
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      for (const listener of this.listeners) {
        listener(state);
      }
    }
  }

  // ── Auto-reconnect ───────────────────────────────────────────

  public startAutoReconnect(): void {
    this.reconnectAttempts = 0;
    this.tryConnect();
  }

  public stopAutoReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async tryConnect(): Promise<void> {
    this.setState("connecting");
    try {
      await this.healthCheck();
      this.setState("connected");
      this.reconnectAttempts = 0;
    } catch {
      this.setState("disconnected");
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.min(2000 * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        this.reconnectTimer = setTimeout(() => this.tryConnect(), delay);
      }
    }
  }

  // ── HTTP Helpers ──────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const fetchHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...headers,
    };
    if (this.sessionId) {
      fetchHeaders["X-Session-Id"] = this.sessionId;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        method,
        headers: fetchHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error((errorBody as any).error || `HTTP ${response.status}`);
      }

      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── API Endpoints ─────────────────────────────────────────────

  /**
   * GET /api/health - Check server health
   */
  public async healthCheck(): Promise<HealthResponse> {
    const result = await this.request<HealthResponse>("GET", "/api/health");
    this.setState("connected");
    return result;
  }

  /**
   * GET /api/status - Get server status
   */
  public async getStatus(): Promise<StatusResponse> {
    return this.request<StatusResponse>("GET", "/api/status");
  }

  /**
   * POST /api/prompt - Send a prompt (non-streaming)
   */
  public async sendPrompt(
    prompt: string,
    options?: { model?: string; cwd?: string; noTools?: boolean }
  ): Promise<PromptResponse> {
    const result = await this.request<PromptResponse>("POST", "/api/prompt", {
      prompt,
      stream: false,
      ...options,
    });
    if (result.sessionId) {
      this.sessionId = result.sessionId;
    }
    return result;
  }

  /**
   * POST /api/prompt - Send a prompt with SSE streaming.
   * Calls onEvent for each SSE event received.
   */
  public async sendPromptStreaming(
    prompt: string,
    onEvent: (event: SSEEvent) => void,
    options?: { model?: string; cwd?: string; noTools?: boolean }
  ): Promise<void> {
    const url = `${this.baseUrl}/api/prompt`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    };
    if (this.sessionId) {
      headers["X-Session-Id"] = this.sessionId;
    }

    this.abortController = new AbortController();

    const body = JSON.stringify({
      prompt,
      stream: true,
      ...options,
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error((errorBody as any).error || `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body reader available");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }

        buffer += decoder.decode(value, { stream: true });

        // Prevent unbounded buffer growth
        if (buffer.length > 1024 * 1024) {
          throw new Error("SSE buffer exceeded 1MB limit");
        }

        // Parse SSE events from buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        let currentEvent = "";
        let currentData = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6);
          } else if (line === "" && currentEvent && currentData) {
            // End of SSE message
            try {
              const data = JSON.parse(currentData);
              const sseEvent = this.parseSSEEvent(currentEvent, data);
              if (sseEvent) {
                if (sseEvent.type === "session") {
                  this.sessionId = sseEvent.sessionId;
                }
                onEvent(sseEvent);
              }
            } catch {
              // Ignore malformed SSE data
            }
            currentEvent = "";
            currentData = "";
          }
        }
      }
    } finally {
      this.abortController = undefined;
    }
  }

  /**
   * Cancel an ongoing streaming request.
   */
  public cancelStreaming(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
  }

  /**
   * GET /api/tools - List available tools
   */
  public async getTools(): Promise<ToolDefinition[]> {
    const result = await this.request<{ tools: ToolDefinition[] }>("GET", "/api/tools");
    return result.tools;
  }

  /**
   * POST /api/tool - Execute a single tool
   */
  public async executeTool(name: string, input: Record<string, unknown>): Promise<ToolExecResponse> {
    return this.request<ToolExecResponse>("POST", "/api/tool", { name, input });
  }

  /**
   * GET /api/sessions - List sessions
   */
  public async getSessions(): Promise<unknown> {
    return this.request("GET", "/api/sessions");
  }

  /**
   * GET /api/context - Get conversation context
   */
  public async getContext(sessionId?: string, lastN?: number): Promise<unknown> {
    let path = "/api/context";
    const params: string[] = [];
    if (sessionId) { params.push(`sessionId=${encodeURIComponent(sessionId)}`); }
    if (lastN) { params.push(`lastN=${lastN}`); }
    if (params.length > 0) { path += "?" + params.join("&"); }
    return this.request("GET", path);
  }

  /**
   * POST /api/compact - Trigger context compaction
   */
  public async compact(): Promise<unknown> {
    return this.request("POST", "/api/compact");
  }

  /**
   * GET /api/plan - Get active plan for current session
   */
  public async getPlan(): Promise<{ sessionId: string | null; plan: unknown }> {
    return this.request("GET", "/api/plan");
  }

  /**
   * GET /api/mcp - Get MCP server status and tools
   */
  public async getMcp(): Promise<{
    servers: Array<{ name: string; alive: boolean; toolCount: number }>;
    tools: Array<{ name: string; description: string }>;
  }> {
    return this.request("GET", "/api/mcp");
  }

  /**
   * GET /api/agents - Get available and running agents
   */
  public async getAgents(): Promise<{
    available: Array<{ name: string; description: string; model?: string; effort?: string; memory?: boolean }>;
    running: Array<{ id: string; elapsed: number }>;
  }> {
    return this.request("GET", "/api/agents");
  }

  /**
   * GET /api/session/:filename - Get transcript for a past session
   */
  public async getSessionTranscript(filename: string): Promise<{
    filename: string;
    messageCount: number;
    messages: Array<{ role: string; content: string }>;
  }> {
    return this.request("GET", `/api/session/${encodeURIComponent(filename)}`);
  }

  // ── SSE Parsing ───────────────────────────────────────────────

  private parseSSEEvent(eventType: string, data: any): SSEEvent | null {
    switch (eventType) {
      case "session":
        return { type: "session", sessionId: data.sessionId };
      case "text":
        return { type: "text", text: data.text };
      case "tool_result":
        return {
          type: "tool_result",
          name: data.name,
          result: data.result,
          isError: data.isError ?? false,
        };
      case "tool_progress":
        return {
          type: "tool_progress",
          name: data.name,
          status: data.status,
          index: data.index,
          total: data.total,
        };
      case "turn_start":
        return { type: "turn_start" };
      case "compaction":
        return { type: "compaction", tokensAfter: data.tokensAfter };
      case "done":
        return {
          type: "done",
          sessionId: data.sessionId,
          usage: data.usage,
          model: data.model,
        };
      case "error":
        return { type: "error", error: data.error };
      default:
        return null;
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────

  public dispose(): void {
    this.stopAutoReconnect();
    this.cancelStreaming();
    this.listeners = [];
  }
}
