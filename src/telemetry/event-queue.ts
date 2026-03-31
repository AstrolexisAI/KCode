// KCode - Telemetry Event Queue
// Circular buffer with periodic and size-based flushing to configured sinks.

import type { TelemetryEvent, TelemetrySink } from "./types";

const DEFAULT_MAX_BUFFER = 1000;
const FLUSH_SIZE_THRESHOLD = 100;
const FLUSH_INTERVAL_MS = 15_000;

export class EventQueue {
  private buffer: TelemetryEvent[] = [];
  private sinks: TelemetrySink[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private maxBufferSize: number;
  private _flushing = false;
  private _shutdown = false;

  constructor(maxBufferSize: number = DEFAULT_MAX_BUFFER) {
    this.maxBufferSize = maxBufferSize;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // Unref so the timer doesn't keep the process alive
    if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }

  /** Add an event to the buffer. Triggers flush if size threshold is reached. */
  enqueue(event: TelemetryEvent): void {
    if (this._shutdown) return;

    this.buffer.push(event);

    // Circular buffer: drop oldest when full
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.splice(0, this.buffer.length - this.maxBufferSize);
    }

    // Flush when buffer hits threshold
    if (this.buffer.length >= FLUSH_SIZE_THRESHOLD) {
      queueMicrotask(() => void this.flush());
    }
  }

  /** Flush all buffered events to every registered sink. */
  async flush(): Promise<void> {
    if (this._flushing || this.buffer.length === 0) return;
    this._flushing = true;

    const batch = this.buffer.splice(0, this.buffer.length);

    const promises = this.sinks.map(async (sink) => {
      try {
        await sink.send(batch);
      } catch (err) {
        // Fire-and-forget: log warning but don't retry
        if (typeof process !== "undefined" && process.env.KCODE_LOG_LEVEL === "debug") {
          console.warn(`[telemetry] Sink "${sink.name}" failed:`, err);
        }
      }
    });

    await Promise.allSettled(promises);
    this._flushing = false;
  }

  /** Register a sink. */
  addSink(sink: TelemetrySink): void {
    if (!this.sinks.some((s) => s.name === sink.name)) {
      this.sinks.push(sink);
    }
  }

  /** Remove a sink by name. */
  removeSink(name: string): void {
    this.sinks = this.sinks.filter((s) => s.name !== name);
  }

  /** Graceful shutdown: flush remaining events and stop the timer. */
  async shutdown(): Promise<void> {
    this._shutdown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    await Promise.allSettled(this.sinks.map((s) => s.shutdown()));
  }

  /** Current number of buffered events (for testing / diagnostics). */
  get bufferedCount(): number {
    return this.buffer.length;
  }

  /** Current registered sink names. */
  get sinkNames(): string[] {
    return this.sinks.map((s) => s.name);
  }
}
