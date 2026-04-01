// KCode - Cloud Session Synchronization
// Handles syncing conversation sessions to the cloud service,
// supporting both full and incremental (delta) sync modes.

import type { CloudClient } from "./client";
import type { SyncResult } from "./types";
import { log } from "../logger";

/** Maximum content length before truncation during sanitization */
const MAX_CONTENT_LENGTH = 2048;

/** Fields to strip from tool call messages during sanitization */
const TOOL_FIELDS_TO_STRIP = ["input", "output", "result", "content"] as const;

export class SessionSync {
  private client: CloudClient;
  private syncState: Map<string, number>;

  constructor(client: CloudClient) {
    this.client = client;
    this.syncState = new Map();
  }

  /**
   * Full sync: uploads all messages and stats for a session.
   * Replaces any previously synced data on the server.
   */
  async syncSession(
    sessionId: string,
    messages: any[],
    stats: any,
  ): Promise<SyncResult> {
    const sanitized = messages.map((msg) => this.sanitizeMessage(msg));

    const result = await this.client.request<SyncResult>(
      "POST",
      `/api/v1/sessions/${sessionId}/sync`,
      {
        messages: sanitized,
        stats,
        fullSync: true,
      },
    );

    this.setLastSyncIndex(sessionId, messages.length);
    log.debug(
      "cloud-sync",
      `Full sync for session ${sessionId}: ${messages.length} messages`,
    );

    return result;
  }

  /**
   * Incremental sync: only uploads messages added since the last sync.
   * Falls back to full sync if lastSyncIndex is 0 or missing.
   */
  async syncDelta(
    sessionId: string,
    messages: any[],
    lastSyncIndex: number,
  ): Promise<SyncResult> {
    // If no previous sync, do a full sync of all messages
    if (lastSyncIndex <= 0 || lastSyncIndex >= messages.length) {
      return this.syncSession(sessionId, messages, null);
    }

    const newMessages = messages.slice(lastSyncIndex);
    const sanitized = newMessages.map((msg) => this.sanitizeMessage(msg));

    const result = await this.client.request<SyncResult>(
      "POST",
      `/api/v1/sessions/${sessionId}/sync`,
      {
        messages: sanitized,
        startIndex: lastSyncIndex,
        fullSync: false,
      },
    );

    this.setLastSyncIndex(sessionId, messages.length);
    log.debug(
      "cloud-sync",
      `Delta sync for session ${sessionId}: ${newMessages.length} new messages (from index ${lastSyncIndex})`,
    );

    return result;
  }

  /**
   * Sanitize a message for cloud upload:
   * - Truncates text content to MAX_CONTENT_LENGTH characters
   * - Strips tool call input/output/result fields (keeps metadata only)
   * - Preserves role, timestamp, and message ID
   */
  sanitizeMessage(msg: any): any {
    if (!msg || typeof msg !== "object") return msg;

    const sanitized: any = { ...msg };

    // Truncate string content
    if (typeof sanitized.content === "string") {
      if (sanitized.content.length > MAX_CONTENT_LENGTH) {
        sanitized.content =
          sanitized.content.slice(0, MAX_CONTENT_LENGTH) + " [truncated]";
      }
    }

    // Handle array content (multi-part messages)
    if (Array.isArray(sanitized.content)) {
      sanitized.content = sanitized.content.map((part: any) => {
        if (!part || typeof part !== "object") return part;
        const sanitizedPart = { ...part };
        if (
          typeof sanitizedPart.text === "string" &&
          sanitizedPart.text.length > MAX_CONTENT_LENGTH
        ) {
          sanitizedPart.text =
            sanitizedPart.text.slice(0, MAX_CONTENT_LENGTH) + " [truncated]";
        }
        return sanitizedPart;
      });
    }

    // Strip tool call details, keep only metadata
    if (sanitized.tool_calls && Array.isArray(sanitized.tool_calls)) {
      sanitized.tool_calls = sanitized.tool_calls.map((tc: any) => {
        const cleaned: any = {
          id: tc.id,
          type: tc.type,
          name: tc.name ?? tc.function?.name,
        };
        return cleaned;
      });
    }

    // Strip tool result content
    if (sanitized.role === "tool") {
      for (const field of TOOL_FIELDS_TO_STRIP) {
        if (field in sanitized && field !== "content") {
          delete sanitized[field];
        }
      }
      // Truncate tool content too
      if (typeof sanitized.content === "string") {
        if (sanitized.content.length > MAX_CONTENT_LENGTH) {
          sanitized.content =
            sanitized.content.slice(0, MAX_CONTENT_LENGTH) + " [truncated]";
        }
      }
    }

    return sanitized;
  }

  /**
   * Get the index of the last successfully synced message for a session.
   * Returns 0 if the session has never been synced.
   */
  getLastSyncIndex(sessionId: string): number {
    return this.syncState.get(sessionId) ?? 0;
  }

  /**
   * Update the last sync index for a session.
   */
  setLastSyncIndex(sessionId: string, index: number): void {
    this.syncState.set(sessionId, index);
  }
}
