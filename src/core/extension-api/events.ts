// KCode - Extension API Event Emitter
// Typed event emitter with wildcard support for the Extension API

import type { ExtensionEvent } from "./types";

type EventHandler = (event: ExtensionEvent) => void;

/**
 * Event emitter for Extension API events.
 * Supports typed event subscriptions and wildcard '*' listeners
 * that receive all events regardless of type.
 */
export class ExtensionEventEmitter {
  private listeners: Map<string, Set<EventHandler>> = new Map();

  /**
   * Register a handler for a specific event type.
   * Use '*' to receive all events.
   */
  on(eventType: string, handler: EventHandler): void {
    let set = this.listeners.get(eventType);
    if (!set) {
      set = new Set();
      this.listeners.set(eventType, set);
    }
    set.add(handler);
  }

  /**
   * Remove a previously registered handler for a specific event type.
   */
  off(eventType: string, handler: EventHandler): void {
    const set = this.listeners.get(eventType);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this.listeners.delete(eventType);
    }
  }

  /**
   * Emit an event to all matching listeners.
   * Notifies both specific-type listeners and wildcard '*' listeners.
   */
  emit(event: ExtensionEvent): void {
    // Notify specific listeners
    const specific = this.listeners.get(event.type);
    if (specific) {
      for (const handler of specific) {
        try {
          handler(event);
        } catch {
          // Swallow handler errors to avoid breaking the emit chain
        }
      }
    }

    // Notify wildcard listeners (event.type is never "*" by typing,
    // but kept for runtime safety in case raw events are emitted directly)
    if ((event.type as string) !== "*") {
      const wildcard = this.listeners.get("*");
      if (wildcard) {
        for (const handler of wildcard) {
          try {
            handler(event);
          } catch {
            // Swallow handler errors
          }
        }
      }
    }
  }

  /**
   * Register a handler that fires only once, then auto-removes itself.
   */
  once(eventType: string, handler: EventHandler): void {
    const wrapper: EventHandler = (event) => {
      this.off(eventType, wrapper);
      handler(event);
    };
    this.on(eventType, wrapper);
  }

  /**
   * Remove all listeners, optionally scoped to a specific event type.
   */
  removeAllListeners(eventType?: string): void {
    if (eventType !== undefined) {
      this.listeners.delete(eventType);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * Returns the number of listeners registered for a given event type.
   */
  listenerCount(eventType: string): number {
    const set = this.listeners.get(eventType);
    return set ? set.size : 0;
  }

  /**
   * Returns all event types that currently have at least one listener.
   */
  eventNames(): string[] {
    return Array.from(this.listeners.keys());
  }
}
