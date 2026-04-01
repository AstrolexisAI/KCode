// KCode - Extension API Types
// Type definitions for the Extension API event system, configuration, and responses

export type ExtensionEvent =
  | { type: "message.created"; data: { id: string; role: string; content: string } }
  | { type: "message.streaming"; data: { id: string; delta: string } }
  | { type: "tool.started"; data: { id: string; name: string } }
  | {
      type: "tool.completed";
      data: { id: string; name: string; success: boolean; durationMs: number };
    }
  | { type: "permission.requested"; data: { id: string; tool: string; input: string } }
  | { type: "session.started"; data: { sessionId: string; model: string } }
  | { type: "session.ended"; data: { sessionId: string; stats: SessionStats } }
  | { type: "model.changed"; data: { from: string; to: string } }
  | { type: "compact.triggered"; data: { strategy: string } }
  | { type: "memory.created"; data: { type: string; title: string } }
  | { type: "error"; data: { message: string; code: string } };

export interface SessionStats {
  tokensUsed: number;
  costUsd: number;
  toolCalls: number;
  durationMs: number;
}

export interface ExtensionApiConfig {
  port: number;
  host: string;
  authToken?: string;
  rateLimit: number;
  corsOrigins: string[];
}

export const DEFAULT_EXTENSION_API_CONFIG: ExtensionApiConfig = {
  port: 19300,
  host: "127.0.0.1",
  rateLimit: 60,
  corsOrigins: ["*"],
};

export type Middleware = (req: Request) => Promise<Response | null>;

export interface HealthResponse {
  status: "ok";
  version: string;
  uptime: number;
  model: string;
  sessionId: string | null;
}

export interface InfoResponse {
  version: string;
  tools: string[];
  models: string[];
  features: string[];
}

export type ExtensionEventType = ExtensionEvent["type"];
