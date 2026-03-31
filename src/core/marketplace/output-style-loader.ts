// KCode - Output Style Loader for Plugins
// Loads custom output style definitions from enabled plugins.
// Styles are .md files in a plugin's output-styles/ directory with optional YAML frontmatter.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { PluginOutputStyle } from "./types";

/**
 * Plugin info needed for loading output styles.
 */
interface PluginInfo {
  name: string;
  dir: string;
  enabled?: boolean;
}

/**
 * Load output styles from all enabled plugins.
 *
 * Scans each plugin's `output-styles/` directory for .md files.
 * Each file becomes a style with:
 *   - name: `pluginName:styleName` (from frontmatter or filename)
 *   - description: from frontmatter
 *   - instructions: the markdown body (after frontmatter)
 *   - priority: from frontmatter (default 100)
 *
 * Returns styles sorted by priority (lower = earlier).
 */
export function loadPluginOutputStyles(plugins: PluginInfo[]): PluginOutputStyle[] {
  const styles: PluginOutputStyle[] = [];

  for (const plugin of plugins) {
    // Skip disabled plugins (default is enabled if not specified)
    if (plugin.enabled === false) continue;

    const stylesDir = join(plugin.dir, "output-styles");
    if (!existsSync(stylesDir)) continue;

    let files: string[];
    try {
      files = readdirSync(stylesDir).filter(f => f.endsWith(".md"));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const filePath = join(stylesDir, file);
        const raw = readFileSync(filePath, "utf-8");
        const { frontmatter, content } = parseFrontmatter(raw);

        const styleName = (frontmatter.name as string) || basename(file, ".md");
        const description = (frontmatter.description as string) || "";
        const priority = typeof frontmatter.priority === "number" ? frontmatter.priority : 100;

        styles.push({
          name: `${plugin.name}:${styleName}`,
          description,
          instructions: content.trim(),
          priority,
        });
      } catch {
        // Skip malformed style files
      }
    }
  }

  return styles.sort((a, b) => a.priority - b.priority);
}

/**
 * Parse simple YAML frontmatter from a markdown file.
 * Frontmatter is delimited by `---` at the start and end.
 *
 * Returns the parsed key-value pairs and the remaining content.
 */
export function parseFrontmatter(text: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, content: text };
  }

  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    return { frontmatter: {}, content: text };
  }

  const fmBlock = trimmed.slice(3, endIndex).trim();
  const content = trimmed.slice(endIndex + 3);
  const frontmatter: Record<string, unknown> = {};

  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Strip surrounding quotes
    if (typeof value === "string" && value.length >= 2) {
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
    }

    // Attempt numeric conversion
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
      value = parseFloat(value);
    }

    // Boolean conversion
    if (value === "true") value = true;
    if (value === "false") value = false;

    if (key) frontmatter[key] = value;
  }

  return { frontmatter, content };
}
