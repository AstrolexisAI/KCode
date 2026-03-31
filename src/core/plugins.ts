// KCode - Plugin System
// Discovers and loads plugins from ~/.kcode/plugins/ and .kcode/plugins/

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger";
import { kcodePath } from "./paths";
import { isWorkspaceTrusted } from "./hook-trust";

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  kcode?: string; // Minimum KCode version required

  // What the plugin provides
  skills?: string[];      // Paths to skill .md files relative to plugin dir
  hooks?: Record<string, {  // Hook event -> command
    command: string;
    args?: string[];
  }>;
  mcpServers?: Record<string, {  // MCP server configs
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
  agents?: string[];       // Paths to agent .md files relative to plugin dir
  outputStyles?: string[]; // Paths to output style .md files relative to plugin dir

  // Marketplace metadata
  marketplace?: string;    // Source marketplace identifier
  sha256?: string;         // Content hash for verification
  verified?: boolean;      // Passed marketplace verification
  downloads?: number;      // Download count
  rating?: number;         // User rating
}

export interface LoadedPlugin {
  name: string;
  version: string;
  description: string;
  dir: string;
  manifest: PluginManifest;
  skillFiles: string[];   // Absolute paths to skill .md files
  agentFiles: string[];   // Absolute paths to agent .md files
  outputStyleFiles: string[]; // Absolute paths to output style .md files
}

export class PluginManager {
  private plugins: LoadedPlugin[] = [];
  private userPluginsDir: string;

  constructor(userPluginsDir?: string) {
    this.userPluginsDir = userPluginsDir ?? kcodePath("plugins");
  }

  /**
   * Discover and load plugins from standard directories.
   * Project-level plugins require workspace trust.
   */
  load(cwd: string): void {
    this.plugins = [];

    // Load from user plugins directory (always trusted)
    this.loadFromDir(this.userPluginsDir);

    // Load from project plugins directory (higher priority) — requires workspace trust
    const projectPluginsDir = join(cwd, ".kcode", "plugins");
    if (isWorkspaceTrusted(cwd)) {
      this.loadFromDir(projectPluginsDir);
    } else if (existsSync(projectPluginsDir)) {
      try {
        const entries = readdirSync(projectPluginsDir, { withFileTypes: true });
        if (entries.some(e => e.isDirectory())) {
          console.error(`[plugins] Skipping project .kcode/plugins/ — workspace not trusted. Run \`kcode init --trust\` to trust this workspace.`);
        }
      } catch { /* ignore */ }
    }

    if (this.plugins.length > 0) {
      log.info("config", `Loaded ${this.plugins.length} plugin(s): ${this.plugins.map(p => p.name).join(", ")}`);
    }
  }

  private loadFromDir(dir: string): void {
    if (!existsSync(dir)) return;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginDir = join(dir, entry.name);
        const manifestPath = join(pluginDir, "plugin.json");

        if (!existsSync(manifestPath)) {
          // Try package.json with kcode field
          const pkgPath = join(pluginDir, "package.json");
          if (existsSync(pkgPath)) {
            try {
              const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
              if (pkg.kcode) {
                this.loadPlugin(pluginDir, { ...pkg.kcode, name: pkg.name, version: pkg.version });
              }
            } catch { /* skip */ }
          }
          continue;
        }

        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PluginManifest;
          this.loadPlugin(pluginDir, manifest);
        } catch (err) {
          log.warn("config", `Failed to load plugin from ${pluginDir}: ${err}`);
        }
      }
    } catch { /* dir not readable */ }
  }

  private loadPlugin(dir: string, manifest: PluginManifest): void {
    // Check for duplicate names
    if (this.plugins.some(p => p.name === manifest.name)) {
      log.warn("config", `Plugin "${manifest.name}" already loaded, skipping duplicate`);
      return;
    }

    // Resolve skill file paths
    const skillFiles = this.resolvePluginPaths(dir, manifest.name, manifest.skills, "skill");

    // Resolve agent file paths
    const agentFiles = this.resolvePluginPaths(dir, manifest.name, manifest.agents, "agent");

    // Resolve output style file paths
    const outputStyleFiles = this.resolvePluginPaths(dir, manifest.name, manifest.outputStyles, "output style");

    this.plugins.push({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? "",
      dir,
      manifest,
      skillFiles,
      agentFiles,
      outputStyleFiles,
    });
  }

  /**
   * Resolve relative paths from a plugin manifest, with path traversal guards.
   */
  private resolvePluginPaths(dir: string, pluginName: string, paths: string[] | undefined, label: string): string[] {
    const resolved: string[] = [];
    if (!paths) return resolved;

    for (const relPath of paths) {
      // Path traversal guard
      if (relPath.includes("..") || relPath.startsWith("/") || relPath.startsWith("\\")) {
        log.warn("config", `Plugin "${pluginName}": ${label} path rejected (traversal attempt): ${relPath}`);
        continue;
      }
      const fullPath = join(dir, relPath);
      if (existsSync(fullPath)) {
        resolved.push(fullPath);
      } else {
        log.warn("config", `Plugin "${pluginName}": ${label} file not found: ${relPath}`);
      }
    }
    return resolved;
  }

  /**
   * Get all loaded plugins.
   */
  getPlugins(): LoadedPlugin[] {
    return [...this.plugins];
  }

  /**
   * Get all skill file paths from all plugins.
   */
  getSkillPaths(): string[] {
    return this.plugins.flatMap(p => p.skillFiles);
  }

  /**
   * Get all MCP server configs from all plugins.
   */
  getMcpConfigs(): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
    const configs: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
    for (const plugin of this.plugins) {
      if (plugin.manifest.mcpServers) {
        for (const [name, config] of Object.entries(plugin.manifest.mcpServers)) {
          const prefixedName = `${plugin.name}__${name}`;
          configs[prefixedName] = config;
        }
      }
    }
    return configs;
  }

  /**
   * Get all hook configs from all plugins.
   */
  getHookConfigs(): Array<{ pluginName: string; event: string; command: string; args?: string[] }> {
    const hooks: Array<{ pluginName: string; event: string; command: string; args?: string[] }> = [];
    for (const plugin of this.plugins) {
      if (plugin.manifest.hooks) {
        for (const [event, config] of Object.entries(plugin.manifest.hooks)) {
          hooks.push({ pluginName: plugin.name, event, ...config });
        }
      }
    }
    return hooks;
  }

  /**
   * Format plugin info for display.
   */
  formatList(): string {
    if (this.plugins.length === 0) {
      return "No plugins installed.\n\nTo install a plugin, create a directory in ~/.kcode/plugins/ with a plugin.json manifest.";
    }

    const lines = this.plugins.map(p => {
      const skills = p.skillFiles.length > 0 ? `, ${p.skillFiles.length} skill(s)` : "";
      const mcps = p.manifest.mcpServers ? `, ${Object.keys(p.manifest.mcpServers).length} MCP server(s)` : "";
      const hooks = p.manifest.hooks ? `, ${Object.keys(p.manifest.hooks).length} hook(s)` : "";
      return `  ${p.name} v${p.version}${skills}${mcps}${hooks}\n    ${p.description || "(no description)"}`;
    });

    return `${this.plugins.length} plugin(s) installed:\n\n${lines.join("\n\n")}`;
  }
}

let _plugins: PluginManager | null = null;
export function getPluginManager(): PluginManager {
  if (!_plugins) _plugins = new PluginManager();
  return _plugins;
}
