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
  /**
   * Set by the UI when the user requests cancellation (Esc during /scan).
   * The /scan handler watches this and aborts the underlying audit run.
   * Stays true until resetScanState() clears it.
   */
  cancelled: boolean;
  cloudProvider?: string; // "anthropic" | "openai" | "" if no fallback
  /** Set when FPs or NEEDS_CONTEXT exist and cloud is available */
  pendingEscalation?: {
    count: number;
    reason: string;
    /** Available models for audit (tagged analysis/reasoning with valid keys) */
    availableModels: Array<{ name: string; provider: string; tags: string[] }>;
  };
  /** Set by the UI: name of the chosen cloud model, or null to skip */
  escalationModelChoice?: string | null;
  /**
   * Set when the cloud-escalation pass aborted (typically due to a
   * misconfigured endpoint — bad API key, wrong baseUrl, sustained
   * timeouts). The primary pass results stay valid; this flag tells
   * the UI to surface the error so the user can fix the config.
   * v2.10.312.
   */
  cloudAbortError?: string;
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
  cancelled: false,
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
  scanState.cancelled = false;
  scanState.cloudProvider = undefined;
  scanState.pendingEscalation = undefined;
  scanState.escalationModelChoice = undefined;
  scanState.result = undefined;
  scanState.error = undefined;
  scanState.cloudAbortError = undefined;
}

/**
 * Sentinel error thrown by the audit pipeline when the user cancels via
 * Esc (or any other path that calls requestScanCancel). Distinguished
 * from real errors so the /scan handler can produce a soft "cancelled
 * by user" message instead of an error report. v2.10.385.
 */
export class ScanCancelledError extends Error {
  constructor(message = "Scan cancelled by user") {
    super(message);
    this.name = "ScanCancelledError";
  }
}

/** True if the active scan has been cancelled by the user. */
export function isScanCancelled(): boolean {
  return scanState.cancelled === true;
}

/** Request cancellation of the active scan (idempotent). */
export function requestScanCancel(): void {
  if (scanState.active) scanState.cancelled = true;
}
