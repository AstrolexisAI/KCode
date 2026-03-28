// KCode - Plugin Manager
// Unified plugin lifecycle: install, remove, list, and load plugin bundles
// Plugins provide skills (slash commands), hooks, and MCP server configs

import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { kcodePath } from "./paths";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HookDefinition {
  event: string;
  command: string;
  args?: string[];
  timeout?: number;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  skills?: string[];                        // paths to skill .md files relative to plugin dir
  hooks?: HookDefinition[];                 // hook configurations
  mcpServers?: Record<string, McpServerConfig>; // MCP server configs
  dependencies?: string[];                  // other plugin names
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  dir: string;
  skillFiles: string[];   // resolved absolute paths to skill .md files
}

// ─── PluginManager ──────────────────────────────────────────────

export class PluginManager {
  private pluginsDir: string;

  constructor(pluginsDir?: string) {
    this.pluginsDir = pluginsDir ?? kcodePath("plugins");
  }

  /**
   * Ensure the plugins directory exists.
   */
  private ensureDir(): void {
    if (!existsSync(this.pluginsDir)) {
      mkdirSync(this.pluginsDir, { recursive: true });
    }
  }

  /**
   * Read and parse a plugin manifest from a directory.
   * Returns null if no valid manifest is found.
   */
  private readManifest(dir: string): PluginManifest | null {
    const manifestPath = join(dir, "plugin.json");
    try {
      const file = Bun.file(manifestPath);
      // Use sync read since Bun.file().text() is async
      const content = readFileSync(manifestPath, "utf-8");
      const raw = JSON.parse(content);

      // Validate required fields
      if (!raw.name || typeof raw.name !== "string") return null;
      if (!raw.version || typeof raw.version !== "string") return null;

      // Validate name: only alphanumeric, hyphens, underscores (prevent path traversal)
      if (!/^[a-zA-Z0-9_-]+$/.test(raw.name)) {
        log.warn("plugins", `Invalid plugin name "${raw.name}" — must be alphanumeric/hyphens/underscores only`);
        return null;
      }

      // Validate skills: must be an array of relative path strings (no path traversal)
      const skills = Array.isArray(raw.skills)
        ? raw.skills.filter((s: unknown) => typeof s === "string" && !String(s).includes(".."))
        : undefined;

      // Validate hooks: must be an array of objects with event + command
      const hooks = Array.isArray(raw.hooks)
        ? raw.hooks.filter((h: unknown) =>
            h && typeof h === "object" &&
            typeof (h as Record<string, unknown>).event === "string" &&
            typeof (h as Record<string, unknown>).command === "string"
          )
        : undefined;

      // Validate mcpServers: delegate to isValidServerConfig downstream
      // but ensure structure is an object of named configs
      const mcpServers = raw.mcpServers && typeof raw.mcpServers === "object" && !Array.isArray(raw.mcpServers)
        ? raw.mcpServers
        : undefined;

      return {
        name: raw.name,
        version: raw.version,
        description: typeof raw.description === "string" ? raw.description : "",
        author: typeof raw.author === "string" ? raw.author : undefined,
        skills,
        hooks,
        mcpServers,
        dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolve a plugin directory into an InstalledPlugin with absolute skill paths.
   */
  private resolvePlugin(dir: string, manifest: PluginManifest): InstalledPlugin {
    const skillFiles: string[] = [];
    if (manifest.skills) {
      for (const rel of manifest.skills) {
        const abs = join(dir, rel);
        if (existsSync(abs)) {
          skillFiles.push(abs);
        }
      }
    }
    return { manifest, dir, skillFiles };
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * List all installed plugins.
   */
  async list(): Promise<PluginManifest[]> {
    this.ensureDir();
    const manifests: PluginManifest[] = [];

    try {
      const entries = readdirSync(this.pluginsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifest = this.readManifest(join(this.pluginsDir, entry.name));
        if (manifest) manifests.push(manifest);
      }
    } catch {
      // Directory not readable
    }

    return manifests;
  }

  /**
   * Install a plugin from a local path or git URL.
   *
   * - Local path: copies the directory into ~/.kcode/plugins/<name>/
   * - Git URL (https:// or git@): clones the repo into ~/.kcode/plugins/<name>/
   *
   * The source must contain a plugin.json manifest.
   */
  async install(source: string): Promise<PluginManifest> {
    this.ensureDir();

    const isGitUrl = source.startsWith("https://") || source.startsWith("git@") || source.endsWith(".git");

    if (isGitUrl) {
      return this.installFromGit(source);
    } else {
      return this.installFromLocal(source);
    }
  }

  private async installFromLocal(sourcePath: string): Promise<PluginManifest> {
    // Validate source has a manifest
    const manifest = this.readManifest(sourcePath);
    if (!manifest) {
      throw new Error(`No valid plugin.json found in ${sourcePath}`);
    }

    const destDir = join(this.pluginsDir, manifest.name);

    // Check if already installed
    if (existsSync(destDir)) {
      throw new Error(`Plugin "${manifest.name}" is already installed at ${destDir}`);
    }

    // Check dependencies
    await this.checkDependencies(manifest);

    // Copy the plugin directory
    cpSync(sourcePath, destDir, { recursive: true });

    log.info("plugins", `Installed plugin: ${manifest.name} v${manifest.version} from local path`);
    return manifest;
  }

  private async installFromGit(url: string): Promise<PluginManifest> {
    // Derive a temp name from the URL for cloning
    const repoName = url.replace(/\.git$/, "").split("/").pop() ?? "plugin";
    const tempDir = join(this.pluginsDir, `.tmp-${repoName}-${Date.now()}`);

    try {
      // Clone the repository
      const proc = Bun.spawnSync(["git", "clone", "--depth", "1", url, tempDir]);
      if (proc.exitCode !== 0) {
        const stderr = proc.stderr.toString();
        throw new Error(`Git clone failed: ${stderr}`);
      }

      // Read the manifest from the cloned repo
      const manifest = this.readManifest(tempDir);
      if (!manifest) {
        // Clean up the temp dir
        rmSync(tempDir, { recursive: true, force: true });
        throw new Error(`No valid plugin.json found in cloned repository: ${url}`);
      }

      const destDir = join(this.pluginsDir, manifest.name);

      // Check if already installed
      if (existsSync(destDir)) {
        rmSync(tempDir, { recursive: true, force: true });
        throw new Error(`Plugin "${manifest.name}" is already installed at ${destDir}`);
      }

      // Check dependencies
      try {
        await this.checkDependencies(manifest);
      } catch (err) {
        rmSync(tempDir, { recursive: true, force: true });
        throw err;
      }

      // Rename temp dir to final location
      const { renameSync } = await import("node:fs");
      renameSync(tempDir, destDir);

      log.info("plugins", `Installed plugin: ${manifest.name} v${manifest.version} from ${url}`);
      return manifest;
    } catch (err) {
      // Clean up temp dir on any failure
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
      throw err;
    }
  }

  /**
   * Verify that all declared dependencies are installed.
   */
  private async checkDependencies(manifest: PluginManifest): Promise<void> {
    if (!manifest.dependencies || manifest.dependencies.length === 0) return;

    const installed = await this.list();
    const installedNames = new Set(installed.map(p => p.name));

    const missing = manifest.dependencies.filter(dep => !installedNames.has(dep));
    if (missing.length > 0) {
      throw new Error(
        `Plugin "${manifest.name}" requires missing plugin(s): ${missing.join(", ")}`
      );
    }
  }

  /**
   * Remove an installed plugin by name.
   * Returns true if the plugin was found and removed, false if not found.
   */
  async remove(name: string): Promise<boolean> {
    const pluginDir = join(this.pluginsDir, name);

    if (!existsSync(pluginDir)) {
      return false;
    }

    // Verify it's actually a plugin (has a manifest)
    const manifest = this.readManifest(pluginDir);
    if (!manifest) {
      // Directory exists but no valid manifest — still remove it
      log.warn("plugins", `Removing "${name}" which has no valid plugin.json`);
    }

    // Check if any other plugin depends on this one
    const allPlugins = await this.list();
    const dependents = allPlugins.filter(
      p => p.name !== name && p.dependencies?.includes(name)
    );
    if (dependents.length > 0) {
      throw new Error(
        `Cannot remove "${name}": required by ${dependents.map(p => p.name).join(", ")}`
      );
    }

    rmSync(pluginDir, { recursive: true, force: true });
    log.info("plugins", `Removed plugin: ${name}`);
    return true;
  }

  /**
   * Get a single plugin's manifest by name.
   */
  async get(name: string): Promise<PluginManifest | null> {
    const pluginDir = join(this.pluginsDir, name);
    if (!existsSync(pluginDir)) return null;
    return this.readManifest(pluginDir);
  }

  /**
   * Load all plugin skills into a SkillManager.
   * Calls skillManager.load() to refresh, then returns the count of skill files found.
   */
  async loadSkills(skillManager: any): Promise<number> {
    const plugins = await this.listResolved();
    let count = 0;

    for (const plugin of plugins) {
      count += plugin.skillFiles.length;
    }

    // Trigger a reload on the skill manager so it picks up plugin skills
    if (typeof skillManager.load === "function") {
      // Reset the loaded flag so load() rediscovers plugins
      if ("loaded" in skillManager) {
        (skillManager as any).loaded = false;
      }
      skillManager.load();
    }

    return count;
  }

  /**
   * Load all hook definitions from all installed plugins.
   */
  async loadHooks(): Promise<HookDefinition[]> {
    const plugins = await this.list();
    const hooks: HookDefinition[] = [];

    for (const manifest of plugins) {
      if (manifest.hooks) {
        for (const hook of manifest.hooks) {
          hooks.push(hook);
        }
      }
    }

    return hooks;
  }

  /**
   * Collect all MCP server configs from all installed plugins.
   * Keys are prefixed with the plugin name to avoid collisions: <plugin>__<server>
   */
  async getMcpConfigs(): Promise<Record<string, McpServerConfig>> {
    const plugins = await this.list();
    const configs: Record<string, McpServerConfig> = {};

    for (const manifest of plugins) {
      if (manifest.mcpServers) {
        for (const [serverName, config] of Object.entries(manifest.mcpServers)) {
          const key = `${manifest.name}__${serverName}`;
          configs[key] = config;
        }
      }
    }

    return configs;
  }

  /**
   * List all installed plugins as fully resolved InstalledPlugin objects.
   */
  private async listResolved(): Promise<InstalledPlugin[]> {
    this.ensureDir();
    const plugins: InstalledPlugin[] = [];

    try {
      const entries = readdirSync(this.pluginsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(this.pluginsDir, entry.name);
        const manifest = this.readManifest(dir);
        if (manifest) {
          plugins.push(this.resolvePlugin(dir, manifest));
        }
      }
    } catch {
      // Directory not readable
    }

    return plugins;
  }
}
