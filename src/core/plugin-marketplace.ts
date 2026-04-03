// KCode - Plugin Marketplace API
// Enhanced marketplace client for plugin discovery, installation, and updates.
// Connects to https://marketplace.kulvex.ai/api/v1/plugins with local fallback.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger";
import { kcodeHome, kcodePath } from "./paths";

// ─── Types ──────────────────────────────────────────────────────

export interface MarketplacePlugin {
  name: string;
  version: string;
  description: string;
  author: string;
  downloads: number;
  rating: number;
  categories: string[];
}

export interface PluginUpdate {
  name: string;
  currentVersion: string;
  latestVersion: string;
}

export interface MarketplaceConfig {
  apiBase: string;
  installed: Record<string, { version: string; installedAt: string }>;
}

// ─── Constants ─────────────────────────────────────────────────

const MARKETPLACE_API = "https://marketplace.kulvex.ai/api/v1/plugins";
const CONFIG_PATH = kcodePath("marketplace.json");
const PLUGINS_DIR = kcodePath("plugins");

// ─── Config ────────────────────────────────────────────────────

function loadMarketplaceConfig(): MarketplaceConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        apiBase: parsed.apiBase ?? MARKETPLACE_API,
        installed: parsed.installed ?? {},
      };
    }
  } catch {
    /* use defaults */
  }
  return { apiBase: MARKETPLACE_API, installed: {} };
}

function saveMarketplaceConfig(config: MarketplaceConfig): void {
  const dir = kcodeHome();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

// ─── Bundled Fallback ──────────────────────────────────────────

function getBundledPlugins(): MarketplacePlugin[] {
  return [
    {
      name: "kcode-docker",
      version: "1.1.0",
      description: "Docker container management, Dockerfile generation, and compose tools",
      author: "Astrolexis",
      downloads: 9870,
      rating: 4.7,
      categories: ["devops", "containers"],
    },
    {
      name: "kcode-database",
      version: "1.3.0",
      description: "SQL query tools for PostgreSQL, MySQL, and SQLite with schema exploration",
      author: "Astrolexis",
      downloads: 8340,
      rating: 4.6,
      categories: ["database", "sql"],
    },
    {
      name: "kcode-aws",
      version: "0.9.0",
      description: "AWS service management: S3, Lambda, EC2, CloudFormation integration",
      author: "Astrolexis",
      downloads: 4320,
      rating: 4.3,
      categories: ["cloud", "aws"],
    },
    {
      name: "kcode-kubernetes",
      version: "1.0.0",
      description: "Kubernetes cluster management, pod monitoring, and kubectl integration",
      author: "Astrolexis",
      downloads: 6520,
      rating: 4.5,
      categories: ["devops", "orchestration"],
    },
    {
      name: "kcode-api-testing",
      version: "1.0.0",
      description: "HTTP request testing, collection management, and response assertions",
      author: "Astrolexis",
      downloads: 5100,
      rating: 4.4,
      categories: ["testing", "api"],
    },
    {
      name: "kcode-git-hooks",
      version: "1.2.0",
      description: "Pre-commit and post-push automation with customizable checks",
      author: "Astrolexis",
      downloads: 12450,
      rating: 4.8,
      categories: ["git", "automation"],
    },
    {
      name: "kcode-terraform",
      version: "1.0.0",
      description: "Terraform plan/apply integration with HCL validation and state management",
      author: "Astrolexis",
      downloads: 5890,
      rating: 4.4,
      categories: ["iac", "devops"],
    },
    {
      name: "kcode-security-scan",
      version: "0.8.0",
      description: "Security vulnerability scanning for dependencies and code patterns",
      author: "Community",
      downloads: 3150,
      rating: 4.2,
      categories: ["security", "audit"],
    },
  ];
}

// ─── Remote Fetch ──────────────────────────────────────────────

async function fetchRemotePlugins(apiBase: string): Promise<MarketplacePlugin[] | null> {
  try {
    const resp = await fetch(apiBase, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      return (await resp.json()) as MarketplacePlugin[];
    }
  } catch {
    log.debug("plugin-marketplace", "Remote marketplace unreachable, using bundled fallback");
  }
  return null;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Search the marketplace for plugins matching a query.
 */
export async function searchPlugins(query: string): Promise<MarketplacePlugin[]> {
  const config = loadMarketplaceConfig();
  const remote = await fetchRemotePlugins(config.apiBase);
  const plugins = remote ?? getBundledPlugins();

  if (!query.trim()) return plugins;

  const q = query.toLowerCase();
  return plugins.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.categories.some((c) => c.toLowerCase().includes(q)) ||
      p.author.toLowerCase().includes(q),
  );
}

/**
 * Install a plugin from the marketplace by name.
 */
export async function installPlugin(name: string, version?: string): Promise<void> {
  if (!name || typeof name !== "string") {
    throw new Error("Plugin name is required");
  }

  const config = loadMarketplaceConfig();
  const remote = await fetchRemotePlugins(config.apiBase);
  const plugins = remote ?? getBundledPlugins();

  const plugin = plugins.find((p) => p.name === name);
  if (!plugin) {
    throw new Error(`Plugin "${name}" not found in marketplace`);
  }

  if (version && version !== plugin.version) {
    throw new Error(`Version "${version}" not available for "${name}". Latest: ${plugin.version}`);
  }

  const pluginDir = join(PLUGINS_DIR, name);
  if (existsSync(pluginDir)) {
    throw new Error(`Plugin "${name}" is already installed at ${pluginDir}`);
  }

  if (!existsSync(PLUGINS_DIR)) mkdirSync(PLUGINS_DIR, { recursive: true });

  // In production this would download from the marketplace CDN.
  // For now, record the installation metadata.
  mkdirSync(pluginDir, { recursive: true });
  const manifest = {
    name,
    version: plugin.version,
    description: plugin.description,
    author: plugin.author,
    license: "MIT",
    kcode: ">=1.7.0",
  };
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf-8");

  config.installed[name] = {
    version: plugin.version,
    installedAt: new Date().toISOString(),
  };
  saveMarketplaceConfig(config);

  log.info("plugin-marketplace", `Installed ${name} v${plugin.version}`);
}

/**
 * Check for available updates on all installed plugins.
 */
export async function checkPluginUpdates(): Promise<PluginUpdate[]> {
  const config = loadMarketplaceConfig();
  const remote = await fetchRemotePlugins(config.apiBase);
  const plugins = remote ?? getBundledPlugins();
  const updates: PluginUpdate[] = [];

  for (const [name, info] of Object.entries(config.installed)) {
    const latest = plugins.find((p) => p.name === name);
    if (latest && latest.version !== info.version) {
      updates.push({
        name,
        currentVersion: info.version,
        latestVersion: latest.version,
      });
    }
  }

  return updates;
}

/**
 * List all available plugins from the marketplace (remote or fallback).
 */
export async function listRemotePlugins(): Promise<MarketplacePlugin[]> {
  const config = loadMarketplaceConfig();
  const remote = await fetchRemotePlugins(config.apiBase);
  return remote ?? getBundledPlugins();
}

// ─── Formatting ────────────────────────────────────────────────

export function formatMarketplaceResults(plugins: MarketplacePlugin[]): string {
  if (plugins.length === 0) return "  No plugins found.";

  const lines: string[] = [`  Marketplace Plugins (${plugins.length}):\n`];
  for (const p of plugins) {
    const stars = "\u2605".repeat(Math.round(p.rating));
    lines.push(`  ${p.name} v${p.version} -- ${p.description}`);
    lines.push(
      `    by ${p.author} | ${p.downloads.toLocaleString()} downloads | ${stars} (${p.rating})`,
    );
    lines.push(`    categories: ${p.categories.join(", ")}`);
  }
  return lines.join("\n");
}
