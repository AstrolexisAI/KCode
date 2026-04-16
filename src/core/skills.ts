// KCode - Skills Manager
// Discovers, loads, and executes slash-command skills from multiple sources

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinSkills, type SkillDefinition } from "./builtin-skills.js";
import { kcodePath } from "./paths";
import { getPluginManager } from "./plugins.js";
import { matchSkills, type SkillTrigger } from "./skill-matcher.js";
import { TemplateManager } from "./templates.js";

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
  /** Whether this is a template command (handled locally, not sent to LLM) */
  isTemplate: boolean;
  /** Built-in action name (stats, doctor, models, clear, compact) — handled by App */
  builtinAction?: string;
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

  const frontmatter = match[1]!;
  const template = match[2]!.trim();

  // Simple YAML parsing for the fields we care about
  const name = extractYamlString(frontmatter, "name");
  if (!name) return null;

  const description = extractYamlString(frontmatter!, "description") ?? "";
  const aliases = extractYamlArray(frontmatter!, "aliases");
  const args = extractYamlArray(frontmatter!, "args");
  const autoInvoke = extractYamlString(frontmatter!, "auto_invoke") === "true";
  const triggers = extractYamlTriggers(frontmatter!);

  return {
    name,
    description,
    aliases,
    args: args.length > 0 ? args : undefined,
    template,
    triggers: triggers.length > 0 ? triggers : undefined,
    autoInvoke: autoInvoke || undefined,
  };
}

function extractYamlString(yaml: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = yaml.match(re);
  if (!match) return null;
  // Strip surrounding quotes
  return match[1]!.trim().replace(/^["']|["']$/g, "");
}

function extractYamlArray(yaml: string, key: string): string[] {
  const re = new RegExp(`^${key}:\\s*\\[(.*)\\]$`, "m");
  const match = yaml.match(re);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function extractYamlTriggers(yaml: string): SkillTrigger[] {
  const triggers: SkillTrigger[] = [];
  const triggerBlock = yaml.match(/^triggers:\s*\n((?:\s+-\s+.*\n?)*)/m);
  if (!triggerBlock) return triggers;

  const entries = triggerBlock[1]!.matchAll(
    /pattern:\s*["']?([^"'\n]+)["']?\s*\n\s*type:\s*["']?(regex|contains|startsWith)["']?/g,
  );
  for (const entry of entries) {
    triggers.push({ pattern: entry[1]!.trim(), type: entry[2]!.trim() as SkillTrigger["type"] });
  }
  return triggers;
}

// ─── Skill Discovery ───────────────────────────────────────────

function loadSkillsFromDirectory(dir: string): SkillDefinition[] {
  const skills: SkillDefinition[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const content = readFileSync(join(dir, entry.name), "utf-8");
        const skill = parseSkillFile(content);
        if (skill) {
          skill.sourceDir = dir;
          skills.push(skill);
        }
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

  // Handle {{#if args}}...{{/if}} blocks (positive conditional)
  if (args.trim()) {
    result = result.replace(/\{\{#if args\}\}([\s\S]*?)\{\{\/if\}\}/g, "$1");
  } else {
    result = result.replace(/\{\{#if args\}\}[\s\S]*?\{\{\/if\}\}/g, "");
  }

  // Handle {{^if args}}...{{/if}} blocks (inverse conditional)
  if (args.trim()) {
    result = result.replace(/\{\{\^if args\}\}[\s\S]*?\{\{\/if\}\}/g, "");
  } else {
    result = result.replace(/\{\{\^if args\}\}([\s\S]*?)\{\{\/if\}\}/g, "$1");
  }

  return result.trim();
}

// ─── SkillManager ───────────────────────────────────────────────

export class SkillManager {
  private skills: SkillDefinition[] = [];
  private loaded = false;
  private templateManager: TemplateManager;

  constructor(private workingDirectory: string) {
    this.templateManager = new TemplateManager(workingDirectory);
  }

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

    // Bundled skills (src/skills/) — ship with KCode, between built-in and user
    const bundledDir = join(import.meta.dir, "..", "skills");
    for (const skill of loadSkillsFromDirectory(bundledDir)) {
      byName.set(skill.name, skill);
    }

    // User-level skills (~/.kcode/skills/)
    const userDir = kcodePath("skills");
    for (const skill of loadSkillsFromDirectory(userDir)) {
      byName.set(skill.name, skill);
    }

    // Plugin skills (between user and project priority)
    for (const filePath of getPluginManager().getSkillPaths()) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const skill = parseSkillFile(content);
        if (skill) byName.set(skill.name, skill);
      } catch {
        /* skip unreadable plugin skill files */
      }
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
      return { skill, prompt: "", isHelp: true, isTemplate: false };
    }

    if (skill.template === "__builtin_template__") {
      const result = this.handleTemplateCommand(args);
      if (result.sendToLLM) {
        return { skill, prompt: result.text, isHelp: false, isTemplate: false };
      }
      return { skill, prompt: result.text, isHelp: false, isTemplate: true };
    }

    // Built-in action commands (handled by App.tsx, not the LLM)
    const builtinMatch = skill.template.match(/^__builtin_(\w+)__$/);
    if (builtinMatch) {
      return {
        skill,
        prompt: args,
        isHelp: false,
        isTemplate: false,
        builtinAction: builtinMatch[1],
      };
    }

    const prompt = expandTemplate(skill.template, args);
    return { skill, prompt, isHelp: false, isTemplate: false };
  }

  /**
   * Handle /template subcommands: list, use, save.
   */
  private handleTemplateCommand(args: string): { text: string; sendToLLM: boolean } {
    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() ?? "list";

    if (subcommand === "list" || !subcommand) {
      return { text: this.formatTemplateList(), sendToLLM: false };
    }

    if (subcommand === "use") {
      const templateName = parts[1];
      if (!templateName) {
        return {
          text: "Usage: /template use <name> [arg1=value1 arg2=value2 ...]",
          sendToLLM: false,
        };
      }

      const template = this.templateManager.findTemplate(templateName);
      if (!template) {
        return {
          text: `Template "${templateName}" not found. Use /template list to see available templates.`,
          sendToLLM: false,
        };
      }

      // Parse key=value args from remaining parts
      const templateArgs: Record<string, string> = {};
      const freeArgs: string[] = [];
      for (let i = 2; i < parts.length; i++) {
        const part = parts[i]!;
        const eqIdx = part.indexOf("=");
        if (eqIdx !== -1) {
          const key = part.slice(0, eqIdx);
          const value = part.slice(eqIdx + 1);
          templateArgs[key] = value;
        } else {
          freeArgs.push(part);
        }
      }

      // If there are free args and the template has defined arg names, map positionally
      if (freeArgs.length > 0 && template.args.length > 0) {
        for (let i = 0; i < Math.min(freeArgs.length, template.args.length); i++) {
          const argName = template.args[i]!;
          if (!templateArgs[argName]) {
            templateArgs[argName] = freeArgs[i]!;
          }
        }
      }

      // If there are free args but no named template args, join them as a single value for the first arg
      if (
        freeArgs.length > 0 &&
        template.args.length > 0 &&
        Object.keys(templateArgs).length === 0
      ) {
        templateArgs[template.args[0]!] = freeArgs.join(" ");
      }

      const expanded = this.templateManager.expandTemplate(template, templateArgs);
      return { text: expanded, sendToLLM: true };
    }

    if (subcommand === "save") {
      const templateName = parts[1];
      if (!templateName) {
        return { text: "Usage: /template save <name>", sendToLLM: false };
      }
      // Placeholder — saving the last assistant message requires conversation context
      return {
        text: `Template save is not yet implemented. To create a template manually, add a .md file to ~/.kcode/templates/ with YAML frontmatter (name, description, args) and a template body using {{arg_name}} placeholders.`,
        sendToLLM: false,
      };
    }

    return {
      text: `Unknown subcommand "${subcommand}". Available: list, use, save`,
      sendToLLM: false,
    };
  }

  /**
   * Format a list of all available templates for display.
   */
  private formatTemplateList(): string {
    const templates = this.templateManager.listTemplates();
    if (templates.length === 0) {
      return 'No templates found.\n\nTo create templates, add .md files to ~/.kcode/templates/ with YAML frontmatter:\n\n  ---\n  name: my-template\n  description: What it does\n  args: [arg1, arg2]\n  ---\n  Template body with {{arg1}} placeholders.\n\nExample templates to try:\n  - explain.md — "Explain this code: {{code}}"\n  - test-for.md — "Write tests for: {{target}}"\n  - refactor.md — "Refactor this to be more readable: {{code}}"';
    }

    const lines: string[] = ["\n  Templates (~/.kcode/templates/)"];
    for (const t of templates) {
      const argsStr = t.args.length > 0 ? ` [${t.args.join(", ")}]` : "";
      lines.push(`  ${t.name}${argsStr.padEnd(20 - t.name.length)}  ${t.description}`);
    }
    lines.push("");
    lines.push("  Usage: /template use <name> [arg=value ...]");
    lines.push("");
    return lines.join("\n");
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

    // Built-in non-skill commands. Must be kept in sync with the
    // slashCompletions set in src/ui/App.tsx — otherwise a command
    // works but doesn't show in /help (silent omission).
    lines.push("  /exit, /quit                  Exit KCode");
    lines.push("  /status                       Show conversation stats");
    lines.push("  /model, /toggle, /switch      Switch between local and cloud models");
    lines.push("  /cloud, /api-key, /provider   Configure cloud API providers");
    lines.push("  /auth                         OAuth login/status/logout for cloud providers");
    lines.push("  /login, /logout               Astrolexis OAuth login / logout");
    lines.push("  /license                      License status / activate <path> / deactivate");
    lines.push("  /plugin, /plugins             Install, list, or remove plugins");
    lines.push("  /marketplace                  Browse and install plugins from the marketplace");
    lines.push("  /hookify                      Manage dynamic hookify rules");
    lines.push("");

    // Skill commands
    lines.push("  Skills");
    for (const skill of this.skills) {
      const aliases =
        skill.aliases.length > 0 ? ` (${skill.aliases.map((a) => "/" + a).join(", ")})` : "";
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

  // ─── Feature 2: Auto-Invocation Matching ────────────────────

  matchAutoInvoke(userMessage: string): SkillDefinition[] {
    this.load();
    return matchSkills(userMessage, this.skills);
  }

  // ─── Feature 3: Progressive Skill Disclosure ────────────────

  getLevel1Metadata(): string {
    this.load();
    const lines: string[] = ["Available skills:"];
    for (const skill of this.skills) {
      if (skill.template.startsWith("__builtin_")) continue;
      lines.push(`- /${skill.name}: ${skill.description}`);
    }
    return lines.join("\n");
  }

  getLevel2Body(skillName: string): string | null {
    this.load();
    const skill = this.find(skillName);
    if (!skill) return null;
    if (skill.template.startsWith("__builtin_")) return null;
    return skill.template;
  }

  getLevel3Resources(skillName: string): string | null {
    this.load();
    return loadSkillResources(skillName, this.skills);
  }
}

// ─── Level 3 Resource Loading ─────────────────────────────────

function loadSkillResources(skillName: string, skills: SkillDefinition[]): string | null {
  const skill = skills.find((s) => s.name.toLowerCase() === skillName.toLowerCase());
  if (!skill?.sourceDir) return null;

  const resourceDir = join(skill.sourceDir, skillName);
  if (!existsSync(resourceDir)) return null;

  const parts: string[] = [];
  try {
    const entries = readdirSync(resourceDir).sort();
    for (const entry of entries) {
      const filePath = join(resourceDir, entry);
      try {
        const content = readFileSync(filePath, "utf-8");
        parts.push(`--- ${entry} ---\n${content}`);
      } catch {
        // Skip unreadable resource files
      }
    }
  } catch {
    return null;
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}
