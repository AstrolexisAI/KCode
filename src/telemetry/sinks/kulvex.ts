// KCode - Kulvex Telemetry Sink
// Batches anonymous usage events and sends to kulvex.ai every 24 hours.
// 100% opt-in. Never sends prompts, responses, code, file paths, or API keys.

import type { TelemetryEvent, TelemetrySink } from "../types";

const KULVEX_TELEMETRY_URL = "https://kulvex.ai/api/telemetry";
const BATCH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_BATCH_SIZE = 500;

export class KulvexSink implements TelemetrySink {
  readonly name = "kulvex";
  private batch: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFlush = Date.now();

  constructor(private installId?: string) {}

  async send(event: TelemetryEvent): Promise<void> {
    // Strip any potentially sensitive attributes — only keep safe fields
    const safe: TelemetryEvent = {
      name: event.name,
      timestamp: event.timestamp,
      traceId: "",
      spanId: "",
      attributes: this.sanitizeAttributes(event.attributes),
      duration: event.duration,
    };

    this.batch.push(safe);

    // Flush if batch is full or interval has passed
    if (this.batch.length >= MAX_BATCH_SIZE) {
      await this.flush();
    } else if (Date.now() - this.lastFlush >= BATCH_INTERVAL_MS) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.batch.length === 0) return;

    const payload = {
      installId: this.installId ?? "anonymous",
      platform: process.platform,
      arch: process.arch,
      version: process.env.KCODE_VERSION ?? "unknown",
      events: this.batch.splice(0, MAX_BATCH_SIZE),
      sentAt: new Date().toISOString(),
    };

    try {
      await fetch(KULVEX_TELEMETRY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // Silently fail — telemetry must never block the user
    }

    this.lastFlush = Date.now();
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private sanitizeAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
    const SAFE_KEYS = new Set([
      "tool", "model", "duration_ms", "is_error", "event_type",
      "input_tokens", "output_tokens", "session_count", "os",
      "hardware_tier", "gpu_count", "command",
    ]);

    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (SAFE_KEYS.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
        safe[k] = v;
      }
    }
    return safe;
  }
}
