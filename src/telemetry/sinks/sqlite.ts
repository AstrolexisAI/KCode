// KCode - SQLite Telemetry Sink
// Appends telemetry events to a local SQLite table for offline analysis.

import type { TelemetrySink, TelemetryEvent } from "../types";
import { Database } from "bun:sqlite";

export class SQLiteSink implements TelemetrySink {
  name = "sqlite";
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;

  constructor(db: Database) {
    this.db = db;
    this.ensureTable();
    this.insertStmt = this.db.prepare(
      `INSERT INTO telemetry_events (name, timestamp, trace_id, span_id, parent_span_id, attributes, duration)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        attributes TEXT,
        duration REAL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    // Index for trace lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_telemetry_trace ON telemetry_events(trace_id)
    `);
    // Index for time-range queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry_events(timestamp)
    `);
  }

  async send(events: TelemetryEvent[]): Promise<void> {
    const insertMany = this.db.transaction((evts: TelemetryEvent[]) => {
      for (const event of evts) {
        this.insertStmt.run(
          event.name,
          event.timestamp,
          event.traceId,
          event.spanId,
          event.parentSpanId ?? null,
          JSON.stringify(event.attributes),
          event.duration ?? null,
        );
      }
    });
    insertMany(events);
  }

  async shutdown(): Promise<void> {
    // Don't close the DB — it may be shared (e.g. awareness.db)
  }
}
