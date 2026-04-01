// KCode - Plugin Documentation Generator
// Generates markdown documentation from plugin manifest and content files.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocsSection, PluginManifest } from "../../../core/plugin-sdk/types";

export async function generateDocs(dir: string): Promise<DocsSection[]> {
  const sections: DocsSection[] = [];
  const manifest = loadManifest(dir);

  if (!manifest) {
    throw new Error("Could not load plugin.json");
  }

  // 1. Overview
  sections.push({
    title: "Overview",
    content: generateOverview(manifest),
  });

  // 2. Installation
  sections.push({
    title: "Installation",
    content: generateInstallation(manifest),
  });

  // 3. Skills
  if (manifest.skills && manifest.skills.length > 0) {
    const skillDocs = generateSkillDocs(dir, manifest.skills);
    if (skillDocs) {
      sections.push({ title: "Skills", content: skillDocs });
    }
  }

  // 4. Hooks
  if (manifest.hooks && Object.keys(manifest.hooks).length > 0) {
    sections.push({
      title: "Hooks",
      content: generateHookDocs(manifest.hooks),
    });
  }

  // 5. MCP Servers
  if (manifest.mcpServers && Object.keys(manifest.mcpServers).length > 0) {
    sections.push({
      title: "MCP Servers",
      content: generateMcpDocs(manifest.mcpServers),
    });
  }

  // 6. Agents
  if (manifest.agents && manifest.agents.length > 0) {
    const agentDocs = generateAgentDocs(dir, manifest.agents);
    if (agentDocs) {
      sections.push({ title: "Agents", content: agentDocs });
    }
  }

  // 7. Output Styles
  if (manifest.outputStyles && manifest.outputStyles.length > 0) {
    const styleDocs = generateStyleDocs(dir, manifest.outputStyles);
    if (styleDocs) {
      sections.push({ title: "Output Styles", content: styleDocs });
    }
  }

  // 8. Configuration
  sections.push({
    title: "Configuration",
    content: generateConfigDocs(manifest),
  });

  return sections;
}

export function formatDocs(sections: DocsSection[]): string {
  const lines: string[] = [];

  for (const section of sections) {
    lines.push(`## ${section.title}\n`);
    lines.push(section.content);
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Section Generators ─────────────────────────────────────────

function generateOverview(manifest: PluginManifest): string {
  const lines = [
    `# ${manifest.name}\n`,
    manifest.description,
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| Version | ${manifest.version} |`,
    `| Author | ${manifest.author || "Unknown"} |`,
    `| License | ${manifest.license || "Not specified"} |`,
    `| KCode | ${manifest.kcode || "Any"} |`,
  ];

  const components: string[] = [];
  if (manifest.skills?.length) components.push("Skills");
  if (manifest.hooks && Object.keys(manifest.hooks).length) components.push("Hooks");
  if (manifest.mcpServers && Object.keys(manifest.mcpServers).length) components.push("MCP");
  if (manifest.agents?.length) components.push("Agents");
  if (manifest.outputStyles?.length) components.push("Output Styles");

  if (components.length > 0) {
    lines.push(`| Components | ${components.join(", ")} |`);
  }

  return lines.join("\n");
}

function generateInstallation(manifest: PluginManifest): string {
  return [
    "```bash",
    `kcode plugin install ${manifest.name}`,
    "```",
    "",
    manifest.kcode ? `Requires KCode ${manifest.kcode}.` : "Compatible with all KCode versions.",
  ].join("\n");
}

function generateSkillDocs(dir: string, patterns: string[]): string | null {
  const lines: string[] = [];
  let found = false;

  for (const pattern of patterns) {
    const files = findFiles(dir, pattern);
    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");
      const fm = parseFrontmatter(content);
      const body = content.replace(/^---[\s\S]*?---\n*/, "").trim();

      if (fm) {
        found = true;
        lines.push(`### \`/${fm.name || file}\``);
        if (fm.description) lines.push(`\n${fm.description}`);
        if (fm.aliases) lines.push(`\n**Aliases:** ${fm.aliases}`);

        // Parse args from frontmatter
        const argsMatch = content.match(/args:\n([\s\S]*?)(?=\n---|\n[a-z])/);
        if (argsMatch) {
          lines.push("\n**Arguments:**");
          const argLines = argsMatch[1].split("\n").filter((l) => l.trim());
          for (const line of argLines) {
            if (line.includes("name:")) {
              lines.push(`- \`${line.replace(/.*name:\s*/, "").trim()}\``);
            }
          }
        }

        if (body) {
          lines.push(`\n**Prompt:**\n\n> ${body.split("\n").join("\n> ")}`);
        }
        lines.push("");
      }
    }
  }

  return found ? lines.join("\n") : null;
}

function generateHookDocs(hooks: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [event, handlers] of Object.entries(hooks)) {
    lines.push(`### ${event}\n`);
    if (!Array.isArray(handlers)) continue;

    for (const handler of handlers) {
      const h = handler as Record<string, unknown>;
      if (h.match) {
        lines.push(
          `**Match:** ${Object.entries(h.match as Record<string, string>)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`,
        );
      }
      if (h.command) {
        lines.push(`**Command:** \`${h.command} ${((h.args as string[]) || []).join(" ")}\``);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function generateMcpDocs(servers: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [name, config] of Object.entries(servers)) {
    const c = config as Record<string, unknown>;
    lines.push(`### ${name}\n`);
    lines.push(`**Command:** \`${c.command} ${((c.args as string[]) || []).join(" ")}\``);
    if (c.env && Object.keys(c.env as Record<string, string>).length > 0) {
      lines.push("\n**Environment:**");
      for (const [k, v] of Object.entries(c.env as Record<string, string>)) {
        lines.push(`- \`${k}\`: ${v || "(required)"}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function generateAgentDocs(dir: string, patterns: string[]): string | null {
  const lines: string[] = [];
  let found = false;

  for (const pattern of patterns) {
    const files = findFiles(dir, pattern);
    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm) {
        found = true;
        lines.push(`### ${fm.name || file}\n`);
        if (fm.description) lines.push(fm.description);
        if (fm.tools) lines.push(`\n**Tools:** ${fm.tools}`);
        if (fm.maxTurns) lines.push(`**Max Turns:** ${fm.maxTurns}`);
        lines.push("");
      }
    }
  }

  return found ? lines.join("\n") : null;
}

function generateStyleDocs(dir: string, patterns: string[]): string | null {
  const lines: string[] = [];
  let found = false;

  for (const pattern of patterns) {
    const files = findFiles(dir, pattern);
    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm) {
        found = true;
        lines.push(`### ${fm.name || file}\n`);
        if (fm.description) lines.push(fm.description);
        lines.push("");
      }
    }
  }

  return found ? lines.join("\n") : null;
}

function generateConfigDocs(manifest: PluginManifest): string {
  return [
    "This plugin can be configured in your KCode settings:\n",
    "```json",
    `{`,
    `  "plugin.${manifest.name}": {`,
    `    // Plugin-specific configuration here`,
    `  }`,
    `}`,
    "```",
  ].join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────

function loadManifest(dir: string): PluginManifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, "plugin.json"), "utf-8"));
  } catch {
    return null;
  }
}

function findFiles(dir: string, pattern: string): string[] {
  const parts = pattern.split("/");
  const dirPart = parts.slice(0, -1).join("/");
  const filePart = parts[parts.length - 1];
  const targetDir = join(dir, dirPart);

  if (!existsSync(targetDir)) return [];

  try {
    const regex = new RegExp("^" + filePart.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    return readdirSync(targetDir)
      .filter((e) => regex.test(e))
      .map((e) => (dirPart ? `${dirPart}/${e}` : e));
  } catch {
    return [];
  }
}

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return fields;
}
