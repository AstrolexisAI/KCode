// KCode Bridge/Daemon Mode - Protocol
// Message parsing, serialization, validation, and creation utilities.

import { randomUUID } from "node:crypto";
import type {
  BridgeMessage,
  ClientMessage,
  ServerMessage,
  SessionCreateMessage,
  SessionMessageMessage,
  SessionCancelMessage,
  SessionDestroyMessage,
  PermissionResponseMessage,
  PingMessage,
  SpawnMode,
} from "./types";

// ─── Constants ──────────────────────────────────────────────────

const CLIENT_MESSAGE_TYPES = new Set([
  "session.create",
  "session.message",
  "session.cancel",
  "session.destroy",
  "permission.response",
  "ping",
]);

const SERVER_MESSAGE_TYPES = new Set([
  "session.created",
  "session.text",
  "session.tool_use",
  "session.thinking",
  "permission.request",
  "session.done",
  "session.error",
  "pong",
  "shutdown",
]);

const VALID_SPAWN_MODES = new Set<SpawnMode>(["single-session", "worktree", "shared-dir"]);

// ─── Validation Helpers ─────────────────────────────────────────

function assertString(obj: Record<string, unknown>, field: string, label: string): void {
  if (typeof obj[field] !== "string" || (obj[field] as string).length === 0) {
    throw new Error(`${label}: missing or invalid '${field}' (expected non-empty string)`);
  }
}

function assertBoolean(obj: Record<string, unknown>, field: string, label: string): void {
  if (typeof obj[field] !== "boolean") {
    throw new Error(`${label}: missing or invalid '${field}' (expected boolean)`);
  }
}

/** Validate base BridgeMessage fields (type, id, timestamp). */
function validateBase(obj: Record<string, unknown>): void {
  assertString(obj, "type", "BridgeMessage");
  assertString(obj, "id", "BridgeMessage");
  assertString(obj, "timestamp", "BridgeMessage");
}

/** Validate fields specific to each client message type. */
function validateClientFields(obj: Record<string, unknown>): void {
  const type = obj.type as string;

  switch (type) {
    case "session.create": {
      assertString(obj, "dir", "session.create");
      assertString(obj, "spawnMode", "session.create");
      if (!VALID_SPAWN_MODES.has(obj.spawnMode as SpawnMode)) {
        throw new Error(`session.create: invalid spawnMode '${obj.spawnMode}'`);
      }
      // model and initialPrompt are optional strings — validate only if present
      if (obj.model !== undefined && typeof obj.model !== "string") {
        throw new Error("session.create: 'model' must be a string if provided");
      }
      if (obj.initialPrompt !== undefined && typeof obj.initialPrompt !== "string") {
        throw new Error("session.create: 'initialPrompt' must be a string if provided");
      }
      break;
    }
    case "session.message": {
      assertString(obj, "sessionId", "session.message");
      assertString(obj, "content", "session.message");
      break;
    }
    case "session.cancel": {
      assertString(obj, "sessionId", "session.cancel");
      break;
    }
    case "session.destroy": {
      assertString(obj, "sessionId", "session.destroy");
      break;
    }
    case "permission.response": {
      assertString(obj, "sessionId", "permission.response");
      assertString(obj, "requestId", "permission.response");
      assertBoolean(obj, "allowed", "permission.response");
      assertBoolean(obj, "remember", "permission.response");
      break;
    }
    case "ping":
      // No extra fields required
      break;
    default:
      throw new Error(`Unknown client message type: '${type}'`);
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Parse a raw JSON string into a validated BridgeMessage.
 * Throws on invalid JSON or missing/invalid fields.
 */
export function parseMessage(raw: string): BridgeMessage {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON");
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error("Message must be a JSON object");
  }

  const record = obj as Record<string, unknown>;
  validateBase(record);

  const type = record.type as string;

  // Validate type-specific fields for client messages
  if (CLIENT_MESSAGE_TYPES.has(type)) {
    validateClientFields(record);
  } else if (!SERVER_MESSAGE_TYPES.has(type)) {
    throw new Error(`Unknown message type: '${type}'`);
  }

  return record as unknown as BridgeMessage;
}

/**
 * Serialize a BridgeMessage to JSON string.
 */
export function serializeMessage(msg: BridgeMessage): string {
  return JSON.stringify(msg);
}

/**
 * Create a BridgeMessage with auto-generated id and timestamp.
 * @param type - The message type discriminator.
 * @param fields - Additional fields to include.
 */
export function createMessage<T extends BridgeMessage>(
  type: T["type"],
  fields: Omit<T, "type" | "id" | "timestamp"> & { id?: string; timestamp?: string },
): T {
  return {
    ...fields,
    type,
    id: fields.id ?? randomUUID(),
    timestamp: fields.timestamp ?? new Date().toISOString(),
  } as T;
}

/**
 * Check if a message type is a client message type.
 */
export function isClientMessageType(type: string): boolean {
  return CLIENT_MESSAGE_TYPES.has(type);
}

/**
 * Check if a message type is a server message type.
 */
export function isServerMessageType(type: string): boolean {
  return SERVER_MESSAGE_TYPES.has(type);
}
