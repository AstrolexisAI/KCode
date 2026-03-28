// KCode - Prompt Template Manager
// Lets users save and reuse common prompts as .md files in ~/.kcode/templates/

import { join } from "node:path";
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { kcodePath } from "./paths";

// ─── Types ──────────────────────────────────────────────────────

export interface PromptTemplate {
  name: string;
  description: string;
  args: string[];
  body: string;
  source: string; // file path
}

// ─── Parsing ────────────────────────────────────────────────────

/**
 * Parse a template .md file with YAML frontmatter.
 * Format:
 *   ---
 *   name: explain
 *   description: Explain code in detail
 *   args: [code]
 *   ---
 *   Explain this code: {{code}}
 */
function parseTemplateFile(content: string, source: string): PromptTemplate | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1]!;
  const body = match[2]!.trim();

  const name = extractYamlString(frontmatter, "name");
  if (!name) return null;

  const description = extractYamlString(frontmatter, "description") ?? "";
  const args = extractYamlArray(frontmatter, "args");

  return { name, description, args, body, source };
}

function extractYamlString(yaml: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = yaml.match(re);
  if (!match) return null;
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

// ─── TemplateManager ────────────────────────────────────────────

export class TemplateManager {
  private templates: PromptTemplate[] = [];
  private loaded = false;
  private templatesDir: string;

  constructor(private workingDirectory: string) {
    this.templatesDir = kcodePath("templates");
  }

  /**
   * Discover and load all templates from ~/.kcode/templates/
   */
  load(): void {
    if (this.loaded) return;

    const byName = new Map<string, PromptTemplate>();

    try {
      const entries = readdirSync(this.templatesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        try {
          const filePath = join(this.templatesDir, entry.name);
          const content = readFileSync(filePath, "utf-8");
          const template = parseTemplateFile(content, filePath);
          if (template) {
            byName.set(template.name, template);
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Directory doesn't exist yet — that's fine
    }

    this.templates = Array.from(byName.values());
    this.loaded = true;
  }

  /**
   * Get all loaded templates.
   */
  listTemplates(): PromptTemplate[] {
    this.load();
    return [...this.templates];
  }

  /**
   * Find a template by name (case-insensitive).
   */
  findTemplate(name: string): PromptTemplate | undefined {
    this.load();
    const lower = name.toLowerCase();
    return this.templates.find((t) => t.name.toLowerCase() === lower);
  }

  /**
   * Expand a template by substituting {{arg_name}} placeholders with provided values.
   */
  expandTemplate(template: PromptTemplate, args: Record<string, string>): string {
    let result = template.body;
    for (const [key, value] of Object.entries(args)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }
    // Remove any remaining unsubstituted placeholders
    result = result.replace(/\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}/g, "");
    return result.trim();
  }

  /**
   * Create a new template file on disk.
   */
  createTemplate(name: string, description: string, body: string, args: string[] = []): string {
    // Ensure the templates directory exists
    if (!existsSync(this.templatesDir)) {
      mkdirSync(this.templatesDir, { recursive: true });
    }

    const fileName = `${name}.md`;
    const filePath = join(this.templatesDir, fileName);
    const argsLine = args.length > 0 ? `\nargs: [${args.join(", ")}]` : "";

    const content = `---
name: ${name}
description: ${description}${argsLine}
---
${body}
`;

    writeFileSync(filePath, content, "utf-8");

    // Reset loaded state so next load() picks up the new file
    this.loaded = false;

    return filePath;
  }
}
