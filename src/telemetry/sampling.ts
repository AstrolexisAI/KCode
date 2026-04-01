// KCode - Telemetry Sampling
// Decides whether an event should be recorded based on configurable rates.

import type { SamplingConfig, TelemetryEvent } from "./types";

/** Error-category event names that are always sampled at 100%. */
const ERROR_PATTERNS = [".error", ".crash", ".fatal"];

/** Event names that are always sampled at 100% (lifecycle events). */
const ALWAYS_SAMPLE = ["kcode.session.start", "kcode.session.end", "kcode.session.error"];

/**
 * Determine whether an event should be sampled (included) based on config.
 *
 * Priority rules:
 * 1. Errors and crashes: always 100%
 * 2. Explicit per-event-name rate in config
 * 3. Fallback to config.default rate
 */
export function shouldSample(event: TelemetryEvent, config: SamplingConfig): boolean {
  const name = event.name;

  // Always sample errors
  if (ALWAYS_SAMPLE.includes(name)) return true;
  if (ERROR_PATTERNS.some((p) => name.includes(p))) return true;

  // Long sessions (>20 turns) are always sampled
  if (typeof event.attributes.turn_count === "number" && event.attributes.turn_count > 20) {
    return true;
  }

  // Look for an explicit rate for this event name
  const rate = typeof config[name] === "number" ? (config[name] as number) : config.default;

  if (rate >= 1) return true;
  if (rate <= 0) return false;

  return Math.random() < rate;
}
