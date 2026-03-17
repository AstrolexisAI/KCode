// KCode - Custom Agent Definitions
// Load user-defined agents from ~/.kcode/agents/ and .kcode/agents/
// Each agent is a .md file with YAML frontmatter configuration.

import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, readFileSync, existsSync } from "node:fs";

export interface CustomAgentDef {
  /** Agent name (from frontmatter or filename) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Override model for this agent */
  model?: string;
  /** Allowed tools (whitelist). If empty/undefined, all tools allowed */
  tools?: string[];
  /** Permission mode override */
  permissionMode?: string;
  /** Max tool turns before stopping */
  maxTurns?: number;
  /** System prompt prepended to the agent's context */
  systemPrompt?: string;
  /** Source file path */
  sourcePath: string;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Simple parser — handles string, number, boolean, and string[] values.
 */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const yamlBlock = match[1]!;
  const body = match[2]!;
  const meta: Record<string, unknown> = {};

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value: string | number | boolean | string[] = trimmed.slice(colonIdx + 1).trim();

    // Parse arrays: [item1, item2]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      continue;
    }

    // Parse booleans
    if (value === "true") { meta[key] = true; continue; }
    if (value === "false") { meta[key] = false; continue; }

    // Parse numbers
    const num = Number(value);
    if (value !== "" && !isNaN(num)) { meta[key] = num; continue; }

    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    meta[key] = value;
  }

  return { meta, body };
}

/**
 * Load agent definitions from a directory.
 */
function loadAgentsFromDir(dir: string): CustomAgentDef[] {
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

        agents.push({
          name: typeof meta.name === "string" ? meta.name : nameFromFile,
          description: typeof meta.description === "string" ? meta.description : `Custom agent: ${nameFromFile}`,
          model: typeof meta.model === "string" ? meta.model : undefined,
          tools: Array.isArray(meta.tools) ? meta.tools as string[] : undefined,
          permissionMode: typeof meta.permissionMode === "string" ? meta.permissionMode : undefined,
          maxTurns: typeof meta.maxTurns === "number" ? Math.min(Math.max(meta.maxTurns, 1), 100) : undefined,
          systemPrompt: body.trim() || undefined,
          sourcePath: filePath,
        });
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
 * Load all custom agents from user and project directories.
 * Project agents override user agents with the same name.
 */
export function loadCustomAgents(cwd: string): CustomAgentDef[] {
  const userDir = join(homedir(), ".kcode", "agents");
  const projectDir = join(cwd, ".kcode", "agents");

  const userAgents = loadAgentsFromDir(userDir);
  const projectAgents = loadAgentsFromDir(projectDir);

  // Deduplicate: project agents override user agents by name
  const byName = new Map<string, CustomAgentDef>();
  for (const agent of userAgents) byName.set(agent.name, agent);
  for (const agent of projectAgents) byName.set(agent.name, agent);

  return [...byName.values()];
}

/**
 * Find a custom agent by name.
 */
export function findCustomAgent(name: string, cwd: string): CustomAgentDef | null {
  const agents = loadCustomAgents(cwd);
  return agents.find(a => a.name === name) ?? null;
}
