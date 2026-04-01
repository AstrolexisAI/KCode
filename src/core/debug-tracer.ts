// KCode - Debug Tracer
// Provides agent decision reasoning, tool selection rationale, and internal state transitions.
// Zero overhead when disabled — all trace points check isEnabled() before doing any work.

// ─── Types ───────────────────────────────────────────────────

export type DebugCategory =
  | "decision"
  | "routing"
  | "tool"
  | "context"
  | "permission"
  | "guard"
  | "hook"
  | "model";

export interface DebugEvent {
  timestamp: number;
  category: DebugCategory;
  action: string; // what happened
  reason: string; // why it happened
  details?: Record<string, unknown>; // extra context
}

export interface GetEventsOptions {
  category?: DebugCategory;
  limit?: number;
  since?: number; // timestamp
}

// ─── DebugTracer ─────────────────────────────────────────────

export class DebugTracer {
  private events: DebugEvent[] = [];
  private enabled: boolean = false;
  private static MAX_EVENTS = 2000;

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Record a trace event. No-op if disabled. */
  trace(
    category: DebugCategory,
    action: string,
    reason: string,
    details?: Record<string, unknown>,
  ): void {
    if (!this.enabled) return;
    this.events.push({
      timestamp: Date.now(),
      category,
      action,
      reason,
      details,
    });
    // Cap buffer to prevent unbounded memory growth
    if (this.events.length > DebugTracer.MAX_EVENTS) {
      this.events = this.events.slice(-DebugTracer.MAX_EVENTS);
    }
  }

  /** Get events with optional filtering. */
  getEvents(opts?: GetEventsOptions): DebugEvent[] {
    let result = this.events;
    if (opts?.category) {
      result = result.filter((e) => e.category === opts.category);
    }
    if (opts?.since) {
      const since = opts.since;
      result = result.filter((e) => e.timestamp >= since);
    }
    if (opts?.limit) {
      result = result.slice(-opts.limit);
    }
    return result;
  }

  /** Get the last N events. */
  getLastEvents(n: number): DebugEvent[] {
    return this.events.slice(-n);
  }

  /** Format a single event as a concise one-line string. */
  formatEvent(event: DebugEvent): string {
    const time = new Date(event.timestamp).toISOString().slice(11, 23); // HH:mm:ss.SSS
    const cat = event.category.toUpperCase().padEnd(10);
    let line = `[${time}] ${cat} ${event.action} -- ${event.reason}`;
    if (event.details && Object.keys(event.details).length > 0) {
      const detailStr = Object.entries(event.details)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ");
      line += ` (${detailStr})`;
    }
    return line;
  }

  /** Format a full trace of events as a multi-line string. */
  formatTrace(events?: DebugEvent[]): string {
    const evts = events ?? this.events;
    if (evts.length === 0) {
      return "  No debug trace events recorded.";
    }
    const lines = [`  Debug Trace (${evts.length} events)`, `  ${"─".repeat(60)}`];
    for (const event of evts) {
      lines.push(`  ${this.formatEvent(event)}`);
    }
    return lines.join("\n");
  }

  /** Clear all recorded events. */
  clear(): void {
    this.events = [];
  }

  /** Get the total number of recorded events. */
  get size(): number {
    return this.events.length;
  }

  // ─── Convenience Methods ─────────────────────────────────────

  /** Trace tool selection with optional alternatives considered. */
  traceToolChoice(toolName: string, reason: string, alternatives?: string[]): void {
    if (!this.enabled) return;
    this.trace(
      "tool",
      `Selected tool: ${toolName}`,
      reason,
      alternatives ? { alternatives } : undefined,
    );
  }

  /** Trace a model switch (fallback, routing, etc.) */
  traceModelSwitch(from: string, to: string, reason: string): void {
    if (!this.enabled) return;
    this.trace("model", `Model switch: ${from} -> ${to}`, reason, { from, to });
  }

  /** Trace a permission decision (allowed, denied, rule match). */
  tracePermission(tool: string, action: string, rule?: string): void {
    if (!this.enabled) return;
    this.trace(
      "permission",
      `${tool}: ${action}`,
      rule ?? "default policy",
      rule ? { rule } : undefined,
    );
  }

  /** Trace context compaction. */
  traceCompaction(tokensBefore: number, tokensAfter: number, method: string): void {
    if (!this.enabled) return;
    const saved = tokensBefore - tokensAfter;
    this.trace(
      "context",
      `Compaction (${method})`,
      `Reduced ${tokensBefore} -> ${tokensAfter} tokens (saved ${saved})`,
      {
        tokensBefore,
        tokensAfter,
        saved,
        method,
      },
    );
  }

  /** Trace guard trigger (loop detection, force stop, etc.) */
  traceGuard(guard: string, triggered: boolean, details?: string): void {
    if (!this.enabled) return;
    const action = triggered
      ? `Guard triggered: ${guard}`
      : `Guard checked: ${guard} (not triggered)`;
    this.trace("guard", action, details ?? (triggered ? "Safety limit reached" : "Within limits"));
  }

  /** Trace routing decisions (task classification, model selection). */
  traceRouting(taskType: string, selectedModel: string, candidates?: string[]): void {
    if (!this.enabled) return;
    this.trace(
      "routing",
      `Route: ${taskType} -> ${selectedModel}`,
      `Task classified as "${taskType}"`,
      {
        taskType,
        selectedModel,
        ...(candidates ? { candidates } : {}),
      },
    );
  }
}

// ─── Singleton ────────────��──────────────────────────────────

let globalTracer: DebugTracer | null = null;

/** Get or create the global debug tracer singleton. */
export function getDebugTracer(): DebugTracer {
  if (!globalTracer) {
    globalTracer = new DebugTracer();
  }
  return globalTracer;
}

/** Reset the global tracer (for testing). */
export function resetDebugTracer(): void {
  globalTracer = null;
}
