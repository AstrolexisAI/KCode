// KCode - Span Helpers
// Lightweight tracing primitives for creating spans without the full OTEL SDK.

import type { Span, TelemetryEvent } from "./types";

/** Generate a random 16-character hex ID. */
function randomHexId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Active trace context for the current session. */
let _currentTraceId: string | null = null;

/** Get or create the current trace ID (one per session). */
export function getTraceId(): string {
  if (!_currentTraceId) {
    _currentTraceId = randomHexId() + randomHexId(); // 32 hex chars
  }
  return _currentTraceId;
}

/** Reset the trace ID (e.g. on new session). */
export function resetTraceId(): void {
  _currentTraceId = null;
}

/** Set an explicit trace ID (for session resume). */
export function setTraceId(traceId: string): void {
  _currentTraceId = traceId;
}

/**
 * Start a new span. Returns a Span object that must be passed to endSpan().
 */
export function startSpan(
  name: string,
  attributes: Record<string, unknown> = {},
  parentSpanId?: string,
): Span {
  return {
    name,
    traceId: getTraceId(),
    spanId: randomHexId(),
    parentSpanId,
    startTime: performance.now(),
    attributes,
  };
}

/**
 * End a span and produce a TelemetryEvent with the measured duration.
 */
export function endSpan(span: Span, extraAttributes?: Record<string, unknown>): TelemetryEvent {
  const duration = performance.now() - span.startTime;
  return {
    name: span.name,
    timestamp: new Date().toISOString(),
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    attributes: { ...span.attributes, ...extraAttributes },
    duration: Math.round(duration * 100) / 100, // 2 decimal places
  };
}

/**
 * Wrap an async function with span tracking.
 * Automatically starts and ends a span, recording duration and errors.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, unknown> = {},
  parentSpanId?: string,
): Promise<{ result: T; event: TelemetryEvent }> {
  const span = startSpan(name, attributes, parentSpanId);
  try {
    const result = await fn(span);
    const event = endSpan(span, { success: true });
    return { result, event };
  } catch (err) {
    const event = endSpan(span, {
      success: false,
      error_type: err instanceof Error ? err.constructor.name : "Unknown",
      error_message: err instanceof Error ? err.message : String(err),
    });
    // Re-throw but still return the event for tracking
    // We need to emit the event before re-throwing
    throw Object.assign(err as Error, { __telemetryEvent: event });
  }
}
