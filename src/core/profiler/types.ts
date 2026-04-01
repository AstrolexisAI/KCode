// Profiler type definitions

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
}

export interface ProfileReport {
  checkpoints: ProfileCheckpoint[];
  totalMs: number;
  peakMemoryMB: number;
  slowestPhase: string;
  recommendations: string[];
}
