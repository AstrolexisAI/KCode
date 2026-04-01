// KCode - Lateral Chat for Collaboration
// Private chat between participants that does NOT go to the AI model.

import { log } from "../logger";
import type { ChatMessage, CollabEvent } from "./types";

type EventListener = (event: CollabEvent) => void;

const MAX_HISTORY = 100;

export class CollabChat {
  private messages: ChatMessage[] = [];
  private listeners: Set<EventListener> = new Set();

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send a chat message (not to AI). */
  sendMessage(participantId: string, participantName: string, message: string): ChatMessage {
    const chatMsg: ChatMessage = {
      id: crypto.randomUUID(),
      participantId,
      participantName,
      message,
      timestamp: Date.now(),
    };

    this.messages.push(chatMsg);

    // Trim history
    if (this.messages.length > MAX_HISTORY) {
      this.messages = this.messages.slice(-MAX_HISTORY);
    }

    this.broadcast({
      type: "collab.chat",
      data: { from: participantName, message, id: chatMsg.id },
      timestamp: chatMsg.timestamp,
      participantId,
    });

    return chatMsg;
  }

  /** Get chat history. */
  getHistory(): ChatMessage[] {
    return [...this.messages];
  }

  /** Clear chat history. */
  clear(): void {
    this.messages = [];
  }

  private broadcast(event: CollabEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.debug("collab/chat", `Event listener error: ${err}`);
      }
    }
  }
}
