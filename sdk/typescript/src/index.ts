// @kulvex/kcode-sdk — TypeScript client for KCode HTTP API

export interface KCodeClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
}

export interface PromptOptions {
  stream?: boolean;
  model?: string;
  noTools?: boolean;
  sessionId?: string;
}

export interface PromptResponse {
  text: string;
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    result: string;
  }>;
  usage: { inputTokens: number; outputTokens: number };
  sessionId: string;
}

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

export interface ModelInfo {
  id: string;
  provider: string;
}

export interface SessionInfo {
  sessionId: string;
  model: string;
  active: boolean;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
  toolUseCount: number;
  tokenCount: number;
}

export interface ToolInfo {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
}

export interface ToolExecResult {
  name: string;
  content: unknown;
  isError: boolean;
}

export class KCodeClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeout: number;

  constructor(options?: KCodeClientOptions) {
    this.baseUrl = (options?.baseUrl ?? "http://localhost:19300").replace(
      /\/$/,
      ""
    );
    this.apiKey = options?.apiKey;
    this.timeout = options?.timeout ?? 30000;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (extra) {
      Object.assign(h, extra);
    }
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(extraHeaders),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({
          error: res.statusText,
          code: res.status,
        }));
        throw new Error(
          `KCode API error ${res.status}: ${(err as Record<string, unknown>).error ?? res.statusText}`
        );
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Core ──────────────────────────────────────────────────────────

  async prompt(
    message: string,
    options?: PromptOptions
  ): Promise<PromptResponse> {
    const extraHeaders: Record<string, string> = {};
    if (options?.sessionId) {
      extraHeaders["X-Session-Id"] = options.sessionId;
    }

    const raw = await this.request<{
      id: string;
      sessionId: string;
      response: string;
      toolCalls?: Array<{
        name: string;
        input: Record<string, unknown>;
        result: string;
      }>;
      usage?: { inputTokens: number; outputTokens: number };
      model: string;
    }>(
      "POST",
      "/api/prompt",
      {
        prompt: message,
        stream: false,
        model: options?.model,
        noTools: options?.noTools,
      },
      extraHeaders
    );

    return {
      text: raw.response ?? "",
      toolCalls: raw.toolCalls ?? [],
      usage: raw.usage ?? { inputTokens: 0, outputTokens: 0 },
      sessionId: raw.sessionId ?? "",
    };
  }

  async *promptStream(
    message: string,
    options?: PromptOptions
  ): AsyncGenerator<string> {
    const headers = this.headers();
    if (options?.sessionId) {
      headers["X-Session-Id"] = options.sessionId;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.baseUrl}/api/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: message,
          stream: true,
          model: options?.model,
          noTools: options?.noTools,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`KCode API error ${res.status}: ${res.statusText}`);
      }

      if (!res.body) {
        throw new Error("No response body for SSE stream");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") return;

            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              if (parsed.type === "text" && typeof parsed.text === "string") {
                yield parsed.text;
              }
            } catch {
              // Non-JSON SSE data — yield raw
              yield data;
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Health ────────────────────────────────────────────────────────

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/api/health");
  }

  async status(): Promise<StatusResponse> {
    return this.request<StatusResponse>("GET", "/api/status");
  }

  // ── Models ────────────────────────────────────────────────────────

  async models(): Promise<Array<ModelInfo>> {
    const res = await this.request<{ models?: ModelInfo[] }>(
      "GET",
      "/api/status"
    );
    // The API does not have a dedicated /api/models endpoint.
    // Model info is available through the status endpoint.
    return res.models ?? [{ id: res.model ?? "unknown", provider: "unknown" }];
  }

  // ── Sessions ──────────────────────────────────────────────────────

  async sessions(): Promise<Array<SessionInfo>> {
    const res = await this.request<{
      active: SessionInfo[];
      recent: Array<Record<string, unknown>>;
    }>("GET", "/api/sessions");
    return res.active ?? [];
  }

  // ── Tools ─────────────────────────────────────────────────────────

  async tools(): Promise<Array<ToolInfo>> {
    const res = await this.request<{ tools: ToolInfo[] }>(
      "GET",
      "/api/tools"
    );
    return res.tools ?? [];
  }

  async executeTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<ToolExecResult> {
    return this.request<ToolExecResult>("POST", "/api/tool", { name, input });
  }

  // ── Context & Plan ────────────────────────────────────────────────

  async context(
    sessionId?: string,
    lastN?: number
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);
    if (lastN !== undefined) params.set("lastN", String(lastN));
    const qs = params.toString();
    return this.request<Record<string, unknown>>(
      "GET",
      `/api/context${qs ? `?${qs}` : ""}`
    );
  }

  async compact(sessionId?: string): Promise<Record<string, unknown>> {
    const extraHeaders: Record<string, string> = {};
    if (sessionId) {
      extraHeaders["X-Session-Id"] = sessionId;
    }
    return this.request<Record<string, unknown>>(
      "POST",
      "/api/compact",
      undefined,
      extraHeaders
    );
  }

  async plan(sessionId?: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);
    const qs = params.toString();
    return this.request<Record<string, unknown>>(
      "GET",
      `/api/plan${qs ? `?${qs}` : ""}`
    );
  }

  // ── Integrations ──────────────────────────────────────────────────

  async mcp(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/api/mcp");
  }

  async agents(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/api/agents");
  }
}

export default KCodeClient;
