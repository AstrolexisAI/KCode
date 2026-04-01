// KCode - Custom HTTP Telemetry Sink
// Generic HTTP webhook sink for forwarding telemetry events to any endpoint.

import type { TelemetryEvent, TelemetrySink } from "../types";

export interface CustomHTTPSinkOptions {
  /** Webhook URL */
  url: string;
  /** HTTP method (default POST) */
  method?: string;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Timeout in milliseconds (default 10000) */
  timeoutMs?: number;
}

export class CustomHTTPSink implements TelemetrySink {
  name = "custom-http";
  private url: string;
  private method: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(options: CustomHTTPSinkOptions) {
    this.url = options.url;
    this.method = options.method ?? "POST";
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(events: TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: this.method,
        headers: {
          "Content-Type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Custom HTTP sink returned ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async shutdown(): Promise<void> {
    // Nothing persistent to clean up
  }
}
