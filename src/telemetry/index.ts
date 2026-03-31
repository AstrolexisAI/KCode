// KCode - Telemetry Module Entry Point
// Initializes the telemetry pipeline: PII filter -> Sampling -> Event Queue -> Sinks

import type { TelemetryConfig, TelemetryEvent } from "./types";
import { EventQueue } from "./event-queue";
import { filterPII } from "./pii-filter";
import { shouldSample } from "./sampling";
import { startSpan, endSpan, getTraceId, resetTraceId, setTraceId } from "./spans";

// Re-export all public types and utilities
export { EventQueue } from "./event-queue";
export { filterPII } from "./pii-filter";
export { shouldSample } from "./sampling";
export { startSpan, endSpan, withSpan, getTraceId, resetTraceId, setTraceId } from "./spans";
export type {
  TelemetryEvent,
  TelemetrySink,
  TelemetryConfig,
  TelemetryLevel,
  SamplingConfig,
  SinkConfig,
  Span,
} from "./types";

// Sinks
export { ConsoleSink } from "./sinks/console";
export { SQLiteSink } from "./sinks/sqlite";
export { OTLPSink } from "./sinks/otlp";
export { CustomHTTPSink } from "./sinks/custom-http";

// ─── Singleton ─────────────────────────────────────────────────

let _queue: EventQueue | null = null;
let _config: TelemetryConfig | null = null;

/**
 * Initialize the telemetry system with the given config.
 * Creates the EventQueue and registers configured sinks.
 */
export function initTelemetry(config: TelemetryConfig): EventQueue {
  _config = config;

  if (_queue) {
    // Already initialized — return existing
    return _queue;
  }

  _queue = new EventQueue();

  // Add sinks based on config
  if (config.sinks.console?.enabled) {
    const { ConsoleSink } = require("./sinks/console") as typeof import("./sinks/console");
    _queue.addSink(new ConsoleSink());
  }

  if (config.sinks.sqlite?.enabled) {
    // SQLite sink is added externally since it needs a DB reference
    // Caller should do: getTelemetry()?.addSink(new SQLiteSink(db))
  }

  if (config.sinks.otlp?.enabled) {
    const { OTLPSink } = require("./sinks/otlp") as typeof import("./sinks/otlp");
    const sinkConf = config.sinks.otlp;
    _queue.addSink(
      new OTLPSink({
        endpoint: (sinkConf.endpoint as string) ?? "http://localhost:4318/v1/traces",
        headers: (sinkConf.headers as Record<string, string>) ?? {},
      }),
    );
  }

  if (config.sinks["custom-http"]?.enabled) {
    const { CustomHTTPSink } = require("./sinks/custom-http") as typeof import("./sinks/custom-http");
    const sinkConf = config.sinks["custom-http"];
    _queue.addSink(
      new CustomHTTPSink({
        url: sinkConf.url as string,
        headers: (sinkConf.headers as Record<string, string>) ?? {},
      }),
    );
  }

  return _queue;
}

/**
 * Get the singleton EventQueue (null if telemetry not initialized or disabled).
 */
export function getTelemetry(): EventQueue | null {
  return _queue;
}

/**
 * Convenience: track an event through the full pipeline (PII filter + sampling + enqueue).
 * No-op if telemetry is not initialized or disabled.
 */
export function trackEvent(
  name: string,
  attributes: Record<string, unknown> = {},
  duration?: number,
): void {
  if (!_queue || !_config || !_config.enabled) return;

  const event: TelemetryEvent = {
    name,
    timestamp: new Date().toISOString(),
    traceId: getTraceId(),
    spanId: Math.random().toString(16).slice(2, 18),
    attributes,
    duration,
  };

  // Apply sampling
  if (!shouldSample(event, _config.sampling)) return;

  // Apply PII filter
  const filtered = filterPII(event);

  _queue.enqueue(filtered);
}

/**
 * Shutdown telemetry: flush remaining events and clean up.
 */
export async function shutdown(): Promise<void> {
  if (_queue) {
    await _queue.shutdown();
    _queue = null;
  }
  _config = null;
}

/**
 * Reset telemetry state (for testing).
 */
export function _resetForTesting(): void {
  _queue = null;
  _config = null;
  resetTraceId();
}
