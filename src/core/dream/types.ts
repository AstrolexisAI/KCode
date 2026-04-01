// KCode - Dream Task Types
// Background task system that runs during idle periods

export interface DreamTask {
  id: string;
  name: string;
  priority: number; // lower = more urgent
  execute: (ctx: DreamContext) => Promise<DreamResult>;
  shouldRun: (state: DreamState) => boolean;
  timeoutMs: number;
  interruptible: boolean;
}

export interface DreamContext {
  cwd: string;
  signal: AbortSignal;
  log: (msg: string) => void;
}

export interface DreamResult {
  taskName: string;
  status: "completed" | "interrupted" | "error";
  durationMs: number;
  details?: string;
}

export interface DreamState {
  lastIndexTime?: number;
  lastAnalysisTime?: number;
  lastDistillTime?: number;
  lastMaintenanceTime?: number;
  sessionTurnCount: number;
  idleSeconds: number;
}

export interface DreamEngineConfig {
  enabled: boolean;
  idleThresholdSeconds: number; // default: 30
  maxConcurrent: number; // default: 1
}

export const DEFAULT_DREAM_CONFIG: DreamEngineConfig = {
  enabled: true,
  idleThresholdSeconds: 30,
  maxConcurrent: 1,
};
