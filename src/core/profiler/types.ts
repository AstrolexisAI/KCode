// Profiler type definitions

export type PhaseCategory = "init" | "config" | "server" | "plugins" | "tools" | "ui" | "other";

export interface ProfileCheckpoint {
  name: string;
  /** ms since process start */
  timestamp: number;
  /** ms since previous checkpoint */
  deltaMs: number;
  /** Resident Set Size in MB */
  memoryMB: number;
  /** Number of modules loaded (Bun's require cache) */
  importsLoaded: number;
  /** Phase category for grouping */
  category?: PhaseCategory;
}

export interface ProfileReport {
  checkpoints: ProfileCheckpoint[];
  totalMs: number;
  peakMemoryMB: number;
  slowestPhase: string;
  recommendations: string[];
  /** Breakdown by category */
  categoryTotals: Record<PhaseCategory, number>;
}

/** Target thresholds for startup performance */
export const STARTUP_TARGETS = {
  /** Cold start without local model server */
  coldStartNoServerMs: 500,
  /** Cold start with llama-server */
  coldStartWithServerMs: 2000,
  /** Phase warning threshold */
  phaseWarningMs: 100,
  /** Phase critical threshold */
  phaseCriticalMs: 500,
} as const;
