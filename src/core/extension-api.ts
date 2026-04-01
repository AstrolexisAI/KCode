// KCode - Public Extension API
// Stable API surface for third-party extensions.
// Extensions can register tools, commands, and access conversation state (read-only).
//
// Documentation: docs/extension-api.md (forthcoming)

import { log } from "./logger";
import type { KCodeConfig, Message } from "./types";

// ─── Extension API Types ────────────────────────────────────────

export interface ExtensionManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  /** Minimum KCode version required */
  kcodeVersion?: string;
  /** Extension entry point (relative to extension root) */
  main: string;
  /** Permissions the extension requests */
  permissions?: ExtensionPermission[];
}

export type ExtensionPermission =
  | "tools:register" // Register custom tools
  | "commands:register" // Register slash commands
  | "conversation:read" // Read conversation messages
  | "config:read" // Read config (excluding secrets)
  | "hooks:listen" // Subscribe to lifecycle hooks
  | "filesystem:read" // Read files in project directory
  | "filesystem:write" // Write files in project directory
  | "network:fetch"; // Make HTTP requests

export interface ExtensionContext {
  /** Extension name */
  name: string;
  /** Working directory */
  cwd: string;
  /** Read-only access to conversation messages */
  getMessages(): ReadonlyArray<Readonly<Message>>;
  /** Read-only access to config (secrets redacted) */
  getConfig(): Readonly<Partial<KCodeConfig>>;
  /** Log a message from the extension */
  log(level: "info" | "warn" | "error" | "debug", message: string): void;
}

/** Tool definition that extensions can register */
export interface ExtensionToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for tool parameters */
  parameters: Record<string, unknown>;
  /** Tool execution function */
  execute: (input: Record<string, unknown>, ctx: ExtensionContext) => Promise<string>;
}

/** Command definition that extensions can register */
export interface ExtensionCommandDefinition {
  name: string;
  description: string;
  /** Command execution function */
  execute: (args: string, ctx: ExtensionContext) => Promise<string | void>;
}

/** Hook listener registration */
export interface ExtensionHookListener {
  event: string;
  handler: (data: Record<string, unknown>, ctx: ExtensionContext) => Promise<void>;
}

// ─── Extension Registry ────────────────────────────────────────

export interface RegisteredExtension {
  manifest: ExtensionManifest;
  tools: ExtensionToolDefinition[];
  commands: ExtensionCommandDefinition[];
  hooks: ExtensionHookListener[];
  loadedAt: number;
}

const _extensions = new Map<string, RegisteredExtension>();

/** Register an extension with the registry */
export function registerExtension(
  manifest: ExtensionManifest,
  setup: {
    tools?: ExtensionToolDefinition[];
    commands?: ExtensionCommandDefinition[];
    hooks?: ExtensionHookListener[];
  },
): void {
  if (_extensions.has(manifest.name)) {
    log.warn("extension", `Extension "${manifest.name}" is already registered, replacing`);
  }

  _extensions.set(manifest.name, {
    manifest,
    tools: setup.tools ?? [],
    commands: setup.commands ?? [],
    hooks: setup.hooks ?? [],
    loadedAt: Date.now(),
  });

  log.info(
    "extension",
    `Registered extension: ${manifest.name} v${manifest.version} (${setup.tools?.length ?? 0} tools, ${setup.commands?.length ?? 0} commands)`,
  );
}

/** Unregister an extension */
export function unregisterExtension(name: string): boolean {
  return _extensions.delete(name);
}

/** Get all registered extensions */
export function getExtensions(): ReadonlyArray<RegisteredExtension> {
  return [..._extensions.values()];
}

/** Get a specific extension by name */
export function getExtension(name: string): RegisteredExtension | null {
  return _extensions.get(name) ?? null;
}

/** Get all tools registered by extensions */
export function getExtensionTools(): ExtensionToolDefinition[] {
  return [..._extensions.values()].flatMap((ext) => ext.tools);
}

/** Get all commands registered by extensions */
export function getExtensionCommands(): ExtensionCommandDefinition[] {
  return [..._extensions.values()].flatMap((ext) => ext.commands);
}

/** Clear all registered extensions (for testing) */
export function _resetExtensions(): void {
  _extensions.clear();
}
