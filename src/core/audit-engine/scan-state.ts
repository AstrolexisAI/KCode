// KCode - Scan State (global mutable state for TUI progress)
//
// Ink can't re-render from within an async handler's setCompleted calls.
// Instead, the /scan handler updates this global state, and App.tsx polls
// it via setInterval. When the interval fires, React state updates happen
// in Ink's own render cycle — which DOES trigger re-renders.

export interface ScanProgress {
  active: boolean;
  phase: string;
  verified: number;
  total: number;
  confirmed: number;
  falsePositives: number;
  escalated: number; // candidates sent to cloud fallback
  startTime: number;
  cloudProvider?: string; // "anthropic" | "openai" | "" if no fallback
  /** Set when FPs or NEEDS_CONTEXT exist and cloud is available */
  pendingEscalation?: { count: number; provider: string; reason: string };
  /** Set by the UI when user responds to escalation prompt */
  escalationApproved?: boolean;
  /** Set when audit completes — the handler reads this to push result. */
  result?: {
    outputPath: string;
    filesScanned: number;
    candidates: number;
    findings: number;
    falsePositives: number;
    elapsedMs: number;
    topFindings: Array<{ severity: string; file: string; line: number; patternId: string }>;
    reportText: string;
  };
  error?: string;
}

/** Global singleton — mutated by the scan handler, read by App.tsx */
export const scanState: ScanProgress = {
  active: false,
  phase: "",
  verified: 0,
  total: 0,
  confirmed: 0,
  falsePositives: 0,
  escalated: 0,
  startTime: 0,
};

export function resetScanState(): void {
  scanState.active = false;
  scanState.phase = "";
  scanState.verified = 0;
  scanState.total = 0;
  scanState.confirmed = 0;
  scanState.falsePositives = 0;
  scanState.escalated = 0;
  scanState.startTime = 0;
  scanState.cloudProvider = undefined;
  scanState.pendingEscalation = undefined;
  scanState.escalationApproved = undefined;
  scanState.result = undefined;
  scanState.error = undefined;
}
