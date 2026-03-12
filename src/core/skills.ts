// KCode - Skills Manager
// Discovers, loads, and executes slash-command skills from multiple sources

import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync } from "node:fs";
import { builtinSkills, type SkillDefinition } from "./builtin-skills.js";

// ─── Types ──────────────────────────────────────────────────────

export interface SkillMatch {
  skill: SkillDefinition;
  args: string;
}

export interface ExpandedSkill {
  /** The original skill definition */
  skill: SkillDefinition;
  /** The fully expanded prompt text to inject as a user message */
  prompt: string;
  /** Whether this is the built-in help command (handled specially) */
  isHelp: boolean;
}

// ─── Skill File Parsing ─────────────────────────────────────────

/**
 * Parse a skill markdown file with YAML frontmatter.
 * Format:
 *   ---
 *   name: commit
 *   description: Create a git commit
 *   aliases: [ci]
 *   args: ["-m message"]
 *   ---
 *   Template body here...
 */
function parseSkillFile(content: string): SkillDefinition | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const template = match[2].trim();

  // Simple YAML parsing for the fields we care about
  const name = extractYamlString(frontmatter, "name");
  if (!name) return null;

  const description = extractYamlString(frontmatter, "description") ?? "";
  const aliases = extractYamlArray(frontmatter, "aliases");
  const args = extractYamlArray(frontmatter, "args");

  return { name, description, aliases, args: args.length > 0 ? args : undefined, template };
}

function extractYamlString(yaml: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = yaml.match(re);
  if (!match) return null;
  // Strip surrounding quotes
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function extractYamlArray(yaml: string, key: string): string[] {
  const re = new RegExp(`^${key}:\\s*\\[(.*)\\]$`, "m");
  const match = yaml.match(re);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

// ─── Skill Discovery ───────────────────────────────────────────

function loadSkillsFromDirectory(dir: string): SkillDefinition[] {
  const skills: SkillDefinition[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const file = Bun.file(join(dir, entry.name));
        // Use synchronous approach: read via node fs
        const content = require("node:fs").readFileSync(join(dir, entry.name), "utf-8");
        const skill = parseSkillFile(content);
        if (skill) skills.push(skill);
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return skills;
}

// ─── Template Expansion ─────────────────────────────────────────

function expandTemplate(template: string, args: string): string {
  let result = template;

  // Replace {{args}} with the provided args
  result = result.replace(/\{\{args\}\}/g, args);

  // Handle {{#if args}}...{{/if}} blocks
  if (args.trim()) {
    result = result.replace(/\{\{#if args\}\}([\s\S]*?)\{\{\/if\}\}/g, "$1");
  } else {
    result = result.replace(/\{\{#if args\}\}[\s\S]*?\{\{\/if\}\}/g, "");
  }

  return result.trim();
}

// ─── SkillManager ───────────────────────────────────────────────

export class SkillManager {
  private skills: SkillDefinition[] = [];
  private loaded = false;

  constructor(private workingDirectory: string) {}

  /**
   * Discover and load all skills from all sources.
   * Priority order: project > user > built-in (later entries override earlier by name).
   */
  load(): void {
    if (this.loaded) return;

    // Start with built-in skills (lowest priority)
    const byName = new Map<string, SkillDefinition>();
    for (const skill of builtinSkills) {
      byName.set(skill.name, skill);
    }

    // User-level skills (~/.kcode/skills/)
    const userDir = join(homedir(), ".kcode", "skills");
    for (const skill of loadSkillsFromDirectory(userDir)) {
      byName.set(skill.name, skill);
    }

    // Project-level skills (.kcode/skills/) - highest priority
    const projectDir = join(this.workingDirectory, ".kcode", "skills");
    for (const skill of loadSkillsFromDirectory(projectDir)) {
      byName.set(skill.name, skill);
    }

    this.skills = Array.from(byName.values());
    this.loaded = true;
  }

  /**
   * Find a skill by name or alias.
   */
  find(nameOrAlias: string): SkillDefinition | null {
    this.load();
    const lower = nameOrAlias.toLowerCase();
    return (
      this.skills.find(
        (s) => s.name.toLowerCase() === lower || s.aliases.some((a) => a.toLowerCase() === lower),
      ) ?? null
    );
  }

  /**
   * Parse a slash command input like "/commit -m fix typo" into a skill match.
   * Returns null if no matching skill found.
   */
  match(input: string): SkillMatch | null {
    if (!input.startsWith("/")) return null;

    const trimmed = input.slice(1).trim();
    const spaceIdx = trimmed.indexOf(" ");
    const commandName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    const skill = this.find(commandName);
    if (!skill) return null;

    return { skill, args };
  }

  /**
   * Expand a matched skill into a prompt ready to send to the LLM.
   */
  expand(skillMatch: SkillMatch): ExpandedSkill {
    const { skill, args } = skillMatch;

    if (skill.template === "__builtin_help__") {
      return { skill, prompt: "", isHelp: true };
    }

    const prompt = expandTemplate(skill.template, args);
    return { skill, prompt, isHelp: false };
  }

  /**
   * Get all available skills for help display.
   */
  listSkills(): SkillDefinition[] {
    this.load();
    return [...this.skills];
  }

  /**
   * Format a help message listing all available skills.
   */
  formatHelp(toolNames: string[]): string {
    this.load();
    const lines: string[] = ["\n  Commands"];

    // Built-in non-skill commands
    lines.push("  /exit, /quit   Exit KCode");
    lines.push("  /status        Show conversation stats");
    lines.push("");

    // Skill commands
    lines.push("  Skills");
    for (const skill of this.skills) {
      const aliases = skill.aliases.length > 0 ? ` (${skill.aliases.map((a) => "/" + a).join(", ")})` : "";
      const nameCol = `  /${skill.name}${aliases}`;
      lines.push(`${nameCol.padEnd(28)} ${skill.description}`);
    }

    lines.push("");
    lines.push("  Tips");
    lines.push(`  - KCode has ${toolNames.length} tools: ${toolNames.join(", ")}`);
    lines.push("  - Set KCODE_MODEL to use a different model");
    lines.push("  - Place a KCODE.md in your project root for custom instructions");
    lines.push("  - Add custom skills in .kcode/skills/*.md\n");

    return lines.join("\n");
  }
}
