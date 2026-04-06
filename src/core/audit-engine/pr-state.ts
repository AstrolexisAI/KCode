// KCode - PR State (global mutable state for TUI progress)
// Same pattern as scan-state.ts — polled by App.tsx via setInterval.

export interface PrProgress {
  active: boolean;
  step: string;
  startTime: number;
  result?: {
    branchName: string;
    commitHash: string;
    prUrl?: string;
    filesChanged: number;
    pushFailed?: string;
    prDescription: string;
  };
  error?: string;
}

export const prState: PrProgress = {
  active: false,
  step: "",
  startTime: 0,
};

export function resetPrState(): void {
  prState.active = false;
  prState.step = "";
  prState.startTime = 0;
  prState.result = undefined;
  prState.error = undefined;
}
