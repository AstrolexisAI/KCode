// KCode - Web UI Session Bridge
// Bridges the Web UI with the active ConversationManager instance
// This module holds references to the active session, allowing both
// the REST API and WebSocket handlers to access the conversation.

import type { ConversationManager } from "../core/conversation";
import type { ToolRegistry } from "../core/tool-registry";

let activeManager: ConversationManager | null = null;
let activeModel = "unknown";
let workingDirectory = process.cwd();
let activeTools: ToolRegistry | null = null;

/** Set the active conversation manager (called from main app) */
export function setConversationManager(manager: ConversationManager): void {
  activeManager = manager;
  try {
    activeModel = manager.getConfig().model;
    workingDirectory = manager.getConfig().workingDirectory;
  } catch { /* config not available yet */ }
}

/** Get the active conversation manager */
export function getConversationManager(): ConversationManager | null {
  return activeManager;
}

/** Set the active model name */
export function setActiveModel(model: string): void {
  activeModel = model;
}

/** Get the active model name */
export function getActiveModel(): string {
  return activeModel;
}

/** Set the working directory */
export function setWorkingDirectory(dir: string): void {
  workingDirectory = dir;
}

/** Get the working directory */
export function getWorkingDirectory(): string {
  return workingDirectory;
}

/** Set the tool registry */
export function setToolRegistry(tools: ToolRegistry): void {
  activeTools = tools;
}

/** Get the tool registry */
export function getToolRegistry(): ToolRegistry | null {
  return activeTools;
}
