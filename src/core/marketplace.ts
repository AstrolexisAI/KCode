// KCode - Plugin Marketplace
// Plugin discovery and distribution system with local registry fallback.
// Supports CDN-based atomic downloads with SHA verification.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger";
import { kcodeHome, kcodePath } from "./paths";
import { CDNFetcher } from "./marketplace/cdn-fetcher";
import { verifyPlugin } from "./marketplace/verifier";
import type { MarketplaceSource, MarketplaceSettings } from "./marketplace/types";

// ─── Types ──────────────────────────────────────────────────────

export interface MarketplacePlugin {
  name: string;
  version: string;
  description: string;
  author: string;
  repository: string;
  downloads: number;
  rating: number;
  tags: string[];
  verified: boolean;
}

export interface MarketplaceConfig {
  registryUrl: string;
  installed: Record<string, { version: string; installedAt: string; marketplace?: string }>;
  /** Marketplace settings for CDN sources, integrity, etc. */
  marketplace?: MarketplaceSettings;
}

// ─── Paths ──────────────────────────────────────────────────────

const KCODE_DIR = kcodeHome();
const MARKETPLACE_CONFIG_PATH = kcodePath("marketplace.json");
const PLUGINS_DIR = kcodePath("plugins");
const BUNDLED_REGISTRY_PATH = join(import.meta.dir, "..", "data", "plugin-registry.json");

const DEFAULT_REGISTRY_URL = "https://plugins.kulvex.ai/api/v1";

// ─── Config Management ─────────────────────────────────────────

function loadConfig(): MarketplaceConfig {
  try {
    if (existsSync(MARKETPLACE_CONFIG_PATH)) {
      const raw = readFileSync(MARKETPLACE_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        registryUrl: parsed.registryUrl ?? DEFAULT_REGISTRY_URL,
        installed: parsed.installed ?? {},
      };
    }
  } catch { /* use defaults */ }
  return { registryUrl: DEFAULT_REGISTRY_URL, installed: {} };
}

function saveConfig(config: MarketplaceConfig): void {
  if (!existsSync(KCODE_DIR)) mkdirSync(KCODE_DIR, { recursive: true });
  writeFileSync(MARKETPLACE_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

// ─── Registry ───────────────────────────────────────────────────

function loadBundledRegistry(): MarketplacePlugin[] {
  try {
    if (existsSync(BUNDLED_REGISTRY_PATH)) {
      const raw = readFileSync(BUNDLED_REGISTRY_PATH, "utf-8");
      return JSON.parse(raw) as MarketplacePlugin[];
    }
  } catch { /* fall through */ }

  return getDefaultRegistry();
}

function getDefaultRegistry(): MarketplacePlugin[] {
  return [
    {
      name: "git-hooks",
      version: "1.2.0",
      description: "Pre-commit and post-push automation with customizable checks",
      author: "Astrolexis",
      repository: "https://github.com/Astrolexis/kcode-plugin-git-hooks",
      downloads: 12450,
      rating: 4.8,
      tags: ["git", "automation", "hooks"],
      verified: true,
    },
    {
      name: "docker",
      version: "1.1.0",
      description: "Docker container management, Dockerfile generation, and compose tools",
      author: "Astrolexis",
      repository: "https://github.com/Astrolexis/kcode-plugin-docker",
      downloads: 9870,
      rating: 4.7,
      tags: ["docker", "devops", "containers"],
      verified: true,
    },
    {
      name: "database",
      version: "1.3.0",
      description: "SQL query tools for PostgreSQL, MySQL, and SQLite with schema exploration",
      author: "Astrolexis",
      repository: "https://github.com/Astrolexis/kcode-plugin-database",
      downloads: 8340,
      rating: 4.6,
      tags: ["sql", "database", "postgresql", "mysql", "sqlite"],
      verified: true,
    },
    {
      name: "kubernetes",
      version: "1.0.0",
      description: "Kubernetes cluster management, pod monitoring, and kubectl integration",
      author: "Astrolexis",
      repository: "https://github.com/Astrolexis/kcode-plugin-kubernetes",
      downloads: 6520,
      rating: 4.5,
      tags: ["k8s", "kubernetes", "devops", "orchestration"],
      verified: true,
    },
    {
      name: "terraform",
      version: "1.0.0",
      description: "Terraform plan/apply integration with HCL validation and state management",
      author: "Astrolexis",
      repository: "https://github.com/Astrolexis/kcode-plugin-terraform",
      downloads: 5890,
      rating: 4.4,
      tags: ["terraform", "iac", "infrastructure", "devops"],
      verified: true,
    },
    {
      name: "test-runner",
      version: "1.1.0",
      description: "Enhanced test runner with coverage reporting and watch mode",
      author: "Astrolexis",
      repository: "https://github.com/Astrolexis/kcode-plugin-test-runner",
      downloads: 7210,
      rating: 4.6,
      tags: ["testing", "coverage", "jest", "vitest"],
      verified: true,
    },
    {
      name: "lint-format",
      version: "1.0.0",
      description: "Auto-lint and format code with ESLint, Prettier, and language-specific formatters",
      author: "Astrolexis",
      repository: "https://github.com/Astrolexis/kcode-plugin-lint-format",
      downloads: 11200,
      rating: 4.7,
      tags: ["lint", "format", "eslint", "prettier", "code-quality"],
      verified: true,
    },
    {
      name: "aws",
      version: "0.9.0",
      description: "AWS service management: S3, Lambda, EC2, CloudFormation integration",
      author: "Astrolexis",
      repository: "https://github.com/Astrolexis/kcode-plugin-aws",
      downloads: 4320,
      rating: 4.3,
      tags: ["aws", "cloud", "s3", "lambda", "devops"],
      verified: true,
    },
    {
      name: "security-scan",
      version: "0.8.0",
      description: "Security vulnerability scanning for dependencies and code patterns",
      author: "Community",
      repository: "https://github.com/kcode-community/kcode-plugin-security-scan",
      downloads: 3150,
      rating: 4.2,
      tags: ["security", "audit", "vulnerabilities", "scanning"],
      verified: false,
    },
    {
      name: "notebook",
      version: "1.0.0",
      description: "Jupyter notebook management with cell execution and output rendering",
      author: "Astrolexis",
      repository: "https://github.com/Astrolexis/kcode-plugin-notebook",
      downloads: 5670,
      rating: 4.5,
      tags: ["jupyter", "notebook", "python", "data-science"],
      verified: true,
    },
  ];
}

async function fetchRemoteRegistry(registryUrl: string): Promise<MarketplacePlugin[] | null> {
  try {
    const resp = await fetch(`${registryUrl}/plugins`, {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      return (await resp.json()) as MarketplacePlugin[];
    }
  } catch { /* offline or unreachable */ }
  return null;
}

// ─── Public API ─────────────────────────────────────────────────

export async function searchPlugins(query: string): Promise<MarketplacePlugin[]> {
  const config = loadConfig();
  const remote = await fetchRemoteRegistry(config.registryUrl);
  const registry = remote ?? loadBundledRegistry();

  if (!query.trim()) return registry;

  const q = query.toLowerCase();
  return registry.filter(p =>
    p.name.toLowerCase().includes(q) ||
    p.description.toLowerCase().includes(q) ||
    p.tags.some(t => t.toLowerCase().includes(q)) ||
    p.author.toLowerCase().includes(q)
  );
}

export async function getPluginDetails(name: string): Promise<MarketplacePlugin | null> {
  const config = loadConfig();
  const remote = await fetchRemoteRegistry(config.registryUrl);
  const registry = remote ?? loadBundledRegistry();

  return registry.find(p => p.name === name) ?? null;
}

export async function installFromMarketplace(name: string, options?: { forceCdn?: boolean }): Promise<boolean> {
  const plugin = await getPluginDetails(name);
  if (!plugin) {
    log.warn("marketplace", `Plugin "${name}" not found in marketplace`);
    return false;
  }

  if (!existsSync(PLUGINS_DIR)) mkdirSync(PLUGINS_DIR, { recursive: true });

  const pluginDir = join(PLUGINS_DIR, name);
  if (existsSync(pluginDir)) {
    log.warn("marketplace", `Plugin "${name}" is already installed`);
    return false;
  }

  const config = loadConfig();
  const cdnSource = getCDNSource(config);

  // Try CDN first if available, then fall back to git clone
  if (cdnSource || options?.forceCdn) {
    try {
      const result = await installViaCDN(name, plugin.version, config);
      if (result) return true;
    } catch (err) {
      log.warn("marketplace", `CDN install failed for ${name}, falling back to git: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback: git clone
  try {
    const proc = Bun.spawnSync(["git", "clone", "--depth", "1", plugin.repository, pluginDir]);
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString();
      log.error("marketplace", `Failed to clone ${name}: ${stderr}`);
      return false;
    }

    // Verify plugin integrity if enabled
    if (config.marketplace?.verifyIntegrity !== false) {
      const verification = verifyPlugin(pluginDir);
      if (!verification.valid) {
        log.warn("marketplace", `Plugin "${name}" has verification issues: ${verification.issues.map(i => i.message).join("; ")}`);
      }
      for (const issue of verification.issues.filter(i => i.severity === "warning")) {
        log.warn("marketplace", `Plugin "${name}": ${issue.message}`);
      }
    }

    config.installed[name] = {
      version: plugin.version,
      installedAt: new Date().toISOString(),
    };
    saveConfig(config);

    if (!plugin.verified) {
      log.warn("marketplace", `Plugin "${name}" is not verified by the marketplace`);
    }

    log.info("marketplace", `Installed plugin: ${name} v${plugin.version}`);
    return true;
  } catch (err) {
    log.error("marketplace", `Install failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Install a plugin via CDN with atomic download.
 */
async function installViaCDN(name: string, version: string, config: MarketplaceConfig): Promise<boolean> {
  const cdnSource = getCDNSource(config);
  if (!cdnSource) return false;

  const cacheDir = kcodePath("plugins", "marketplace-cache");
  const fetcher = new CDNFetcher({
    cacheDir,
    cdnBaseUrl: cdnSource.url,
    timeoutMs: 30_000,
  });

  const result = await fetcher.fetchPlugin(name, version);

  // Copy from cache to plugins dir
  const { cpSync } = await import("node:fs");
  const pluginDir = join(PLUGINS_DIR, name);
  cpSync(result.pluginDir, pluginDir, { recursive: true });

  config.installed[name] = {
    version: result.version,
    installedAt: new Date().toISOString(),
    marketplace: cdnSource.name,
  };
  saveConfig(config);

  log.info("marketplace", `Installed plugin: ${name} v${result.version} from CDN (${result.fromCache ? "cached" : "downloaded"})`);
  return true;
}

/**
 * Get the first CDN source from marketplace config, if any.
 */
function getCDNSource(config: MarketplaceConfig): MarketplaceSource | null {
  if (!config.marketplace?.sources) return null;
  return config.marketplace.sources.find(s => s.type === "cdn") ?? null;
}

export async function updatePlugin(name: string): Promise<boolean> {
  const pluginDir = join(PLUGINS_DIR, name);
  if (!existsSync(pluginDir)) {
    log.warn("marketplace", `Plugin "${name}" is not installed`);
    return false;
  }

  try {
    const proc = Bun.spawnSync(["git", "pull", "--ff-only"], { cwd: pluginDir });
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString();
      log.error("marketplace", `Failed to update ${name}: ${stderr}`);
      return false;
    }

    const plugin = await getPluginDetails(name);
    if (plugin) {
      const config = loadConfig();
      config.installed[name] = {
        version: plugin.version,
        installedAt: config.installed[name]?.installedAt ?? new Date().toISOString(),
      };
      saveConfig(config);
    }

    log.info("marketplace", `Updated plugin: ${name}`);
    return true;
  } catch (err) {
    log.error("marketplace", `Update failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function listInstalled(): Promise<MarketplacePlugin[]> {
  const config = loadConfig();
  const installedNames = Object.keys(config.installed);
  if (installedNames.length === 0) return [];

  const registry = loadBundledRegistry();
  const remote = await fetchRemoteRegistry(config.registryUrl);
  const fullRegistry = remote ?? registry;

  const result: MarketplacePlugin[] = [];
  for (const name of installedNames) {
    const pluginDir = join(PLUGINS_DIR, name);
    if (!existsSync(pluginDir)) continue;

    const details = fullRegistry.find(p => p.name === name);
    if (details) {
      result.push(details);
    } else {
      result.push({
        name,
        version: config.installed[name]!.version,
        description: "(locally installed)",
        author: "unknown",
        repository: "",
        downloads: 0,
        rating: 0,
        tags: [],
        verified: false,
      });
    }
  }

  return result;
}

export async function checkUpdates(): Promise<{ name: string; current: string; latest: string }[]> {
  const config = loadConfig();
  const remote = await fetchRemoteRegistry(config.registryUrl);
  const registry = remote ?? loadBundledRegistry();
  const updates: { name: string; current: string; latest: string }[] = [];

  for (const [name, info] of Object.entries(config.installed)) {
    const latest = registry.find(p => p.name === name);
    if (latest && latest.version !== info.version) {
      updates.push({ name, current: info.version, latest: latest.version });
    }
  }

  return updates;
}

// ─── Formatting ─────────────────────────────────────────────────

export function formatPluginInfo(plugin: MarketplacePlugin): string {
  const stars = "\u2605".repeat(Math.round(plugin.rating));
  const verified = plugin.verified ? " [verified]" : "";
  return [
    `  ${plugin.name} v${plugin.version}${verified}`,
    `  ${plugin.description}`,
    `  Author: ${plugin.author} | Downloads: ${plugin.downloads.toLocaleString()} | Rating: ${stars} (${plugin.rating})`,
    `  Tags: ${plugin.tags.join(", ")}`,
    `  Repository: ${plugin.repository}`,
  ].join("\n");
}

export function formatPluginList(plugins: MarketplacePlugin[], title: string): string {
  if (plugins.length === 0) return `  No plugins found.`;

  const lines = [`  ${title} (${plugins.length}):\n`];
  for (const p of plugins) {
    const verified = p.verified ? " \u2713" : "";
    const rating = `${p.rating}/5`;
    lines.push(`  ${p.name} v${p.version}${verified} — ${p.description}`);
    lines.push(`    by ${p.author} | ${p.downloads.toLocaleString()} downloads | ${rating}`);
  }
  return lines.join("\n");
}
