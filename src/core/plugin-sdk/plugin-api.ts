// KCode - Plugin API
// API exposed to plugins at runtime for controlled access to KCode internals.

import { log } from "../logger";

export interface MemoryEntry {
  type: string;
  title: string;
  content: string;
  createdAt?: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  duration?: number;
}

export interface PluginContext {
  pluginName: string;
  pluginDir: string;
  kcodeVersion: string;
}

type EventHandler = (...args: unknown[]) => void;

export class PluginAPI {
  private ctx: PluginContext;
  private eventHandlers: Map<string, Set<EventHandler>> = new Map();
  private configStore: Map<string, unknown> = new Map();
  private memories: MemoryEntry[] = [];

  readonly log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    const prefix = `plugin:${ctx.pluginName}`;
    this.log = {
      info: (msg: string) => log.info(prefix, msg),
      warn: (msg: string) => log.warn(prefix, msg),
      error: (msg: string) => log.error(prefix, msg),
      debug: (msg: string) => log.debug(prefix, msg),
    };
  }

  getContext(): PluginContext {
    return { ...this.ctx };
  }

  // ─── Config (scoped to plugin namespace) ───────────────────────

  async getConfig(key: string): Promise<unknown> {
    const scopedKey = `plugin.${this.ctx.pluginName}.${key}`;
    if (this.configStore.has(scopedKey)) {
      return this.configStore.get(scopedKey);
    }
    try {
      const { getConfig } = await import("../config");
      const settings = getConfig();
      return (settings as Record<string, unknown>)[scopedKey] ?? null;
    } catch {
      return null;
    }
  }

  async setConfig(key: string, value: unknown): Promise<void> {
    const scopedKey = `plugin.${this.ctx.pluginName}.${key}`;
    this.configStore.set(scopedKey, value);
    try {
      const { kcodeHome } = await import("../paths");
      const { join } = await import("node:path");
      const configPath = join(kcodeHome(), "plugin-config.json");
      let existing: Record<string, unknown> = {};
      try {
        const file = Bun.file(configPath);
        if (await file.exists()) {
          existing = await file.json();
        }
      } catch {
        /* empty */
      }
      existing[scopedKey] = value;
      await Bun.write(configPath, JSON.stringify(existing, null, 2));
    } catch (err) {
      this.log.error(`Failed to persist config: ${err}`);
    }
  }

  // ─── Memory (scoped to plugin) ────────────────────────────────

  async getMemories(type?: string): Promise<MemoryEntry[]> {
    try {
      const { kcodeHome } = await import("../paths");
      const { join } = await import("node:path");
      const { readdirSync, readFileSync } = await import("node:fs");
      const memDir = join(kcodeHome(), "plugins", this.ctx.pluginName, "memories");
      try {
        const files = readdirSync(memDir).filter((f) => f.endsWith(".md"));
        const entries: MemoryEntry[] = [];
        for (const file of files) {
          const content = readFileSync(join(memDir, file), "utf-8");
          const entry = parseMemoryFile(content);
          if (entry && (!type || entry.type === type)) {
            entries.push(entry);
          }
        }
        return entries;
      } catch {
        return [];
      }
    } catch {
      return this.memories.filter((m) => !type || m.type === type);
    }
  }

  async addMemory(entry: { type: string; title: string; content: string }): Promise<void> {
    const full: MemoryEntry = { ...entry, createdAt: new Date().toISOString() };
    this.memories.push(full);
    try {
      const { kcodeHome } = await import("../paths");
      const { join } = await import("node:path");
      const { mkdirSync } = await import("node:fs");
      const memDir = join(kcodeHome(), "plugins", this.ctx.pluginName, "memories");
      mkdirSync(memDir, { recursive: true });
      const filename = `${entry.type}_${entry.title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.md`;
      const fileContent = `---\nname: ${entry.title}\ntype: ${entry.type}\ncreatedAt: ${full.createdAt}\n---\n\n${entry.content}\n`;
      await Bun.write(join(memDir, filename), fileContent);
    } catch (err) {
      this.log.error(`Failed to persist memory: ${err}`);
    }
  }

  // ─── Tool Execution ───────────────────────────────────────────

  async executeTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();
    try {
      const tools = await import("../../tools/index");
      const allTools = tools.getRegisteredTools?.() ?? tools.default ?? [];
      const tool = Array.isArray(allTools)
        ? allTools.find((t: any) => t.name === name)
        : null;
      if (!tool) {
        return {
          success: false,
          output: "",
          error: `Tool not found: ${name}`,
        };
      }
      this.log.debug(`Executing tool: ${name}`);
      const result = await tool.handler(input);
      const duration = Date.now() - start;
      return {
        success: true,
        output: typeof result === "string" ? result : JSON.stringify(result),
        duration,
      };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: `Tool not found: ${name}`,
        duration: Date.now() - start,
      };
    }
  }

  // ─── Events ───────────────────────────────────────────────────

  on(event: string, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    this.eventHandlers.get(event)?.forEach((h) => {
      try {
        h(...args);
      } catch (err) {
        this.log.error(`Event handler error for "${event}": ${err}`);
      }
    });
    // Wildcard listeners
    this.eventHandlers.get("*")?.forEach((h) => {
      try {
        h(event, ...args);
      } catch (err) {
        this.log.error(`Wildcard handler error: ${err}`);
      }
    });
  }

  // ─── UI Helpers ───────────────────────────────────────────────

  async showNotification(
    message: string,
    type: "info" | "warning" | "error" = "info",
  ): Promise<void> {
    const prefix = type === "error" ? "\u2717" : type === "warning" ? "\u26a0" : "\u2713";
    console.log(`[${this.ctx.pluginName}] ${prefix} ${message}`);
  }

  async showProgress(label: string, fn: () => Promise<void>): Promise<void> {
    this.log.info(`${label}...`);
    const start = Date.now();
    try {
      await fn();
      this.log.info(`${label} done (${Date.now() - start}ms)`);
    } catch (err) {
      this.log.error(`${label} failed: ${err}`);
      throw err;
    }
  }
}

function parseMemoryFile(content: string): MemoryEntry | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!fmMatch) return null;
  const frontmatter = fmMatch[1];
  const body = fmMatch[2].trim();
  const meta: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      meta[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
    }
  }
  return {
    type: meta.type || "unknown",
    title: meta.name || "untitled",
    content: body,
    createdAt: meta.createdAt,
  };
}

export function createPluginAPI(ctx: PluginContext): PluginAPI {
  return new PluginAPI(ctx);
}
