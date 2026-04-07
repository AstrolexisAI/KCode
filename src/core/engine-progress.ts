// KCode - Engine Progress State
// Global mutable state polled by App.tsx (same pattern as scan-state.ts)

export interface EngineProgress {
  active: boolean;
  phase: string;
  step: number;
  totalSteps: number;
  projectPath: string;
  siteType: string;
  startTime: number;
}

export const engineState: EngineProgress = {
  active: false,
  phase: "",
  step: 0,
  totalSteps: 4,
  projectPath: "",
  siteType: "",
  startTime: 0,
};

export function resetEngineState(): void {
  engineState.active = false;
  engineState.phase = "";
  engineState.step = 0;
  engineState.totalSteps = 4;
  engineState.projectPath = "";
  engineState.siteType = "";
  engineState.startTime = 0;
}
