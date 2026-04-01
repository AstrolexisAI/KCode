// KCode - Remote Trigger Types

export interface RemoteTrigger {
  id: string;
  name: string;
  schedule: string; // cron: "min hour dom month dow"
  prompt: string;
  workingDirectory?: string;
  model?: string;
  maxTurns?: number;
  env?: Record<string, string>;
  status: "active" | "paused" | "error";
  lastRun?: {
    timestamp: number;
    status: "success" | "error";
    summary?: string;
    durationMs: number;
  };
  nextRun?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TriggerCreateInput {
  name: string;
  schedule: string;
  prompt: string;
  workingDirectory?: string;
  model?: string;
  maxTurns?: number;
}

export interface TriggerRunResult {
  triggerId: string;
  status: "success" | "error";
  summary: string;
  messagesCount: number;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
  artifacts?: { path: string; action: "created" | "modified" | "deleted" }[];
}

export interface TriggerUpdateInput {
  name?: string;
  schedule?: string;
  prompt?: string;
  workingDirectory?: string;
  model?: string;
  maxTurns?: number;
  status?: "active" | "paused" | "error";
}

export class TriggerApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "TriggerApiError";
  }
}

export class TriggerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerValidationError";
  }
}
