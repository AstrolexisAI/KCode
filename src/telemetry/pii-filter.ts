// KCode - PII Filter for Telemetry
// Strips or hashes sensitive data before events leave the device.

import type { TelemetryEvent } from "./types";

const encoder = new TextEncoder();

/** SHA-256 hash truncated to 12 hex characters. Uses Bun's native crypto. */
function sha256Short(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(encoder.encode(input));
  return hasher.digest("hex").slice(0, 12);
}

/** Fields that must never appear in telemetry. */
const STRIP_FIELDS = [
  "content",
  "user_input",
  "assistant_output",
  "api_key",
  "token",
  "password",
  "secret",
  "authorization",
] as const;

/** Fields containing file paths that should be hashed. */
const PATH_FIELDS = ["file_path", "path", "cwd", "working_directory"] as const;

/**
 * Remove PII from a telemetry event.
 *
 * - Hashes file paths (SHA-256 truncated to 12 chars)
 * - Removes content, user_input, assistant_output, api_key, etc.
 * - Truncates error messages to 100 characters
 */
export function filterPII(event: TelemetryEvent): TelemetryEvent {
  const attrs = { ...event.attributes };

  // Hash path fields
  for (const field of PATH_FIELDS) {
    if (typeof attrs[field] === "string") {
      attrs[`${field}_hash`] = sha256Short(attrs[field] as string);
      delete attrs[field];
    }
  }

  // Strip sensitive fields
  for (const field of STRIP_FIELDS) {
    delete attrs[field];
  }

  // Truncate error messages
  if (typeof attrs.error_message === "string") {
    attrs.error_message = (attrs.error_message as string).slice(0, 100);
  }

  return { ...event, attributes: attrs };
}
