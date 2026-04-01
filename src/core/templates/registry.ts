// KCode - Template Registry
// Loads templates from builtin, user (~/.kcode/templates/), and project (.kcode/templates/).

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger";
import { kcodeHome } from "../paths";
import type { Template, TemplateListItem, TemplateParam } from "./types";

export class TemplateRegistry {
  private templates = new Map<string, Template>();

  /** Load templates from all sources. */
  async loadAll(projectDir?: string): Promise<void> {
    this.templates.clear();

    // 1. Builtin templates
    const builtinDir = join(import.meta.dir, "builtin");
    await this.loadFromDir(builtinDir, "builtin");

    // 2. User templates (~/.kcode/templates/)
    const userDir = join(kcodeHome(), "templates");
    await this.loadFromDir(userDir, "user");

    // 3. Project templates (.kcode/templates/)
    if (projectDir) {
      const projDir = join(projectDir, ".kcode", "templates");
      await this.loadFromDir(projDir, "project");
    }
  }

  /** Get a template by name. */
  get(name: string): Template | undefined {
    return this.templates.get(name);
  }

  /** List all templates sorted by name. */
  list(): TemplateListItem[] {
    return Array.from(this.templates.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        tags: t.tags,
        source: t.source,
        parameterCount: t.parameters.length,
      }));
  }

  /** Add a user template from a file path. */
  async add(filePath: string): Promise<void> {
    const content = await Bun.file(filePath).text();
    const template = this.parseTemplateFile(content, "user");
    if (!template) throw new Error(`Failed to parse template from ${filePath}`);

    const userDir = join(kcodeHome(), "templates");
    mkdirSync(userDir, { recursive: true });
    const destPath = join(userDir, `${template.name}.md`);
    copyFileSync(filePath, destPath);
    template.filePath = destPath;
    this.templates.set(template.name, template);
  }

  /** Remove a user template. */
  async remove(name: string): Promise<boolean> {
    const template = this.templates.get(name);
    if (!template) return false;
    if (template.source !== "user") {
      throw new Error("Only user templates can be removed");
    }
    if (template.filePath) {
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(template.filePath);
      } catch (err) {
        log.debug("templates", `Failed to delete template file: ${err}`);
      }
    }
    this.templates.delete(name);
    return true;
  }

  /** Get template count. */
  size(): number {
    return this.templates.size;
  }

  // ─── Private ─────────────────────────────────────────────────

  private async loadFromDir(dir: string, source: Template["source"]): Promise<void> {
    if (!existsSync(dir)) return;

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch (err) {
      log.debug("templates", `Failed to read template dir ${dir}: ${err}`);
      return;
    }

    for (const file of files) {
      try {
        const filePath = join(dir, file);
        const content = await Bun.file(filePath).text();
        const template = this.parseTemplateFile(content, source);
        if (template) {
          template.filePath = filePath;
          this.templates.set(template.name, template);
        }
      } catch (err) {
        log.debug("templates", `Failed to parse template ${file}: ${err}`);
      }
    }
  }

  /** Parse a template markdown file with YAML frontmatter. */
  parseTemplateFile(content: string, source: Template["source"]): Template | null {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return null;

    const frontmatter = fmMatch[1]!;
    const prompt = fmMatch[2]!.trim();

    // Simple YAML parser
    const meta: Record<string, unknown> = {};
    let currentKey = "";
    let currentArray: unknown[] | null = null;
    let currentObjArray: Record<string, unknown>[] | null = null;
    let currentObj: Record<string, unknown> | null = null;

    for (const line of frontmatter.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Array item with object properties (e.g., "  - name: foo")
      if (/^\s*-\s+\w+:/.test(line) && currentKey) {
        if (!currentObjArray) currentObjArray = [];
        currentObj = {};
        const objMatch = trimmed.match(/^-\s+(\w+):\s*(.*)$/);
        if (objMatch) {
          currentObj[objMatch[1]!] = this.parseYamlValue(objMatch[2]!);
        }
        currentObjArray.push(currentObj);
        continue;
      }

      // Continuation of object in array (e.g., "    type: string")
      if (/^\s{4,}\w+:/.test(line) && currentObj) {
        const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
        if (propMatch) {
          currentObj[propMatch[1]!] = this.parseYamlValue(propMatch[2]!);
        }
        continue;
      }

      // Simple array item (e.g., "  - value")
      if (/^\s*-\s+/.test(line) && currentKey && !currentObjArray) {
        if (!currentArray) currentArray = [];
        currentArray.push(trimmed.replace(/^-\s+/, ""));
        continue;
      }

      // Flush previous array/obj
      if (currentKey) {
        if (currentObjArray) {
          meta[currentKey] = currentObjArray;
          currentObjArray = null;
          currentObj = null;
        } else if (currentArray) {
          meta[currentKey] = currentArray;
          currentArray = null;
        }
      }

      // Top-level key: value
      const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (kvMatch) {
        currentKey = kvMatch[1]!;
        const val = kvMatch[2]!;
        if (val && !val.startsWith("[") && val !== "") {
          meta[currentKey] = this.parseYamlValue(val);
          currentKey = "";
        } else if (val.startsWith("[") && val.endsWith("]")) {
          // Inline array: [a, b, c]
          meta[currentKey] = val
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim());
          currentKey = "";
        }
      }
    }

    // Flush last
    if (currentKey && currentObjArray) meta[currentKey] = currentObjArray;
    else if (currentKey && currentArray) meta[currentKey] = currentArray;

    if (!meta.name || !meta.description) return null;

    // Build parameters
    const params: TemplateParam[] = [];
    const rawParams = (meta.parameters ?? []) as Record<string, unknown>[];
    for (const p of rawParams) {
      params.push({
        name: String(p.name ?? ""),
        description: String(p.description ?? ""),
        type: String(p.type ?? "string") as TemplateParam["type"],
        choices: Array.isArray(p.choices)
          ? p.choices.map(String)
          : typeof p.choices === "string"
            ? p.choices
                .replace(/[[\]]/g, "")
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean)
            : undefined,
        default:
          p.default === "true"
            ? true
            : p.default === "false"
              ? false
              : (p.default as string | boolean | undefined),
        required: p.required === true || p.required === "true",
      });
    }

    return {
      name: String(meta.name),
      description: String(meta.description),
      tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
      parameters: params,
      prompt,
      postSetup: Array.isArray(meta.postSetup) ? meta.postSetup.map(String) : undefined,
      source,
    };
  }

  private parseYamlValue(val: string): string | boolean | number {
    if (val === "true") return true;
    if (val === "false") return false;
    const num = Number(val);
    if (!isNaN(num) && val.trim() !== "") return num;
    return val;
  }
}
