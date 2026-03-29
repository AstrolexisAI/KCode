// KCode - Response Session
// Tracks the lifecycle of each assistant response to prevent
// mixing truncated responses with subsequent turns.

export type ResponseStatus = "streaming" | "incomplete" | "completed" | "aborted" | "failed";

export interface ResponseSession {
  id: string;
  turnId: number;
  status: ResponseStatus;
  text: string;
  chunks: Array<{ seq: number; text: string; timestamp: number }>;
  stopReason?: string;
  continuationCount: number;
  maxContinuations: number;
  hadTools: boolean;
  toolCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

let _activeSession: ResponseSession | null = null;
let _sessionHistory: ResponseSession[] = [];
const MAX_SESSION_HISTORY = 20;

/** Create a new response session for a turn. */
export function beginResponseSession(turnId: number): ResponseSession {
  // Close any previous session as incomplete
  if (_activeSession && _activeSession.status === "streaming") {
    _activeSession.status = "incomplete";
    _activeSession.updatedAt = Date.now();
    _sessionHistory.push(_activeSession);
    if (_sessionHistory.length > MAX_SESSION_HISTORY) {
      _sessionHistory = _sessionHistory.slice(-MAX_SESSION_HISTORY);
    }
  }

  const session: ResponseSession = {
    id: `resp_${Date.now()}_${turnId}`,
    turnId,
    status: "streaming",
    text: "",
    chunks: [],
    continuationCount: 0,
    maxContinuations: 2,
    hadTools: false,
    toolCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  _activeSession = session;
  return session;
}

/** Get the active response session. */
export function getActiveResponseSession(): ResponseSession | null {
  return _activeSession;
}

/** Append text to the active session. */
export function appendSessionText(text: string): void {
  if (!_activeSession) return;
  _activeSession.text += text;
  _activeSession.chunks.push({
    seq: _activeSession.chunks.length,
    text,
    timestamp: Date.now(),
  });
  _activeSession.updatedAt = Date.now();
}

/** Record that tools were used in this session. */
export function recordSessionToolUse(count: number = 1): void {
  if (!_activeSession) return;
  _activeSession.hadTools = true;
  _activeSession.toolCount += count;
  _activeSession.updatedAt = Date.now();
}

/** Mark the session as a continuation attempt. */
export function recordSessionContinuation(): number {
  if (!_activeSession) return 0;
  _activeSession.continuationCount++;
  _activeSession.updatedAt = Date.now();
  return _activeSession.continuationCount;
}

/** Check if the session has exceeded max continuations. */
export function isSessionContinuationExhausted(): boolean {
  if (!_activeSession) return true;
  return _activeSession.continuationCount >= _activeSession.maxContinuations;
}

/** Close the session with a final status. */
export function closeResponseSession(
  status: "completed" | "incomplete" | "aborted" | "failed",
  stopReason?: string,
  lastError?: string,
): void {
  if (!_activeSession) return;
  _activeSession.status = status;
  _activeSession.stopReason = stopReason;
  if (lastError) _activeSession.lastError = lastError;
  _activeSession.updatedAt = Date.now();

  // Archive to history
  _sessionHistory.push(_activeSession);
  if (_sessionHistory.length > MAX_SESSION_HISTORY) {
    _sessionHistory = _sessionHistory.slice(-MAX_SESSION_HISTORY);
  }
  _activeSession = null;
}

/** Get the most recent completed/incomplete session. */
export function getLastSession(): ResponseSession | null {
  return _sessionHistory[_sessionHistory.length - 1] ?? null;
}

/** Check if a previous turn is still in incomplete state. */
export function hasPendingIncompleteSession(): boolean {
  const last = getLastSession();
  return last?.status === "incomplete";
}

/** Reset all session state (for testing). */
export function resetSessionState(): void {
  _activeSession = null;
  _sessionHistory = [];
}
