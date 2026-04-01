// KCode - Console Telemetry Sink
// Logs events to stdout. Intended for development use only.

import type { TelemetryEvent, TelemetrySink } from "../types";

export class ConsoleSink implements TelemetrySink {
  name = "console";

  async send(events: TelemetryEvent[]): Promise<void> {
    for (const event of events) {
      const dur = event.duration != null ? ` (${event.duration}ms)` : "";
      const attrs =
        Object.keys(event.attributes).length > 0 ? " " + JSON.stringify(event.attributes) : "";
      console.log(`[telemetry] ${event.timestamp} ${event.name}${dur}${attrs}`);
    }
  }

  async shutdown(): Promise<void> {
    // Nothing to clean up
  }
}
