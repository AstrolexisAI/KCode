// KCode - Task Orchestrator Types

export type TaskType =
  | "audit"
  | "debug"
  | "implement"
  | "review"
  | "refactor"
  | "test"
  | "deploy"
  | "explain"
  | "general";

export interface ClassifiedTask {
  type: TaskType;
  confidence: number; // 0-1
  /** Extracted entities from the user message */
  entities: {
    files?: string[];
    error?: string;
    feature?: string;
    url?: string;
    language?: string;
  };
  /** The original user message */
  raw: string;
}

export interface PipelineStep {
  name: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface PipelineResult {
  steps: Array<{
    name: string;
    output: string;
    durationMs: number;
  }>;
  /** Condensed context for the LLM — the minimum it needs to reason */
  context: string;
  /** Focused prompt for the LLM — specific question, not open-ended */
  prompt: string;
}
