// KCode - Coordinator Message Bus
// Filesystem-based message passing between coordinator and workers
//
// Structure:
//   {scratchpadDir}/.messages/
//     inbox-coordinator.jsonl
//     inbox-worker-1.jsonl
//     inbox-worker-2.jsonl

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorMessage } from "./types";

export class MessageBus {
  private messagesDir: string;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(scratchpadDir: string) {
    this.messagesDir = join(scratchpadDir, ".messages");
    mkdirSync(this.messagesDir, { recursive: true });
  }

  /** Send a message to a recipient */
  send(message: CoordinatorMessage): void {
    if (!message.to || !message.from) {
      throw new Error("Message must have 'to' and 'from' fields");
    }
    const inbox = this.inboxPath(message.to);
    appendFileSync(inbox, JSON.stringify(message) + "\n");
  }

  /** Read and consume all pending messages for a recipient */
  receive(recipient: string): CoordinatorMessage[] {
    const inbox = this.inboxPath(recipient);
    if (!existsSync(inbox)) return [];

    const content = readFileSync(inbox, "utf-8");
    if (!content.trim()) return [];

    const messages: CoordinatorMessage[] = [];
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as CoordinatorMessage);
      } catch {
        // Skip malformed lines
      }
    }

    // Clear inbox after reading
    writeFileSync(inbox, "");

    return messages;
  }

  /** Peek at messages without consuming them */
  peek(recipient: string): CoordinatorMessage[] {
    const inbox = this.inboxPath(recipient);
    if (!existsSync(inbox)) return [];

    const content = readFileSync(inbox, "utf-8");
    if (!content.trim()) return [];

    const messages: CoordinatorMessage[] = [];
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as CoordinatorMessage);
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  }

  /** Start polling for messages at a given interval */
  startPolling(
    recipient: string,
    callback: (messages: CoordinatorMessage[]) => void,
    intervalMs: number = 1000,
  ): void {
    this.stopPolling(); // Clear any existing poll
    this.pollingInterval = setInterval(() => {
      const messages = this.receive(recipient);
      if (messages.length > 0) {
        callback(messages);
      }
    }, intervalMs);
  }

  /** Stop polling */
  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /** Check if polling is active */
  isPolling(): boolean {
    return this.pollingInterval !== null;
  }

  /** Get the messages directory path */
  getMessagesDir(): string {
    return this.messagesDir;
  }

  /** Get inbox file path for a recipient */
  private inboxPath(recipient: string): string {
    // Sanitize recipient name to prevent path traversal
    const safe = recipient.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.messagesDir, `inbox-${safe}.jsonl`);
  }
}
