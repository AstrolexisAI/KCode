// KCode - Telemetry Types
// Core interfaces for the professional telemetry pipeline.

export interface TelemetryEvent {
  /** Event name, e.g. "kcode.tool.execute" */
  name: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Trace ID for correlating events within a session */
  traceId: string;
  /** Unique span ID for this event */
  spanId: string;
  /** Parent span ID (undefined for root spans) */
  parentSpanId?: string;
  /** Arbitrary key-value attributes */
  attributes: Record<string, unknown>;
  /** Duration in milliseconds (set when span ends) */
  duration?: number;
}

export interface TelemetrySink {
  /** Human-readable sink name */
  name: string;
  /** Send a batch of events to the sink */
  send(events: TelemetryEvent[]): Promise<void>;
  /** Graceful shutdown */
  shutdown(): Promise<void>;
}

export type TelemetryLevel = "off" | "minimal" | "standard" | "verbose";

export interface SamplingConfig {
  /** Default sampling rate (0.0 - 1.0) */
  default: number;
  /** Per-event-name overrides */
  [eventName: string]: number;
}

export interface SinkConfig {
  enabled: boolean;
  /** Sink-specific options */
  [key: string]: unknown;
}

export interface TelemetryConfig {
  /** Master switch */
  enabled: boolean;
  /** Privacy level */
  level: TelemetryLevel;
  /** Sampling rates */
  sampling: SamplingConfig;
  /** Sink configurations keyed by sink name */
  sinks: Record<string, SinkConfig>;
}

export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: number;
  attributes: Record<string, unknown>;
}
