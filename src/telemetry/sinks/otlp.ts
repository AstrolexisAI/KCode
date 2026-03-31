// KCode - OTLP/HTTP Telemetry Sink
// Sends events to an OpenTelemetry-compatible endpoint using OTLP/HTTP JSON protocol.

import type { TelemetrySink, TelemetryEvent } from "../types";

export interface OTLPSinkOptions {
  /** OTLP endpoint, e.g. "https://otel.example.com:4318/v1/traces" */
  endpoint: string;
  /** Optional headers (e.g. Authorization) */
  headers?: Record<string, string>;
  /** Timeout in milliseconds (default 10000) */
  timeoutMs?: number;
}

/**
 * Convert a TelemetryEvent to OTLP span format (simplified).
 */
function toOTLPSpan(event: TelemetryEvent) {
  const startNanos = BigInt(new Date(event.timestamp).getTime()) * 1_000_000n;
  const durationNanos = event.duration != null ? BigInt(Math.round(event.duration * 1_000_000)) : 0n;

  return {
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId || "",
    name: event.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: startNanos.toString(),
    endTimeUnixNano: (startNanos + durationNanos).toString(),
    attributes: Object.entries(event.attributes).map(([key, value]) => ({
      key,
      value: formatOTLPValue(value),
    })),
    status: { code: 0 }, // UNSET
  };
}

function formatOTLPValue(value: unknown) {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "boolean") return { boolValue: value };
  return { stringValue: String(value) };
}

export class OTLPSink implements TelemetrySink {
  name = "otlp";
  private endpoint: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(options: OTLPSinkOptions) {
    this.endpoint = options.endpoint;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(events: TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return;

    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "kcode" } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "kcode.telemetry" },
              spans: events.map(toOTLPSpan),
            },
          ],
        },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OTLP endpoint returned ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async shutdown(): Promise<void> {
    // Nothing persistent to clean up
  }
}
