// KCode - Custom Agent Definitions (Rich Agent System)
// Load user-defined agents from ~/.kcode/agents/ and .kcode/agents/
// Each agent is a .md file with YAML frontmatter configuration.
//
// Supported frontmatter fields:
//   name, description, model, tools, disallowedTools, permissionMode,
//   maxTurns, effort, apiKey, apiBase, mcpServers (inline JSON or multi-line),
//   hooks (inline JSON or multi-line), memory (boolean — agent-scoped memory),
//   skills (whitelist of slash commands the agent can use)
//
// The markdown body becomes the agent's system prompt.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { kcodePath } from "./paths";

// ─── Types ──────────────────────────────────────────────────────

export interface AgentMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface AgentHookAction {
  type: "command" | "http";
  command?: string;
  url?: string;
  timeout?: number;
}

export interface AgentHookEntry {
  event: string;
  matcher?: string;
  actions: AgentHookAction[];
}

export interface CustomAgentDef {
  /** Agent name (from frontmatter or filename) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Override model for this agent */
  model?: string;
  /** Allowed tools (whitelist). If empty/undefined, all tools allowed */
  tools?: string[];
  /** Disallowed tools (blacklist). Complements the whitelist. */
  disallowedTools?: string[];
  /** Permission mode override */
  permissionMode?: string;
  /** Max tool turns before stopping */
  maxTurns?: number;
  /** Effort level override (low/medium/high/max) */
  effort?: string;
  /** API key override (for this agent to use a different provider) */
  apiKey?: string;
  /** API base URL override */
  apiBase?: string;
  /** MCP servers to connect (agent-scoped) */
  mcpServers?: Record<string, AgentMcpServer>;
  /** Lifecycle hooks scoped to this agent */
  hooks?: AgentHookEntry[];
  /** Enable agent-scoped persistent memory (stored in ~/.kcode/agents/<name>/memory/) */
  memory?: boolean;
  /** Whitelist of slash command skills this agent can invoke */
  skills?: string[];
  /** System prompt prepended to the agent's context */
  systemPrompt?: string;
  /** Source file path */
  sourcePath: string;
}

// ─── Frontmatter Parser ──────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown file.
 * Handles: string, number, boolean, string[] (inline and multi-line),
 * and JSON values for complex structures (mcpServers, hooks).
 */
export function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const yamlBlock = match[1]!;
  const body = match[2]!;
  const meta: Record<string, unknown> = {};

  const lines = yamlBlock.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    i++;

    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let rawValue = trimmed.slice(colonIdx + 1).trim();

    // Multi-line YAML array (lines starting with "  -")
    if (rawValue === "" || rawValue === "|") {
      // Look ahead: multi-line array or multi-line string?
      const collected: string[] = [];
      let isArray = false;

      while (i < lines.length) {
        const nextLine = lines[i]!;
        // Continuation line: starts with whitespace
        if (nextLine.match(/^\s+/)) {
          const nextTrimmed = nextLine.trim();
          if (nextTrimmed.startsWith("- ")) {
            isArray = true;
            collected.push(
              nextTrimmed
                .slice(2)
                .trim()
                .replace(/^["']|["']$/g, ""),
            );
          } else if (nextTrimmed.startsWith("{") || nextTrimmed.startsWith("[")) {
            // Inline JSON continuation
            collected.push(nextTrimmed);
          } else {
            collected.push(nextTrimmed);
          }
          i++;
        } else {
          break;
        }
      }

      if (isArray) {
        meta[key] = collected.filter(Boolean);
      } else if (collected.length > 0) {
        // Try parsing as JSON (for mcpServers, hooks)
        const joined = collected.join("\n");
        if (joined.length > 100 * 1024) continue; // Skip JSON > 100KB
        try {
          meta[key] = JSON.parse(joined);
        } catch {
          meta[key] = joined;
        }
      }
      continue;
    }

    // Inline JSON object or array
    if (rawValue.startsWith("{") || (rawValue.startsWith("[") && rawValue.includes("{"))) {
      try {
        meta[key] = JSON.parse(rawValue);
        continue;
      } catch {
        // Fall through to normal parsing
      }
    }

    // Inline array: [item1, item2]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      meta[key] = rawValue
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }

    // Parse booleans
    if (rawValue === "true") {
      meta[key] = true;
      continue;
    }
    if (rawValue === "false") {
      meta[key] = false;
      continue;
    }

    // Parse numbers
    const num = Number(rawValue);
    if (rawValue !== "" && !isNaN(num)) {
      meta[key] = num;
      continue;
    }

    // Strip quotes
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      rawValue = rawValue.slice(1, -1);
    }

    meta[key] = rawValue;
  }

  return { meta, body };
}

// ─── Validation Helpers ──────────────────────────────────────────

const VALID_EFFORT_LEVELS = new Set(["low", "medium", "high", "max"]);
const VALID_PERMISSION_MODES = new Set(["ask", "auto", "plan", "deny", "acceptEdits"]);
const MODEL_NAME_PATTERN = /^[a-zA-Z0-9._:/@-]{1,200}$/;

function validateEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return VALID_EFFORT_LEVELS.has(value) ? value : undefined;
}

function validatePermissionMode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return VALID_PERMISSION_MODES.has(value) ? value : undefined;
}

function validateModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return MODEL_NAME_PATTERN.test(value) ? value : undefined;
}

function validateApiBase(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function validateEnvValue(value: string): boolean {
  return !/[\n\r\0]/.test(value) && value.length < 10000;
}

function validateMcpServers(value: unknown): Record<string, AgentMcpServer> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, AgentMcpServer> = {};
  for (const [name, config] of Object.entries(value as Record<string, unknown>)) {
    if (!config || typeof config !== "object") continue;
    const c = config as Record<string, unknown>;
    result[name] = {
      command: typeof c.command === "string" ? c.command : undefined,
      args: Array.isArray(c.args) ? c.args.map(String) : undefined,
      env: c.env && typeof c.env === "object" ? (c.env as Record<string, string>) : undefined,
      url: typeof c.url === "string" ? c.url : undefined,
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function validateHooks(value: unknown): AgentHookEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: AgentHookEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const h = item as Record<string, unknown>;
    if (typeof h.event !== "string") continue;
    const actions: AgentHookAction[] = [];
    if (Array.isArray(h.actions)) {
      for (const a of h.actions) {
        if (!a || typeof a !== "object") continue;
        const act = a as Record<string, unknown>;
        if (act.type !== "command" && act.type !== "http") continue;
        actions.push({
          type: act.type as "command" | "http",
          command: typeof act.command === "string" ? act.command : undefined,
          url: typeof act.url === "string" ? act.url : undefined,
          timeout: typeof act.timeout === "number" ? act.timeout : undefined,
        });
      }
    }
    if (actions.length > 0) {
      result.push({
        event: h.event,
        matcher: typeof h.matcher === "string" ? h.matcher : undefined,
        actions,
      });
    }
  }
  return result.length > 0 ? result : undefined;
}

// ─── Agent Builder ───────────────────────────────────────────────

/** Security-sensitive fields that project-level agents must not escalate. */
const RESTRICTED_PERMISSION_MODES = new Set(["auto"]);

function buildAgentDef(
  meta: Record<string, unknown>,
  body: string,
  nameFromFile: string,
  sourcePath: string,
  isProjectLevel = false,
): CustomAgentDef {
  let permissionMode = validatePermissionMode(meta.permissionMode);
  // Project-level agents cannot escalate to "auto" permission mode (security)
  if (isProjectLevel && permissionMode && RESTRICTED_PERMISSION_MODES.has(permissionMode)) {
    permissionMode = undefined; // Fall back to session default
  }

  // Project-level agents cannot override apiKey or apiBase (prevent credential exfiltration)
  const apiKey = isProjectLevel
    ? undefined
    : typeof meta.apiKey === "string" && validateEnvValue(meta.apiKey)
      ? meta.apiKey
      : undefined;
  const apiBase = isProjectLevel ? undefined : validateApiBase(meta.apiBase);

  // Sanitize system prompt from project-level agents
  let systemPrompt = body.trim() || undefined;
  if (isProjectLevel && systemPrompt) {
    // Limit length and strip prompt injection attempts
    if (systemPrompt.length > 20_000) {
      systemPrompt =
        systemPrompt.slice(0, 20_000) + "\n[truncated: agent prompt exceeds 20KB limit]";
    }
  }

  return {
    name: typeof meta.name === "string" ? meta.name : nameFromFile,
    description:
      typeof meta.description === "string" ? meta.description : `Custom agent: ${nameFromFile}`,
    model: validateModel(meta.model),
    tools: Array.isArray(meta.tools) ? (meta.tools as string[]) : undefined,
    disallowedTools: Array.isArray(meta.disallowedTools)
      ? (meta.disallowedTools as string[])
      : undefined,
    permissionMode,
    maxTurns:
      typeof meta.maxTurns === "number" ? Math.min(Math.max(meta.maxTurns, 1), 100) : undefined,
    effort: validateEffort(meta.effort),
    apiKey,
    apiBase,
    mcpServers: validateMcpServers(meta.mcpServers),
    hooks: isProjectLevel ? undefined : validateHooks(meta.hooks), // Project agents cannot define hooks
    memory: meta.memory === true,
    skills: Array.isArray(meta.skills) ? (meta.skills as string[]) : undefined,
    systemPrompt,
    sourcePath,
  };
}

// ─── Agent Loading ───────────────────────────────────────────────

/**
 * Load agent definitions from a directory.
 */
function loadAgentsFromDir(dir: string, isProjectLevel = false): CustomAgentDef[] {
  if (!existsSync(dir)) return [];

  const agents: CustomAgentDef[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = join(dir, entry.name);
      try {
        const content = readFileSync(filePath, "utf-8");
        if (content.length > 64 * 1024) continue; // Skip files > 64KB

        const { meta, body } = parseFrontmatter(content);
        const nameFromFile = entry.name.replace(/\.md$/, "");
        agents.push(buildAgentDef(meta, body, nameFromFile, filePath, isProjectLevel));
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory not accessible
  }

  return agents;
}

/**
 * Load all custom agents from bundled, user, and project directories.
 * Priority (highest wins): project > user > bundled.
 */
export function loadCustomAgents(cwd: string): CustomAgentDef[] {
  // Bundled agents ship with KCode (src/agents/)
  const bundledDir = join(import.meta.dir, "..", "agents");
  const userDir = kcodePath("agents");
  const projectDir = join(cwd, ".kcode", "agents");

  const bundledAgents = loadAgentsFromDir(bundledDir);
  const userAgents = loadAgentsFromDir(userDir);
  const projectAgents = loadAgentsFromDir(projectDir, true); // project-level: restricted

  // Deduplicate: higher priority overrides lower by name
  const byName = new Map<string, CustomAgentDef>();
  for (const agent of bundledAgents) byName.set(agent.name, agent);
  for (const agent of userAgents) byName.set(agent.name, agent);
  for (const agent of projectAgents) byName.set(agent.name, agent);

  return [...byName.values()];
}

// ─── Inline Agent Definitions (from --agents CLI flag) ──────────

const inlineAgents = new Map<string, CustomAgentDef>();

/**
 * Register agent definitions from inline JSON (--agents CLI flag).
 * These are merged with file-based agents, with inline taking priority.
 */
export function registerInlineAgents(defs: Array<Record<string, unknown>>): void {
  for (const def of defs) {
    const name = def.name;
    if (!name || typeof name !== "string") continue;
    inlineAgents.set(
      name,
      buildAgentDef(
        def,
        typeof def.systemPrompt === "string" ? def.systemPrompt : "",
        name,
        "(inline)",
      ),
    );
  }
}

/**
 * Find a custom agent by name (case-insensitive).
 */
export function findCustomAgent(name: string, cwd: string): CustomAgentDef | null {
  // Inline agents take priority
  const inline = inlineAgents.get(name);
  if (inline) return inline;

  // Case-insensitive search through inline agents
  const nameLower = name.toLowerCase();
  for (const [key, agent] of inlineAgents) {
    if (key.toLowerCase() === nameLower) return agent;
  }

  const agents = loadCustomAgents(cwd);
  return agents.find((a) => a.name === name || a.name.toLowerCase() === nameLower) ?? null;
}

/**
 * List all available agents (inline + file-based).
 */
export function listAllAgents(cwd: string): CustomAgentDef[] {
  const fileAgents = loadCustomAgents(cwd);
  const byName = new Map<string, CustomAgentDef>();

  // File agents first (lower priority)
  for (const agent of fileAgents) byName.set(agent.name, agent);
  // Inline agents override
  for (const [, agent] of inlineAgents) byName.set(agent.name, agent);

  return [...byName.values()];
}

// ─── Agent Memory ────────────────────────────────────────────────

/**
 * Get the memory directory for an agent-scoped memory store.
 * Located at ~/.kcode/agents/<name>/memory/
 */
export function getAgentMemoryDir(agentName: string): string {
  // Sanitize agent name for use as directory
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return kcodePath("agents", safe, "memory");
}

/**
 * Check if an agent has memory enabled and return its memory directory.
 */
export function getAgentMemoryPath(agent: CustomAgentDef): string | null {
  if (!agent.memory) return null;
  return getAgentMemoryDir(agent.name);
}
